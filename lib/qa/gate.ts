import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveWingetPackageDependencies, type PackagedWingetDependency } from '@/lib/winget-dependencies';
import { arePackageDependenciesCovered } from '@/lib/qa/dependency-reputation';
import { getCatalogSource } from '@/lib/catalog';
import { CuratedEvidenceMismatchError, isCuratedPackageId } from '@/lib/curated-catalog/core.mjs';
import { getApprovedCuratedRelease } from '@/lib/curated-catalog/server';
import { classifyQaFailure } from '@/lib/qa/classify';
import { createServerClient, isSupabaseServerConfigured } from '@/lib/supabase';
import {
  getPackageCompatibilityBlock,
  type PackageCompatibilityBlockCode,
} from '@/lib/package-eligibility';
import type { QaClassification, QaResultRow } from '@/types/qa';

export interface ExactQaPayloadKey {
  wingetId: string;
  version: string;
  architecture: string;
  installerSha256: string;
}

export function isCoveredCleanReputation(row: {
  virustotal_status?: unknown;
  virustotal_malicious?: unknown;
  virustotal_suspicious?: unknown;
  virustotal_total_engines?: unknown;
} | null | undefined): boolean {
  return row?.virustotal_status === 'clean' && row.virustotal_malicious === 0 &&
    row.virustotal_suspicious === 0 && typeof row.virustotal_total_engines === 'number' &&
    Number.isInteger(row.virustotal_total_engines) && row.virustotal_total_engines > 0;
}

/**
 * Covered reputation that stays below the operator's malicious threshold.
 *
 * At the default threshold of 1 this is exactly isCoveredCleanReputation. A
 * raised threshold is the operator accepting that a few engines flag an
 * installer, so a scan below it must admit packaging rather than hold it
 * forever for not being clean; engine coverage is still required.
 */
export function isCoveredReputationBelowThreshold(
  row: Parameters<typeof isCoveredCleanReputation>[0],
  maliciousThreshold: number
): boolean {
  if (maliciousThreshold <= 1) return isCoveredCleanReputation(row);
  return typeof row?.virustotal_malicious === 'number' && row.virustotal_malicious < maliciousThreshold &&
    typeof row.virustotal_total_engines === 'number' &&
    Number.isInteger(row.virustotal_total_engines) && row.virustotal_total_engines > 0;
}

export function exactPayloadReputationQuery(client: SupabaseClient, key: ExactQaPayloadKey) {
  return client.from('qa_package_results')
    .select('virustotal_status, virustotal_malicious, virustotal_suspicious, virustotal_total_engines')
    .eq('winget_id', key.wingetId).eq('tested_version', key.version)
    .eq('architecture', key.architecture).eq('installer_sha256', key.installerSha256)
    .order('tested_at_utc', { ascending: false })
    .order('virustotal_scanned_at_utc', { ascending: false, nullsFirst: false })
    .limit(1).maybeSingle();
}

export function exactPayloadMaliciousQuery(client: SupabaseClient, key: ExactQaPayloadKey, maliciousThreshold = 1) {
  return client.from('qa_package_results').select('virustotal_malicious, virustotal_total_engines')
    .eq('winget_id', key.wingetId).eq('tested_version', key.version)
    .eq('architecture', key.architecture).eq('installer_sha256', key.installerSha256)
    .gte('virustotal_malicious', maliciousThreshold).order('tested_at_utc', { ascending: false })
    .limit(1).maybeSingle();
}

export class QaGateError extends Error {
  readonly code = 'QA_FAILED_CURRENT_VERSION' as const;

  constructor(
    readonly details: {
      wingetId: string;
      testedVersion: string;
      testedAtUtc: string;
      architecture: string;
      classification: QaClassification;
    }
  ) {
    super(
      `Installation testing failed for ${details.wingetId} ${details.testedVersion} (${details.architecture})`
    );
    this.name = 'QaGateError';
  }
}

export class QaGateNotPassedError extends Error {
  readonly code = 'QA_NOT_PASSED_CURRENT_VERSION' as const;

  constructor(
    readonly details: {
      wingetId: string;
      version: string;
      architecture: string;
      installerSha256: string;
      packageProfileSha256: string;
      reason:
        | 'missing'
        | 'failed'
        | 'version'
        | 'architecture'
        | 'installer_sha256'
        | 'package_profile'
        | 'reputation';
    }
  ) {
    super(
      details.reason === 'reputation'
        ? `Installer reputation is not verified clean for ${details.wingetId} ${details.version} (${details.architecture})`
        : `Installation testing has not passed yet for ${details.wingetId} ${details.version} (${details.architecture})`
    );
    this.name = 'QaGateNotPassedError';
  }
}

