import { getCatalogSource } from '@/lib/catalog';
import { classifyQaFailure } from '@/lib/qa/classify';
import { getServerClientOrNull } from '@/lib/supabase';
import {
  getPackageCompatibilityBlock,
  type PackageCompatibilityBlockCode,
} from '@/lib/package-eligibility';
import type { QaClassification, QaResultRow } from '@/types/qa';

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
        | 'package_profile';
    }
  ) {
    super(
      `Installation testing has not passed yet for ${details.wingetId} ${details.version} (${details.architecture})`
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
  sourceType?: 'winget' | 'custom';
}): Promise<void> {
  if (input.sourceType === 'custom') return;

  // 0 means "do not check", so it has to survive the ?? below rather than be
  // treated as absent.
  const maliciousThreshold = input.maliciousThreshold ?? 1;
  const architecture = (input.architecture || 'x64').toLowerCase();
  const installerSha256 = input.installerSha256?.trim().toUpperCase() || '';
  const packageProfileSha256 = input.packageProfileSha256?.trim().toUpperCase() || '';

  // Without Supabase the operational QA tables are out of reach, but the
  // published catalog snapshot carries qa_results - so the verdict checks below
  // still run, off the catalog, and a self-hosted install honours the same
  // pass/fail and security decisions the hosted one does.
  const supabase = getServerClientOrNull();

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

  // Security gate: a malicious VirusTotal verdict for this exact installer
  // blocks packaging even when the installability gate is overridden.
  if (installerSha256 && supabase && maliciousThreshold > 0 && !input.securityOverride) {
    const { data: securityRow, error: securityError } = await supabase
      .from('qa_package_results')
      .select('virustotal_malicious, virustotal_total_engines')
      .eq('winget_id', input.wingetId)
      .eq('tested_version', input.version)
      .eq('architecture', architecture)
      .eq('installer_sha256', installerSha256)
      .gte('virustotal_malicious', maliciousThreshold)
      .order('tested_at_utc', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (securityError) {
      throw new Error(`Could not read the installer security verdict: ${securityError.message}`);
    }
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
