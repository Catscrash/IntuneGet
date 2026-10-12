import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parseAccessTokenMock = vi.hoisted(() => vi.fn());
const liveUpdatesMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: parseAccessTokenMock }));
// The live Graph scan is the source of truth in both backends; only its
// answer is stubbed here, so the rows land in a real SQLite database.
vi.mock('@/app/api/intune/apps/updates/route', () => ({ GET: liveUpdatesMock }));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: vi.fn() }));

let tempDir: string;
let route: typeof import('@/app/api/updates/refresh/route');

beforeEach(async () => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'intuneget-refresh-'));
  process.env.DATABASE_MODE = 'sqlite';
  process.env.DATABASE_PATH = join(tempDir, 'app.db');
  process.env.PACKAGER_API_KEY = 'test';
  parseAccessTokenMock.mockReset();
  parseAccessTokenMock.mockResolvedValue({ userId: 'u1', tenantId: 't1' });
  vi.doMock('@/lib/db', async () => {
    const sqlite = await import('@/lib/db/sqlite');
    return {
      getDatabase: () => sqlite.sqliteDb,
      isSqliteMode: () => true,
      resetDatabaseInstance: () => {},
    };
  });
  route = await import('@/app/api/updates/refresh/route');
});

afterEach(async () => {
  const { closeSqliteDb } = await import('@/lib/db/sqlite');
  closeSqliteDb();
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DATABASE_MODE;
  delete process.env.DATABASE_PATH;
  delete process.env.PACKAGER_API_KEY;
});

function request(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost/api/updates/refresh', {
    method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('updates refresh route in SQLite mode', () => {
  it('stores the live scan in the local database', async () => {
    liveUpdatesMock.mockResolvedValue(Response.json({
      updates: [{
        wingetId: 'Example.App',
        intuneApp: { id: 'app-1', displayName: 'Example' },
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        isManaged: true,
      }],
      updateCount: 1,
      checkedApps: [],
    }));

    const response = await route.POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, refreshedCount: 1, removedCount: 0, updateCount: 1 });
    const { sqliteDb } = await import('@/lib/db/sqlite');
    const stored = await sqliteDb.updateCheckResults.getByUserId('u1', 't1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ winget_id: 'Example.App', intune_app_id: 'app-1', latest_version: '2.0.0', is_managed: true });
  });

  it('passes a failed live scan through and keeps the cached rows', async () => {
    liveUpdatesMock.mockResolvedValue(Response.json({ code: 'UPDATE_SCAN_RETRYABLE' }, { status: 503 }));
    const response = await route.POST(request());
    expect(response.status).toBe(503);
  });

  it('returns 401 without a token', async () => {
    parseAccessTokenMock.mockResolvedValue(null);
    const response = await route.POST(request());
    expect(response.status).toBe(401);
  });
});
