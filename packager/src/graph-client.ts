/**
 * Microsoft Graph API Client
 * Handles authentication and API requests to Microsoft Graph
 */

import { ConfidentialClientApplication } from '@azure/msal-node';
import { ManagedIdentityCredential, type TokenCredential } from '@azure/identity';
import { PackagerConfig } from './config.js';
import { ProxyMsalNetwork } from './proxy-msal.js';
import { createLogger, Logger } from './logger.js';

const GRAPH_ENDPOINT = 'https://graph.microsoft.com/beta';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// Intune answers bursts, such as an "update all" run, with 429 and 503
// ServerBusy. Those requests were refused, not processed, so they are retried.
const GRAPH_ATTEMPTS = 5;
const GRAPH_RETRY_BASE_MS = 2000;
const GRAPH_RETRY_MAX_MS = 60000;

// A POST that failed with a gateway error or a dropped connection may still
// have created the object, and a retry would create it twice. POST therefore
// retries only the statuses that say the request was turned away.
const RETRYABLE_POST_STATUSES = new Set([429, 503]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

type GraphMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Delay before the next attempt: Retry-After when Graph sends one, else exponential. */
export function graphRetryDelayMs(attempt: number, retryAfter: string | null | undefined, now = Date.now()): number {
  const value = retryAfter?.trim();
  if (value) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, GRAPH_RETRY_MAX_MS);
  }
  return Math.min(GRAPH_RETRY_BASE_MS * 2 ** (attempt - 1), GRAPH_RETRY_MAX_MS);
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class GraphClient {
  private config: PackagerConfig;
  private tenantId: string;
  // Exactly one of these is set, depending on the auth mode.
  private msalClient: ConfidentialClientApplication | null = null;
  private managedIdentity: TokenCredential | null = null;
  private tokenCache: TokenCache | null = null;
  private logger: Logger;

  constructor(config: PackagerConfig, tenantId: string) {
    this.config = config;
    this.tenantId = tenantId;
    this.logger = createLogger('GraphClient');

    if (config.azure.useManagedIdentity) {
      // Managed identity: authenticate AS the identity via @azure/identity - no
      // secret, nothing stored. The identity must hold the Graph app roles.
      this.managedIdentity = config.azure.managedIdentityClientId
        ? new ManagedIdentityCredential({ clientId: config.azure.managedIdentityClientId })
        : new ManagedIdentityCredential();
    } else {
      this.msalClient = new ConfidentialClientApplication({
        ...(config.proxy?.agentFor(new URL(`https://login.microsoftonline.com/${tenantId}`))
          ? { system: { networkClient: new ProxyMsalNetwork(config.proxy) } } : {}),
        auth: {
          clientId: config.azure.clientId,
          clientSecret: config.azure.clientSecret,
          authority: `https://login.microsoftonline.com/${tenantId}`,
        },
      });
    }
  }

  /**
   * Get access token (with caching)
   */
  private async getAccessToken(): Promise<string> {
    // Check cache
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
      return this.tokenCache.token;
    }

    try {
      let token: string;
      let expiresAt: number;

      if (this.managedIdentity) {
        const result = await this.managedIdentity.getToken(GRAPH_SCOPE);
        if (!result?.token) {
          throw new Error('Failed to acquire access token from managed identity');
        }
        token = result.token;
        expiresAt = result.expiresOnTimestamp || Date.now() + 3600000;
      } else {
        const result = await this.msalClient!.acquireTokenByClientCredential({
          scopes: [GRAPH_SCOPE],
        });
        if (!result || !result.accessToken) {
          throw new Error('Failed to acquire access token');
        }
        token = result.accessToken;
        expiresAt = result.expiresOn ? result.expiresOn.getTime() : Date.now() + 3600000;
      }

      this.tokenCache = { token, expiresAt };
      this.logger.debug('Acquired new access token', { tenantId: this.tenantId });
      return token;
    } catch (error) {
      this.logger.error('Failed to acquire access token', {
        tenantId: this.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Send a Graph request, retrying throttled and transiently failed ones.
   * Returns the response body as text; an error carries the last body.
   */
  private async request(method: GraphMethod, path: string, body?: unknown): Promise<string> {
    const url = `${GRAPH_ENDPOINT}${path}`;
    const fetch = this.config.proxy?.fetch.bind(this.config.proxy) ?? (await import('node-fetch')).default;
    const retryable = method === 'POST' ? RETRYABLE_POST_STATUSES : RETRYABLE_STATUSES;

    for (let attempt = 1; ; attempt++) {
      const token = await this.getAccessToken();
      let response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (method === 'POST' || attempt >= GRAPH_ATTEMPTS) throw error;
        const delayMs = graphRetryDelayMs(attempt, null);
        this.logger.warn(`Retrying Graph API ${method} after a network error`, {
          path, attempt, delayMs, error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(delayMs);
        continue;
      }

      if (response.ok) {
        return await response.text();
      }

      const errorBody = await response.text();
      if (retryable.has(response.status) && attempt < GRAPH_ATTEMPTS) {
        const delayMs = graphRetryDelayMs(attempt, response.headers?.get('retry-after'));
        this.logger.warn(`Retrying Graph API ${method}`, { path, status: response.status, attempt, delayMs });
        await this.sleep(delayMs);
        continue;
      }

      this.logger.error(`Graph API ${method} failed`, {
        path,
        status: response.status,
        error: errorBody,
      });
      throw new Error(`Graph API ${method} failed: ${response.status} - ${errorBody}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Make a GET request to Graph API
   */
  async get<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await this.request('GET', path)) as T;
  }

  /**
   * Make a POST request to Graph API
   */
  async post<T = unknown>(path: string, body: unknown): Promise<T> {
    // Handle empty responses
    const text = await this.request('POST', path, body);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Make a PATCH request to Graph API
   */
  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    // Handle empty responses
    const text = await this.request('PATCH', path, body);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Make a DELETE request to Graph API
   */
  async delete(path: string): Promise<void> {
    await this.request('DELETE', path);
  }
}
