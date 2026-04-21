import type { FibonacciValue, RoomSnapshot } from './room.types.js';

export const RoomEvents = {
  UserJoined: 'room.user-joined',
  UserLeft: 'room.user-left',
  TopicCreated: 'room.topic-created',
  VoteCast: 'room.vote-cast',
  Revealed: 'room.revealed',
  AdminChanged: 'room.admin-changed',
} as const;

interface BaseEvt {
  roomCode: string;
  at: number;
}

export interface HelloEvt extends BaseEvt {
  type: 'hello';
  snapshot: RoomSnapshot;
}

export interface UserJoinedEvt extends BaseEvt {
  type: 'user-joined';
  user: { id: string; name: string };
}

export interface UserLeftEvt extends BaseEvt {
  type: 'user-left';
  userId: string;
  userName: string;
}

export interface TopicCreatedEvt extends BaseEvt {
  type: 'topic-created';
  topic: { id: string; title: string; createdAt: number };
}

export interface VoteCastEvt extends BaseEvt {
  type: 'vote-cast';
  userId: string;
  total: number;
  expected: number;
}

export interface RevealedEvt extends BaseEvt {
  type: 'revealed';
  topicId: string;
  title: string;
  votes: Array<{ userId: string; userName: string; value: FibonacciValue }>;
  reason: 'timeout' | 'all-voted';
}

export interface AdminChangedEvt extends BaseEvt {
  type: 'admin-changed';
  adminUserId: string;
}

export type RoomEvent =
  | HelloEvt
  | UserJoinedEvt
  | UserLeftEvt
  | TopicCreatedEvt
  | VoteCastEvt
  | RevealedEvt
  | AdminChangedEvt;
