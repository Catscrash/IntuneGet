/**
 * Which build of the packager is running.
 *
 * The packager is deployed separately from the web app - a different machine,
 * a different release cadence - so "which version is out there" cannot be
 * answered by looking at the server. It reports this on every job it claims,
 * which also means a finished package records the build that produced it: the
 * question is usually asked after something looks wrong, and by then the
 * packager may already have been upgraded.
 *
 * Resolved from whatever the deployment actually offers, in descending order
 * of trust, and honest when it knows nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface PackagerBuild {
  /** Package version, e.g. "1.4.0". */
  version: string;
  /** Commit the build came from, short form, or "unknown". */
  ref: string;
  /** Where ref came from, so a reader knows how much to trust it. */
  refSource: 'env' | 'package' | 'git' | 'unknown';
}

interface PackageJsonShape {
  version?: string;
  /** Stamped at publish time; absent when running from a checkout. */
  buildRef?: string;
}

function packagerRoot(): string {
  // The package compiles to CommonJS, so __dirname is the module's directory:
  // dist/ at runtime, src/ from a checkout. The package root is one level up
  // from either. Callers that cannot rely on it (tests) pass root explicitly.
  return path.resolve(__dirname, '..');
}

function readPackageJson(root: string): PackageJsonShape {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJsonShape;
  } catch {
    return {};
  }
}

function gitRef(root: string): string | null {
  // Only when the packager runs from a checkout. A published package has no
  // .git, and shelling out there would cost a process per start for nothing.
  if (!existsSync(path.join(root, '..', '.git'))) {
    return null;
  }
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function resolvePackagerBuild(
  env: NodeJS.ProcessEnv = process.env,
  root: string = packagerRoot()
): PackagerBuild {
  const pkg = readPackageJson(root);
  const version = pkg.version || 'unknown';

  // An operator who builds their own image can stamp this without touching the
  // package, so it wins over everything else.
  const fromEnv = env.PACKAGER_BUILD_REF?.trim();
  if (fromEnv) {
    return { version, ref: fromEnv, refSource: 'env' };
  }

  const fromPackage = pkg.buildRef?.trim();
  if (fromPackage) {
    return { version, ref: fromPackage, refSource: 'package' };
  }

  const fromGit = gitRef(root);
  if (fromGit) {
    return { version, ref: fromGit, refSource: 'git' };
  }

  return { version, ref: 'unknown', refSource: 'unknown' };
}

/**
 * One short string for logs and for the server: "1.4.0+abc1234 (git)". Kept
 * compact because it travels on every job claim.
 */
export function formatPackagerBuild(build: PackagerBuild): string {
  return `${build.version}+${build.ref} (${build.refSource})`;
}
