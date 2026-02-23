import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GM_xmlhttpRequest } from '$';
import logger from '@/utils/logger';

let cachedClient: SupabaseClient | null = null;
let cachedKey = '';

export function getSupabaseClient(url: string, anonKey: string) {
  const cacheKey = `${url}|${anonKey}`;
  if (cachedClient && cachedKey === cacheKey) {
    return cachedClient;
  }

  cachedClient = createClient(url, anonKey, {
    global: {
      fetch: monkeyFetch,
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  cachedKey = cacheKey;
  logger.info('Supabase client initialized');
  return cachedClient;
}

async function monkeyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (typeof GM_xmlhttpRequest !== 'function') {
    return fetch(input, init);
  }

  const request = new Request(input, init);
  const headerObj: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headerObj[key] = value;
  });
  const bodyText =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();

  return new Promise<Response>((resolve, reject) => {
    GM_xmlhttpRequest({
      method: request.method,
      url: request.url,
      headers: headerObj,
      data: bodyText,
      responseType: 'text',
      onload: (resp) => {
        resolve(
          new Response(resp.responseText ?? '', {
            status: resp.status,
            statusText: resp.statusText,
            headers: parseHeaders(resp.responseHeaders || ''),
          }),
        );
      },
      onerror: () => reject(new TypeError('GM_xmlhttpRequest failed')),
      ontimeout: () => reject(new TypeError('GM_xmlhttpRequest timed out')),
    });
  });
}

function parseHeaders(rawHeaders: string) {
  const headers = new Headers();
  for (const line of rawHeaders.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) {
      headers.append(key, value);
    }
  }
  return headers;
}
