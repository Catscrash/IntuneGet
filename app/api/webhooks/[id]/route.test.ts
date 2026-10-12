import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The individual webhook routes read and write through the db abstraction, so
// they work without Supabase. The id is the only thing the client sends, so
// every call must carry the signed-in user to the adapter.
const fixture = vi.hoisted(() => ({
  allowed: true,
  webhooks: {
    getById: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn(),
  },
  sendTestWebhook: vi.fn(),
}));
vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: async () => fixture.allowed ? { userId: 'local-webhook-owner' } : null,
}));
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ webhooks: fixture.webhooks }) }));
vi.mock('@/lib/webhooks/egress', () => ({ validateWebhookTarget: vi.fn(async () => ({ valid: true })) }));
vi.mock('@/lib/webhooks/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/service')>()),
  sendTestWebhook: fixture.sendTestWebhook,
}));
import { DELETE, GET, PUT } from './route';
import { POST as TEST } from './test/route';

const context = { params: Promise.resolve({ id: 'local-webhook' }) };
const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/webhooks/local-webhook', {
  method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const calls = {
  GET: () => GET(request('GET'), context),
  PUT: () => PUT(request('PUT', { name: 'Renamed fixture' }), context),
  DELETE: () => DELETE(request('DELETE'), context),
  TEST: () => TEST(request('POST'), context),
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.allowed = true;
  fixture.webhooks.getById.mockResolvedValue(null);
  fixture.webhooks.update.mockResolvedValue(null);
  fixture.webhooks.deleteById.mockResolvedValue(false);
});

describe('individual webhook routes', () => {
  it.each(Object.keys(calls) as Array<keyof typeof calls>)('keeps authentication ahead of storage for %s', async (name) => {
    fixture.allowed = false;
    expect((await calls[name]()).status).toBe(401);
    expect(fixture.webhooks.getById).not.toHaveBeenCalled();
    expect(fixture.webhooks.update).not.toHaveBeenCalled();
    expect(fixture.webhooks.deleteById).not.toHaveBeenCalled();
  });

  it.each(Object.keys(calls) as Array<keyof typeof calls>)('answers 404 for a webhook the user does not own: %s', async (name) => {
    expect((await calls[name]()).status).toBe(404);
  });

  it('scopes reads, writes and deletes to the owner', async () => {
    await calls.GET();
    await calls.PUT();
    await calls.DELETE();
    expect(fixture.webhooks.getById).toHaveBeenCalledWith('local-webhook', 'local-webhook-owner');
    expect(fixture.webhooks.update).toHaveBeenCalledWith(
      'local-webhook', 'local-webhook-owner', expect.objectContaining({ name: 'Renamed fixture' })
    );
    expect(fixture.webhooks.deleteById).toHaveBeenCalledWith('local-webhook', 'local-webhook-owner');
  });

  it('masks the secret of a stored webhook', async () => {
    fixture.webhooks.getById.mockResolvedValue({ id: 'local-webhook', secret: 'test-secret' });
    const response = await calls.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ webhook: { id: 'local-webhook', secret: '********' } });
  });
});
