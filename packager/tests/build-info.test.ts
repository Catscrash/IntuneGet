import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagerBuild, formatPackagerBuild } from '../src/build-info';

let root: string;

function writePackageJson(contents: Record<string, unknown>) {
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(contents));
}

describe('resolvePackagerBuild', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'packager-build-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the version from the package', () => {
    writePackageJson({ version: '1.4.0' });

    expect(resolvePackagerBuild({}, root).version).toBe('1.4.0');
  });

  it('prefers an explicitly stamped ref over everything else', () => {
    // An operator building their own image can stamp this without touching the
    // package, so it has to win.
    writePackageJson({ version: '1.4.0', buildRef: 'from-package' });

    expect(resolvePackagerBuild({ PACKAGER_BUILD_REF: 'from-env' }, root)).toEqual({
      version: '1.4.0',
      ref: 'from-env',
      refSource: 'env',
    });
  });

  it('falls back to the ref stamped into the package at publish time', () => {
    writePackageJson({ version: '1.4.0', buildRef: 'abc1234' });

    expect(resolvePackagerBuild({}, root)).toEqual({
      version: '1.4.0',
      ref: 'abc1234',
      refSource: 'package',
    });
  });

  it('says so rather than guessing when nothing identifies the build', () => {
    // A published package outside a checkout: reporting a wrong commit would
    // be worse than admitting there is none.
    writePackageJson({ version: '1.4.0' });

    expect(resolvePackagerBuild({}, root)).toEqual({
      version: '1.4.0',
      ref: 'unknown',
      refSource: 'unknown',
    });
  });

  it('survives an unreadable package.json', () => {
    expect(resolvePackagerBuild({}, root)).toEqual({
      version: 'unknown',
      ref: 'unknown',
      refSource: 'unknown',
    });
  });

  it('does not invent a ref when a checkout marker is present', () => {
    // The .git marker sits next to the package root, as in the repository.
    mkdirSync(path.join(root, 'pkg'));
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'pkg', 'package.json'), JSON.stringify({ version: '1.4.0' }));

    const build = resolvePackagerBuild({}, path.join(root, 'pkg'));

    // git may refuse (the marker is a bare directory, not a repository);
    // either way it must not throw and must not make something up.
    expect(['git', 'unknown']).toContain(build.refSource);
    expect(build.version).toBe('1.4.0');
  });
});

describe('formatPackagerBuild', () => {
  it('is compact enough to travel on every claim', () => {
    expect(
      formatPackagerBuild({ version: '1.4.0', ref: 'abc1234', refSource: 'git' })
    ).toBe('1.4.0+abc1234 (git)');
  });
});
