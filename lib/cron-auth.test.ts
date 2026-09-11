import { describe, expect, it, afterEach } from 'vitest';
import { isAuthorizedCronRequest } from './cron-auth';

function requestWith(authorization?: string): Request {
  return new Request('http://localhost/api/cron/anything', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('isAuthorizedCronRequest', () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('accepts the configured secret', () => {
    process.env.CRON_SECRET = 'the-real-secret';

    expect(isAuthorizedCronRequest(requestWith('Bearer the-real-secret'))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    process.env.CRON_SECRET = 'the-real-secret';

    expect(isAuthorizedCronRequest(requestWith('Bearer nope'))).toBe(false);
  });

  it('rejects a missing header', () => {
    process.env.CRON_SECRET = 'the-real-secret';

    expect(isAuthorizedCronRequest(requestWith())).toBe(false);
  });

  it.each(['Bearer undefined', 'Bearer ', 'Bearer null', ''])(
    'rejects %o while the secret is unset',
    (authorization) => {
      delete process.env.CRON_SECRET;

      expect(isAuthorizedCronRequest(requestWith(authorization))).toBe(false);
    }
  );

  it('rejects everything while the secret is empty', () => {
    process.env.CRON_SECRET = '';

    expect(isAuthorizedCronRequest(requestWith('Bearer '))).toBe(false);
    expect(isAuthorizedCronRequest(requestWith('Bearer undefined'))).toBe(false);
  });
});
