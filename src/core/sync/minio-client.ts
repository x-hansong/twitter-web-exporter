import { GM_xmlhttpRequest } from '$';
import { AwsClient } from 'aws4fetch';

interface MinioClientOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

interface MinioResponse {
  status: number;
  statusText: string;
  text: string;
}

interface MinioFailureResponse {
  status?: number;
  statusText?: string;
  responseText?: string;
  error?: string;
  finalUrl?: string;
}

export class MinioClient {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly signer: AwsClient;

  constructor(options: MinioClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/g, '');
    this.bucket = options.bucket.trim();
    this.signer = new AwsClient({
      accessKeyId: options.accessKeyId.trim(),
      secretAccessKey: options.secretAccessKey.trim(),
      region: options.region.trim() || 'us-east-1',
      service: 's3',
    });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const response = await this.request(key, 'GET');
    if (response.status === 404) {
      return null;
    }
    this.ensureSuccess(response, key);
    return JSON.parse(response.text) as T;
  }

  async getText(key: string): Promise<string | null> {
    const response = await this.request(key, 'GET');
    if (response.status === 404) {
      return null;
    }
    this.ensureSuccess(response, key);
    return response.text;
  }

  async putJson(key: string, data: unknown) {
    await this.putText(key, JSON.stringify(data, null, 2), 'application/json');
  }

  async putText(key: string, text: string, contentType: string) {
    const response = await this.request(key, 'PUT', text, { 'Content-Type': contentType });
    this.ensureSuccess(response, key);
  }

  private async request(
    key: string,
    method: 'GET' | 'PUT',
    body?: string,
    headers?: Record<string, string>,
  ) {
    const signedRequest = await this.signer.sign(this.buildUrl(key), {
      method,
      headers,
      body,
    });

    if (typeof GM_xmlhttpRequest !== 'function') {
      const response = await fetch(signedRequest);
      return {
        status: response.status,
        statusText: response.statusText,
        text: await response.text(),
      } satisfies MinioResponse;
    }

    const requestHeaders: Record<string, string> = {};
    signedRequest.headers.forEach((value, header) => {
      requestHeaders[header] = value;
    });

    return new Promise<MinioResponse>((resolve, reject) => {
      const request = GM_xmlhttpRequest as unknown as (details: {
        method: string;
        url: string;
        headers: Record<string, string>;
        data?: string;
        responseType: 'text';
        onload: (resp: MinioFailureResponse & { status: number; statusText: string }) => void;
        onerror?: (resp?: MinioFailureResponse) => void;
        ontimeout?: (resp?: MinioFailureResponse) => void;
        onabort?: (resp?: MinioFailureResponse) => void;
      }) => void;

      request({
        method,
        url: signedRequest.url,
        headers: requestHeaders,
        data: body,
        responseType: 'text',
        onload: (resp) =>
          resolve({
            status: resp.status,
            statusText: resp.statusText,
            text: resp.responseText ?? '',
          }),
        onerror: (resp) => reject(this.buildRequestError(key, 'failed', resp)),
        ontimeout: (resp) => reject(this.buildRequestError(key, 'timed out', resp)),
        onabort: (resp) => reject(this.buildRequestError(key, 'aborted', resp)),
      });
    });
  }

  private ensureSuccess(response: MinioResponse, key: string) {
    if (response.status >= 200 && response.status < 300) {
      return;
    }

    throw new Error(
      `MinIO request failed for ${key}: ${response.status} ${response.statusText} ${response.text}`,
    );
  }

  private buildUrl(key: string) {
    return `${this.endpoint}/${this.bucket}/${key.replace(/^\/+/g, '')}`;
  }

  private buildRequestError(
    key: string,
    reason: 'failed' | 'timed out' | 'aborted',
    response?: MinioFailureResponse,
  ) {
    const details = [
      typeof response?.status === 'number' ? `status=${response.status}` : null,
      response?.statusText ? `statusText=${response.statusText}` : null,
      response?.error ? `error=${response.error}` : null,
      response?.finalUrl ? `url=${response.finalUrl}` : null,
      response?.responseText ? `response=${response.responseText}` : null,
    ].filter(Boolean);

    const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
    return new Error(`MinIO request ${reason} for ${key}${suffix}`);
  }
}
