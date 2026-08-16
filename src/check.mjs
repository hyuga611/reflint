#!/usr/bin/env node
// reflint — reference-integrity checker for AGENTS.md / llms.txt / CLAUDE.md.
//
// 「AI向けの設定ファイルが、もう存在しないコマンド・スクリプト・パスを
//   指していないか」を検証する。表記や文体ではなく "嘘の指示" を落とす。
// 依存ゼロ・言語非依存。CI(GitHub Action)で毎PR走らせるのが本体。
//
//   node src/check.mjs [file ...]     # 省略時は AGENTS.md / llms.txt / CLAUDE.md を自動検出

import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Read rather than hardcoded: a version constant is one more place a release has to
// remember, and the one that nobody notices going stale.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
import { isGitRepo, resolveRef, mergeBase, readAtRef, existsAtRef, scriptsAtRef } from './git.mjs';

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

// リポジトリ全体のパス索引（1回だけ作って使い回す）。
// 実データ監査（公開リポジトリ 139文書・2026-07）で、「存在しない」と報告した参照の 47% が
// 実際にはリポジトリ内に実在していた。`interactive_mode_test.go` と書かれたファイルが
// `internal/cli/interactive_mode_test.go` にある、という類い。人もエージェントも辿れるので落とさない。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor', '.next', '.venv', 'coverage']);
const repoIndexCache = new Map();

function buildRepoIndex(root) {
  const byBase = new Map(); // 基本名 → そのパス群
  const all = [];
  const walk = (dir, rel, depth) => {
    if (depth > 12 || all.length > 60000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      all.push(p);
      if (!byBase.has(e.name)) byBase.set(e.name, []);
      byBase.get(e.name).push(p);
      if (e.isDirectory()) walk(join(dir, e.name), p, depth + 1);
    }
  };
  walk(root, '', 0);
  return { byBase, all };
}

/**
 * .gitignore で意図的に無視されている参照か。
 * 実データ監査（2026-07）で、「存在しない」と報告した参照には、生成物・実行時設定・
 * gitignore 済みファイルが多く混ざっていた（`a365.generated.config.json` は本文に
 * "gitignored" と書いてあった）。git が無視すると宣言しているものを CI で落とすのは筋が悪い。
 * 完全な gitignore 実装ではなく、素のパターン（名前・`*.ext`・`dir/`・先頭 `/`）だけを見る。
 */
const gitignoreCache = new Map();