export class QaSecurityGateError extends Error {
  readonly code = 'QA_SECURITY_FLAGGED_CURRENT_VERSION' as const;

  constructor(
    readonly details: {
      wingetId: string;
      version: string;
      architecture: string;
      malicious: number;
      totalEngines: number | null;
    }
  ) {
    super(
      `VirusTotal reported ${details.malicious} malicious verdict${details.malicious === 1 ? '' : 's'} for the ${details.wingetId} ${details.version} (${details.architecture}) installer`
    );
    this.name = 'QaSecurityGateError';
  }
}

export class QaCompatibilityGateError extends Error {
  readonly code = 'QA_PACKAGE_COMPATIBILITY_BLOCKED' as const;

  constructor(
    readonly details: {
      wingetId: string;
      version: string;
      architecture: string;
      installerSha256: string;
      blockCode: PackageCompatibilityBlockCode;
    }
  ) {
    super(
      `Automated deployment is unavailable for ${details.wingetId} ${details.version} (${details.architecture})`
    );
    this.name = 'QaCompatibilityGateError';
  }
}

export type AnyQaGateError =
  | QaGateError
  | QaGateNotPassedError
  | QaSecurityGateError
  | QaCompatibilityGateError;

export function isQaGateError(error: unknown): error is AnyQaGateError {
  return (
    error instanceof QaGateError ||
    error instanceof QaGateNotPassedError ||
    error instanceof QaSecurityGateError ||
    error instanceof QaCompatibilityGateError
  );
}

export function describeQaGateError(error: AnyQaGateError): string {
  if (error instanceof QaCompatibilityGateError) {
    return `${error.message}. This exact installer release has a reviewed compatibility block; a future corrected vendor release remains eligible for QA.`;
  }
  if (error instanceof QaSecurityGateError) {
    return `${error.message}. Packaging is blocked for this version until the finding is reviewed. Earlier versions with a clean verdict remain available.`;
  }
  if (error instanceof QaGateNotPassedError) {
    if (error.details.reason === 'reputation') {
      return `${error.message}. Packaging will resume after a clean VirusTotal verdict with engine coverage is available.`;
    }
    return `${error.message}. Automatic deployment will resume after the installation test passes.`;
  }
  const { classification, testedAtUtc } = error.details;
  return [
    error.message,
    `The failing result was recorded at ${testedAtUtc}.`,
    classification.evidence,
    classification.remediation,
  ].join(' ');
}

