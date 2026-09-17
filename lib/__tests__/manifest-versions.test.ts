import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getVersionsMock, getAppsByWingetIdsMock } = vi.hoisted(() => ({
  getVersionsMock: vi.fn(),
  getAppsByWingetIdsMock: vi.fn(),
}));

vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({
    getVersions: getVersionsMock,
    getAppsByWingetIds: getAppsByWingetIdsMock,
  }),
}));

import { fetchAvailableVersions } from '../manifest-api';

const mockFetch = vi.fn();
global.fetch = mockFetch;

/** The WinGet repo answers with one directory entry per published version. */
function githubVersions(...names: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => names.map((name) => ({ type: 'dir', name })),
  };
}

describe('fetchAvailableVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getVersionsMock.mockResolvedValue([]);
    getAppsByWingetIdsMock.mockResolvedValue([]);
  });

  it('serves the catalog list when it holds the catalog latest version', async () => {
    getVersionsMock.mockResolvedValue(['0.85.0.0', '0.84.0.0']);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '0.85.0.0' },
    ]);

    expect(await fetchAvailableVersions('PuTTY.PuTTY')).toEqual(['0.85.0.0', '0.84.0.0']);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('goes live when the catalog offers a version its own list lacks', async () => {
    // The browse card reads latest_version and the dropdown reads the version
    // history; while those disagree, the newest version is not selectable and
    // the package cannot be deployed at it by anyone.
    getVersionsMock.mockResolvedValue(['0.84.0.0', '0.83.0.0']);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '0.85.0.0' },
    ]);
    mockFetch.mockResolvedValue(githubVersions('0.83.0.0', '0.84.0.0', '0.85.0.0'));

    const versions = await fetchAvailableVersions('PuTTY.PuTTY');

    expect(versions).toContain('0.85.0.0');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the behind-but-real catalog list when the repository will not answer', async () => {
    getVersionsMock.mockResolvedValue(['0.84.0.0', '0.83.0.0']);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'PuTTY.PuTTY', latest_version: '0.85.0.0' },
    ]);
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    expect(await fetchAvailableVersions('PuTTY.PuTTY')).toEqual(['0.84.0.0', '0.83.0.0']);
  });

  it('still falls back when the catalog knows no versions at all', async () => {
    getVersionsMock.mockResolvedValue([]);
    getAppsByWingetIdsMock.mockResolvedValue([]);
    mockFetch.mockResolvedValue(githubVersions('1.0.0'));

    expect(await fetchAvailableVersions('Some.App')).toEqual(['1.0.0']);
  });

  it('does not reach for the repository when the catalog names no latest version', async () => {
    // Nothing to contradict, so nothing to check - an app the catalog has not
    // finished importing must not cost a request on every browse.
    getVersionsMock.mockResolvedValue(['2.0.0']);
    getAppsByWingetIdsMock.mockResolvedValue([
      { winget_id: 'Some.App', latest_version: null },
    ]);

    expect(await fetchAvailableVersions('Some.App')).toEqual(['2.0.0']);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
