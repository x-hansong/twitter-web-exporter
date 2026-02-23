/**
 * Integration test for Supabase incremental batch sync.
 *
 * Prerequisites:
 *   - Tables `sync_states`, `synced_tweets`, `synced_users`, `synced_captures`
 *     must exist in the target Supabase project (see plan for DDL).
 *   - Environment variables: SUPABASE_URL, SUPABASE_API_KEY (anon key).
 *
 * Usage:
 *   node scripts/test-supabase-sync.mjs
 */

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_API_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// Test-specific twitter_user_id to isolate from real data.
const TEST_USER_ID = '__test_sync_' + Date.now();
const BATCH_SIZE = 500;

let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  } else {
    passed++;
    console.log(`  ✓ ${message}`);
  }
}

function makeTweetPayload(restId, ts) {
  return {
    __typename: 'Tweet',
    rest_id: restId,
    core: { user_results: { result: { rest_id: 'u1', core: { screen_name: 'test' } } } },
    views: { count: '0', state: 'Enabled' },
    source: 'test',
    edit_control: {
      edit_tweet_ids: [],
      editable_until_msecs: '0',
      is_edit_eligible: false,
      edits_remaining: '0',
    },
    is_translatable: false,
    legacy: {
      bookmark_count: 0,
      bookmarked: false,
      created_at: 'Mon Jan 01 00:00:00 +0000 2024',
      conversation_id_str: restId,
      display_text_range: [0, 5],
      entities: { user_mentions: [], urls: [], hashtags: [], symbols: [], timestamps: [] },
      favorite_count: 0,
      favorited: false,
      full_text: 'test tweet',
      is_quote_status: false,
      lang: 'en',
      possibly_sensitive: false,
      possibly_sensitive_editable: false,
      quote_count: 0,
      reply_count: 0,
      retweet_count: 0,
      retweeted: false,
      user_id_str: 'u1',
      id_str: restId,
    },
    twe_private_fields: { created_at: ts, updated_at: ts, media_count: 0 },
  };
}

function makeUserPayload(restId, ts) {
  return {
    __typename: 'User',
    rest_id: restId,
    affiliates_highlighted_label: null,
    has_graduated_access: false,
    is_blue_verified: false,
    profile_image_shape: 'Circle',
    legacy: {
      default_profile: true,
      default_profile_image: false,
      description: 'test',
      entities: { description: { urls: [] } },
      fast_followers_count: 0,
      favourites_count: 0,
      followers_count: 0,
      friends_count: 0,
      has_custom_timelines: false,
      is_translator: false,
      listed_count: 0,
      media_count: 0,
      normal_followers_count: 0,
      pinned_tweet_ids_str: [],
      possibly_sensitive: false,
      profile_interstitial_type: '',
      statuses_count: 0,
      translator_type: 'none',
      want_retweets: false,
      withheld_in_countries: [],
    },
    avatar: { image_url: '' },
    core: { name: 'Test User', screen_name: 'testuser' },
    dm_permissions: { can_dm: false },
    location: { location: '' },
    media_permissions: { can_media_tag: false },
    privacy: {},
    verification: { verified: false },
    relationship_perspectives: { following: false },
    twe_private_fields: { created_at: ts, updated_at: ts },
  };
}