export async function enforceQaGate(input: {
  wingetId: string;
  version: string;
  architecture?: string;
  installerSha256?: string;
  packageProfileSha256?: string;
  /** The trusted resolver's bundle, when the caller already prepares dispatch. */
  resolvedPackageDependencies?: readonly Pick<PackagedWingetDependency, 'installerSha256'>[];
  requirePassed?: boolean;
  qaOverride?: boolean;
  /**
   * Waive a VirusTotal verdict for this package. Deliberately separate from
   * qaOverride: accepting a failed installation test is a different decision
   * from accepting an antivirus finding, and one must not silently carry the
   * other.
   */
  securityOverride?: boolean;
  /**
   * How many engines must flag the installer before packaging is refused.
   * 0 disables the check. Defaults to 1 when the caller has no operator
   * setting to hand, which is the behaviour this gate has always had.
   */
  maliciousThreshold?: number;
  sourceType?: 'winget' | 'custom' | 'curated';
  curatedReleaseId?: string;
}): Promise<void> {
  if (isCuratedPackageId(input.wingetId) || input.sourceType === 'curated') {
    const { app, release } = getApprovedCuratedRelease(input.wingetId, input.version, input.curatedReleaseId);
    // The execution profile (default or a verified custom PSADT configuration)
    // is authorized by authorizeCuratedWorkflow on every dispatch. Comparing it
    // here against the tested hash would reject releases after any compatible
    // packager release and every MSP batch, which passes no profile.
    if (input.sourceType === 'custom' || input.qaOverride || (input.architecture || app.architecture) !== app.architecture ||
        (input.installerSha256 && input.installerSha256.toLowerCase() !== release.installerSha256.toLowerCase())) {
      throw new CuratedEvidenceMismatchError();
    }
    return;
  }
  if (input.sourceType === 'custom') return;

  // 0 means "do not check", so it has to survive the ?? below rather than be
  // treated as absent.
  const maliciousThreshold = input.maliciousThreshold ?? 1;
  const architecture = (input.architecture || 'x64').toLowerCase();
  const installerSha256 = input.installerSha256?.trim().toUpperCase() || '';
  const packageProfileSha256 = input.packageProfileSha256?.trim().toUpperCase() || '';
  const reputationHold = (cause?: unknown) => Object.assign(new QaGateNotPassedError({
    wingetId: input.wingetId,
    version: input.version,
    architecture,
    installerSha256,
    packageProfileSha256,
    reason: 'reputation',
  }), cause === undefined ? {} : { cause });

  // Without Supabase the operational QA tables are out of reach, but the
  // published catalog snapshot carries qa_results - so the verdict checks below
  // still run, off the catalog, and a self-hosted install honours the same
  // pass/fail and security decisions the hosted one does.
  const supabase = isSupabaseServerConfigured() ? createServerClient() : null;

  // Reviewed exact-payload compatibility blocks cannot be bypassed. These are
  // upstream or platform safety boundaries, not ordinary QA failures.
  // qa_package_blocks is not part of the snapshot, so this check is Supabase's
  // alone; the catalog verdict below still blocks a failed or malicious build.
  if (installerSha256 && supabase) {
    const compatibilityBlock = await getPackageCompatibilityBlock(supabase, {
      wingetId: input.wingetId,
      version: input.version,
      architecture,
      installerSha256,
    });
    if (compatibilityBlock) {
      throw new QaCompatibilityGateError({
        wingetId: input.wingetId,
        version: input.version,
        architecture,
        installerSha256,
        blockCode: compatibilityBlock.code,
      });
    }
  }

  // The exact-payload VirusTotal checks below read the operational QA tables,
  // so they are Supabase's alone. The operator can switch them off
  // (maliciousThreshold 0) or waive them for one app (securityOverride); both
  // cover the reputation requirement too, since that is a VirusTotal verdict
  // as much as a malicious finding is.
  const checksReputation = Boolean(supabase) && maliciousThreshold > 0 && !input.securityOverride;

  if (checksReputation && !installerSha256) throw reputationHold();

  // Security gate: a malicious VirusTotal verdict for this exact installer
  // blocks packaging even when the installability gate is overridden.
  if (checksReputation && supabase) {
    let securityResult;
    try {
      securityResult = await exactPayloadMaliciousQuery(supabase, {
        wingetId: input.wingetId, version: input.version, architecture, installerSha256,
      }, maliciousThreshold);
    } catch (error) {
      throw reputationHold(error);
    }
    const { data: securityRow, error: securityError } = securityResult;
    if (securityError) throw reputationHold(securityError);
    const malicious = (securityRow?.virustotal_malicious as number | null) ?? 0;
    if (malicious >= maliciousThreshold) {
      throw new QaSecurityGateError({
        wingetId: input.wingetId,
        version: input.version,
        architecture,
        malicious,
        totalEngines: (securityRow?.virustotal_total_engines as number | null) ?? null,
      });
    }

    // A successful lifecycle or an installability override does not establish
    // reputation. Only covered, clean evidence for these exact bytes can admit
    // packaging. QA owns public-installer submission and verdict refreshes.
    let reputationResult;
    try {
      reputationResult = await exactPayloadReputationQuery(supabase, {
        wingetId: input.wingetId, version: input.version, architecture, installerSha256,
      });
    } catch (error) {
      throw reputationHold(error);
    }
    const { data: reputationRow, error: reputationError } = reputationResult;
    if (reputationError) throw reputationHold(reputationError);
    if (!isCoveredReputationBelowThreshold(reputationRow, maliciousThreshold)) throw reputationHold();
  }

  // The catalog verdict is the only security signal a self-hosted install has,
  // so it must be read before the override below rather than after it. A
  // malicious verdict is not something an operator override may wave through -
  // that is the same boundary the Supabase check above enforces when it runs.
  const catalogRow = supabase ? null : await getCatalogSource().getQaResult(input.wingetId);
  // input.architecture, not the 'x64'-defaulted local: matching on the default
  // would let a malicious verdict for another architecture slip past a caller
  // that did not name one, while the verdict check below would still see it.
  if (catalogRow && matchesRequestedPackage(catalogRow, input.wingetId, input.version, input.architecture)) {
    throwIfCatalogVerdictBlocks(catalogRow, {
      securityOnly: true,
      maliciousThreshold,
      securityOverride: input.securityOverride,
    });
  }

  // Check the bundle being dispatched. Callers that only have a payload tuple
  // must resolve it first; a primary pass never covers stale prerequisites.
  // Prerequisite reputation is read from catalog_file_reputation, so like the
  // exact-payload checks above it is Supabase's alone and follows the same
  // operator threshold and waiver. Asking for a server client without Supabase
  // throws, which held every self-hosted deployment for reputation.
  if (checksReputation && supabase) {
    let dependenciesCovered: boolean;
    try {
      const dependencies = input.resolvedPackageDependencies ?? await resolveWingetPackageDependencies({
        wingetId: input.wingetId, version: input.version, architecture, installerSha256,
      });
      dependenciesCovered = await arePackageDependenciesCovered(supabase, dependencies);
    } catch (error) {
      throw reputationHold(error);
    }
    if (!dependenciesCovered) throw reputationHold();
  }

  if (!input.requirePassed && input.qaOverride) return;

  const { data: passedRow, error: passedError } = installerSha256 && supabase
    ? await supabase
        .from('qa_package_results')
        .select('winget_id, tested_version, architecture, installer_sha256, outcome')
        .eq('winget_id', input.wingetId)
        .eq('tested_version', input.version)
        .eq('architecture', architecture)
        .eq('installer_sha256', installerSha256)
        .eq('outcome', 'Passed')
        .order('tested_at_utc', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };
  if (passedError) throw new Error(`Could not read app-version QA result: ${passedError.message}`);
  if (passedRow) return;

  if (input.requirePassed) {
    throw new QaGateNotPassedError({
      wingetId: input.wingetId,
      version: input.version,
      architecture,
      installerSha256,
      packageProfileSha256,
      reason: installerSha256 ? 'missing' : 'installer_sha256',
    });
  }

  const row = catalogRow ?? (await getCatalogSource().getQaResult(input.wingetId));

  if (!row || !matchesRequestedPackage(row, input.wingetId, input.version, input.architecture)) {
    return;
  }

  throwIfCatalogVerdictBlocks(row, {
    maliciousThreshold,
    securityOverride: input.securityOverride,
  });
}

