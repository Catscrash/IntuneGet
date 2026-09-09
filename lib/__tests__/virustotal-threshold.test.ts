import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_SETTINGS,
  MAX_VIRUSTOTAL_MALICIOUS_THRESHOLD,
  resolveVirusTotalMaliciousThreshold,
} from '@/types/user-settings';

describe('resolveVirusTotalMaliciousThreshold', () => {
  it('keeps a valid threshold', () => {
    expect(resolveVirusTotalMaliciousThreshold(3)).toBe(3);
  });

  it('keeps zero, which turns the check off', () => {
    // 0 is a deliberate setting, not a missing one - it must survive.
    expect(resolveVirusTotalMaliciousThreshold(0)).toBe(0);
  });

  it('accepts a numeric string from an older client', () => {
    expect(resolveVirusTotalMaliciousThreshold('4')).toBe(4);
  });

  it('falls back to the default rather than to "off" for unusable values', () => {
    // Settings are an open JSON blob. A broken value must not silently
    // disable a security check, so it lands on the default instead of 0.
    for (const value of [undefined, null, 'nonsense', NaN, {}, [], -1, 2.5]) {
      expect(resolveVirusTotalMaliciousThreshold(value)).toBe(
        DEFAULT_USER_SETTINGS.virusTotalMaliciousThreshold
      );
    }
  });

  it('caps absurd values', () => {
    expect(resolveVirusTotalMaliciousThreshold(10_000)).toBe(
      MAX_VIRUSTOTAL_MALICIOUS_THRESHOLD
    );
  });

  it('defaults to blocking on a single engine, as before the setting existed', () => {
    expect(DEFAULT_USER_SETTINGS.virusTotalMaliciousThreshold).toBe(1);
  });
});
