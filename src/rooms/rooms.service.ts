import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import {
  FIBONACCI,
  type FibonacciValue,
  type Room,
  type RoomSnapshot,
  type Topic,
} from './room.types.js';
import { RoomEvents, type RoomEvent } from './rooms.events.js';
import type { CreateRoomDto } from './dto/create-room.dto.js';

const REVEAL_TIMEOUT_S = 15;
const REVEAL_TIMEOUT_MS = REVEAL_TIMEOUT_S * 1000;

@Injectable()
export class RoomsService {
  constructor(private readonly events: EventEmitter2) {}

  private readonly rooms = new Map<string, Room>();
  private readonly pendingLeaves = new Map<string, NodeJS.Timeout>();
  // Tracks the active connection ID per user so a late-firing teardown from a
  // stale SSE connection doesn't evict a user who has already reconnected.
  private readonly connectionIds = new Map<string, string>();

  createRoom(dto: CreateRoomDto): { code: string; userId: string; userName: string } {
    const name = this.sanitizeName(dto.adminName);
    const code = this.generateCode();
    const userId = randomUUID();

    const room: Room = {
      code,
      creatorId: userId,
      adminUserId: userId,
      createdAt: Date.now(),
      users: new Map([[userId, { id: userId, name, joinedAt: Date.now() }]]),
      currentTopic: null,
      history: [],
    };

    this.rooms.set(code, room);
    return { code, userId, userName: name };
  }

  joinRoom(
    code: string,
    name: string,
  ): { userId: string; userName: string; snapshot: RoomSnapshot } {
    const room = this.mustGetRoom(code);
    const sanitized = this.sanitizeName(name);
    const userId = randomUUID();

    room.users.set(userId, { id: userId, name: sanitized, joinedAt: Date.now() });

    this.events.emit(RoomEvents.UserJoined, {
      type: 'user-joined',
      roomCode: code,
      at: Date.now(),
      user: { id: userId, name: sanitized },
    });

    return { userId, userName: sanitized, snapshot: this.buildSnapshot(room) };
  }

  rejoinRoom(
    code: string,
    userId: string | undefined,
    name: string,
  ): { userId: string; userName: string; snapshot: RoomSnapshot } {
    const room = this.mustGetRoom(code);
    const sanitized = this.sanitizeName(name);

    // Already a member — keep the same identity, refresh display name.
    if (userId && room.users.has(userId)) {
      const user = room.users.get(userId)!;
      user.name = sanitized;
      return { userId, userName: sanitized, snapshot: this.buildSnapshot(room) };
    }

    // Original creator returning after eviction — restore their user and admin.
    if (userId && userId === room.creatorId) {
      room.users.set(userId, { id: userId, name: sanitized, joinedAt: Date.now() });
      const wasAdmin = room.adminUserId === userId;
      room.adminUserId = userId;

      this.events.emit(RoomEvents.UserJoined, {
        type: 'user-joined',
        roomCode: code,
        at: Date.now(),
        user: { id: userId, name: sanitized },
      });

      if (!wasAdmin) {
        this.events.emit(RoomEvents.AdminChanged, {
          type: 'admin-changed',
          roomCode: code,
          at: Date.now(),
          adminUserId: userId,
        });
      }

      return { userId, userName: sanitized, snapshot: this.buildSnapshot(room) };
    }

    // Stale or unknown userId — fall back to a fresh join.
    return this.joinRoom(code, sanitized);
  }

