import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QaResultRow } from '@/types/qa';

const {
  getQaResultMock,
  getPackageCompatibilityBlockMock,
  getPackageResultMock,
  packageEqMock,
  serverClientMock,
} = vi.hoisted(() => ({
  getQaResultMock: vi.fn(),
  getPackageCompatibilityBlockMock: vi.fn(),
  getPackageResultMock: vi.fn(),
  packageEqMock: vi.fn(),
  serverClientMock: vi.fn(),
}));
vi.mock('@/lib/catalog', () => ({
  getCatalogSource: () => ({ getQaResult: getQaResultMock }),
}));
vi.mock('@/lib/supabase', () => ({
  // The gate reaches for its client through getServerClientOrNull() so it can
  // fall back to the catalog snapshot when there is none.
  getServerClientOrNull: () => serverClientMock(),
}));

function supabaseStub() {
  return {
    from: () => {
      const builder: Record<string, unknown> = {};
      builder.select = vi.fn(() => builder);
      builder.eq = vi.fn((...args: unknown[]) => {
        packageEqMock(...args);
        return builder;
      });
      builder.gte = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.limit = vi.fn(() => builder);
      builder.maybeSingle = getPackageResultMock;
      return builder;
    },
  };
}
vi.mock('@/lib/package-eligibility', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/package-eligibility')>();
  return {
    ...original,
    getPackageCompatibilityBlock: getPackageCompatibilityBlockMock,
  };
});

import {
  enforceQaGate,
  QaCompatibilityGateError,
  QaGateError,
  QaGateNotPassedError,
  QaSecurityGateError,
} from './gate';

const installerSha256 = 'A'.repeat(64);
const packageProfileSha256 = 'B'.repeat(64);

const failedRow = {
  winget_id: 'OpenJS.NodeJS',
  display_name: 'Node.js',
  publisher: 'OpenJS Foundation',
  tested_version: '26.7.0',
  architecture: 'x64',
  outcome: 'Failed',
  installer_sha256: installerSha256,
  tested_at_utc: '2026-08-07T12:00:00Z',
  overall_duration_seconds: 30,
  installer_type: 'msi',
  install_command: 'msiexec /i node.msi /qn',
  uninstall_command: 'msiexec /x {BAD-CODE} /qn',
  detection: { type: 'fileVersion', path: 'C:\\Program Files\\nodejs\\node.exe', minimumVersion: '26.7.0' },
  phase_results: {
    install: { exitCode: 0, durationSeconds: 1, timedOut: false },
    detectionAfterInstall: { exitCode: 0, durationSeconds: 1, timedOut: false },
    uninstall: { exitCode: 1605, durationSeconds: 1, timedOut: false },
    detectionAfterUninstall: null,
  },
  changes: null,
  relevant_event_count: 0,
  environment: null,
  effective_configuration: null,
  qa_schema_version: 1,
  synced_at: '2026-08-07T12:01:00Z',
  test_level: 'psadt-package',
  package_profile_sha256: packageProfileSha256,
  psadt_version: '4.1.8',
  psadt_template_sha256: 'C'.repeat(64),
  psadt_config_sha256: 'D'.repeat(64),
  detection_rules_sha256: 'E'.repeat(64),
  packager_commit: 'f'.repeat(40),
  package_content_sha256: 'F'.repeat(64),
} satisfies QaResultRow;

