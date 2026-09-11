/**
 * Marker older packages carried in their description. Still recognised so the
 * duplicate guard keeps matching apps deployed before the switch; nothing
 * writes it any more.
 */
export const LEGACY_INTUNE_APP_SOURCE_MARKER = 'Source: IntuneGet.com';

/**
 * The marker written today: the package id rather than a product name. It
 * carries no branding into Company Portal, and it is what the match below
 * already preferred - an exact id beats "one of ours".
 */
export function intuneAppSourceMarker(wingetId: string): string {
  return `Winget: ${wingetId.trim()}`;
}

export interface DuplicateAppInfo {
  matchType: 'exact';
  existingAppId: string;
  existingAppUrl: string;
  existingVersion?: string;
  createdAt?: string;
}

interface DuplicateLookupJob {
  display_name: string;
  winget_id: string;
}

interface GraphReader {
  get<T>(path: string): Promise<T>;
}

interface GraphMobileAppSummary {
  id: string;
  displayName?: string;
  description?: string | null;
  /** Admin-only field; where the package-id marker lives today. */
  notes?: string | null;
}

interface GraphWin32AppDetails extends GraphMobileAppSummary {
  '@odata.type'?: string;
  displayVersion?: string | null;
  createdDateTime?: string;
  publishingState?: string | null;
  committedContentVersion?: string | null;
}

interface GraphAppPage {
  value?: GraphMobileAppSummary[];
  '@odata.nextLink'?: string;
}

/** Match "Winget: <id>" against the package being deployed. */
function matchesPackageMarker(value: string | null | undefined, wingetId: string): boolean {
  const marker = value?.match(/Winget:\s*(\S+)/);
  if (!marker) return false;
  return Boolean(wingetId) && marker[1].toLowerCase() === wingetId.toLowerCase();
}

/**
 * Whether an existing Intune app is one of ours for this package.
 *
 * The marker is written to `notes`, which Company Portal does not show. Apps
 * deployed before that carry it in the description - either as the same
 * "Winget: <id>" line or, older still, as the product marker - so both are
 * read here. Dropping them would make every existing app look unknown and
 * turn the next redeploy into a second app object.
 */
function isIntuneGetFingerprint(
  app: Pick<GraphMobileAppSummary, 'description' | 'notes'>,
  wingetId: string
): boolean {
  // A package marker, wherever it sits, is authoritative: it names the package
  // outright, so a marker for a *different* one is a definite no rather than a
  // reason to fall through. Only an app carrying no marker at all is judged by
  // the old product line.
  for (const field of [app.notes, app.description]) {
    if (field?.match(/Winget:\s*(\S+)/)) {
      return matchesPackageMarker(field, wingetId);
    }
  }

  return Boolean(app.description?.includes(LEGACY_INTUNE_APP_SOURCE_MARKER));
}

function graphPathFromNextLink(nextLink: string): string {
  return nextLink.replace(/^https:\/\/graph\.microsoft\.com\/(?:beta|v1\.0)/, '');
}

/**
 * Find a committed, published IntuneGet Win32 app with the same display name
 * and source fingerprint. The collection query selects only base mobileApp
 * fields; Win32-only fields are read from an individual polymorphic resource.
 */
export async function findDuplicateIntuneApp(
  graphClient: GraphReader,
  job: DuplicateLookupJob,
): Promise<DuplicateAppInfo | null> {
  const displayNameLower = job.display_name.toLowerCase();
  let nextPath: string | null =
    `/deviceAppManagement/mobileApps?$filter=isof('microsoft.graph.win32LobApp')` +
    `&$select=id,displayName,description,notes`;

  while (nextPath) {
    const page: GraphAppPage = await graphClient.get<GraphAppPage>(nextPath);
    for (const app of page.value ?? []) {
      if (
        app.displayName?.toLowerCase() !== displayNameLower ||
        !isIntuneGetFingerprint(app, job.winget_id)
      ) {
        continue;
      }

      // Graph validates collection $select against mobileApp, so fetch the
      // polymorphic resource before reading Win32-only properties.
      const details = await graphClient.get<GraphWin32AppDetails>(
        `/deviceAppManagement/mobileApps/${encodeURIComponent(app.id)}`,
      );
      if (
        details.publishingState?.toLowerCase() !== 'published' ||
        !details.committedContentVersion?.trim()
      ) {
        continue;
      }

      const appId = details.id || app.id;
      return {
        matchType: 'exact',
        existingAppId: appId,
        existingAppUrl: `https://intune.microsoft.com/#view/Microsoft_Intune_Apps/SettingsMenu/~/0/appId/${appId}`,
        existingVersion: details.displayVersion ?? undefined,
        createdAt: details.createdDateTime,
      };
    }

    nextPath = page['@odata.nextLink']
      ? graphPathFromNextLink(page['@odata.nextLink'])
      : null;
  }

  return null;
}
