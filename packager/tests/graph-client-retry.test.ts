import { describe, expect, it, vi } from 'vitest';
import { GraphClient, graphRetryDelayMs } from '../src/graph-client';
import type { PackagerConfig } from '../src/config';

type FetchMock = ReturnType<typeof vi.fn>;

function makeConfig(fetch: FetchMock): PackagerConfig {
  return {
    packagerId: 'packager-1',
    mode: 'api',
    supabase: { url: '', serviceRoleKey: '' },
    api: { url: 'https://intuneget.example.com', key: 'api-key' },
    azure: { clientId: 'client-1', clientSecret: 'secret', useManagedIdentity: false },
    polling: { interval: 5000, staleJobTimeout: 300000 },
    paths: { work: '/tmp/work', tools: '/tmp/tools' },
    proxy: { fetch, agentFor: () => undefined } as unknown as PackagerConfig['proxy'],
  };
}

function reply(status: number, body = '', headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const SERVER_BUSY = reply(503, '{"error":{"code":"ServerBusy","message":"An error has occurred"}}');

interface TestableClient {
  getAccessToken: () => Promise<string>;
  sleep: ReturnType<typeof vi.fn>;
}

function client(fetch: FetchMock) {
  const graph = new GraphClient(makeConfig(fetch), 'tenant-1');
  const testable = graph as unknown as TestableClient;
  testable.getAccessToken = async () => 'token';
  testable.sleep = vi.fn(async () => undefined);
  return { graph, sleep: testable.sleep };
}

describe('GraphClient retries', () => {
  it('retries a POST that Intune answered with 503 ServerBusy', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(SERVER_BUSY)
      .mockResolvedValueOnce(reply(201, '{"id":"app-1"}'));
    const { graph, sleep } = client(fetch);

    await expect(graph.post('/deviceAppManagement/mobileApps', { displayName: 'App' }))
      .resolves.toEqual({ id: 'app-1' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"displayName":"App"}' });
  });

  it('waits as long as Retry-After asks', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(429, '', { 'retry-after': '7' }))
      .mockResolvedValueOnce(reply(200, '{"value":[]}'));
    const { graph, sleep } = client(fetch);

    await graph.get('/deviceAppManagement/mobileApps');
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('does not retry a POST after a gateway error, which may have created the object', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(502, 'Bad Gateway'));
    const { graph } = client(fetch);

    await expect(graph.post('/deviceAppManagement/mobileApps', {}))
      .rejects.toThrow('Graph API POST failed: 502 - Bad Gateway');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a POST whose connection dropped', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const { graph } = client(fetch);

    await expect(graph.post('/deviceAppManagement/mobileApps', {})).rejects.toThrow('socket hang up');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries reads and updates after gateway errors and dropped connections', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(504))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(reply(204));
    const { graph } = client(fetch);

    await expect(graph.patch('/deviceAppManagement/mobileApps/app-1', { notes: 'x' })).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after five attempts with the last error body', async () => {
    const fetch = vi.fn().mockResolvedValue(SERVER_BUSY);
    const { graph } = client(fetch);

    await expect(graph.post('/deviceAppManagement/mobileApps', {}))
      .rejects.toThrow('Graph API POST failed: 503 - {"error":{"code":"ServerBusy"');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not retry a request Graph rejected as invalid', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(400, '{"error":{"code":"BadRequest"}}'));
    const { graph } = client(fetch);

    await expect(graph.get('/deviceAppManagement/mobileApps/x')).rejects.toThrow('Graph API GET failed: 400');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('graphRetryDelayMs', () => {
  it('backs off exponentially without Retry-After', () => {
    expect([1, 2, 3, 4].map((attempt) => graphRetryDelayMs(attempt, null))).toEqual([2000, 4000, 8000, 16000]);
  });

  it('accepts Retry-After in seconds or as a date, capped at a minute', () => {
    const now = Date.parse('2026-11-02T06:40:49Z');
    expect(graphRetryDelayMs(1, '3', now)).toBe(3000);
    expect(graphRetryDelayMs(1, 'Mon, 02 Nov 2026 06:41:00 GMT', now)).toBe(11000);
    expect(graphRetryDelayMs(1, '3600', now)).toBe(60000);
    expect(graphRetryDelayMs(2, 'soon', now)).toBe(4000);
  });
});
