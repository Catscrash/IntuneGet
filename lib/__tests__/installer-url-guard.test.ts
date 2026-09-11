import { beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const { assertPublicInstallerUrl } = await import('@/lib/installer-download');

describe('assertPublicInstallerUrl', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    delete process.env.INSTALLER_ALLOW_PRIVATE_URLS;
  });

  it('accepts a public host', async () => {
    lookupMock.mockResolvedValue([{ address: '13.37.13.37', family: 4 }]);

    await expect(assertPublicInstallerUrl('https://downloads.example.com/app.msi'))
      .resolves.toBeUndefined();
  });

  it.each([
    ['http://127.0.0.1/app.msi', 'private or reserved'],
    ['https://169.254.169.254/latest/meta-data/', 'private or reserved'],
    ['https://10.1.2.3/share/app.msi', 'private or reserved'],
  ])('rejects the address literal in %s', async (url, expected) => {
    await expect(assertPublicInstallerUrl(url)).rejects.toThrow(expected);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('rejects a host that resolves into the network', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.10.5', family: 4 }]);

    await expect(assertPublicInstallerUrl('https://fileserver.corp.example/app.msi'))
      .rejects.toThrow('private or reserved');
  });

  it.each([
    ['ftp://example.com/app.msi', 'HTTP or HTTPS'],
    ['https://user:pass@example.com/app.msi', 'credentials'],
    ['https://example.com:8080/app.msi', 'disallowed port'],
    ['not-a-url', 'not a valid URL'],
  ])('rejects %s on shape alone', async (url, expected) => {
    await expect(assertPublicInstallerUrl(url)).rejects.toThrow(expected);
  });

  it('lets an operator serve installers from their own network on request', async () => {
    process.env.INSTALLER_ALLOW_PRIVATE_URLS = 'true';

    await expect(assertPublicInstallerUrl('http://fileserver.corp.example:8080/app.msi'))
      .resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('keeps rejecting credentials even with private URLs allowed', async () => {
    process.env.INSTALLER_ALLOW_PRIVATE_URLS = 'true';

    await expect(assertPublicInstallerUrl('http://user:pass@fileserver.corp.example/app.msi'))
      .rejects.toThrow('credentials');
  });
});
