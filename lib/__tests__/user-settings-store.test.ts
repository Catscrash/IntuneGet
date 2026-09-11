import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@/lib/db/types';
import {
  readEffectiveSettings,
  SHARED_SETTINGS_ROW_ID,
  splitSettingsUpdate,
} from '@/lib/user-settings-store';

function dbWith(rows: Record<string, Record<string, unknown> | null>): DatabaseAdapter {
  return {
    userSettings: {
      get: vi.fn(async (id: string) => rows[id] ?? null),
      merge: vi.fn(),
    },
  } as unknown as DatabaseAdapter;
}

describe('splitSettingsUpdate', () => {
  it('sends deployment settings to the shared row and preferences to the user', () => {
    const { shared, personal } = splitSettingsUpdate({
      carryOverAssignments: true,
      supersedePreviousApp: true,
      allowAvailableUninstall: true,
      appDescriptionSuffix: 'by IT',
      virusTotalMaliciousThreshold: 4,
      cartAutoOpenOnAdd: false,
      theme: 'dark',
    });

    expect(shared).toEqual({
      carryOverAssignments: true,
      supersedePreviousApp: true,
      allowAvailableUninstall: true,
      appDescriptionSuffix: 'by IT',
      virusTotalMaliciousThreshold: 4,
    });
    // Cart behaviour and appearance stay personal.
    expect(personal).toEqual({ cartAutoOpenOnAdd: false, theme: 'dark' });
  });
});

describe('readEffectiveSettings', () => {
  it('lays the shared values over the user’s own row', async () => {
    const db = dbWith({
      'user-1': { theme: 'dark', virusTotalMaliciousThreshold: 1 },
      [SHARED_SETTINGS_ROW_ID]: { virusTotalMaliciousThreshold: 4 },
    });

    const settings = await readEffectiveSettings(db, 'user-1');

    expect(settings.virusTotalMaliciousThreshold).toBe(4);
    expect(settings.theme).toBe('dark');
  });

  it('gives every user the same deployment settings', async () => {
    // The point of the change: a package must not be built differently
    // depending on which admin clicked Deploy.
    const db = dbWith({
      'user-1': { appDescriptionSuffix: 'by Alice' },
      'user-2': {},
      [SHARED_SETTINGS_ROW_ID]: { appDescriptionSuffix: 'by IT' },
    });

    for (const user of ['user-1', 'user-2']) {
      const settings = await readEffectiveSettings(db, user);
      expect(settings.appDescriptionSuffix, user).toBe('by IT');
    }
  });

  it('keeps a value configured before the key became shared', async () => {
    // Migration: an instance that already had these set must not silently
    // fall back to defaults and start packaging differently.
    const db = dbWith({
      'user-1': { carryOverAssignments: true, supersedePreviousApp: true },
      [SHARED_SETTINGS_ROW_ID]: null,
    });

    const settings = await readEffectiveSettings(db, 'user-1');

    expect(settings.carryOverAssignments).toBe(true);
    expect(settings.supersedePreviousApp).toBe(true);
  });

  it('lets the shared row win even when it turns a setting off', async () => {
    // false is a decision, not an absent value.
    const db = dbWith({
      'user-1': { carryOverAssignments: true },
      [SHARED_SETTINGS_ROW_ID]: { carryOverAssignments: false },
    });

    expect((await readEffectiveSettings(db, 'user-1')).carryOverAssignments).toBe(false);
  });

  it('survives a user with no row at all', async () => {
    const db = dbWith({ [SHARED_SETTINGS_ROW_ID]: { virusTotalMaliciousThreshold: 3 } });

    expect((await readEffectiveSettings(db, 'new-user')).virusTotalMaliciousThreshold).toBe(3);
  });
});
