// reflint — 「このPRで新しく壊れた参照だけを落とす」ための最小限の git ヘルパ。
// 依存ゼロ（child_process で git を直接叩く・配列引数なのでシェル解釈なし）。git が無ければ機能ごと無効。

import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 128 * 1024 * 1024,
  });
}

export function isGitRepo() {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** ref/sha をコミットの sha に解決する。できなければ null。 */
export function resolveRef(ref) {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/** 2つの ref の共通祖先（三点差分の基準）。取れなければ null。 */
export function mergeBase(a, b) {
  try {
    return git(['merge-base', a, b]).trim();
  } catch {
    return null;
  }
}

/** その ref で追跡されている全ファイル（リポジトリ相対・posix）。 */
export function filesAtRef(ref) {
  let out;
  try {
    out = git(['ls-tree', '-r', '--name-only', ref]);
  } catch {
    return [];
  }
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** その ref でのファイル内容。存在しなければ null。 */
export function readAtRef(ref, path) {
  try {
    return git(['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * その ref 時点の「実在判定」を作る。
 * 参照が壊れた原因が「文書側の変更」でも「ファイルの削除」でも同じように扱えるように、
 * 判定は必ずその ref のツリーに対して行う（作業ツリーを見ない）。
 * 解決規則は CLI 本体と同じ: そのまま / 文書のあるディレクトリ基準 / 基本名 / 末尾一致。
 */
export function existsAtRef(ref, docPath = '') {
  const paths = filesAtRef(ref);
  const files = new Set(paths);
  const dirs = new Set();
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  const bases = new Set(paths.map((p) => p.split('/').pop()));
  const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const norm = (p) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  return (p) => {
    const c = norm(p);
    if (!c) return false;
    if (files.has(c) || dirs.has(c)) return true;
    if (docDir) {
      const rel = norm(`${docDir}/${c}`);
      if (files.has(rel) || dirs.has(rel)) return true;
    }
    if (!c.includes('/')) return bases.has(c);
    return paths.some((x) => x.endsWith(`/${c}`));
  };
}

/** その ref の package.json の scripts 名。無ければ null（＝スクリプト検証をしない）。 */
export function scriptsAtRef(ref) {
  const text = readAtRef(ref, 'package.json');
  if (text == null) return null;
  try {
    return new Set(Object.keys(JSON.parse(text).scripts || {}));
  } catch {
    return null;
  }
}