function loadGitignore(root) {
  if (gitignoreCache.has(root)) return gitignoreCache.get(root);
  let rules = [];
  try {
    rules = readFileSync(join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  } catch {
    rules = [];
  }
  gitignoreCache.set(root, rules);
  return rules;
}

export function isGitIgnored(root, p) {
  const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
  const base = clean.split('/').pop();
  for (const rule of loadGitignore(root)) {
    const r = rule.replace(/^\//, '').replace(/\/$/, '');
    if (!r) continue;
    if (r === clean || r === base) return true;
    if (clean === r || clean.startsWith(r + '/')) return true;
    if (r.startsWith('*.') && base.endsWith(r.slice(1))) return true;
    if (r.endsWith('*') && base.startsWith(r.slice(0, -1))) return true;
  }
  return false;
}

export function existsInRepo(root, p) {
  const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean) return false;
  if (!repoIndexCache.has(root)) repoIndexCache.set(root, buildRepoIndex(root));
  const { byBase, all } = repoIndexCache.get(root);
  if (!clean.includes('/')) return byBase.has(clean);
  const suffix = `/${clean}`;
  return all.some((x) => x.endsWith(suffix));
}

/**
 * 「これはこのリポジトリのパスとして書かれている」と言えるかを、リポジトリ側の事実で決める。
 * 実データ監査（公開リポジトリ 139文書・2026-07）で、拡張子の無い参照の多くはパスではなかった:
 * リポジトリ名（`arnica/depsguard`）、外部リポジトリ（`aosp-mirror/platform_frameworks_base`）、
 * 語の並列（`async/await`）、名前空間（`sdkerrors/errorsmod`）。
 * 拡張子が無いものは、先頭のディレクトリがこのリポジトリに実在するときだけパスとして扱う。
 */
export function isRepoPath(t, exists) {
  if (/\.[A-Za-z0-9]{1,8}$/.test(t)) return true; // 拡張子付きはパスとして書かれている
  const head = t.split('/')[0];
  if (!head || head === t) return false;          // ディレクトリを含まない拡張子なし → パスと断定しない
  return exists(head);
}

/**
 * 「このPRで新しく壊れた参照」だけを残す（純粋関数・テスト可能）。
 * 既存の壊れた参照＝過去の債務は落とさない。行番号が動いただけでは新規と見なさないよう、
 * 位置ではなく「ファイル × 種類 × 参照先」で照合する。
 */
export function diffFindings(baseFindings, headFindings) {
  const key = (f) => `${f.file || ''}\u0000${f.kind}\u0000${f.ref ?? f.msg}`;
  const before = new Set(baseFindings.map(key));
  const fresh = headFindings.filter((f) => !before.has(key(f)));
  return { fresh, preexisting: headFindings.length - fresh.length };
}

export function looksLikePath(t) {
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][\w+.-]*:\/\//i.test(t)) return false; // URL
  if (t.includes('\\')) return false;               // Windows パス（バックスラッシュ）は対象外
  if (/^[a-zA-Z]:/.test(t)) return false;           // ドライブレター絶対パス (C:\ X:\ 等・NASを叩かない)
  if (t.startsWith('/')) return false;              // 絶対パス / スラッシュコマンド (/newpage 等) は対象外
  if (t.includes('<') || t.includes('>')) return false; // テンプレプレースホルダ (foo_<slug>.md 等)
  if (t.includes('{') || t.includes('}')) return false; // 同上 ({type}.md, {{var}}/path 等)
  if (t.includes('(') || t.includes(')')) return false; // 擬似コード (provider/normalize(model_id) 等)
  if (t.includes('"') || t.includes("'")) return false; // 文字列リテラル/Cのinclude ("r_util/r_assert.h" 等)
  if (t.includes('*')) return false;                // glob はスキップ
  if (t.includes('...')) return false;              // 省略記法 (./... , spec/requests/api/... 等)
  if (/^\.[A-Za-z0-9]+$/.test(t)) return false;     // 拡張子そのもの（散文中の「.ts と .js」等）
  // ビルド生成物は「まだ無い」のが正常。作る前のリポジトリで CI を落とさない。
  if (/^(?:\.\/)?(?:dist|build|out|target|coverage|node_modules|\.next|\.output|tmp|temp|\.venv|venv)(?:\/|$)/i.test(t)) return false;
  if (/^[A-Za-z_$][\w$]*\.(?:env|log|lock|tmp)$/.test(t)) return false; // process.env のような式・実行時生成物
  if (t.startsWith('#') || t.startsWith('@')) return false;
  if (t.startsWith('-')) return false;              // CLIフラグ / CSS変数の列挙 (--text-primary/secondary 等)
  // ホーム相対（~/.claude/settings.json 等）は各自のマシンの話で、リポジトリには無い。
  // 実在するものまで「壊れた参照」と言ってしまうので、判定の対象から外す。
  if (t.startsWith('~')) return false;
  // ホスト名で始まるものはパスではない（Goのモジュールパス github.com/x/y、
  // Kubernetes の API グループ coordination.k8s.io/leases 等）。
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(t)) return false;
  return (t.includes('/') && !t.endsWith('/')) || CODE_EXT.test(t);
}

/** テンプレの穴埋めセグメント：`exact/path/to/file.py` `skills/path/SKILL.md` `your-app/main.ts` */
const PLACEHOLDER_SEG =
  /(?:^|\/)(?:path|paths|dir|folder|your[\w-]*|my[\w-]*|foo|bar|baz|example|sample)(?:\/|$)/i;

/**
 * 文書がバッククォート内で宣言した命名パターン（`*.prototype.ts` 等）に一致する参照は、
 * 固定の参照ではなく「読者がこう名付けて作る」対象。
 * openclaw の prototype-openclaw-tui が "name it `*.prototype.ts`" と書いた上で
 * 実行例に具体名を並べており、その6行が誤検知になっていた。
 */