/**
 * Whether a catalog QA row describes the package about to be deployed.
 *
 * A verdict for another version or architecture says nothing about this build,
 * and an installer-preflight run is not a verdict on the packaged app, so
 * neither may block or clear it.
 */
function matchesRequestedPackage(
  row: QaResultRow,
  wingetId: string,
  version: string,
  architecture?: string
): boolean {
  return (
    row.winget_id === wingetId &&
    row.tested_version === version &&
    (!architecture || row.architecture.toLowerCase() === architecture.toLowerCase()) &&
    row.test_level === 'psadt-package'
  );
}

/**
 * Apply a catalog QA verdict.
 *
 * securityOnly runs just the malicious check, for the pass before an operator
 * override is honoured: an override may accept a failed installation test, but
 * never a build antivirus engines flagged.
 */
function throwIfCatalogVerdictBlocks(
  row: QaResultRow,
  options?: {
    securityOnly?: boolean;
    maliciousThreshold?: number;
    securityOverride?: boolean;
  }
): void {
  const maliciousThreshold = options?.maliciousThreshold ?? 1;
  const blocksOnSecurity =
    maliciousThreshold > 0 &&
    !options?.securityOverride &&
    (row.virustotal_malicious ?? 0) >= maliciousThreshold;

  if (blocksOnSecurity) {
    throw new QaSecurityGateError({
      wingetId: row.winget_id,
      version: row.tested_version,
      architecture: row.architecture,
      malicious: row.virustotal_malicious ?? 0,
      totalEngines: row.virustotal_total_engines ?? null,
    });
  }

  if (options?.securityOnly) return;
  if (row.outcome !== 'Failed') return;

  throw new QaGateError({
    wingetId: row.winget_id,
    testedVersion: row.tested_version,
    testedAtUtc: row.tested_at_utc,
    architecture: row.architecture,
    classification: classifyQaFailure(row.phase_results, row.changes),
  });
}
