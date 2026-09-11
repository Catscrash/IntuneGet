import { describe, expect, it } from 'vitest';
import { JobProcessor } from '../src/job-processor';
import type { PackagingJob } from '../src/job-poller';

/**
 * The generated PowerShell is built with template literals, where JavaScript
 * consumes backslash escapes before PowerShell ever sees them: `\s` becomes
 * `s` and `\(` becomes `(`. A regex written as '\(\s+' therefore reaches the
 * endpoint as '(s+' - an unterminated group.
 *
 * PowerShell throws InvalidRegularExpression on that, PSADT exits 60001, and
 * Intune reports the app as failed while the installer itself succeeded. The
 * client-side symptom looks like a broken detection rule, because the IME
 * skips detection after a non-zero exit.
 *
 * Every regex literal in the emitted script has to survive the template, so
 * this asserts on the emitted text rather than on the source.
 */
type ScriptGenerator = {
  getPostInstallVerificationBlock(job: PackagingJob, escapedAppName: string): string;
  getUninstallCommand(job: PackagingJob, fileName: string): string;
};

const generator = JobProcessor.prototype as unknown as ScriptGenerator;

function packagingJob(overrides: Partial<PackagingJob> = {}): PackagingJob {
  return {
    id: 'job-1',
    user_id: 'user-1',
    user_email: 'user@example.com',
    tenant_id: 'tenant-1',
    winget_id: '7zip.7zip',
    version: '26.02',
    display_name: '7-Zip 26.02 (x64 edition)',
    publisher: 'Igor Pavlov',
    architecture: 'x64',
    installer_type: 'wix',
    installer_url: 'https://example.com/7z.msi',
    installer_sha256: 'A'.repeat(64),
    install_command: 'msiexec /i "7z.msi" /qn',
    uninstall_command: 'REGISTRY_UNINSTALL:7-Zip',
    install_scope: 'machine',
    detection_rules: [],
    package_config: { psadtConfig: {} },
    status: 'queued',
    progress_percent: 0,
    created_at: '2026-09-11T07:00:00.000Z',
    ...overrides,
  } as PackagingJob;
}

/** Every `-replace '<pattern>'` in the emitted PowerShell. */
function replacePatterns(script: string): string[] {
  return [...script.matchAll(/-replace\s+'((?:[^']|'')*)'/g)].map((m) => m[1]);
}

describe('generated PowerShell survives the template literal', () => {
  it('emits only valid regex patterns in the uninstall-identity block', () => {
    const script = generator.getPostInstallVerificationBlock(
      packagingJob(),
      '7-Zip 26.02 (x64 edition)'
    );

    const patterns = replacePatterns(script);
    expect(patterns.length).toBeGreaterThan(0);

    for (const pattern of patterns) {
      // (?i) is a .NET inline flag that JavaScript does not accept, so it is
      // translated rather than treated as a defect. What both engines agree on
      // - and what actually broke here - is an unterminated group.
      const forJs = pattern.replace(/^\(\?i\)/, '');
      expect(() => new RegExp(forJs), `invalid pattern: ${pattern}`).not.toThrow();
    }
  });

  it('keeps the whitespace classes that normalise a display name', () => {
    const script = generator.getPostInstallVerificationBlock(
      packagingJob(),
      '7-Zip 26.02 (x64 edition)'
    );

    // The point of these patterns is to collapse "Foo ( )" and "Foo  Bar";
    // with the backslashes eaten they would match the letter "s" instead.
    expect(script).toContain(String.raw`-replace '\(\s+', '('`);
    expect(script).toContain(String.raw`-replace '\s+\)', ')'`);
    expect(script).toContain(String.raw`-replace '\s{2,}', ' '`);
    expect(script).not.toMatch(/-replace\s+'\(s\+'/);
  });

  it('keeps the publisher-prefix separator class', () => {
    const script = generator.getPostInstallVerificationBlock(
      packagingJob(),
      '7-Zip 26.02 (x64 edition)'
    );

    expect(script).toContain(String.raw`'(?:\s+|[._-]+)'`);
    expect(script).not.toContain(`'(?:s+|[._-]+)'`);
  });
});
