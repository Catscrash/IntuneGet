import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntuneUploader } from '../src/intune-uploader';
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
    proxy: { fetch } as unknown as PackagerConfig['proxy'],
  };
}

function reply(status: number, statusText = '', body = '') {
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => body };
}

const AUTH_FAILURE = reply(
  403,
  'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.',
  '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code>'
    + '<AuthenticationErrorDetail>Signature not valid in the specified time frame</AuthenticationErrorDetail></Error>'
);

interface ChunkUploader {
  uploadFileChunks(
    filePath: string,
    azureStorageUri: string,
    onProgress?: (percent: number) => Promise<void>,
    renewUri?: () => Promise<string>
  ): Promise<void>;
  sleep(ms: number): Promise<void>;
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunks-'));
  file = path.join(dir, 'app.intunewin');
  // Two blocks: one full 6 MB block and a short tail.
  fs.writeFileSync(file, Buffer.alloc(6 * 1024 * 1024 + 10));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function uploader(fetch: FetchMock): ChunkUploader {
  const instance = new IntuneUploader(makeConfig(fetch)) as unknown as ChunkUploader;
  instance.sleep = vi.fn(async () => undefined);
  return instance;
}

describe('uploadFileChunks', () => {
  it('renews the upload URI and retries a block Azure refused with 403', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(201))
      .mockResolvedValueOnce(AUTH_FAILURE)
      .mockResolvedValue(reply(201));
    const renewUri = vi.fn(async () => 'https://blob.example/app?sig=renewed');

    await uploader(fetch).uploadFileChunks(file, 'https://blob.example/app?sig=first', undefined, renewUri);

    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(renewUri).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(4);
    expect(urls[1]).toContain('sig=first');
    expect(urls[2]).toContain('sig=renewed');
    expect(urls[2]).toContain(`blockid=${encodeURIComponent(Buffer.from('000001').toString('base64'))}`);
    expect(urls[3]).toBe('https://blob.example/app?sig=renewed&comp=blocklist');
  });

  it('retries a server error and a dropped connection with the same URI', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(reply(503, 'Server Busy'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(reply(201));
    const renewUri = vi.fn(async () => 'https://blob.example/app?sig=renewed');

    await uploader(fetch).uploadFileChunks(file, 'https://blob.example/app?sig=first', undefined, renewUri);

    expect(renewUri).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("gives up after four attempts and reports Azure's error detail", async () => {
    const fetch = vi.fn().mockResolvedValue(AUTH_FAILURE);

    await expect(
      uploader(fetch).uploadFileChunks(file, 'https://blob.example/app?sig=first', undefined, async () => 'https://blob.example/app?sig=renewed')
    ).rejects.toThrow(
      'Failed to upload block 0: 403 Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature. (Signature not valid in the specified time frame)'
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry a request Azure rejects as malformed', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(400, 'Bad Request', '<Error><Code>InvalidBlockId</Code></Error>'));

    await expect(
      uploader(fetch).uploadFileChunks(file, 'https://blob.example/app?sig=first')
    ).rejects.toThrow('Failed to upload block 0: 400 Bad Request (InvalidBlockId)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
