import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

let dir: string;
let adapter: typeof import('../../../../lib/db/sqlite').sqliteDb;
let closeDb: typeof import('../../../../lib/db/sqlite').closeSqliteDb;
let resetDatabaseInstance: typeof import('../../../../lib/db').resetDatabaseInstance;
let routeGet: typeof import('./route').GET;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'intuneget-health-'));
  process.env.DATABASE_MODE = 'sqlite';
  process.env.PACKAGER_MODE = 'local';
  process.env.PACKAGER_API_KEY = 'packager-key-for-test';
  process.env.DATABASE_PATH = path.join(dir, 'test.db');
  process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
  process.env.AZURE_CLIENT_SECRET = 'test-secret';

  const sqlite = await import('../../../../lib/db/sqlite');
  adapter = sqlite.sqliteDb;
  closeDb = sqlite.closeSqliteDb;
  const dbIndex = await import('../../../../lib/db');
  resetDatabaseInstance = dbIndex.resetDatabaseInstance;
  resetDatabaseInstance();
  vi.doMock('@/lib/db', () => ({
    getDatabase: () => adapter,
    getDatabaseMode: () => 'sqlite',
    resetDatabaseInstance: () => undefined,
    verifyPackagerApiKey: (providedKey: string | null) => providedKey === 'packager-key-for-test',
  }));
  routeGet = (await import('./route')).GET;
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/db');
  resetDatabaseInstance();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATABASE_MODE;
  delete process.env.PACKAGER_MODE;
  delete process.env.PACKAGER_API_KEY;
  delete process.env.DATABASE_PATH;
  delete process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID;
  delete process.env.AZURE_CLIENT_SECRET;
});

describe('packager health stale recovery', () => {
  it('rejects unauthenticated stale recovery and leaves a stale processing job owned', async () => {
    const job = await adapter.jobs.create({
      id: 'job-stale-1',
      user_id: 'victim-user',
      tenant_id: 'victim-tenant',
      winget_id: 'Vendor.App',
      version: '1.0.0',
      display_name: 'Vendor App',
      installer_type: 'msi',
      installer_url: 'https://downloads.example.invalid/vendor.msi',
      status: 'queued',
    });
    const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await adapter.jobs.claim(job.id, 'local-packager-a');
    await adapter.jobs.update(job.id, {
      packager_heartbeat_at: staleHeartbeat,
      packaging_started_at: staleHeartbeat,
    }, { packager_id: 'local-packager-a' });

    const response = await routeGet(new NextRequest('http://localhost/api/packager/health'));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe('Unauthorized - invalid packager credentials');

    const after = await adapter.jobs.getById(job.id);
    expect(after?.status).toBe('packaging');
    expect(after?.packager_id).toBe('local-packager-a');
    expect(after?.packager_heartbeat_at).toBe(staleHeartbeat);

    const originalOwnerUpdate = await adapter.jobs.update(job.id, {
      packager_heartbeat_at: new Date().toISOString(),
    }, { packager_id: 'local-packager-a' });
    expect(originalOwnerUpdate?.packager_id).toBe('local-packager-a');
  });

  it('requeues a stale processing job for an authenticated packager health check', async () => {
    const job = await adapter.jobs.create({
      id: 'job-auth-stale-1',
      user_id: 'victim-user',
      tenant_id: 'victim-tenant',
      winget_id: 'Vendor.App',
      version: '1.0.0',
      display_name: 'Vendor App',
      installer_type: 'msi',
      installer_url: 'https://downloads.example.invalid/vendor.msi',
      status: 'queued',
    });
    const staleHeartbeat = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await adapter.jobs.claim(job.id, 'local-packager-a');
    await adapter.jobs.update(job.id, {
      packager_heartbeat_at: staleHeartbeat,
      packaging_started_at: staleHeartbeat,
    }, { packager_id: 'local-packager-a' });

    const response = await routeGet(new NextRequest('http://localhost/api/packager/health', {
      headers: { Authorization: 'Bearer packager-key-for-test' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats.staleJobsRecovered).toBe(1);

    const after = await adapter.jobs.getById(job.id);
    expect(after?.status).toBe('queued');
    expect(after?.packager_id).toBeNull();
  });

  it('does not alter a non-stale processing job', async () => {
    const job = await adapter.jobs.create({
      id: 'job-fresh-1',
      user_id: 'victim-user',
      tenant_id: 'victim-tenant',
      winget_id: 'Vendor.Fresh',
      version: '1.0.0',
      display_name: 'Fresh App',
      installer_type: 'msi',
      installer_url: 'https://downloads.example.invalid/fresh.msi',
      status: 'queued',
    });
    await adapter.jobs.claim(job.id, 'local-packager-a');

    const response = await routeGet(new NextRequest('http://localhost/api/packager/health', {
      headers: { Authorization: 'Bearer packager-key-for-test' },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stats.staleJobsRecovered).toBeUndefined();

    const after = await adapter.jobs.getById(job.id);
    expect(after?.status).toBe('packaging');
    expect(after?.packager_id).toBe('local-packager-a');
  });
});