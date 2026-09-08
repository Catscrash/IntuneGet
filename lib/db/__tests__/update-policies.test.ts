import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The real adapter, against a temp database file. sqlite.test.ts mirrors the
// production SQL in-memory, which cannot catch a schema or statement that is
// wrong only in lib/db/sqlite.ts itself - so the policy repository is tested
// through the module the routes actually import.
let dir: string;
let adapter: typeof import('../sqlite').sqliteDb;
let closeDb: typeof import('../sqlite').closeSqliteDb;

function basePolicy(overrides: Record<string, unknown> = {}) {
  return {
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    winget_id: 'Mozilla.Firefox',
    policy_type: 'notify' as const,
    pinned_version: null,
    deployment_config: null,
    original_upload_history_id: null,
    is_enabled: true,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'intuneget-policies-'));
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  // Fresh module registry per test so the adapter's singleton handle reopens
  // against this test's file rather than the previous test's.
  const mod = await import('../sqlite');
  adapter = mod.sqliteDb;
  closeDb = mod.closeSqliteDb;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe('sqlite updatePolicies', () => {
  it('creates a policy and reports it as created', async () => {
    const { policy, created } = await adapter.updatePolicies.upsert(basePolicy());

    expect(created).toBe(true);
    expect(policy.id).toBeTruthy();
    expect(policy.policy_type).toBe('notify');
    expect(policy.is_enabled).toBe(true);
    expect(policy.consecutive_failures).toBe(0);
  });

  it('replaces the policy for the same user, tenant and app rather than adding a second', async () => {
    // One policy per app is the rule the table enforces; the bell-icon
    // dropdown sets a policy without first looking one up, so a second call
    // must land on the same row.
    const first = await adapter.updatePolicies.upsert(basePolicy());
    const second = await adapter.updatePolicies.upsert(
      basePolicy({ policy_type: 'ignore' })
    );

    expect(second.created).toBe(false);
    expect(second.policy.id).toBe(first.policy.id);
    expect(second.policy.policy_type).toBe('ignore');
    expect(second.policy.created_at).toBe(first.policy.created_at);

    const all = await adapter.updatePolicies.getByUserId('user-1');
    expect(all).toHaveLength(1);
  });

  it('keeps policies of different tenants and apps apart', async () => {
    await adapter.updatePolicies.upsert(basePolicy());
    await adapter.updatePolicies.upsert(basePolicy({ tenant_id: 'tenant-2' }));
    await adapter.updatePolicies.upsert(basePolicy({ winget_id: 'Git.Git' }));

    expect(await adapter.updatePolicies.getByUserId('user-1')).toHaveLength(3);
    expect(await adapter.updatePolicies.getByUserId('user-1', 'tenant-2')).toHaveLength(1);
  });

  it('round-trips the deployment config as an object', async () => {
    // auto_update stores the whole re-deployment recipe; it must come back
    // parsed, or the trigger would try to spread a JSON string.
    const { policy } = await adapter.updatePolicies.upsert(
      basePolicy({
        policy_type: 'auto_update',
        deployment_config: { displayName: 'Firefox', detectionRules: [{ type: 'msi' }] },
      })
    );

    expect(policy.deployment_config).toEqual({
      displayName: 'Firefox',
      detectionRules: [{ type: 'msi' }],
    });

    const [reloaded] = await adapter.updatePolicies.getByUserId('user-1');
    expect(reloaded.deployment_config).toEqual(policy.deployment_config);
  });

  it('returns only the requested apps for annotating a list of updates', async () => {
    await adapter.updatePolicies.upsert(basePolicy({ policy_type: 'ignore' }));
    await adapter.updatePolicies.upsert(basePolicy({ winget_id: 'Git.Git' }));
    await adapter.updatePolicies.upsert(basePolicy({ winget_id: 'Notepad.Plus' }));

    const found = await adapter.updatePolicies.getForWingetIds(
      'user-1',
      ['Mozilla.Firefox', 'Notepad.Plus'],
      'tenant-1'
    );

    expect(found.map((p) => p.winget_id).sort()).toEqual(['Mozilla.Firefox', 'Notepad.Plus']);
  });

  it('answers an empty app list without querying', async () => {
    await adapter.updatePolicies.upsert(basePolicy());

    expect(await adapter.updatePolicies.getForWingetIds('user-1', [])).toEqual([]);
  });

  it('carries the auto-update bookkeeping across a policy change', async () => {
    // Changing the policy type must not reset what the last run deployed:
    // /api/updates/available drops an update whose version matches
    // last_auto_update_version, so wiping it re-offers what just went out.
    const { policy } = await adapter.updatePolicies.upsert(
      basePolicy({ policy_type: 'auto_update' })
    );
    await adapter.updatePolicies.update(policy.id, 'user-1', {
      last_auto_update_at: '2026-09-01T00:00:00Z',
      last_auto_update_version: '2.0.0',
      consecutive_failures: 3,
    });

    const { policy: reSet } = await adapter.updatePolicies.upsert(
      basePolicy({ policy_type: 'notify' })
    );

    expect(reSet.policy_type).toBe('notify');
    expect(reSet.last_auto_update_version).toBe('2.0.0');
    expect(reSet.last_auto_update_at).toBe('2026-09-01T00:00:00Z');
    expect(reSet.consecutive_failures).toBe(3);
  });

  it('ignores fields explicitly patched as undefined', async () => {
    // A caller that spreads an optional field must not silently re-enable a
    // disabled policy just by mentioning the key.
    const { policy } = await adapter.updatePolicies.upsert(
      basePolicy({ is_enabled: false })
    );

    const patched = await adapter.updatePolicies.update(policy.id, 'user-1', {
      is_enabled: undefined,
      pinned_version: '9.9.9',
    });

    expect(patched?.is_enabled).toBe(false);
    expect(patched?.pinned_version).toBe('9.9.9');
  });

  it('patches only the fields it is given', async () => {
    const { policy } = await adapter.updatePolicies.upsert(
      basePolicy({ policy_type: 'pin_version', pinned_version: '1.2.3' })
    );

    const patched = await adapter.updatePolicies.update(policy.id, 'user-1', {
      is_enabled: false,
    });

    expect(patched?.is_enabled).toBe(false);
    expect(patched?.pinned_version).toBe('1.2.3');
    expect(patched?.policy_type).toBe('pin_version');
  });

  it('scopes reads, patches and deletes to the owning user', async () => {
    // The id is the only thing the client sends, so every one of these has to
    // carry the user or one tenant admin could edit another's policy by id.
    const { policy } = await adapter.updatePolicies.upsert(basePolicy());

    expect(await adapter.updatePolicies.getById(policy.id, 'user-2')).toBeNull();
    expect(await adapter.updatePolicies.update(policy.id, 'user-2', { is_enabled: false }))
      .toBeNull();
    expect(await adapter.updatePolicies.deleteById(policy.id, 'user-2')).toBe(false);

    expect(await adapter.updatePolicies.getById(policy.id, 'user-1')).not.toBeNull();
  });

  it('deletes a policy and reports whether there was one', async () => {
    const { policy } = await adapter.updatePolicies.upsert(basePolicy());

    expect(await adapter.updatePolicies.deleteById(policy.id, 'user-1')).toBe(true);
    expect(await adapter.updatePolicies.deleteById(policy.id, 'user-1')).toBe(false);
    expect(await adapter.updatePolicies.getByUserId('user-1')).toEqual([]);
  });
});
