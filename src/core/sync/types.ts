import { Capture, Tweet, User } from '@/types';
import { TweetViewPayload } from './tweet-view';

export const SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const SYNC_BATCH_SIZE = 500;
export const SYNC_MAX_RETRIES = 3;

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
