/**
 * Utilities for building Intune app descriptions.
 */

/**
 * Marker older packages carried. Kept only so the duplicate guard still
 * recognises apps deployed before the switch - nothing writes it any more.
 */
export const LEGACY_INTUNE_APP_SOURCE_MARKER = 'Source: IntuneGet.com';

/**
 * The machine-readable line appended to every managed app description.
 *
 * It is the package id rather than a product name: the tenant-wide duplicate
 * guard already prefers this form (it matches the id instead of merely
 * recognising "one of ours"), and it puts no branding in front of the people
 * who see the app in Company Portal.
 */
export function intuneAppSourceMarker(wingetId: string): string {
  return `Winget: ${wingetId.trim()}`;
}

export interface IntuneDescriptionParams {
  /** Operator- or catalog-authored text; the body of the description. */
  description?: string;
  /** Used when there is no description at all. */
  fallback: string;
  /** Package id, for the machine-readable marker. Omit to append none. */
  wingetId?: string;
  /**
   * Free text the operator configured (settings: appDescriptionSuffix), for
   * example a team signature. Appended after the marker, never in place of it.
   */
  sourceText?: string;
}

export function buildIntuneAppDescription({
  description,
  fallback,
  wingetId,
  sourceText,
}: IntuneDescriptionParams): string {
  const baseDescription = (description?.trim() || fallback.trim());
  const lines = [baseDescription];

  const marker = wingetId?.trim() ? intuneAppSourceMarker(wingetId) : '';
  // Idempotent: re-deploying an app must not stack the marker, and an
  // operator who typed it into the description themselves keeps their line.
  if (marker && !baseDescription.includes(marker)) {
    lines.push(marker);
  }

  const trimmedSourceText = sourceText?.trim();
  if (trimmedSourceText && !baseDescription.includes(trimmedSourceText)) {
    lines.push(trimmedSourceText);
  }

  return lines.join('\n');
}