export function declaredGlobMatcher(text) {
  const globs = [];
  for (const m of String(text).matchAll(/`([^`\s]*\*[^`\s]*)`/g)) {
    const g = m[1];
    if (!/[./]/.test(g)) continue; // `*` 単体や `--flag=*` はパターンではない
    const src = g
      .split('*')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    globs.push(new RegExp('^' + src + '$'));
  }
  if (!globs.length) return () => false;
  return (p) => globs.some((re) => re.test(p) || re.test(p.split('/').pop()));
}

/**
 * その行が実際のコマンド起動か。フェンスの中には会話ログや擬似出力も入る
 * （`[Read plan file once: docs/…]` や `PLAN_OR_REQUIREMENTS: Task 2 from docs/…`）。
 * それらはパスを含んでいても、そのファイルを読めという指示ではない。
 */
export function isCommandLine(line) {
  let s = String(line).replace(/^\s+/, '').replace(/^\$\s+/, '');
  if (!s || /^[#[<|>]/.test(s)) return false;
  // 先頭の環境変数代入は読み飛ばす（`CRABBOX_MACOS_TYPES=all scripts/x.sh`）
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(s)) s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '');
  const head = s.split(/\s+/)[0];
  if (!head || head.endsWith(':')) return false; // `KEY: value` 形の擬似出力
  return /^[\w./-]+$/.test(head);
}

/**
 * ドキュメント本文を走査して参照エラーを返す（純粋関数・テスト可能）。
 * @param text  ファイル本文
 * @param scripts  package.json の scripts 名の Set（null ならスクリプト検証をスキップ）
 * @param exists  パスの実在判定 `(relPath) => boolean`
 * @param ignore  追加で無視する参照名の Set（--ignore / reflint.ignore）
 */
// HTML コメントは無効化された記述で、参照ではない（`<!-- 旧: `docs/old.md` -->`）。
// 複数行にまたがるので開閉を状態で持ち、行内の該当区間だけを落とす（行の残りは走査する）。
// 行番号しか報告しないので、桁を保つ必要はない。
function stripHtmlComments(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.open) {
      const end = line.indexOf('-->', i);
      if (end < 0) return out; // 行末までコメントが続く
      state.open = false;
      i = end + 3;
    } else {
      const start = line.indexOf('<!--', i);
      if (start < 0) return out + line.slice(i);
      out += line.slice(i, start);
      state.open = true;
      i = start + 4;
    }
  }
  return out;
}

