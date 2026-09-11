import { describe, expect, it, vi, beforeEach } from 'vitest';

const lookupMock = vi.fn();
const requestMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

vi.mock('node:https', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

const {
  parseWebhookUrl,
  validateWebhookTarget,
  postWebhook,
  WebhookTargetError,
} = await import('./egress');

describe('parseWebhookUrl', () => {
  it('accepts a public HTTPS destination', () => {
    expect(parseWebhookUrl('https://hooks.slack.com/services/T/B/X').hostname).toBe(
      'hooks.slack.com'
    );
  });

  it.each([
    ['https://127.0.0.1/internal-only', 'private or reserved'],
    ['https://169.254.169.254/latest/meta-data/', 'private or reserved'],
    ['https://10.0.0.5/admin', 'private or reserved'],
    ['https://[::1]/admin', 'private or reserved'],
    ['http://example.com/hook', 'HTTPS'],
    ['https://user:pass@example.com/hook', 'credentials'],
    ['https://example.com:6443/api', 'custom port'],
    ['not-a-url', 'Invalid URL'],
  ])('rejects %s', (url, expected) => {
    expect(() => parseWebhookUrl(url)).toThrow(WebhookTargetError);
    expect(() => parseWebhookUrl(url)).toThrow(expected);
  });
});

describe('validateWebhookTarget', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('accepts a hostname resolving to a public address', async () => {
    lookupMock.mockResolvedValue([{ address: '13.37.13.37', family: 4 }]);

    await expect(validateWebhookTarget('https://hook.example.com/x')).resolves.toEqual({
      valid: true,
    });
  });

  it('rejects a hostname resolving to loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(validateWebhookTarget('https://internal.example.com/x')).resolves.toEqual({
      valid: false,
      error: 'URL hostname resolves to a private or reserved address',
    });
  });

  it('rejects a hostname with both a public and a private answer', async () => {
    lookupMock.mockResolvedValue([
      { address: '13.37.13.37', family: 4 },
      { address: '192.168.1.10', family: 4 },
    ]);

    await expect(validateWebhookTarget('https://split.example.com/x')).resolves.toMatchObject({
      valid: false,
    });
  });

  it('rejects a hostname that does not resolve', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(validateWebhookTarget('https://nope.example.com/x')).resolves.toEqual({
      valid: false,
      error: 'URL hostname did not resolve',
    });
  });
});

describe('postWebhook', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    requestMock.mockReset();
  });

  it('refuses to request a destination resolving into the network', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(
      postWebhook('https://internal.example.com/x', { headers: {}, body: '{}' })
    ).rejects.toThrow(WebhookTargetError);
  });

  it('refuses a private address literal without resolving anything', async () => {
    await expect(
      postWebhook('https://169.254.169.254/latest/', { headers: {}, body: '{}' })
    ).rejects.toThrow(WebhookTargetError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('connects to the resolved address with the hostname pinned', async () => {
    lookupMock.mockResolvedValue([{ address: '13.37.13.37', family: 4 }]);
    requestMock.mockImplementation((_options: unknown, handler: (res: unknown) => void) => {
      const response = {
        statusCode: 302,
        headers: { location: 'http://127.0.0.1/internal-only' },
        on: (event: string, cb: (chunk?: Buffer) => void) => {
          if (event === 'end') cb();
          return response;
        },
      };
      handler(response);
      return {
        setTimeout: () => undefined,
        on: () => undefined,
        end: () => undefined,
        destroy: () => undefined,
      };
    });

    const result = await postWebhook('https://hook.example.com/x', {
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });

    // A redirect is reported back, never followed
    expect(result).toEqual({ status: 302, ok: false, body: '' });

    const options = requestMock.mock.calls[0][0] as {
      hostname: string;
      servername: string;
      headers: Record<string, string>;
    };
    expect(options.hostname).toBe('13.37.13.37');
    expect(options.servername).toBe('hook.example.com');
    expect(options.headers.Host).toBe('hook.example.com');
  });
});
