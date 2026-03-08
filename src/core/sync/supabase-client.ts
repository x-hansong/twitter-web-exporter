import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GM_xmlhttpRequest } from '$';
import logger from '@/utils/logger';

let cachedClient: SupabaseClient | null = null;
let cachedKey = '';

export function getSupabaseClient(url: string, anonKey: string, lzcApiAuthToken = '') {
  const cacheKey = `${url}|${anonKey}|${lzcApiAuthToken}`;
  if (cachedClient && cachedKey === cacheKey) {
    return cachedClient;
  }

  cachedClient = createClient(url, anonKey, {
    global: {
      fetch: (input, init) => monkeyFetch(input, init, lzcApiAuthToken),
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

async function monkeyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  lzcApiAuthToken = '',
): Promise<Response> {
  if (typeof GM_xmlhttpRequest !== 'function') {
    return fetch(input, init);
  }

  const request = new Request(input, init);
  const headerObj: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headerObj[key] = value;
  });
  if (lzcApiAuthToken) {
    headerObj['Lzc-Api-Auth-Token'] = lzcApiAuthToken;
  }
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
        const headers = parseHeaders(resp.responseHeaders || '');
        const bodyText = resp.responseText ?? '';
        const finalUrl = resp.finalUrl || request.url;

        if (looksLikeHtmlErrorResponse(request.url, finalUrl, headers, bodyText)) {
          reject(
            new TypeError(
              `Supabase request returned HTML instead of JSON. Check supabaseUrl or reverse proxy auth. request=${request.url} final=${finalUrl} status=${resp.status}`,
            ),
          );
          return;
        }

        resolve(
          new Response(bodyText, {
            status: resp.status,
            statusText: resp.statusText,
            headers,
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

function looksLikeHtmlErrorResponse(
  requestUrl: string,
  finalUrl: string,
  headers: Headers,
  bodyText: string,
) {
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  const trimmedBody = bodyText.trimStart().toLowerCase();
  const isHtml =
    contentType.includes('text/html') ||
    trimmedBody.startsWith('<!doctype html') ||
    trimmedBody.startsWith('<html');

  if (!isHtml) {
    return false;
  }

  // Supabase REST/Auth responses should be JSON in this client. HTML almost
  // always means a proxy/login page intercepted the request.
  return (
    requestUrl !== finalUrl || requestUrl.includes('/rest/v1/') || requestUrl.includes('/auth/v1/')
  );
}