function makeCapturePayload(id, dataKey) {
  return {
    id,
    extension: 'test-ext',
    type: 'tweet',
    data_key: dataKey,
    created_at: Date.now(),
    sort_index: '0',
  };
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log('\n🧹 Cleaning up test data...');
  await supabase.from('synced_tweets').delete().eq('twitter_user_id', TEST_USER_ID);
  await supabase.from('synced_users').delete().eq('twitter_user_id', TEST_USER_ID);
  await supabase.from('synced_captures').delete().eq('twitter_user_id', TEST_USER_ID);
  await supabase.from('sync_states').delete().eq('twitter_user_id', TEST_USER_ID);
  // Also clean the isolation test user.
  await supabase
    .from('synced_tweets')
    .delete()
    .eq('twitter_user_id', TEST_USER_ID + '_other');
  await supabase
    .from('sync_states')
    .delete()
    .eq('twitter_user_id', TEST_USER_ID + '_other');
  console.log('  Done.');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testConnection() {
  console.log('\n── Test: Supabase connection ──');
  const { data, error } = await supabase.from('sync_states').select('twitter_user_id').limit(1);
  assert(!error, `Connection OK (no error): ${error?.message ?? 'ok'}`);
  assert(Array.isArray(data), 'Returned data is an array');
}

async function testSyncStateUpsert() {
  console.log('\n── Test: sync_states upsert ──');
  const now = new Date().toISOString();

  // Insert
  const { error: e1 } = await supabase.from('sync_states').upsert(
    {
      twitter_user_id: TEST_USER_ID,
      last_synced_at: 1000,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: 'twitter_user_id' },
  );
  assert(!e1, `Insert sync_state: ${e1?.message ?? 'ok'}`);

  // Read back
  const { data: rows, error: e2 } = await supabase
    .from('sync_states')
    .select('*')
    .eq('twitter_user_id', TEST_USER_ID)
    .limit(1);
  assert(!e2, `Read sync_state: ${e2?.message ?? 'ok'}`);
  assert(rows?.length === 1, 'Exactly one row');
  assert(rows?.[0]?.last_synced_at === 1000, 'last_synced_at = 1000');

  // Update (cursor advance)
  const { error: e3 } = await supabase.from('sync_states').upsert(
    {
      twitter_user_id: TEST_USER_ID,
      last_synced_at: 2000,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: 'twitter_user_id' },
  );
  assert(!e3, `Update sync_state: ${e3?.message ?? 'ok'}`);
  const { data: rows2 } = await supabase
    .from('sync_states')
    .select('last_synced_at')
    .eq('twitter_user_id', TEST_USER_ID)
    .limit(1);
  assert(rows2?.[0]?.last_synced_at === 2000, 'Cursor advanced to 2000');
}

async function testTweetUpsert() {
  console.log('\n── Test: synced_tweets upsert ──');
  const ts = Date.now();
  const tweet = makeTweetPayload('t_001', ts);

  const row = {
    twitter_user_id: TEST_USER_ID,
    rest_id: tweet.rest_id,
    source_updated_at: ts,
    payload: tweet,
    synced_at: new Date().toISOString(),
  };

  // First insert
  const { error: e1 } = await supabase
    .from('synced_tweets')
    .upsert([row], { onConflict: 'twitter_user_id,rest_id' });
  assert(!e1, `Insert tweet: ${e1?.message ?? 'ok'}`);

  // Verify
  const { data, error: e2 } = await supabase
    .from('synced_tweets')
    .select('rest_id, source_updated_at')
    .eq('twitter_user_id', TEST_USER_ID)
    .eq('rest_id', 't_001');
  assert(!e2 && data?.length === 1, 'One tweet row exists');

  // Upsert same tweet (idempotency)
  const { error: e3 } = await supabase
    .from('synced_tweets')
    .upsert([{ ...row, source_updated_at: ts + 100 }], { onConflict: 'twitter_user_id,rest_id' });
  assert(!e3, `Upsert same tweet: ${e3?.message ?? 'ok'}`);
  const { data: data2 } = await supabase
    .from('synced_tweets')
    .select('rest_id')
    .eq('twitter_user_id', TEST_USER_ID)
    .eq('rest_id', 't_001');
  assert(data2?.length === 1, 'Still exactly one row after upsert (idempotent)');
}

async function testUserUpsert() {
  console.log('\n── Test: synced_users upsert ──');
  const ts = Date.now();
  const user = makeUserPayload('u_001', ts);

  const row = {
    twitter_user_id: TEST_USER_ID,
    rest_id: user.rest_id,
    source_updated_at: ts,
    payload: user,
    synced_at: new Date().toISOString(),
  };

  const { error: e1 } = await supabase
    .from('synced_users')
    .upsert([row], { onConflict: 'twitter_user_id,rest_id' });
  assert(!e1, `Insert user: ${e1?.message ?? 'ok'}`);

  const { data } = await supabase
    .from('synced_users')
    .select('rest_id')
    .eq('twitter_user_id', TEST_USER_ID)
    .eq('rest_id', 'u_001');
  assert(data?.length === 1, 'One user row exists');

  // Idempotency
  const { error: e2 } = await supabase
    .from('synced_users')
    .upsert([row], { onConflict: 'twitter_user_id,rest_id' });
  assert(!e2, 'Upsert same user is idempotent');
}

async function testCaptureUpsert() {
  console.log('\n── Test: synced_captures upsert ──');
  const cap = makeCapturePayload('cap_001', 't_001');

  const row = {
    twitter_user_id: TEST_USER_ID,
    capture_id: cap.id,
    extension: cap.extension,
    capture_type: cap.type,
    data_key: cap.data_key,
    created_at: cap.created_at,
    sort_index: cap.sort_index,
    payload: cap,
    synced_at: new Date().toISOString(),
  };

  const { error: e1 } = await supabase
    .from('synced_captures')
    .upsert([row], { onConflict: 'twitter_user_id,capture_id' });
  assert(!e1, `Insert capture: ${e1?.message ?? 'ok'}`);

  const { data } = await supabase
    .from('synced_captures')
    .select('capture_id')
    .eq('twitter_user_id', TEST_USER_ID)
    .eq('capture_id', 'cap_001');
  assert(data?.length === 1, 'One capture row exists');

  // Idempotency
  const { error: e2 } = await supabase
    .from('synced_captures')
    .upsert([row], { onConflict: 'twitter_user_id,capture_id' });
  assert(!e2, 'Upsert same capture is idempotent');
}

async function testBatchUpsert() {
  console.log('\n── Test: batch upsert (chunking) ──');
  const ts = Date.now();
  const count = 1200; // > 2 batches of 500
  const tweets = Array.from({ length: count }, (_, i) =>
    makeTweetPayload(`batch_${String(i).padStart(5, '0')}`, ts + i),
  );

  const rows = tweets.map((t) => ({
    twitter_user_id: TEST_USER_ID,
    rest_id: t.rest_id,
    source_updated_at: t.twe_private_fields.updated_at,
    payload: t,
    synced_at: new Date().toISOString(),
  }));

  const chunks = chunkArray(rows, BATCH_SIZE);
  assert(chunks.length === 3, `Split into 3 chunks (got ${chunks.length})`);

  for (const chunk of chunks) {
    const { error } = await supabase
      .from('synced_tweets')
      .upsert(chunk, { onConflict: 'twitter_user_id,rest_id' });
    assert(!error, `Batch chunk ok: ${error?.message ?? 'ok'}`);
  }

  // Count
  const { count: total, error: ce } = await supabase
    .from('synced_tweets')
    .select('*', { count: 'exact', head: true })
    .eq('twitter_user_id', TEST_USER_ID)
    .like('rest_id', 'batch_%');
  assert(!ce, `Count query ok: ${ce?.message ?? 'ok'}`);
  assert(total === count, `Total rows = ${count} (got ${total})`);
}

async function testAccountIsolation() {
  console.log('\n── Test: account isolation ──');
  const otherUser = TEST_USER_ID + '_other';
  const ts = Date.now();

  // Write with different twitter_user_id
  const { error: e1 } = await supabase.from('synced_tweets').upsert(
    [
      {
        twitter_user_id: otherUser,
        rest_id: 't_001',
        source_updated_at: ts,
        payload: makeTweetPayload('t_001', ts),
        synced_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'twitter_user_id,rest_id' },
  );
  assert(!e1, `Insert for other user: ${e1?.message ?? 'ok'}`);

  // Verify TEST_USER_ID's t_001 still exists separately
  const { data: mainRows } = await supabase
    .from('synced_tweets')
    .select('twitter_user_id')
    .eq('twitter_user_id', TEST_USER_ID)
    .eq('rest_id', 't_001');
  const { data: otherRows } = await supabase
    .from('synced_tweets')
    .select('twitter_user_id')
    .eq('twitter_user_id', otherUser)
    .eq('rest_id', 't_001');
  assert(mainRows?.length === 1, 'Main user has own t_001');
  assert(otherRows?.length === 1, 'Other user has own t_001');
}

async function testCursorFlow() {
  console.log('\n── Test: cursor / incremental flow ──');
  const now = new Date().toISOString();

  // Reset cursor to 0
  await supabase.from('sync_states').upsert(
    {
      twitter_user_id: TEST_USER_ID,
      last_synced_at: 0,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: 'twitter_user_id' },
  );

  // Read cursor
  const { data: s1 } = await supabase
    .from('sync_states')
    .select('last_synced_at')
    .eq('twitter_user_id', TEST_USER_ID)
    .limit(1);
  assert(s1?.[0]?.last_synced_at === 0, 'Cursor starts at 0');

  // Simulate sync round: advance cursor
  const maxUpdatedAt = 5000;
  const { error } = await supabase.from('sync_states').upsert(
    {
      twitter_user_id: TEST_USER_ID,
      last_synced_at: maxUpdatedAt,
      last_success_at: now,
      last_error: null,
      updated_at: now,
    },
    { onConflict: 'twitter_user_id' },
  );
  assert(!error, 'Cursor advanced without error');

  const { data: s2 } = await supabase
    .from('sync_states')
    .select('last_synced_at')
    .eq('twitter_user_id', TEST_USER_ID)
    .limit(1);
  assert(s2?.[0]?.last_synced_at === maxUpdatedAt, `Cursor = ${maxUpdatedAt}`);
}

async function testSyncStateError() {
  console.log('\n── Test: sync_state error recording ──');
  const now = new Date().toISOString();
  const errMsg = 'network timeout';

  const { error } = await supabase
    .from('sync_states')
    .upsert(
      { twitter_user_id: TEST_USER_ID, last_error: errMsg, updated_at: now },
      { onConflict: 'twitter_user_id' },
    );
  assert(!error, `Record error: ${error?.message ?? 'ok'}`);

  const { data } = await supabase
    .from('sync_states')
    .select('last_error, last_synced_at')
    .eq('twitter_user_id', TEST_USER_ID)
    .limit(1);
  assert(data?.[0]?.last_error === errMsg, 'Error message persisted');
  // Cursor should NOT have changed
  assert(data?.[0]?.last_synced_at === 5000, 'Cursor unchanged after error');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Supabase Sync Integration Tests ===');
  console.log(`URL: ${SUPABASE_URL}`);
  console.log(`Test user: ${TEST_USER_ID}\n`);

  try {
    await testConnection();
    await testSyncStateUpsert();
    await testTweetUpsert();
    await testUserUpsert();
    await testCaptureUpsert();
    await testBatchUpsert();
    await testAccountIsolation();
    await testCursorFlow();
    await testSyncStateError();
  } finally {
    await cleanup();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
