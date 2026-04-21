export const FIBONACCI = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, '?'] as const;
export type FibonacciValue = (typeof FIBONACCI)[number];

export interface User {
  id: string;
  name: string;
  joinedAt: number;
}

export interface Vote {
  userId: string;
  value: FibonacciValue;
  castAt: number;
}

export type TopicState = 'active' | 'revealed';

export interface Topic {
  id: string;
  title: string;
  createdAt: number;
  state: TopicState;
  votes: Map<string, Vote>;
  revealTimer?: NodeJS.Timeout;
  revealedAt?: number;
}

export interface HistoryEntry {
  topicId: string;
  title: string;
  createdAt: number;
  revealedAt: number;
  votes: Array<{ userName: string; value: FibonacciValue }>;
}

export interface Room {
  code: string;
  adminUserId: string;
  createdAt: number;
  users: Map<string, User>;
  currentTopic: Topic | null;
  history: HistoryEntry[];
}

export interface TopicSnapshotActive {
  id: string;
  title: string;
  state: 'active';
  createdAt: number;
  votedUserIds: string[];
}

export interface TopicSnapshotRevealed {
  id: string;
  title: string;
  state: 'revealed';
  createdAt: number;
  revealedAt: number;
  votes: Array<{ userId: string; userName: string; value: FibonacciValue }>;
}

export type TopicSnapshot = TopicSnapshotActive | TopicSnapshotRevealed;

export interface RoomSnapshot {
  code: string;
  adminUserId: string;
  users: Array<{ id: string; name: string }>;
  currentTopic: TopicSnapshot | null;
}
