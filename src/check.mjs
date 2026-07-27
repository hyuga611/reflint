#!/usr/bin/env node
// reflint — reference-integrity checker for AGENTS.md / llms.txt / CLAUDE.md.
//
// 「AI向けの設定ファイルが、もう存在しないコマンド・スクリプト・パスを
//   指していないか」を検証する。表記や文体ではなく "嘘の指示" を落とす。
// 依存ゼロ・言語非依存。CI(GitHub Action)で毎PR走らせるのが本体。
//
//   node src/check.mjs [file ...]     # 省略時は AGENTS.md / llms.txt / CLAUDE.md を自動検出

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// npm/pnpm/yarn が定義なしでも動く組み込みサブコマンドは除外する
export const RESERVED = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'up', 'update',
  'exec', 'dlx', 'create', 'init', 'link', 'publish', 'pack',
]);
export const CODE_EXT = /\.(m?[jt]sx?|json|ya?ml|toml|md|txt|sh|py|rb|go|rs|php|html?|css|lock|env|cfg|ini|xml|svg)$/i;
const DEFAULT_FILES = ['AGENTS.md', 'llms.txt', 'CLAUDE.md'];

// 散文で「フォーマット名」として言及されるだけの裸のファイル名は、実在しなくても
// 参照エラーではない（例: "your `AGENTS.md`, `llms.txt`, or `CLAUDE.md`"）。
// ディレクトリ区切りを含む書き方（`docs/llms.txt`）は明示的な参照なので対象のまま。
// リンタは誤検出ひとつで捨てられるので、ここは検出漏れより精度を優先する。
export const FORMAT_NAMES = new Set([
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SKILL.md', 'README.md',
  'llms.txt', 'llms-full.txt', '.cursorrules', '.windsurfrules',
]);

/** 裸のファイル名（ディレクトリを含まない）か。 */
function isBareName(t) {
  return !t.includes('/');
}

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
  if (t.includes('\\')) return false;               // Windows パス（バックスラッシュ）は対象外
  if (/^[a-zA-Z]:/.test(t)) return false;           // ドライブレター絶対パス (C:\ X:\ 等・NASを叩かない)
  if (t.startsWith('/')) return false;              // 絶対パス / スラッシュコマンド (/newpage 等) は対象外
  if (t.includes('<') || t.includes('>')) return false; // テンプレプレースホルダ (foo_<slug>.md 等)
  if (t.includes('*')) return false;                // glob はスキップ
  if (t.startsWith('#') || t.startsWith('@')) return false;
  return (t.includes('/') && !t.endsWith('/')) || CODE_EXT.test(t);
}

/**
 * ドキュメント本文を走査して参照エラーを返す（純粋関数・テスト可能）。
 * @param text  ファイル本文
 * @param scripts  package.json の scripts 名の Set（null ならスクリプト検証をスキップ）
 * @param exists  パスの実在判定 `(relPath) => boolean`
 * @param ignore  追加で無視する参照名の Set（--ignore / reflint.ignore）
 */
