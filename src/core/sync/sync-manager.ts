import { options } from '@/core/options';
import { db } from '@/core/database';
import { Capture, Tweet, User } from '@/types';
import logger from '@/utils/logger';
import { getSupabaseClient } from './supabase-client';
import { MinioClient } from './minio-client';
import {
  buildMinioManifestChunkKey,
  buildMinioManifestIndexKey,
  buildMinioManifestLegacyKey,
  buildMinioPendingManifestKey,
  buildMinioStateKey,
  MINIO_MANIFEST_CHUNK_SIZE,
  MinioManifestChunkRef,
  MinioManifestIndex,
  MinioManifestRecord,
  MinioSyncState,
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

type SyncBackend = 'supabase' | 'minio';

interface MinioConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface MinioPutResult<TId extends string> {
  successes: Set<TId>;
  failures: string[];
}

interface SourceSyncRecord {
  kind: 'tweet' | 'user';
  id: string;
  updatedAt: number;
}

export class SyncManager {
  private intervalId: number | null = null;
  private running = false;
  private started = false;
  private lastSyncEnabled = false;
  private lastSyncBackend: SyncBackend = 'supabase';
  private lastSupabaseUrl = '';
  private lastSupabaseKey = '';
  private lastMinioEndpoint = '';
  private lastMinioBucket = '';
  private lastMinioAccessKeyId = '';

  start() {
    if (this.started) return;
    this.started = true;
    this.lastSyncEnabled = !!options.get('syncEnabled');
    this.lastSyncBackend = this.getSyncBackend();
    this.lastSupabaseUrl = options.get('supabaseUrl', '')?.trim() ?? '';
    this.lastSupabaseKey = options.get('supabaseAnonKey', '')?.trim() ?? '';
    this.lastMinioEndpoint = options.get('minioEndpoint', '')?.trim() ?? '';
    this.lastMinioBucket = options.get('minioBucket', '')?.trim() ?? '';
    this.lastMinioAccessKeyId = options.get('minioAccessKeyId', '')?.trim() ?? '';

    this.intervalId = window.setInterval(() => {
      void this.runOnce('interval');
    }, SYNC_INTERVAL_MS);

    options.signal.subscribe(() => {
      const enabled = !!options.get('syncEnabled');
      const backend = this.getSyncBackend();
      const previousReady = this.isBackendReady(
        this.lastSyncBackend,
        this.lastSupabaseUrl,
        this.lastSupabaseKey,
        this.lastMinioEndpoint,
        this.lastMinioBucket,
        this.lastMinioAccessKeyId,
      );
      const currentReady = this.isBackendReady(
        backend,
        options.get('supabaseUrl', '')?.trim() ?? '',
        options.get('supabaseAnonKey', '')?.trim() ?? '',
        options.get('minioEndpoint', '')?.trim() ?? '',
        options.get('minioBucket', '')?.trim() ?? '',
        options.get('minioAccessKeyId', '')?.trim() ?? '',
      );

      if (!this.lastSyncEnabled && enabled) {
        void this.runOnce('enabled');
      } else if (!previousReady && currentReady) {
        void this.runOnce('config-ready');
      } else if (enabled && backend !== this.lastSyncBackend) {
        void this.runOnce('backend-changed');
      }

      this.lastSyncEnabled = enabled;
      this.lastSyncBackend = backend;
      this.lastSupabaseUrl = options.get('supabaseUrl', '')?.trim() ?? '';
      this.lastSupabaseKey = options.get('supabaseAnonKey', '')?.trim() ?? '';
      this.lastMinioEndpoint = options.get('minioEndpoint', '')?.trim() ?? '';
      this.lastMinioBucket = options.get('minioBucket', '')?.trim() ?? '';
      this.lastMinioAccessKeyId = options.get('minioAccessKeyId', '')?.trim() ?? '';
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

    const backend = this.getSyncBackend();
    const twitterUserId = db.getCurrentUserId();
    if (!twitterUserId || twitterUserId === 'unknown') {
      logger.warn('Sync skipped: twitter user id is unknown');
      return;
    }

    this.running = true;
    const startAt = Date.now();
    logger.info(`Sync started (${backend}, ${reason})`);

    try {
      if (backend === 'supabase') {
        const url = options.get('supabaseUrl', '')?.trim();
        const key = options.get('supabaseAnonKey', '')?.trim();
        if (!url || !key) {
          logger.warn('Sync skipped: Supabase URL or anon key is not configured');
          return;
        }
        await this.syncSupabaseWithRetry(twitterUserId, url, key);
      } else {
        const config = this.getMinioConfig();
        this.validateMinioConfig(config);
        await this.syncMinioWithRetry(twitterUserId, config);
      }

      logger.info(`Sync completed in ${Date.now() - startAt}ms`);
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`Sync failed after retries: ${message}`, error);

      if (backend === 'supabase') {
        const url = options.get('supabaseUrl', '')?.trim();
        const key = options.get('supabaseAnonKey', '')?.trim();
        if (url && key) {
          await this.upsertSyncStateError(twitterUserId, url, key, message);
        }
      } else {
        const config = this.getMinioConfig();
        if (config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey) {
          await this.upsertMinioSyncStateError(twitterUserId, config, message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private getSyncBackend(): SyncBackend {
    return options.get('syncBackend', 'supabase') === 'minio' ? 'minio' : 'supabase';
  }

  private isBackendReady(
    backend: SyncBackend,
    supabaseUrl: string,
    supabaseKey: string,
    minioEndpoint: string,
    minioBucket: string,
    minioAccessKeyId: string,
  ) {
    if (backend === 'supabase') {
      return this.lastSyncEnabled && supabaseUrl.length > 0 && supabaseKey.length > 0;
    }
    return (
      this.lastSyncEnabled &&
      minioEndpoint.length > 0 &&
      minioBucket.length > 0 &&
      minioAccessKeyId.length > 0
    );
  }

  private getMinioConfig(): MinioConfig {
    return {
      endpoint: options.get('minioEndpoint', '')?.trim() ?? '',
      bucket: options.get('minioBucket', '')?.trim() ?? '',
      region: options.get('minioRegion', 'us-east-1')?.trim() ?? 'us-east-1',
      accessKeyId: options.get('minioAccessKeyId', '')?.trim() ?? '',
      secretAccessKey: options.get('minioSecretAccessKey', '')?.trim() ?? '',
    };
  }

  private validateMinioConfig(config: MinioConfig) {
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new Error('MinIO endpoint, bucket, access key id, and secret access key are required');
    }
  }

  private async syncSupabaseWithRetry(twitterUserId: string, url: string, key: string) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
      try {
        await this.syncSupabaseOnce(twitterUserId, url, key);
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`Supabase sync attempt ${attempt}/${SYNC_MAX_RETRIES} failed`, error);
        if (attempt < SYNC_MAX_RETRIES) {
          await wait(2 ** (attempt - 1) * 1000);
        }
      }
    }

    throw lastError ?? new Error('Unknown sync error');
  }

  private async syncMinioWithRetry(twitterUserId: string, config: MinioConfig) {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
      try {
        await this.syncMinioOnce(twitterUserId, config);
        return;
      } catch (error) {
        lastError = error as Error;
        logger.warn(`MinIO sync attempt ${attempt}/${SYNC_MAX_RETRIES} failed`, error);
        if (attempt < SYNC_MAX_RETRIES) {
          await wait(2 ** (attempt - 1) * 1000);
        }
      }
    }

    throw lastError ?? new Error('Unknown sync error');
  }

  private async syncSupabaseOnce(twitterUserId: string, url: string, key: string) {
    const supabase = getSupabaseClient(url, key);
    const lastSyncedAt = await this.getLastSyncedAt(supabase, twitterUserId);

    const [tweetRecords, userRecords] = await Promise.all([
      db.getUpdatedTweetsSince(lastSyncedAt),
      db.getUpdatedUsersSince(lastSyncedAt),
    ]);

    const tweets = (tweetRecords ?? []).sort(compareTweetByUpdatedAt);
    const users = (userRecords ?? []).sort(compareUserByUpdatedAt);
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

    await this.upsertTweets(getSupabaseClient(url, key), twitterUserId, tweets, now);
    await this.upsertUsers(getSupabaseClient(url, key), twitterUserId, users, now);

    const captureDataKeys = [
      ...tweets.map((tweet) => tweet.rest_id),
      ...users.map((user) => user.rest_id),
    ];
    const captures = (await db.getCapturesByDataKeys(captureDataKeys)).sort(compareCapture);
    await this.upsertCaptures(getSupabaseClient(url, key), twitterUserId, captures, now);

    const { error: stateError } = await getSupabaseClient(url, key).from(TABLE_SYNC_STATE).upsert(
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
      `Supabase sync stats: tweets=${tweets.length}, users=${users.length}, captures=${captures.length}, cursor=${maxUpdatedAt}`,
    );
  }

  private async syncMinioOnce(twitterUserId: string, config: MinioConfig) {
    const client = new MinioClient(config);
    const state = await client.getJson<MinioSyncState>(buildMinioStateKey(twitterUserId));
    const lastSyncedAt = state?.last_synced_at ?? 0;

    const [tweetRecords, userRecords] = await Promise.all([
      db.getUpdatedTweetsSince(lastSyncedAt),
      db.getUpdatedUsersSince(lastSyncedAt),
    ]);

    const tweets = (tweetRecords ?? []).sort(compareTweetByUpdatedAt);
    const users = (userRecords ?? []).sort(compareUserByUpdatedAt);
    const now = new Date().toISOString();

    if (tweets.length === 0 && users.length === 0) {
      logger.info('MinIO sync skipped: no incremental records');
      await client.putJson(buildMinioStateKey(twitterUserId), {
        version: 1,
        twitter_user_id: twitterUserId,
        last_synced_at: lastSyncedAt,
        last_success_at: now,
        last_error: null,
        updated_at: now,
      } satisfies MinioSyncState);
      return;
    }

    const maxUpdatedAt = Math.max(
      lastSyncedAt,
      ...tweets.map((tweet) => tweet.twe_private_fields.updated_at),
      ...users.map((user) => user.twe_private_fields.updated_at),
    );
    const captureDataKeys = [
      ...tweets.map((tweet) => tweet.rest_id),
      ...users.map((user) => user.rest_id),
    ];
    const captures = (await db.getCapturesByDataKeys(captureDataKeys)).sort(compareCapture);

    logger.info(
      `MinIO sync preparing manifests: tweets=${tweets.length}, users=${users.length}, captures=${captures.length}`,
    );
    logger.info('MinIO stage: put manifest records');
    const manifestResult = await this.putManifestRecords(client, twitterUserId, tweets, captures);
    const committedCursor = this.computeCommittedCursor(
      lastSyncedAt,
      tweets,
      users,
      captures,
      new Set(tweets.map((tweet) => tweet.rest_id)),
      new Set(users.map((user) => user.rest_id)),
      new Set(captures.map((capture) => capture.id)),
      manifestResult.successes,
    );
    const allFailures = [...manifestResult.failures];
    const hasFailures = allFailures.length > 0;
    logger.info('MinIO stage: write sync state');
    await client.putJson(buildMinioStateKey(twitterUserId), {
      version: 1,
      twitter_user_id: twitterUserId,
      last_synced_at: committedCursor,
      last_success_at:
        committedCursor > lastSyncedAt || !hasFailures ? now : (state?.last_success_at ?? null),
      last_error: hasFailures
        ? `Partial MinIO sync failure (${allFailures.length} errors); first error: ${allFailures[0]}`
        : null,
      updated_at: now,
    } satisfies MinioSyncState);

    logger.info(
      `MinIO sync stats: tweets=${tweets.length}, users=${users.length}, captures=${captures.length}, cursor=${committedCursor}, max_cursor=${maxUpdatedAt}`,
    );

    if (!hasFailures) {
      return;
    }

    if (committedCursor > lastSyncedAt) {
      logger.warn(
        `MinIO sync completed with partial failures; committed cursor advanced from ${lastSyncedAt} to ${committedCursor}`,
      );
      return;
    }

    throw new Error(`MinIO sync made no progress; first error: ${allFailures[0]}`);
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

  private async putManifestRecords(
    client: MinioClient,
    twitterUserId: string,
    tweets: Tweet[],
    captures: Capture[],
  ): Promise<MinioPutResult<string>> {
    const tweetMap = new Map(tweets.map((tweet) => [tweet.rest_id, tweet]));
    const groupedRecords = new Map<string, MinioManifestRecord[]>();
    const committedCaptureIds = new Set<string>();
    const failures: string[] = [];

    for (const capture of captures) {
      if (capture.type !== 'tweet') {
        continue;
      }

      const tweet = tweetMap.get(capture.data_key);
      if (!tweet) {
        continue;
      }

      const moduleRecords = groupedRecords.get(capture.extension) ?? [];
      try {
        moduleRecords.push({
          version: 1,
          twitter_user_id: twitterUserId,
          module: capture.extension,
          capture_id: capture.id,
          tweet_id: tweet.rest_id,
          created_at: capture.created_at,
          sort_index: capture.sort_index ?? null,
          tweet: buildTweetViewPayload(tweet),
        });
      } catch (error) {
        logger.warn(`MinIO manifest record skipped for ${capture.id}: ${(error as Error).message}`);
        continue;
      }
      groupedRecords.set(capture.extension, moduleRecords);
    }

    for (const [module, records] of groupedRecords) {
      try {
        logger.info(`MinIO manifest merge: module=${module}, records=${records.length}`);
        const manifestState = await this.loadManifestState(client, twitterUserId, module);
        const seenCaptureIds = new Set(
          manifestState.pendingRecords.map((record) => record.capture_id),
        );
        const additions = records
          .filter((record) => !seenCaptureIds.has(record.capture_id))
          .sort((left, right) =>
            left.created_at === right.created_at
              ? left.capture_id.localeCompare(right.capture_id)
              : left.created_at - right.created_at,
          );

        if (additions.length === 0) {
          for (const record of records) {
            committedCaptureIds.add(record.capture_id);
          }
          continue;
        }

        const nextPendingRecords = [...manifestState.pendingRecords, ...additions];
        const publishedChunks: MinioManifestChunkRef[] = [...manifestState.index.published_chunks];

        while (nextPendingRecords.length >= MINIO_MANIFEST_CHUNK_SIZE) {
          const chunkRecords = nextPendingRecords.splice(0, MINIO_MANIFEST_CHUNK_SIZE);
          const chunkId = nextManifestChunkId(publishedChunks);
          const chunkKey = buildMinioManifestChunkKey(twitterUserId, module, chunkId);
          await client.putText(chunkKey, serializeManifest(chunkRecords), 'application/x-ndjson');
          publishedChunks.push({
            id: chunkId,
            key: chunkKey,
            record_count: chunkRecords.length,
          });
          logger.info(
            `MinIO manifest chunk published: module=${module}, chunk=${chunkId}, records=${chunkRecords.length}`,
          );
        }

        const pendingKey = buildMinioPendingManifestKey(twitterUserId, module);
        await client.putText(
          pendingKey,
          serializeManifest(nextPendingRecords),
          'application/x-ndjson',
        );

        const indexKey = buildMinioManifestIndexKey(twitterUserId, module);
        await client.putJson(indexKey, {
          version: 1,
          twitter_user_id: twitterUserId,
          module,
          published_chunks: publishedChunks,
          pending: {
            key: pendingKey,
            record_count: nextPendingRecords.length,
          },
          updated_at: new Date().toISOString(),
        } satisfies MinioManifestIndex);
        for (const record of records) {
          committedCaptureIds.add(record.capture_id);
        }
        logger.info(
          `MinIO manifest written: module=${module}, pending=${nextPendingRecords.length}, added=${additions.length}, published=${publishedChunks.length}`,
        );
      } catch (error) {
        const message = (error as Error).message;
        failures.push(message);
        logger.warn(`MinIO manifest merge failed: module=${module}: ${message}`);
      }
    }

    return {
      successes: committedCaptureIds,
      failures,
    };
  }

  private computeCommittedCursor(
    lastSyncedAt: number,
    tweets: Tweet[],
    users: User[],
    captures: Capture[],
    successfulTweetIds: Set<string>,
    successfulUserIds: Set<string>,
    successfulCaptureIds: Set<string>,
    successfulManifestCaptureIds: Set<string>,
  ) {
    const captureGroups = new Map<string, Capture[]>();
    for (const capture of captures) {
      const group = captureGroups.get(capture.data_key) ?? [];
      group.push(capture);
      captureGroups.set(capture.data_key, group);
    }

    const committedTweets = new Set<string>();
    for (const tweet of tweets) {
      if (!successfulTweetIds.has(tweet.rest_id)) {
        continue;
      }

      const relatedCaptures = captureGroups.get(tweet.rest_id) ?? [];
      if (
        relatedCaptures.every(
          (capture) =>
            successfulCaptureIds.has(capture.id) &&
            (capture.type !== 'tweet' || successfulManifestCaptureIds.has(capture.id)),
        )
      ) {
        committedTweets.add(tweet.rest_id);
      }
    }

    const committedUsers = new Set<string>();
    for (const user of users) {
      if (!successfulUserIds.has(user.rest_id)) {
        continue;
      }

      const relatedCaptures = captureGroups.get(user.rest_id) ?? [];
      if (relatedCaptures.every((capture) => successfulCaptureIds.has(capture.id))) {
        committedUsers.add(user.rest_id);
      }
    }

    const sourceRecords: SourceSyncRecord[] = [
      ...tweets.map((tweet) => ({
        kind: 'tweet' as const,
        id: tweet.rest_id,
        updatedAt: tweet.twe_private_fields.updated_at,
      })),
      ...users.map((user) => ({
        kind: 'user' as const,
        id: user.rest_id,
        updatedAt: user.twe_private_fields.updated_at,
      })),
    ].sort(compareSourceRecord);

    let committedCursor = lastSyncedAt;
    let index = 0;
    while (index < sourceRecords.length) {
      const groupUpdatedAt = sourceRecords[index]?.updatedAt;
      if (groupUpdatedAt === undefined) {
        break;
      }

      const group: SourceSyncRecord[] = [];
      while (sourceRecords[index]?.updatedAt === groupUpdatedAt) {
        const record = sourceRecords[index];
        if (record) {
          group.push(record);
        }
        index += 1;
      }

      const fullyCommitted = group.every((record) =>
        record.kind === 'tweet' ? committedTweets.has(record.id) : committedUsers.has(record.id),
      );
      if (!fullyCommitted) {
        break;
      }

      committedCursor = groupUpdatedAt;
    }

    return committedCursor;
  }

  private async loadManifestState(client: MinioClient, twitterUserId: string, module: string) {
    const indexKey = buildMinioManifestIndexKey(twitterUserId, module);
    const pendingKey = buildMinioPendingManifestKey(twitterUserId, module);
    const existingIndex = await client.getJson<MinioManifestIndex>(indexKey);

    if (existingIndex) {
      const pendingText = (await client.getText(existingIndex.pending.key)) ?? '';
      return {
        index: normalizeManifestIndex(existingIndex, twitterUserId, module),
        pendingRecords: parseManifest(pendingText),
      };
    }

    const legacyKey = buildMinioManifestLegacyKey(twitterUserId, module);
    const legacyText = (await client.getText(legacyKey)) ?? '';
    if (!legacyText.trim()) {
      return {
        index: createEmptyManifestIndex(twitterUserId, module, pendingKey),
        pendingRecords: [] as MinioManifestRecord[],
      };
    }

    logger.info(`MinIO manifest migration: module=${module}, source=legacy-jsonl`);
    const legacyRecords = parseManifest(legacyText);
    const publishedChunks: MinioManifestChunkRef[] = [];
    let chunkIndex = 0;
    while (legacyRecords.length >= MINIO_MANIFEST_CHUNK_SIZE) {
      chunkIndex += 1;
      const chunkId = padChunkId(chunkIndex);
      const chunkKey = buildMinioManifestChunkKey(twitterUserId, module, chunkId);
      const chunkRecords = legacyRecords.splice(0, MINIO_MANIFEST_CHUNK_SIZE);
      await client.putText(chunkKey, serializeManifest(chunkRecords), 'application/x-ndjson');
      publishedChunks.push({
        id: chunkId,
        key: chunkKey,
        record_count: chunkRecords.length,
      });
    }

    return {
      index: {
        version: 1,
        twitter_user_id: twitterUserId,
        module,
        published_chunks: publishedChunks,
        pending: {
          key: pendingKey,
          record_count: legacyRecords.length,
        },
        updated_at: new Date().toISOString(),
      },
      pendingRecords: legacyRecords,
    };
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

  private async upsertMinioSyncStateError(
    twitterUserId: string,
    config: MinioConfig,
    message: string,
  ) {
    try {
      const client = new MinioClient(config);
      const key = buildMinioStateKey(twitterUserId);
      const current = await client.getJson<MinioSyncState>(key);
      const now = new Date().toISOString();
      await client.putJson(key, {
        version: 1,
        twitter_user_id: twitterUserId,
        last_synced_at: current?.last_synced_at ?? 0,
        last_success_at: current?.last_success_at ?? null,
        last_error: message,
        updated_at: now,
      } satisfies MinioSyncState);
    } catch (error) {
      logger.warn('Failed to persist MinIO sync error state', error);
    }
  }
}

function parseManifest(text: string) {
  if (!text.trim()) {
    return [] as MinioManifestRecord[];
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MinioManifestRecord);
}

function serializeManifest(records: MinioManifestRecord[]) {
  if (records.length === 0) {
    return '';
  }

  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function createEmptyManifestIndex(
  twitterUserId: string,
  module: string,
  pendingKey: string,
): MinioManifestIndex {
  return {
    version: 1,
    twitter_user_id: twitterUserId,
    module,
    published_chunks: [],
    pending: {
      key: pendingKey,
      record_count: 0,
    },
    updated_at: '',
  };
}

function normalizeManifestIndex(
  index: MinioManifestIndex,
  twitterUserId: string,
  module: string,
): MinioManifestIndex {
  return {
    version: 1,
    twitter_user_id: index.twitter_user_id || twitterUserId,
    module: index.module || module,
    published_chunks: [...(index.published_chunks ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    pending: index.pending ?? {
      key: buildMinioPendingManifestKey(twitterUserId, module),
      record_count: 0,
    },
    updated_at: index.updated_at ?? '',
  };
}

function nextManifestChunkId(chunks: MinioManifestChunkRef[]) {
  const lastId = chunks[chunks.length - 1]?.id;
  const nextIndex = lastId ? Number.parseInt(lastId, 10) + 1 : 1;
  return padChunkId(nextIndex);
}

function padChunkId(value: number) {
  return String(value).padStart(6, '0');
}

function compareTweetByUpdatedAt(left: Tweet, right: Tweet) {
  return compareSourceRecord(
    {
      kind: 'tweet',
      id: left.rest_id,
      updatedAt: left.twe_private_fields.updated_at,
    },
    {
      kind: 'tweet',
      id: right.rest_id,
      updatedAt: right.twe_private_fields.updated_at,
    },
  );
}

function compareUserByUpdatedAt(left: User, right: User) {
  return compareSourceRecord(
    {
      kind: 'user',
      id: left.rest_id,
      updatedAt: left.twe_private_fields.updated_at,
    },
    {
      kind: 'user',
      id: right.rest_id,
      updatedAt: right.twe_private_fields.updated_at,
    },
  );
}

function compareSourceRecord(left: SourceSyncRecord, right: SourceSyncRecord) {
  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }

  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind);
  }

  return left.id.localeCompare(right.id);
}

function compareCapture(left: Capture, right: Capture) {
  if (left.data_key !== right.data_key) {
    return left.data_key.localeCompare(right.data_key);
  }

  if (left.created_at !== right.created_at) {
    return left.created_at - right.created_at;
  }

  return left.id.localeCompare(right.id);
}
