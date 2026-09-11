import { describe, expect, it } from 'vitest';
import {
  buildIntuneAppDescription,
  intuneAppSourceMarker,
  LEGACY_INTUNE_APP_SOURCE_MARKER,
} from '@/lib/intune-description';

describe('buildIntuneAppDescription', () => {
  it('appends the package id rather than a product name', () => {
    // End users read this in Company Portal, so the marker is machine-readable
    // metadata, not branding.
    const result = buildIntuneAppDescription({
      description: 'A file archiver with a high compression ratio.',
      fallback: '7-Zip',
      wingetId: '7zip.7zip',
    });

    expect(result).toBe('A file archiver with a high compression ratio.\nWinget: 7zip.7zip');
    expect(result).not.toContain(LEGACY_INTUNE_APP_SOURCE_MARKER);
  });

  it('appends the operator signature after the marker', () => {
    const result = buildIntuneAppDescription({
      description: 'A file archiver.',
      fallback: '7-Zip',
      wingetId: '7zip.7zip',
      sourceText: 'Packaged with care by IT',
    });

    expect(result).toBe('A file archiver.\nWinget: 7zip.7zip\nPackaged with care by IT');
  });

  it('adds nothing beyond the marker when no signature is configured', () => {
    for (const sourceText of [undefined, '', '   ']) {
      expect(
        buildIntuneAppDescription({
          description: 'Body.',
          fallback: 'App',
          wingetId: 'Some.App',
          sourceText,
        })
      ).toBe('Body.\nWinget: Some.App');
    }
  });

  it('is idempotent, so a redeploy does not stack the lines', () => {
    // The description editor round-trips this text; appending twice would grow
    // it on every redeploy.
    const once = buildIntuneAppDescription({
      description: 'Body.',
      fallback: 'App',
      wingetId: 'Some.App',
      sourceText: 'by IT',
    });
    const twice = buildIntuneAppDescription({
      description: once,
      fallback: 'App',
      wingetId: 'Some.App',
      sourceText: 'by IT',
    });

    expect(twice).toBe(once);
  });

  it('falls back to the display name when there is no description', () => {
    expect(
      buildIntuneAppDescription({ description: '', fallback: '7-Zip', wingetId: '7zip.7zip' })
    ).toBe('7-Zip\nWinget: 7zip.7zip');
  });

  it('omits the marker when no package id is available', () => {
    expect(buildIntuneAppDescription({ description: 'Body.', fallback: 'App' })).toBe('Body.');
  });

  it('builds the marker the duplicate guard matches on', () => {
    // packager/src/duplicate-app.ts reads /Winget:\s*(\S+)/ and compares the id.
    const marker = intuneAppSourceMarker('7zip.7zip');
    expect(marker.match(/Winget:\s*(\S+)/)?.[1]).toBe('7zip.7zip');
  });
});
