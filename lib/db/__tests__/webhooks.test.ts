import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The real adapter against a temp database file, for the same reason as
// job-create.test.ts: sqlite.test.ts mirrors the production SQL by hand, so a
// statement that is wrong only in lib/db/sqlite.ts passes there.
let dir: string;
let adapter: typeof import('../sqlite').sqliteDb;
let closeDb: typeof import('../sqlite').closeSqliteDb;

function baseWebhook(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'user-1',
    name: 'Test Webhook',
    url: 'https://example.com/hook',
    webhook_type: 'teams' as const,
    secret: null,
    headers: {},
    is_enabled: true,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'intuneget-webhooks-'));
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  const mod = await import('../sqlite');
  adapter = mod.sqliteDb;
  closeDb = mod.closeSqliteDb;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe('sqlite webhooks', () => {
  it('creates a webhook with the delivery defaults', async () => {
    const webhook = await adapter.webhooks.create(baseWebhook());

    expect(webhook.id).toBeTruthy();
    expect(webhook.webhook_type).toBe('teams');
    expect(webhook.is_enabled).toBe(true);
    expect(webhook.failure_count).toBe(0);
    expect(webhook.last_failure_at).toBeNull();
    expect(webhook.headers).toEqual({});
  });

  it('round-trips custom headers and a secret', async () => {
    const webhook = await adapter.webhooks.create(
      baseWebhook({
        webhook_type: 'custom',
        secret: 'shhh',
        headers: { 'X-Token': 'abc', 'X-Env': 'prod' },
      })
    );

    expect(webhook.secret).toBe('shhh');
    expect(webhook.headers).toEqual({ 'X-Token': 'abc', 'X-Env': 'prod' });

    const [reloaded] = await adapter.webhooks.getByUserId('user-1');
    expect(reloaded.headers).toEqual({ 'X-Token': 'abc', 'X-Env': 'prod' });
  });

  it('returns only enabled webhooks for delivery', async () => {
    // A disabled webhook must never receive a delivery, and that is decided
    // here rather than at each call site.
    await adapter.webhooks.create(baseWebhook({ name: 'on' }));
    await adapter.webhooks.create(baseWebhook({ name: 'off', is_enabled: false }));

    expect(await adapter.webhooks.getByUserId('user-1')).toHaveLength(2);
    const enabled = await adapter.webhooks.getEnabledByUserId('user-1');
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe('on');
  });

  it('counts the webhooks a user has, for the per-user limit', async () => {
    expect(await adapter.webhooks.countByUserId('user-1')).toBe(0);
    await adapter.webhooks.create(baseWebhook());
    await adapter.webhooks.create(baseWebhook({ name: 'second' }));
    expect(await adapter.webhooks.countByUserId('user-1')).toBe(2);
    expect(await adapter.webhooks.countByUserId('user-2')).toBe(0);
  });

  it('records circuit-breaker state from the delivery path', async () => {
    const webhook = await adapter.webhooks.create(baseWebhook());

    const failed = await adapter.webhooks.update(webhook.id, 'user-1', {
      failure_count: 3,
      last_failure_at: '2026-09-09T10:00:00.000Z',
    });
    expect(failed?.failure_count).toBe(3);
    expect(failed?.last_failure_at).toBe('2026-09-09T10:00:00.000Z');
    expect(failed?.name).toBe('Test Webhook');

    const recovered = await adapter.webhooks.update(webhook.id, 'user-1', {
      failure_count: 0,
      last_success_at: '2026-09-09T11:00:00.000Z',
    });
    expect(recovered?.failure_count).toBe(0);
    expect(recovered?.last_success_at).toBe('2026-09-09T11:00:00.000Z');
  });

  it('scopes reads, patches and deletes to the owning user', async () => {
    // The id is the only thing a client sends, and the row holds an HMAC
    // secret - so every one of these has to carry the user.
    const webhook = await adapter.webhooks.create(baseWebhook({ secret: 'shhh' }));

    expect(await adapter.webhooks.getById(webhook.id, 'user-2')).toBeNull();
    expect(await adapter.webhooks.update(webhook.id, 'user-2', { name: 'x' })).toBeNull();
    expect(await adapter.webhooks.deleteById(webhook.id, 'user-2')).toBe(false);

    expect(await adapter.webhooks.getById(webhook.id, 'user-1')).not.toBeNull();
  });

  it('deletes a webhook and reports whether there was one', async () => {
    const webhook = await adapter.webhooks.create(baseWebhook());

    expect(await adapter.webhooks.deleteById(webhook.id, 'user-1')).toBe(true);
    expect(await adapter.webhooks.deleteById(webhook.id, 'user-1')).toBe(false);
    expect(await adapter.webhooks.getByUserId('user-1')).toEqual([]);
  });

  it('rejects a webhook type the delivery path cannot format', async () => {
    await expect(
      adapter.webhooks.create(
        baseWebhook({ webhook_type: 'carrier-pigeon' as never })
      )
    ).rejects.toThrow();
  });
});
