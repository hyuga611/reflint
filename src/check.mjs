#!/usr/bin/env node
// reflint — reference-integrity checker for AGENTS.md / llms.txt / CLAUDE.md.
//
// 「AI向けの設定ファイルが、もう存在しないコマンド・スクリプト・パスを
//   指していないか」を検証する。表記や文体ではなく "嘘の指示" を落とす。
// 依存ゼロ・言語非依存。CI(GitHub Action)で毎PR走らせるのが本体。
//
//   node src/check.mjs [file ...]     # 省略時は AGENTS.md / llms.txt / CLAUDE.md を自動検出

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// npm/pnpm/yarn が定義なしでも動く組み込みサブコマンドは除外する
export const RESERVED = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'up', 'update',
  'exec', 'dlx', 'create', 'init', 'link', 'publish', 'pack',
]);
export const CODE_EXT = /\.(m?[jt]sx?|json|ya?ml|toml|md|txt|sh|py|rb|go|rs|php|html?|css|lock|env|cfg|ini|xml|svg)$/i;
const DEFAULT_FILES = ['AGENTS.md', 'llms.txt', 'CLAUDE.md'];

export function lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

export function looksLikePath(t) {
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) return false; // URL
  if (t.includes('*')) return false;                // glob はスキップ
  if (t.startsWith('#') || t.startsWith('@')) return false;
  return (t.includes('/') && !t.endsWith('/')) || CODE_EXT.test(t);
}

/**
 * ドキュメント本文を走査して参照エラーを返す（純粋関数・テスト可能）。
 * @param text  ファイル本文
 * @param scripts  package.json の scripts 名の Set（null ならスクリプト検証をスキップ）
 * @param exists  パスの実在判定 `(relPath) => boolean`
 */
export function scan(text, { scripts = null, exists = () => true, codeBlocks = false } = {}) {
  const findings = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const ln = i + 1;

    // フェンス（``` / ~~~）の開閉。マーカ行自体は走査しない。
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      return;
    }

    // 1) `npm run <script>` などが package.json に存在するか
    for (const m of line.matchAll(/\b(?:npm run|pnpm run|yarn run|bun run|pnpm|yarn)\s+([\w:.-]+)/g)) {
      const name = m[1];
      if (RESERVED.has(name)) continue;
      if (scripts && !scripts.has(name)) {
        const near = [...scripts].sort((a, b) => lev(a, name) - lev(b, name))[0];
        const hint = near && lev(near, name) <= 2 ? `（"${near}" では？）` : '';
        findings.push({ ln, kind: 'script', msg: `\`${m[0]}\` — package.json に script "${name}" がありません${hint}` });
      }
    }

    // 2) バッククォートで書かれた参照パスが実在するか
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      if (!looksLikePath(t)) continue;
      if (!exists(t.replace(/^\.\//, ''))) {
        findings.push({ ln, kind: 'path', msg: `参照 \`${t}\` が存在しません` });
      }
    }

    // 3) markdown リンク [text](target) の参照先が実在するか（llms.txt 参照整合の本体）
    //    llms.txt は本文がリンクの束なので、ここがバッククォート検査では拾えない核心。
    //    誤検出ゼロ優先で「リポジトリ相対パス」だけに限定する。
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      // タイトル付き `(path "title")` はパス部分だけ取り出す
      let target = m[1].trim().replace(/\s+["'][^"']*["']\s*$/, '').trim();
      if (!target || target.startsWith('#') || target.startsWith('/')) continue; // 空/アンカー/サイト絶対
      if (/^[a-z][\w+.-]*:/i.test(target)) continue; // http: https: mailto: tel: data: など
      if (!looksLikePath(target)) continue;
      const rel = target.replace(/[#?].*$/, '').replace(/^\.\//, ''); // アンカー/クエリを外して実在判定
      if (rel && !exists(rel)) {
        findings.push({ ln, kind: 'link', msg: `リンク先 \`${target}\` が存在しません` });
      }
    }

    // 4) （opt-in）コードブロック内の裸のパス参照が実在するか。
    //    誤検出ゼロ優先で「拡張子付きのリポ相対パス」だけに限定。--code-blocks で有効化。
    if (codeBlocks && inFence) {
      for (const raw of line.split(/\s+/)) {
        const t = raw.replace(/^[('"`]+/, '').replace(/[)'"`,;:]+$/, '');
        if (!t || t.startsWith('#') || t.startsWith('/')) continue;
        if (/^[a-z][\w+.-]*:/i.test(t)) continue; // scheme (http: など)
        if (!looksLikePath(t) || !CODE_EXT.test(t)) continue; // 拡張子付きのみ
        const rel = t.replace(/^\.\//, '');
        if (!exists(rel)) {
          findings.push({ ln, kind: 'code-path', msg: `コードブロック内の参照 \`${t}\` が存在しません` });
        }
      }
    }
  });
  return findings;
}

function loadScripts(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

export function main(argv) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const root = process.cwd();
  const codeBlocks = argv.includes('--code-blocks') || process.env.REFLINT_CODE_BLOCKS === '1';
  const args = argv.filter((a) => a !== '--' && a !== '--code-blocks');
  const files = args.length ? args : DEFAULT_FILES.filter((f) => existsSync(join(root, f)));

  if (files.length === 0) {
    console.log('reflint: 対象ファイルなし（AGENTS.md / llms.txt / CLAUDE.md）。スキップ。');
    return 0;
  }

  const scripts = loadScripts(root);
  const exists = (p) => existsSync(resolve(root, p));
  let total = 0;

  for (const file of files) {
    let text;
    try {
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      console.error(`reflint: ${file} を読めません`);
      return 2;
    }
    const findings = scan(text, { scripts, exists, codeBlocks });
    if (findings.length === 0) {
      console.log(`✓ ${file} — 参照整合OK`);
      continue;
    }
    total += findings.length;
    console.error(`✗ ${file} — ${findings.length} 件`);
    for (const f of findings) {
      console.error(`  ${file}:${f.ln}\t${f.msg}`);
      // GitHub Actions ではPRにインライン注釈を出す
      if (inActions) console.log(`::error file=${file},line=${f.ln}::${f.msg.replace(/\r?\n/g, ' ')}`);
    }
  }

  if (total > 0) {
    console.error(`\nreflint: ${total} 件の参照エラー`);
    return 1;
  }
  console.log('reflint: すべてOK');
  return 0;
}

// 直接実行された時だけ CLI として動く（import 時は関数だけ公開）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