export function scan(text, { scripts = null, exists = () => true, codeBlocks = false, ignore = new Set() } = {}) {
  // 散文中のフォーマット名（裸のファイル名のみ）と、ユーザー指定の無視リスト。
  const skipProse = (t) => ignore.has(t) || (isBareName(t) && FORMAT_NAMES.has(t));
  const findings = [];
  const suppressed = []; // コード扱いで見送った指摘（件数だけ返す）
  let fence = null; // フェンス内は { ch, len }（開始マーカの文字と長さ）、外は null
  // いったんリポジトリ外へ cd した文書は、以降の相対パスの基準が違う。ブロックを越えて持続する
  // （最初のブロックで `cd ~/Projects/agent-scripts` し、次のブロックからそこの相対で書く形が実在した）。
  let fenceEscaped = false;
  const htmlComment = { open: false };
  // インデントコードブロック（4スペース以上）。リストのネストと区別するため、
  // 「直前が空行」かつ「直前の非空行がリスト項目でない」ときだけ開始する。
  //   - 親                     ← リスト。4スペース下げの子はコードではない
  //       - 子 `path.md`
  // に対して
  //   出力例:                  ← 段落。空行を挟んだ4スペース下げはコード
  //
  //       `path.md`
  let inIndentedCode = false;
  let prevBlank = true;
  let lastNonBlankListy = false;
  const declaredPattern = codeBlocks ? declaredGlobMatcher(text) : () => false;
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const ln = i + 1;
    const line = stripHtmlComments(rawLine, htmlComment);

    // 行をまたぐ状態は early return より先に進めておく。
    const isBlank = line.trim() === '';
    const indentWidth = (/^[ \t]*/.exec(line)[0]).replace(/\t/g, '    ').length;
    const listy = /^[ \t]*(?:[-*+]|\d+[.)])\s/.test(line);
    const prevWasBlank = prevBlank;
    const prevNonBlankListy = lastNonBlankListy;
    prevBlank = isBlank;
    if (!isBlank) lastNonBlankListy = listy;

    // フェンス（``` / ~~~）の開閉。マーカ行自体は走査しない。
    // 閉じは CommonMark に合わせて「開始と同じ文字・開始以上の長さ・情報文字列なし」だけ認める。
    // 素朴な !inFence トグルだと、``` の例を ```` で囲んだ文書でマーカ数が奇数になり、
    // そこから下がずっと「フェンス内」に張り付く（実測 2026-08: 実在の AGENTS.md 118本中1本、
    // 3,461行の文書で見出しや地の文までフェンス内と誤認されていた）。
    const fm = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!fence) fence = { ch, len };
      else if (ch === fence.ch && len >= fence.len && fm[2].trim() === '') fence = null;
      // 閉じ条件を満たさないマーカ行はフェンスの中身。いずれにせよマーカ行は走査しない。
      return;
    }
    const inFence = fence !== null;
    if (inFence && /^\s*\$?\s*cd\s+(~|\/|[A-Za-z]:)/.test(line)) {
      fenceEscaped = true;
      return;
    }
    // インデントコードブロックの開始・終了。空行では状態を変えない（ブロック内の空行を許す）。
    if (!inFence && !isBlank) {
      if (indentWidth >= 4) {
        if (!inIndentedCode && prevWasBlank && !prevNonBlankListy) inIndentedCode = true;
      } else {
        inIndentedCode = false;
      }
    }
    // コード扱いの行は既定では参照とみなさない。--help は --code-blocks を
    // "also check paths inside fenced code blocks" と説明しているのに、この判定を見ていたのは
    // 下の 4) だけで、1)〜3) は素通しだった（＝フラグの有無で結果が変わらなかった）。
    // 見送った分は捨てずに別のバケツへ積み、件数だけ呼び出し側に返す。
    // 「減った」と「見ていない」が区別できないのが一番困るため（0.9.2 と同じ失敗の形）。
    const sink = (inFence || inIndentedCode) && !codeBlocks ? suppressed : findings;

    // 1) `npm run <script>` などが package.json に存在するか
    // 先頭が `-` のトークンはスクリプト名ではなくフラグ。`pnpm -r build` /
    // `pnpm --filter @app/cli test` / `pnpm -w lint` を、それぞれ "-r" "--filter" "-w" という
    // 名前のスクリプトが無い、と報告していた（実測 2026-08: script 検出 39件中 16件がこれ）。
    // フラグが付く形は workspace 単位の実行で、ルートの package.json は判定材料にならないため、
    // 名前を拾わずその呼び出しごと見送る。
    for (const m of line.matchAll(/\b(?:npm run|pnpm run|yarn run|bun run|pnpm|yarn)\s+([\w:.][\w:.-]*)/g)) {
      const name = m[1];
      if (RESERVED.has(name)) continue;
      if (scripts && !scripts.has(name)) {
        const near = [...scripts].sort((a, b) => lev(a, name) - lev(b, name))[0];
        const hint = near && lev(near, name) <= 2 ? ` (did you mean "${near}"?)` : '';
        sink.push({ ln, kind: 'script', ref: name, msg: `\`${m[0]}\` — no script "${name}" in package.json${hint}` });
      }
    }

    // 2) バッククォートで書かれた参照パスが実在するか
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      if (!looksLikePath(t) || skipProse(t)) continue;
      // `path/to/file.rs::symbol` / `utils/file_utils.py:FileProcessor` / `file.ts#anchor`
      // はファイル部分だけを見る（記号名まで含めて実在判定しない）。
      const target = t
        .replace(/^\.\//, '')
        .split('::')[0]
        .replace(/^([^:]*\.[A-Za-z0-9]{1,8}):[A-Za-z_$][\w$]*$/, '$1')
        .replace(/[#?].*$/, '');
      if (!target || !isRepoPath(target, exists)) continue;
      if (!exists(target)) {
        sink.push({ ln, kind: 'path', ref: target, msg: `reference \`${t}\` does not exist` });
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
        sink.push({ ln, kind: 'link', ref: rel, msg: `link target \`${target}\` does not exist` });
      }
    }

    // 4) （opt-in）コードブロック内の裸のパス参照が実在するか。--code-blocks で有効化。
    //
    // 参照はバッククォートやリンク記法で囲まれているとは限らない。実行できる形で書かれた
    // コマンドの引数には囲みが付かないので、囲みだけを見る走査からは構造的に見えない
    // （openclaw/openclaw の control-ui-e2e が壊れたテストパスを指していたのを取りこぼした）。
    //
    // だがフェンスの中身を素朴に拾うと誤検知が支配する。4リポジトリ80スキルの実測で
    // 「拡張子付きなら全部」は 133件出して真の欠陥は1件だった。下の除外は、その133件が
    // 何だったかを1件ずつ見て、判定材料が同じ文書の中にあるものだけを落としている。
    if (codeBlocks && inFence && !fenceEscaped && isCommandLine(line)) {
      for (const raw of line.split(/\s+/)) {
        const t = raw.replace(/^[('"`]+/, '').replace(/[)'"`,;:]+$/, '');
        if (!t || t.startsWith('#') || t.startsWith('/')) continue;
        if (/^[a-z][\w+.-]*:/i.test(t)) continue; // scheme (http: など)
        // 裸のファイル名は、ツール自身が名前で解決する引数（`gh workflow run ci.yml`）。
        // リポジトリ相対として解くと、実在するワークフローを軒並み壊れていると言う。
        if (!t.includes('/')) continue;
        if (t.startsWith('../')) continue; // リポジトリ外
        if (t.includes('$') || t.includes('{')) continue; // 実行時に決まる
        if (!looksLikePath(t) || !CODE_EXT.test(t)) continue; // 拡張子付きのみ
        if (skipProse(t)) continue;
        const rel = t.replace(/^\.\//, '');
        if (PLACEHOLDER_SEG.test(rel)) continue; // `tests/exact/path/to/test.py` 等の穴埋め
        if (declaredPattern(rel)) continue; // 文書が命名パターンとして宣言している
        // 先頭ディレクトリすら無いものは足場が無い＝生成物の置き場か、別プロジェクトの木。
        if (!exists(rel.split('/')[0])) continue;
        if (!exists(rel)) {
          findings.push({ ln, kind: 'code-path', ref: t, msg: `reference \`${t}\` in code block does not exist` });
        }
      }
    }
  });
  // 呼び出し側は戻り値を配列として扱うので、件数は非列挙プロパティで足す
  // （既存の deepEqual ベースのテストと JSON 出力を壊さない）。
  Object.defineProperty(findings, 'skipped', { value: suppressed.length, enumerable: false });
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
export function nearestScripts(startDir, root) {
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
    findings.map((f) => ({ file, line: f.ln || 1, kind: f.kind, ref: f.ref ?? null, message: f.msg })),
  );
  const skipped = results.reduce((n, r) => n + (r.findings.skipped ?? 0), 0);
  return { ok: findings.length === 0, count: findings.length, skipped, findings };
}

const HELP = `reflint ${VERSION} — do the paths in your agent instructions still exist?

  reflint [file ...]        default: AGENTS.md, llms.txt, CLAUDE.md

  --code-blocks             also check paths inside fenced code blocks
  --ignore a,b              skip these paths (repeatable, or REFLINT_IGNORE)
  --since <ref> | --base    only files changed against a git ref ("off" for all)
  --format json | --json    machine-readable output
  -h, --help  ·  -v, --version

  exit 0 nothing to fix (or nothing to check) / 1 findings / 2 could not run
`;

export function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  const root = process.cwd();
  let codeBlocks = argv.includes('--code-blocks') || process.env.REFLINT_CODE_BLOCKS === '1';
  let asJson = argv.includes('--json') || process.env.REFLINT_FORMAT === 'json';
  let since = process.env.REFLINT_SINCE || null;
  const ignore = new Set(
    (process.env.REFLINT_IGNORE || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const files0 = [];
  const unknown = [];
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
    if (a === '--since' || a === '--base') {
      since = argv[i + 1] || null;
      i++;
      continue;
    }
    if (a.startsWith('--since=')) {
      since = a.slice(8);
      continue;
    }
    if (a.startsWith('--base=')) {
      since = a.slice(7);
      continue;
    }
    // A token starting with "-" is never a file. Falling through to files0 made an
    // unrecognised flag a path to check, which then could not be read — so a mistyped
    // CI flag turned a passing lint into "reflint: cannot read --strcit", and the
    // fix somebody reaches for is to delete the step.
    if (a.startsWith('-')) {
      unknown.push(a);
      continue;
    }
    files0.push(a);
  }
  if (unknown.length) {
    console.error(`reflint: unknown option ${unknown.join(', ')}`);
    console.error('reflint: run with --help to see what it takes');
    return 2;
  }
  // GitHub Actions の pull_request では、指定が無くても PR のベースを既定にする。
  // `--since off` は明示的に「全件検査に戻す」の意味。
  if (since === 'off' || since === 'none') since = null;
  else if (!since && process.env.GITHUB_BASE_REF) since = `origin/${process.env.GITHUB_BASE_REF}`;
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
    // それでも見つからないものは、リポジトリ全体から探す（実在するのに書き方が違うだけ、を落とさない）。
    const fileDir = dirname(abs);
    const scripts = nearestScripts(fileDir, root);
    const exists = (p) =>
      existsSync(resolve(fileDir, p)) ||
      existsSync(resolve(root, p)) ||
      existsInRepo(root, p) ||
      isGitIgnored(root, p);
    results.push({ file, findings: scan(text, { scripts, exists, codeBlocks, ignore }) });
  }

  // --since: 既存の壊れた参照（過去の債務）は落とさず、このPRで新しく壊れたものだけを見る。
  // 判定は必ずベース側のツリーに対して行うので、「文書を書き換えて壊した」も
  // 「参照先ファイルを消して壊した」も同じように新規として拾える。
  let preexisting = 0;
  if (since) {
    const err = (m) => {
      if (asJson) console.log(JSON.stringify({ ok: false, error: m }, null, 2));
      else console.error(`reflint: ${m}`);
    };
    if (!isGitRepo()) {
      err(`--since given but this is not a git repository — checking every reference instead`);
      since = null; // 差分が取れなかったのに「新規」と名乗らない
    } else {
      const tip = resolveRef(since);
      if (!tip) {
        err(`cannot resolve ref "${since}" (need git history — try fetch-depth: 0) — checking every reference instead`);
        since = null;
      } else {
        const base = mergeBase(tip, 'HEAD') || tip;
        const baseScripts = scriptsAtRef(base);
        for (const r of results) {
          const baseText = readAtRef(base, r.file);
          if (baseText == null) continue; // ベースに無い＝このPRで追加された文書。全部が新規。
          const baseFindings = scan(baseText, {
            scripts: baseScripts,
            exists: existsAtRef(base, r.file),
            codeBlocks,
            ignore,
          }).map((f) => ({ ...f, file: r.file }));
          const head = r.findings.map((f) => ({ ...f, file: r.file }));
          const d = diffFindings(baseFindings, head);
          preexisting += d.preexisting;
          r.findings = d.fresh;
        }
      }
    }
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

  // 黙った理由は必ず言う（既存の壊れた参照を見逃したのか、そもそも無いのかが分からないのが一番困る）
  const scope = since ? ` new since ${since}` : '';
  const carried = preexisting > 0 ? ` (${preexisting} pre-existing, not failing this run — run without --since to see them)` : '';
  // コードブロックの中で見送った件数。0件と「見ていない」を混同させない。
  const skipped = results.reduce((n, r) => n + (r.findings.skipped ?? 0), 0);
  const held = skipped > 0 ? ` (${skipped} inside code blocks, not checked — run with --code-blocks)` : '';

  if (total > 0) {
    console.error(`\nreflint: ${total}${scope} broken reference${total === 1 ? '' : 's'}${carried}${held}`);
    return 1;
  }
  console.log(`reflint: all references resolve${scope ? ` (no new breakage since ${since})` : ''}${carried}${held}`);
  return 0;
}

// 直接実行された時だけ CLI として動く（import 時は関数だけ公開）
//
// argv[1] は「どう呼ばれたか」のパス。`npm i -g` も `npx` もそこにシンボリックリンクを置くので、
// 解決済みの実パスである import.meta.url とは一致せず、install した版の CLI は何もせずに
// exit 0 で終わっていた。リンタにとってこれは最悪の壊れ方で、「問題を見つけなかった」と
// 「一度も動いていない」が区別できない。比較する前にリンクを解決する。
function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  if (import.meta.url === pathToFileURL(arg).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
