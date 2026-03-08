import { Capture, Tweet, User } from '@/types';
import { TweetViewPayload } from './tweet-view';

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const SYNC_BATCH_SIZE = 500;
export const SYNC_MAX_RETRIES = 3;
export const MINIO_MANIFEST_CHUNK_SIZE = 100;

export interface MinioSyncState {
  version: 1;
  twitter_user_id: string;
  last_synced_at: number;
  last_success_at?: string | null;
  last_error?: string | null;
  updated_at?: string;
}

export interface MinioManifestRecord {
  version: 1;
  twitter_user_id: string;
  module: string;
  capture_id: string;
  tweet_id: string;
  created_at: number;
  sort_index?: string | null;
  tweet: TweetViewPayload;
}

export interface MinioManifestChunkRef {
  id: string;
  key: string;
  record_count: number;
}

export interface MinioPendingChunkRef {
  key: string;
  record_count: number;
}

export interface MinioManifestIndex {
  version: 1;
  twitter_user_id: string;
  module: string;
  published_chunks: MinioManifestChunkRef[];
  pending: MinioPendingChunkRef;
  updated_at: string;
}

export interface SyncState {
  twitter_user_id: string;
  last_synced_at: number;
  last_success_at?: string | null;
  last_error?: string | null;
  updated_at?: string;
}

export interface SyncedTweetRow {
  twitter_user_id: string;
  rest_id: string;
  source_updated_at: number;
  payload: Tweet;
  view_payload: TweetViewPayload;
  synced_at: string;
}

export interface SyncedUserRow {
  twitter_user_id: string;
  rest_id: string;
  source_updated_at: number;
  payload: User;
  synced_at: string;
}

export interface SyncedCaptureRow {
  twitter_user_id: string;
  capture_id: string;
  extension: string;
  capture_type: string;
  data_key: string;
  created_at: number;
  sort_index?: string;
  payload: Capture;
  synced_at: string;
}

export function buildMinioStateKey(twitterUserId: string) {
  return `users/${twitterUserId}/state/minio-sync-state.json`;
}

export function buildMinioManifestLegacyKey(twitterUserId: string, module: string) {
  return `users/${twitterUserId}/manifests/${module}.jsonl`;
}

export function buildMinioManifestIndexKey(twitterUserId: string, module: string) {
  return `users/${twitterUserId}/manifests/${module}/index.json`;
}

export function buildMinioPendingManifestKey(twitterUserId: string, module: string) {
  return `users/${twitterUserId}/manifests/${module}/pending/current.jsonl`;
}

export function buildMinioManifestChunkKey(twitterUserId: string, module: string, chunkId: string) {
  return `users/${twitterUserId}/manifests/${module}/chunks/${chunkId}.jsonl`;
}