describe('enforceQaGate', () => {
  beforeEach(() => {
    getQaResultMock.mockReset();
    getPackageCompatibilityBlockMock.mockReset();
    getPackageCompatibilityBlockMock.mockResolvedValue(null);
    getPackageResultMock.mockReset();
    packageEqMock.mockReset();
    serverClientMock.mockReset();
    serverClientMock.mockReturnValue(supabaseStub());
  });

  it('blocks a failed exact version and architecture', async () => {
    getQaResultMock.mockResolvedValue(failedRow);
    await expect(
      enforceQaGate({ wingetId: 'OpenJS.NodeJS', version: '26.7.0', architecture: 'x64' })
    ).rejects.toBeInstanceOf(QaGateError);
  });

  it.each([
    { version: '26.8.0', architecture: 'x64' },
    { version: '26.7.0', architecture: 'arm64' },
  ])('allows stale or architecture-mismatched failures', async (input) => {
    getQaResultMock.mockResolvedValue(failedRow);
    await expect(enforceQaGate({ wingetId: 'OpenJS.NodeJS', ...input })).resolves.toBeUndefined();
  });

  it('allows an explicit override and missing data', async () => {
    getQaResultMock.mockResolvedValue(failedRow);
    await expect(
      enforceQaGate({ wingetId: 'OpenJS.NodeJS', version: '26.7.0', architecture: 'x64', qaOverride: true })
    ).resolves.toBeUndefined();
    getQaResultMock.mockResolvedValue(null);
    await expect(enforceQaGate({ wingetId: 'Unknown.App', version: '1.0' })).resolves.toBeUndefined();
  });

  it('reuses a passed app version regardless of the requested PSADT profile', async () => {
    getPackageResultMock.mockResolvedValue({
      data: { ...failedRow, outcome: 'Passed' },
      error: null,
    });
    await expect(
      enforceQaGate({
        wingetId: 'OpenJS.NodeJS',
        version: '26.7.0',
        architecture: 'x64',
        installerSha256: installerSha256.toLowerCase(),
        packageProfileSha256: 'C'.repeat(64),
        requirePassed: true,
      })
    ).resolves.toBeUndefined();
    expect(packageEqMock).toHaveBeenCalledWith('winget_id', 'OpenJS.NodeJS');
    expect(packageEqMock).toHaveBeenCalledWith('tested_version', '26.7.0');
    expect(packageEqMock).toHaveBeenCalledWith('architecture', 'x64');
    expect(packageEqMock).toHaveBeenCalledWith('installer_sha256', installerSha256);
    expect(packageEqMock).toHaveBeenCalledWith('outcome', 'Passed');
  });

  it('blocks when the app payload has no successful QA result', async () => {
    getPackageResultMock.mockResolvedValue({ data: null, error: null });
    await expect(
      enforceQaGate({
        wingetId: 'OpenJS.NodeJS',
        version: '26.7.0',
        architecture: 'x64',
        installerSha256,
        packageProfileSha256,
        requirePassed: true,
      })
    ).rejects.toBeInstanceOf(QaGateNotPassedError);
  });

  it('blocks packaging when VirusTotal reported a malicious verdict for the exact installer', async () => {
    getPackageResultMock.mockResolvedValueOnce({
      data: { virustotal_malicious: 1, virustotal_total_engines: 72 },
      error: null,
    });
    await expect(
      enforceQaGate({
        wingetId: 'OpenJS.NodeJS',
        version: '26.7.0',
        architecture: 'x64',
        installerSha256,
        packageProfileSha256,
        requirePassed: true,
      })
    ).rejects.toBeInstanceOf(QaSecurityGateError);
  });

  it('does not allow a manual QA override to bypass the security gate', async () => {
    getPackageResultMock.mockResolvedValueOnce({
      data: { virustotal_malicious: 4, virustotal_total_engines: 70 },
      error: null,
    });
    await expect(
      enforceQaGate({
        wingetId: 'OpenJS.NodeJS',
        version: '26.7.0',
        architecture: 'x64',
        installerSha256,
        qaOverride: true,
      })
    ).rejects.toBeInstanceOf(QaSecurityGateError);
  });

  it('does not allow a QA override to bypass an exact compatibility block', async () => {
    getPackageCompatibilityBlockMock.mockResolvedValueOnce({
      wingetId: 'r12f.DivoomGateway',
      version: '0.1.42.0',
      architecture: 'x64',
      installerSha256,
      code: 'expired_signing_certificate',
      detail: 'The signing certificate is expired.',
    });

    await expect(enforceQaGate({
      wingetId: 'r12f.DivoomGateway',
      version: '0.1.42.0',
      architecture: 'x64',
      installerSha256,
      qaOverride: true,
    })).rejects.toBeInstanceOf(QaCompatibilityGateError);

    expect(getPackageResultMock).not.toHaveBeenCalled();
  });

  it('blocks a flagged current version even when its installation test passed', async () => {
    getQaResultMock.mockResolvedValue({
      ...failedRow,
      outcome: 'Passed',
      virustotal_status: 'flagged',
      virustotal_malicious: 2,
      virustotal_total_engines: 72,
    });
    await expect(
      enforceQaGate({ wingetId: 'OpenJS.NodeJS', version: '26.7.0', architecture: 'x64' })
    ).rejects.toBeInstanceOf(QaSecurityGateError);
  });

  it('does not block on suspicious-only or missing VirusTotal verdicts', async () => {
    getQaResultMock.mockResolvedValue({
      ...failedRow,
      outcome: 'Passed',
      virustotal_status: 'suspicious',
      virustotal_malicious: 0,
      virustotal_suspicious: 3,
      virustotal_total_engines: 72,
    });
    await expect(
      enforceQaGate({ wingetId: 'OpenJS.NodeJS', version: '26.7.0', architecture: 'x64' })
    ).resolves.toBeUndefined();
  });

  describe('operator threshold and security override', () => {
    beforeEach(() => {
      serverClientMock.mockReturnValue(null);
      getQaResultMock.mockResolvedValue({
        ...failedRow,
        outcome: 'Passed',
        virustotal_status: 'flagged',
        virustotal_malicious: 2,
        virustotal_total_engines: 75,
      });
    });

    const flagged = {
      wingetId: 'OpenJS.NodeJS',
      version: '26.7.0',
      architecture: 'x64',
      installerSha256,
    };

    it('blocks at the default threshold of one engine', async () => {
      await expect(enforceQaGate(flagged)).rejects.toBeInstanceOf(QaSecurityGateError);
    });

    it('lets a count below the operator threshold through', async () => {
      // 2 of 75 engines is where antivirus false positives live; an operator
      // who raised the bar to 3 has decided that is noise.
      await expect(
        enforceQaGate({ ...flagged, maliciousThreshold: 3 })
      ).resolves.toBeUndefined();
    });

    it('still blocks once the count reaches the operator threshold', async () => {
      await expect(
        enforceQaGate({ ...flagged, maliciousThreshold: 2 })
      ).rejects.toBeInstanceOf(QaSecurityGateError);
    });

    it('checks nothing at a threshold of zero', async () => {
      await expect(
        enforceQaGate({ ...flagged, maliciousThreshold: 0 })
      ).resolves.toBeUndefined();
    });

    it('honours an explicit security override', async () => {
      await expect(
        enforceQaGate({ ...flagged, securityOverride: true })
      ).resolves.toBeUndefined();
    });

    it('does not let the QA override waive a security finding', async () => {
      // The two are separate decisions: accepting a failed installation test
      // must not silently accept an antivirus finding as well.
      await expect(
        enforceQaGate({ ...flagged, qaOverride: true })
      ).rejects.toBeInstanceOf(QaSecurityGateError);
    });

    it('does not let the security override waive a failed installation test', async () => {
      // ... and the reverse, so neither override widens beyond its own scope.
      getQaResultMock.mockResolvedValue({ ...failedRow, virustotal_malicious: null });

      await expect(
        enforceQaGate({ ...flagged, securityOverride: true })
      ).rejects.toBeInstanceOf(QaGateError);
    });
  });

  describe('without Supabase (self-hosted, catalog snapshot only)', () => {
    // qa_results ships in the published catalog snapshot, so a self-hosted
    // install can honour the same verdicts the hosted one does. The
    // operational tables (qa_package_results, qa_package_blocks) do not, so
    // those checks simply do not run rather than crashing the deployment.
    beforeEach(() => {
      serverClientMock.mockReturnValue(null);
    });

    it('still blocks a build the catalog reports as failed', async () => {
      getQaResultMock.mockResolvedValue(failedRow);

      await expect(
        enforceQaGate({
          wingetId: 'OpenJS.NodeJS',
          version: '26.7.0',
          architecture: 'x64',
          installerSha256,
        })
      ).rejects.toBeInstanceOf(QaGateError);
    });

    it('still blocks a build the catalog reports as malicious', async () => {
      getQaResultMock.mockResolvedValue({
        ...failedRow,
        outcome: 'Passed',
        virustotal_status: 'flagged',
        virustotal_malicious: 4,
        virustotal_total_engines: 70,
      });

      await expect(
        enforceQaGate({
          wingetId: 'OpenJS.NodeJS',
          version: '26.7.0',
          architecture: 'x64',
          installerSha256,
          // Even the operator's own override must not get past this one.
          qaOverride: true,
        })
      ).rejects.toBeInstanceOf(QaSecurityGateError);
    });

    it('lets an untested app through rather than blocking every deployment', async () => {
      // Nothing marks a package "passed" without a QA pipeline, so treating
      // "no verdict" as a failure would block the whole catalog.
      getQaResultMock.mockResolvedValue(null);

      await expect(
        enforceQaGate({
          wingetId: 'OpenJS.NodeJS',
          version: '26.7.0',
          architecture: 'x64',
          installerSha256,
        })
      ).resolves.toBeUndefined();
    });

    it('blocks a malicious verdict even when the caller names no architecture', async () => {
      getQaResultMock.mockResolvedValue({
        ...failedRow,
        outcome: 'Passed',
        architecture: 'arm64',
        virustotal_status: 'flagged',
        virustotal_malicious: 2,
        virustotal_total_engines: 70,
      });

      await expect(
        enforceQaGate({
          wingetId: 'OpenJS.NodeJS',
          version: '26.7.0',
          installerSha256,
          qaOverride: true,
        })
      ).rejects.toBeInstanceOf(QaSecurityGateError);
    });

    it('lets a build the catalog reports as passed through', async () => {
      getQaResultMock.mockResolvedValue({ ...failedRow, outcome: 'Passed' });

      await expect(
        enforceQaGate({
          wingetId: 'OpenJS.NodeJS',
          version: '26.7.0',
          architecture: 'x64',
          installerSha256,
        })
      ).resolves.toBeUndefined();
    });

    it('never reaches for a Supabase client', async () => {
      getQaResultMock.mockResolvedValue(null);

      await enforceQaGate({
        wingetId: 'OpenJS.NodeJS',
        version: '26.7.0',
        architecture: 'x64',
        installerSha256,
      });

      expect(getPackageResultMock).not.toHaveBeenCalled();
      expect(getPackageCompatibilityBlockMock).not.toHaveBeenCalled();
    });
  });

  it('does not allow a manual override to bypass strict automatic QA', async () => {
    getPackageResultMock.mockResolvedValue({ data: null, error: null });
    await expect(
      enforceQaGate({
        wingetId: 'OpenJS.NodeJS',
        version: '26.7.0',
        architecture: 'x64',
        installerSha256,
        packageProfileSha256,
        requirePassed: true,
        qaOverride: true,
      })
    ).rejects.toBeInstanceOf(QaGateNotPassedError);
  });
});
