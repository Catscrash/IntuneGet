/**
 * Webhook egress guard
 *
 * Webhook destinations are supplied by users, so anything the server sends to
 * them has to be kept off the deployment's own network. A scheme check alone
 * does not do that: `https://127.0.0.1/...` passes it, and one redirect hop on
 * an attacker-controlled HTTPS host reaches any plain-HTTP internal address.
 *
 * Requests here therefore go to the address the hostname resolves to, only
 * when that address is public, with the hostname pinned for TLS and Host so a
 * second DNS answer cannot move the connection. Redirects are never followed -
 * a 3xx is reported as a failed delivery, not re-validated as a new hop.
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import * as https from 'node:https';
import { isPublicIpAddress } from '@/lib/installer-download';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;

export interface WebhookResponse {
  status: number;
  ok: boolean;
  body: string;
}

/**
 * URL.hostname keeps the brackets around an IPv6 literal, which isIP() and
 * the DNS resolver both reject, so strip them before either sees the host.
 */
function hostnameAddress(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

export interface WebhookRequestOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A webhook destination that must not be requested at all
 */
export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookTargetError';
  }
}

/**
 * Parse a webhook destination and reject shapes that are never legitimate
 */
export function parseWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookTargetError('Invalid URL format');
  }

  if (url.protocol !== 'https:') {
    throw new WebhookTargetError('URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new WebhookTargetError('URL must not contain credentials');
  }
  if (url.port && url.port !== '443') {
    throw new WebhookTargetError('URL must not use a custom port');
  }
  if (!url.hostname) {
    throw new WebhookTargetError('Invalid URL format');
  }
  const host = hostnameAddress(url.hostname);
  if (isIP(host) && !isPublicIpAddress(host)) {
    throw new WebhookTargetError('URL must not target a private or reserved address');
  }

  return url;
}

/**
 * Resolve a webhook hostname, rejecting anything that points inside the network
 */
async function resolvePublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostnameAddress(url.hostname);
  const literalFamily = isIP(host);
  if (literalFamily) {
    // parseWebhookUrl() already rejected private literals
    return { address: host, family: literalFamily as 4 | 6 };
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new WebhookTargetError('URL hostname did not resolve');
  }

  if (addresses.length === 0) {
    throw new WebhookTargetError('URL hostname did not resolve');
  }
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new WebhookTargetError('URL hostname resolves to a private or reserved address');
  }

  return addresses[0] as { address: string; family: 4 | 6 };
}

/**
 * Validate a webhook destination, including where its hostname resolves to.
 *
 * Use this wherever a user-supplied webhook URL is accepted for storage, so a
 * rejected destination is reported as a validation error instead of failing
 * later on every delivery attempt.
 */
export async function validateWebhookTarget(
  url: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    await resolvePublicAddress(parseWebhookUrl(url));
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof WebhookTargetError ? error.message : 'Invalid webhook URL',
    };
  }
}

/**
 * POST a webhook payload to a validated public destination
 *
 * Throws WebhookTargetError when the destination is not allowed; callers
 * report that as a delivery failure without retrying, since re-resolving the
 * same hostname will not make it public.
 */
export async function postWebhook(
  rawUrl: string,
  { headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal }: WebhookRequestOptions
): Promise<WebhookResponse> {
  const url = parseWebhookUrl(rawUrl);
  const resolved = await resolvePublicAddress(url);
  const host = hostnameAddress(url.hostname);

  return new Promise<WebhookResponse>((resolve, reject) => {
    const request = https.request(
      {
        hostname: resolved.address,
        family: resolved.family,
        // Pin the certificate to the name the user configured, except for an
        // address literal, which has no name to present
        servername: isIP(host) ? undefined : host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...headers,
          Host: url.host,
          'Content-Length': Buffer.byteLength(body).toString(),
        },
        timeout: timeoutMs,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let received = '';

        response.on('data', (chunk: Buffer) => {
          if (received.length < MAX_RESPONSE_BYTES) {
            received += chunk.toString('utf8');
          }
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body: received.slice(0, MAX_RESPONSE_BYTES),
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Request timed out'));
    });
    request.on('error', reject);
    request.end(body);
  });
}
