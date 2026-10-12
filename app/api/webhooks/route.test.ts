import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Webhooks are stored through the db abstraction, so they work in a
// Supabase-less SQLite install as well. These tests pin that the routes go
// through the adapter, keep authentication and validation ahead of storage,
// and never hand a stored secret back.
const fixture = vi.hoisted(() => ({
  allowed: true,
  webhooks: {
    getByUserId: vi.fn(),
    countByUserId: vi.fn(),
    create: vi.fn(),
  },
  validateWebhookTarget: vi.fn(),
}));
vi.mock('@/lib/auth-utils', () => ({
  parseAccessToken: async () => fixture.allowed ? { userId: 'local-webhook-owner' } : null,
}));
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ webhooks: fixture.webhooks }) }));
vi.mock('@/lib/webhooks/egress', () => ({ validateWebhookTarget: fixture.validateWebhookTarget }));

import { GET, POST } from './route';

const post = (body: unknown) => new NextRequest('http://localhost/api/webhooks', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
});
const valid = { name: ' Local fixture ', url: 'https://example.test/webhook', webhook_type: 'custom' };

beforeEach(() => {
  vi.clearAllMocks();
  fixture.allowed = true;
  fixture.webhooks.getByUserId.mockResolvedValue([]);
  fixture.webhooks.countByUserId.mockResolvedValue(0);
  fixture.validateWebhookTarget.mockResolvedValue({ valid: true });
});

describe('webhook routes', () => {
  it.each(['GET', 'POST'])('keeps authentication ahead of storage for %s', async (method) => {
    fixture.allowed = false;
    const response = method === 'GET'
      ? await GET(new NextRequest('http://localhost/api/webhooks')) : await POST(post(valid));
    expect(response.status).toBe(401);
    expect(fixture.webhooks.getByUserId).not.toHaveBeenCalled();
    expect(fixture.webhooks.create).not.toHaveBeenCalled();
  });

  it.each([{ ...valid, name: '' }, { ...valid, url: '' }, { ...valid, webhook_type: 'invalid' }])(
    'retains input validation before storage', async (body) => {
      const response = await POST(post(body));
      expect(response.status).toBe(400);
      expect(fixture.webhooks.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a target the egress check rejects', async () => {
    fixture.validateWebhookTarget.mockResolvedValue({ valid: false, error: 'Webhook URL resolves to a private address' });
    const response = await POST(post(valid));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Webhook URL resolves to a private address' });
    expect(fixture.webhooks.create).not.toHaveBeenCalled();
  });

  it('lists the owner\'s webhooks with secrets masked', async () => {
    fixture.webhooks.getByUserId.mockResolvedValue([{ id: 'local-record', secret: 'test-secret' }]);
    const response = await GET(new NextRequest('http://localhost/api/webhooks'));
    expect(response.status).toBe(200);
    expect(fixture.webhooks.getByUserId).toHaveBeenCalledWith('local-webhook-owner');
    expect(await response.json()).toEqual({ webhooks: [{ id: 'local-record', secret: '********' }] });
  });

  it('creates a webhook for the owner with the name trimmed and the secret masked', async () => {
    fixture.webhooks.create.mockResolvedValue({ id: 'local-record', secret: 'test-secret' });
    const response = await POST(post({ ...valid, secret: 'test-secret' }));
    expect(response.status).toBe(201);
    expect(fixture.webhooks.countByUserId).toHaveBeenCalledWith('local-webhook-owner');
    expect(fixture.webhooks.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Local fixture', user_id: 'local-webhook-owner', secret: 'test-secret' })
    );
    expect(await response.json()).toEqual({ webhook: { id: 'local-record', secret: '********' } });
  });

  it('retains the webhook limit', async () => {
    fixture.webhooks.countByUserId.mockResolvedValue(10);
    const response = await POST(post(valid));
    expect(response.status).toBe(400);
    expect(fixture.webhooks.create).not.toHaveBeenCalled();
  });

  it('reports a storage failure as a server error', async () => {
    fixture.webhooks.countByUserId.mockRejectedValue(new Error('local-failure'));
    const response = await POST(post(valid));
    expect(response.status).toBe(500);
  });
});