export function scan(text, { scripts = null, exists = () => true, codeBlocks = false, ignore = new Set() } = {}) {
  // 散文中のフォーマット名（裸のファイル名のみ）と、ユーザー指定の無視リスト。
  const skipProse = (t) => ignore.has(t) || (isBareName(t) && FORMAT_NAMES.has(t));
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
        const hint = near && lev(near, name) <= 2 ? ` (did you mean "${near}"?)` : '';
        findings.push({ ln, kind: 'script', msg: `\`${m[0]}\` — no script "${name}" in package.json${hint}` });
      }
    }

    // 2) バッククォートで書かれた参照パスが実在するか
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      if (!looksLikePath(t) || skipProse(t)) continue;
      if (!exists(t.replace(/^\.\//, ''))) {
        findings.push({ ln, kind: 'path', msg: `reference \`${t}\` does not exist` });
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
      if (!looksLikePath(target) || ignore.has(target)) continue;
      const rel = target.replace(/[#?].*$/, '').replace(/^\.\//, ''); // アンカー/クエリを外して実在判定
      if (rel && !exists(rel)) {
        findings.push({ ln, kind: 'link', msg: `link target \`${target}\` does not exist` });
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
        if (skipProse(t)) continue;
        const rel = t.replace(/^\.\//, '');
        if (!exists(rel)) {
          findings.push({ ln, kind: 'code-path', msg: `reference \`${t}\` in code block does not exist` });
        }
      }
    }
  });
  return findings;
}

function loadScripts(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

/** monorepo 対応：ファイルの位置から上へ辿り、最も近い package.json の scripts を返す。 */
function nearestScripts(startDir, root) {
  let dir = resolve(startDir);
  const rootAbs = resolve(root);
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, 'package.json'))) return loadScripts(dir);
    if (dir === rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** results（[{file, findings}]）を機械可読な JSON 形へ（純粋・テスト可能）。 */
export function toJson(results) {
  const findings = results.flatMap(({ file, findings }) =>
    findings.map((f) => ({ file, line: f.ln || 1, kind: f.kind, message: f.msg })),
  );
  return { ok: findings.length === 0, count: findings.length, findings };
}

export function main(argv) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const root = process.cwd();
  let codeBlocks = argv.includes('--code-blocks') || process.env.REFLINT_CODE_BLOCKS === '1';
  let asJson = argv.includes('--json') || process.env.REFLINT_FORMAT === 'json';
  const ignore = new Set(
    (process.env.REFLINT_IGNORE || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const files0 = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--' || a === '--code-blocks' || a === '--json') continue;
    if (a === '--ignore') {
      for (const n of (argv[i + 1] || '').split(',')) if (n.trim()) ignore.add(n.trim());
      i++;
      continue;
    }
    if (a.startsWith('--ignore=')) {
      for (const n of a.slice(9).split(',')) if (n.trim()) ignore.add(n.trim());
      continue;
    }
    if (a === '--format') {
      if (argv[i + 1] === 'json') asJson = true;
      i++;
      continue;
    }
    if (a.startsWith('--format=')) {
      if (a.slice(9) === 'json') asJson = true;
      continue;
    }
    files0.push(a);
  }
  const files = files0.length ? files0 : DEFAULT_FILES.filter((f) => existsSync(join(root, f)));

  if (files.length === 0) {
    if (asJson) console.log(JSON.stringify({ ok: true, count: 0, findings: [] }, null, 2));
    else console.log('reflint: no target file found (AGENTS.md / llms.txt / CLAUDE.md) — skipping.');
    return 0;
  }

  const results = [];
  for (const file of files) {
    const abs = resolve(root, file);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      if (asJson) console.log(JSON.stringify({ ok: false, error: `cannot read ${file}` }, null, 2));
      else console.error(`reflint: cannot read ${file}`);
      return 2;
    }
    // monorepo: scripts は最も近い package.json、パス実在はファイル位置 or リポ root で解決。
    const fileDir = dirname(abs);
    const scripts = nearestScripts(fileDir, root);
    const exists = (p) => existsSync(resolve(fileDir, p)) || existsSync(resolve(root, p));
    results.push({ file, findings: scan(text, { scripts, exists, codeBlocks, ignore }) });
  }

  const total = results.reduce((n, r) => n + r.findings.length, 0);

  if (asJson) {
    console.log(JSON.stringify(toJson(results), null, 2));
    return total > 0 ? 1 : 0;
  }

  for (const { file, findings } of results) {
    if (findings.length === 0) {
      console.log(`✓ ${file} — all references resolve`);
      continue;
    }
    console.error(`✗ ${file} — ${findings.length} broken reference${findings.length === 1 ? '' : 's'}`);
    for (const f of findings) {
      console.error(`  ${file}:${f.ln}\t${f.msg}`);
      // GitHub Actions ではPRにインライン注釈を出す
      if (inActions) console.log(`::error file=${file},line=${f.ln}::${f.msg.replace(/\r?\n/g, ' ')}`);
    }
  }

  if (total > 0) {
    console.error(`\nreflint: ${total} broken reference${total === 1 ? '' : 's'}`);
    return 1;
  }
  console.log('reflint: all references resolve');
  return 0;
}

// 直接実行された時だけ CLI として動く（import 時は関数だけ公開）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
