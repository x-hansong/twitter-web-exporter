import { options } from '@/core/options';
import { db } from '@/core/database';
import { Capture, Tweet, User } from '@/types';
import logger from '@/utils/logger';
import { getSupabaseClient } from './supabase-client';
import {
  SYNC_BATCH_SIZE,
  SYNC_INTERVAL_MS,
  SYNC_MAX_RETRIES,
  SyncedCaptureRow,
  SyncedTweetRow,
  SyncedUserRow,
  SyncState,
} from './types';
import { buildTweetViewPayload } from './tweet-view';

const TABLE_SYNC_STATE = 'sync_states';
const TABLE_SYNCED_TWEETS = 'synced_tweets';
const TABLE_SYNCED_USERS = 'synced_users';
const TABLE_SYNCED_CAPTURES = 'synced_captures';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export class SyncManager {
  private intervalId: number | null = null;
  private running = false;
  private started = false;
  private lastSyncEnabled = false;
  private lastSupabaseUrl = '';
  private lastSupabaseKey = '';

  start() {
    if (this.started) return;
    this.started = true;
    this.lastSyncEnabled = !!options.get('syncEnabled');
    this.lastSupabaseUrl = options.get('supabaseUrl', '')?.trim() ?? '';
    this.lastSupabaseKey = options.get('supabaseAnonKey', '')?.trim() ?? '';

    this.intervalId = window.setInterval(() => {
      void this.runOnce('interval');
    }, SYNC_INTERVAL_MS);

    options.signal.subscribe(() => {
      const enabled = !!options.get('syncEnabled');
      const url = options.get('supabaseUrl', '')?.trim() ?? '';
      const key = options.get('supabaseAnonKey', '')?.trim() ?? '';
      const previousReady =
        this.lastSyncEnabled && this.lastSupabaseUrl.length > 0 && this.lastSupabaseKey.length > 0;
      const currentReady = enabled && url.length > 0 && key.length > 0;

      if (!this.lastSyncEnabled && enabled) {
        void this.runOnce('enabled');
      } else if (!previousReady && currentReady) {
        void this.runOnce('config-ready');
      }

      this.lastSyncEnabled = enabled;
      this.lastSupabaseUrl = url;
      this.lastSupabaseKey = key;
    });

    void this.runOnce('startup');
  }

  async runNow() {
    return this.runOnce('manual');
  }

  private async runOnce(reason: string) {
    if (this.running) return;
    if (!options.get('syncEnabled')) return;
    if (!navigator.onLine) {
      logger.warn('Sync skipped: browser is offline');
      return;
    }

    const url = options.get('supabaseUrl', '')?.trim();
    const key = options.get('supabaseAnonKey', '')?.trim();
    if (!url || !key) {
      logger.warn('Sync skipped: Supabase URL or anon key is not configured');
      return;
    }

    const twitterUserId = db.getCurrentUserId();
    if (!twitterUserId || twitterUserId === 'unknown') {
      logger.warn('Sync skipped: twitter user id is unknown');
      return;
    }

    this.running = true;
    const startAt = Date.now();
    logger.info(`Sync started (${reason})`);

    try {
      await this.syncWithRetry(twitterUserId, url, key);
      logger.info(`Sync completed in ${Date.now() - startAt}ms`);
    } catch (error) {
      logger.error(`Sync failed after retries: ${(error as Error).message}`, error);
      await this.upsertSyncStateError(twitterUserId, url, key, (error as Error).message);
    } finally {
      this.running = false;
    }
  }

  private async syncWithRetry(twitterUserId: string, url: string, key: string) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
      try {
        await this.syncOnce(twitterUserId, url, key);
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Sync attempt ${attempt}/${SYNC_MAX_RETRIES} failed`, error);
        if (attempt < SYNC_MAX_RETRIES) {
          await wait(2 ** (attempt - 1) * 1000);
        }
      }
    }

    throw lastError ?? new Error('Unknown sync error');
  }

  private async syncOnce(twitterUserId: string, url: string, key: string) {
    const supabase = getSupabaseClient(url, key);
    const lastSyncedAt = await this.getLastSyncedAt(supabase, twitterUserId);

    const [tweetRecords, userRecords] = await Promise.all([
      db.getUpdatedTweetsSince(lastSyncedAt),
      db.getUpdatedUsersSince(lastSyncedAt),
    ]);

    const tweets = tweetRecords ?? [];
    const users = userRecords ?? [];
    const now = new Date().toISOString();

    if (tweets.length === 0 && users.length === 0) {
      logger.info('Sync skipped: no incremental records');
      const { error } = await supabase.from(TABLE_SYNC_STATE).upsert(
        {
          twitter_user_id: twitterUserId,
          last_synced_at: lastSyncedAt,
          last_success_at: now,
          last_error: null,
          updated_at: now,
        },
        { onConflict: 'twitter_user_id' },
      );
      if (error) {
        throw error;
      }
      return;
    }

    const maxUpdatedAt = Math.max(
      lastSyncedAt,
      ...tweets.map((tweet) => tweet.twe_private_fields.updated_at),
      ...users.map((user) => user.twe_private_fields.updated_at),
    );

    await this.upsertTweets(supabase, twitterUserId, tweets, now);
    await this.upsertUsers(supabase, twitterUserId, users, now);

    const captureDataKeys = [
      ...tweets.map((tweet) => tweet.rest_id),
      ...users.map((user) => user.rest_id),
    ];
    const captures = await db.getCapturesByDataKeys(captureDataKeys);
    await this.upsertCaptures(supabase, twitterUserId, captures, now);

    const { error: stateError } = await supabase.from(TABLE_SYNC_STATE).upsert(
      {
        twitter_user_id: twitterUserId,
        last_synced_at: maxUpdatedAt,
        last_success_at: now,
        last_error: null,
        updated_at: now,
      },
      { onConflict: 'twitter_user_id' },
    );
    if (stateError) {
      throw stateError;
    }

    logger.info(
      `Sync stats: tweets=${tweets.length}, users=${users.length}, captures=${captures.length}, cursor=${maxUpdatedAt}`,
    );
  }

  private async getLastSyncedAt(
    supabase: ReturnType<typeof getSupabaseClient>,
    twitterUserId: string,
  ): Promise<number> {
    const { data, error } = await supabase
      .from(TABLE_SYNC_STATE)
      .select('last_synced_at')
      .eq('twitter_user_id', twitterUserId)
      .limit(1);

    if (error) {
      throw error;
    }

    return data?.[0]?.last_synced_at ?? 0;
  }

  private async upsertTweets(
    supabase: ReturnType<typeof getSupabaseClient>,
    twitterUserId: string,
    tweets: Tweet[],
    syncedAt: string,
  ) {
    if (tweets.length === 0) return;

    for (const chunk of chunkArray(tweets, SYNC_BATCH_SIZE)) {
      const rows: SyncedTweetRow[] = chunk.map((tweet) => ({
        twitter_user_id: twitterUserId,
        rest_id: tweet.rest_id,
        source_updated_at: tweet.twe_private_fields.updated_at,
        payload: tweet,
        view_payload: buildTweetViewPayload(tweet),
        synced_at: syncedAt,
      }));
      const { error } = await supabase
        .from(TABLE_SYNCED_TWEETS)
        .upsert(rows, { onConflict: 'twitter_user_id,rest_id' });
      if (error) {
        throw error;
      }
    }
  }

  private async upsertUsers(
    supabase: ReturnType<typeof getSupabaseClient>,
    twitterUserId: string,
    users: User[],
    syncedAt: string,
  ) {
    if (users.length === 0) return;

    for (const chunk of chunkArray(users, SYNC_BATCH_SIZE)) {
      const rows: SyncedUserRow[] = chunk.map((user) => ({
        twitter_user_id: twitterUserId,
        rest_id: user.rest_id,
        source_updated_at: user.twe_private_fields.updated_at,
        payload: user,
        synced_at: syncedAt,
      }));
      const { error } = await supabase
        .from(TABLE_SYNCED_USERS)
        .upsert(rows, { onConflict: 'twitter_user_id,rest_id' });
      if (error) {
        throw error;
      }
    }
  }

  private async upsertCaptures(
    supabase: ReturnType<typeof getSupabaseClient>,
    twitterUserId: string,
    captures: Capture[],
    syncedAt: string,
  ) {
    if (captures.length === 0) return;

    for (const chunk of chunkArray(captures, SYNC_BATCH_SIZE)) {
      const rows: SyncedCaptureRow[] = chunk.map((capture) => ({
        twitter_user_id: twitterUserId,
        capture_id: capture.id,
        extension: capture.extension,
        capture_type: capture.type,
        data_key: capture.data_key,
        created_at: capture.created_at,
        sort_index: capture.sort_index,
        payload: capture,
        synced_at: syncedAt,
      }));
      const { error } = await supabase
        .from(TABLE_SYNCED_CAPTURES)
        .upsert(rows, { onConflict: 'twitter_user_id,capture_id' });
      if (error) {
        throw error;
      }
    }
  }

  private async upsertSyncStateError(
    twitterUserId: string,
    url: string,
    key: string,
    message: string,
  ) {
    const supabase = getSupabaseClient(url, key);
    const now = new Date().toISOString();
    const { error } = await supabase.from(TABLE_SYNC_STATE).upsert(
      {
        twitter_user_id: twitterUserId,
        last_error: message,
        updated_at: now,
      } as Partial<SyncState>,
      { onConflict: 'twitter_user_id' },
    );
    if (error) {
      logger.warn('Failed to persist sync error state', error);
    }
  }
}
