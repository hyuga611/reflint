/**
 * reflint used to treat an unrecognised `--flag` as a path to scan.
 *
 * It did not go silent here, but it produced a message about a path nobody had
 * asked about, from a tool whose job is to explain things. The operator cannot tell a
 * refusal from a broken tool, so they stop trusting either.
 *
 * There was also no `--help` and no `--version`, which is the first thing anyone
 * types after installing.
 *
 * Found by installing the published package and typing `--help`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '..', 'src', 'check.mjs');

function run(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

const empty = () => mkdtempSync(join(tmpdir(), 'agents-lint-cli-'));

test('an unknown option is refused rather than taken as a path', () => {
  const dir = empty();
  try {
    const r = run(['--zzz-not-a-flag'], dir);
    assert.equal(r.code, 2, 'exit 2 is "could not run", distinct from 0 "nothing to fix"');
    assert.match(r.err, /unknown option --zzz-not-a-flag/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--help prints usage and exits 0', () => {
  const dir = empty();
  try {
    for (const flag of ['--help', '-h']) {
      const r = run([flag], dir);
      assert.equal(r.code, 0, flag);
      assert.match(r.out, /^reflint \d+\.\d+\.\d+ /, `${flag} must name the tool and its version`);
      assert.match(r.out, /exit 0/, `${flag} must say what the exit codes mean`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--version prints the version in package.json, not a constant that drifts', async () => {
  const dir = empty();
  try {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
    for (const flag of ['--version', '-v']) {
      const r = run([flag], dir);
      assert.equal(r.code, 0, flag);
      assert.equal(r.out.trim(), pkg.version, flag);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The other half. A tool that refuses a flag it should accept is no better than one
 * that swallows a flag it should refuse — and this is the direction that gets the
 * whole step deleted from CI.
 */
test('a bare run with no arguments is unaffected', () => {
  const dir = empty();
  try {
    const r = run([], dir);
    assert.equal(r.code, 0, 'nothing to check is not a failure');
    assert.doesNotMatch(r.err, /unknown option/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
