// Talking to a relay's HTTP API from this workstation: health, status, pairing.

import http from 'node:http';
import https from 'node:https';
import type { Config } from './config.js';
import { resolveAdminOrigin } from './relay-urls.js';
import { ensureRuntime } from './runtime.js';

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  body?: string;
}

/** An HTTP error answer, with its status and parsed body. */
type RequestError = Error & { statusCode?: number; body?: Record<string, unknown> };

/**
 * Minimal JSON client. Picks http or https from the URL: a self-hosted relay is
 * reached over https, while the local relay is plain http on loopback.
 */
export function requestJson<T = Record<string, unknown>>(
  urlString: string,
  options: RequestOptions = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 1500,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(text);
          } catch {
            body = { raw: text };
          }
          const status = response.statusCode || 0;
          if (status >= 400) {
            const error: RequestError = new Error(
              typeof body.message === 'string' ? body.message : `HTTP ${status}`,
            );
            error.statusCode = status;
            error.body = body;
            reject(error);
          } else resolve(body as T);
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export function healthUrl(config: Config): string {
  return `${resolveAdminOrigin(config)}/healthz`;
}

/** This workstation's own credentials, which scope a relay's answers to it. */
export function hostHeaders(): Record<string, string> {
  const state = ensureRuntime();
  return { 'X-Herdr-Host-Id': state.hostId, 'X-Herdr-Host-Token': state.hostToken };
}

export async function waitForRelay(
  config: Config,
  { attempts = 20, delayMs = 100 } = {},
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestJson(healthUrl(config), { timeout: 800 });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError || new Error('relay did not become ready');
}

interface HostStatus {
  ok?: boolean;
  message?: string;
  hosts?: { id: string }[];
}

export async function waitForHost(
  config: Config,
  { attempts = 30, delayMs = 100 } = {},
): Promise<HostStatus> {
  const headers = hostHeaders();
  const hostId = headers['X-Herdr-Host-Id'];
  const statusEndpoint = `${resolveAdminOrigin(config)}/api/status`;
  let lastStatus: HostStatus | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastStatus = await requestJson<HostStatus>(statusEndpoint, {
        timeout: 800,
        headers,
      });
      if (lastStatus.hosts?.some((host) => host.id === hostId)) return lastStatus;
    } catch (error) {
      lastStatus = { ok: false, message: (error as Error).message };
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const error = new Error(
    lastStatus?.message || 'the Herdr host connector did not register with the relay',
  ) as Error & { health?: HostStatus | null };
  error.health = lastStatus;
  throw error;
}

export function extractPairingCode(response: unknown): string {
  const answer = response as { code?: unknown; pairCode?: unknown } | null;
  const code = answer?.code || answer?.pairCode;
  if (typeof code !== 'string' || code.length === 0) {
    throw new Error('the relay response did not contain a valid pairing code');
  }
  return code;
}