  leaveRoom(code: string, userId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;

    const user = room.users.get(userId);
    if (!user) return;

    room.users.delete(userId);

    this.events.emit(RoomEvents.UserLeft, {
      type: 'user-left',
      roomCode: code,
      at: Date.now(),
      userId,
      userName: user.name,
    });

    if (room.users.size === 0) {
      if (room.currentTopic?.revealTimer) clearTimeout(room.currentTopic.revealTimer);
      this.rooms.delete(code);
      return;
    }

    // Transfer admin to the longest-standing remaining user
    if (room.adminUserId === userId) {
      const next = [...room.users.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.adminUserId = next.id;
      this.events.emit(RoomEvents.AdminChanged, {
        type: 'admin-changed',
        roomCode: code,
        at: Date.now(),
        adminUserId: next.id,
      });
    }

    if (
      room.currentTopic &&
      room.currentTopic.state === 'active' &&
      room.currentTopic.votes.size >= room.users.size
    ) {
      clearTimeout(room.currentTopic.revealTimer);
      this.reveal(room, 'all-voted');
    }
  }

  createTopic(code: string, userId: string, title: string): { topicId: string; title: string } {
    const room = this.mustGetRoomAsAdmin(code, userId);

    if (room.currentTopic && room.currentTopic.state === 'active') {
      throw new ConflictException('Current topic is not yet revealed');
    }

    const trimmed = title.trim();
    if (!trimmed) throw new BadRequestException('Title cannot be empty');

    const topic: Topic = {
      id: randomUUID(),
      title: trimmed,
      createdAt: Date.now(),
      state: 'active',
      votes: new Map(),
    };

    topic.revealTimer = setTimeout(() => this.reveal(room, 'timeout'), REVEAL_TIMEOUT_MS);
    room.currentTopic = topic;

    this.events.emit(RoomEvents.TopicCreated, {
      type: 'topic-created',
      roomCode: code,
      at: Date.now(),
      topic: { id: topic.id, title: topic.title, createdAt: topic.createdAt },
    });

    return { topicId: topic.id, title: topic.title };
  }

  castVote(code: string, userId: string, value: FibonacciValue): { ok: true; total: number; expected: number } {
    const room = this.mustGetRoom(code);

    if (!room.users.has(userId)) throw new ForbiddenException('Not a member of this room');

    const topic = room.currentTopic;
    if (!topic || topic.state !== 'active') throw new BadRequestException('No active topic to vote on');

    if (!(FIBONACCI as readonly unknown[]).includes(value))
      throw new BadRequestException('Invalid Fibonacci value');

    topic.votes.set(userId, { userId, value, castAt: Date.now() });

    const total = topic.votes.size;
    const expected = room.users.size;

    this.events.emit(RoomEvents.VoteCast, {
      type: 'vote-cast',
      roomCode: code,
      at: Date.now(),
      userId,
      total,
      expected,
    });

    if (total >= expected) {
      clearTimeout(topic.revealTimer);
      this.reveal(room, 'all-voted');
    }

    return { ok: true, total, expected };
  }

  getSnapshot(code: string): RoomSnapshot {
    return this.buildSnapshot(this.mustGetRoom(code));
  }

  listenerStream(code: string, userId: string): Observable<RoomEvent> {
    const room = this.mustGetRoom(code);

    return new Observable<RoomEvent>((subscriber) => {
      const pendingKey = `${code}:${userId}`;
      const connId = randomUUID();

      // Cancel any pending leave from a previous disconnection
      const pending = this.pendingLeaves.get(pendingKey);
      if (pending) {
        clearTimeout(pending);
        this.pendingLeaves.delete(pendingKey);
      }

      // Register this connection as the authoritative one for this user
      this.connectionIds.set(pendingKey, connId);

      subscriber.next({
        type: 'hello',
        roomCode: code,
        at: Date.now(),
        snapshot: this.buildSnapshot(room),
      });

      const handler = (evt: RoomEvent) => {
        if (evt.roomCode === code) subscriber.next(evt);
      };

      this.events.on('room.*', handler);

      return () => {
        this.events.off('room.*', handler);

        const timer = setTimeout(() => {
          this.pendingLeaves.delete(pendingKey);
          // Only evict if no newer connection has taken over for this user
          if (this.connectionIds.get(pendingKey) === connId) {
            this.connectionIds.delete(pendingKey);
            this.leaveRoom(code, userId);
          }
        }, 5_000);

        this.pendingLeaves.set(pendingKey, timer);
      };
    });
  }

  private reveal(room: Room, reason: 'timeout' | 'all-voted'): void {
    const topic = room.currentTopic;
    if (!topic || topic.state === 'revealed') return;

    clearTimeout(topic.revealTimer);
    topic.revealTimer = undefined;
    topic.state = 'revealed';
    topic.revealedAt = Date.now();

    const votes = [...topic.votes.values()].map((v) => ({
      userId: v.userId,
      userName: room.users.get(v.userId)?.name ?? '?',
      value: v.value,
    }));

    room.history.push({
      topicId: topic.id,
      title: topic.title,
      createdAt: topic.createdAt,
      revealedAt: topic.revealedAt,
      votes: votes.map((v) => ({ userName: v.userName, value: v.value })),
    });

    this.events.emit(RoomEvents.Revealed, {
      type: 'revealed',
      roomCode: room.code,
      at: Date.now(),
      topicId: topic.id,
      title: topic.title,
      votes,
      reason,
    });
  }

  private buildSnapshot(room: Room): RoomSnapshot {
    const topic = room.currentTopic;

    let currentTopic: RoomSnapshot['currentTopic'] = null;
    if (topic) {
      if (topic.state === 'active') {
        currentTopic = {
          id: topic.id,
          title: topic.title,
          state: 'active',
          createdAt: topic.createdAt,
          votedUserIds: [...topic.votes.keys()],
        };
      } else {
        currentTopic = {
          id: topic.id,
          title: topic.title,
          state: 'revealed',
          createdAt: topic.createdAt,
          revealedAt: topic.revealedAt!,
          votes: [...topic.votes.values()].map((v) => ({
            userId: v.userId,
            userName: room.users.get(v.userId)?.name ?? '?',
            value: v.value,
          })),
        };
      }
    }

    return {
      code: room.code,
      adminUserId: room.adminUserId,
      users: [...room.users.values()].map((u) => ({ id: u.id, name: u.name })),
      currentTopic,
    };
  }

  private mustGetRoom(code: string): Room {
    const room = this.rooms.get(code);
    if (!room) throw new NotFoundException(`Room ${code} not found`);
    return room;
  }

  private mustGetRoomAsAdmin(code: string, userId: string): Room {
    const room = this.mustGetRoom(code);
    if (room.adminUserId !== userId) throw new UnauthorizedException('Not the admin of this room');
    return room;
  }

  private sanitizeName(name: string): string {
    const trimmed = name?.trim().slice(0, 30);
    if (!trimmed) throw new BadRequestException('Name cannot be empty');
    return trimmed;
  }

  private generateCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Unable to generate a unique room code');
  }
}
