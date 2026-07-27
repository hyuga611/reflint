import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, looksLikePath, toJson } from '../src/check.mjs';
import reflintRule, { toTextlintErrors, lineStartIndex } from '../src/textlint-rule.mjs';

test('存在しない npm script を検出', () => {
  const f = scan('ビルド: `npm run build`', { scripts: new Set(['poc', 'test']), exists: () => true });
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /build/);
});

test('近い script 名を提案', () => {
  const f = scan('`npm run biuld`', { scripts: new Set(['build']), exists: () => true });
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /"build"/);
});

test('存在しない参照パスを検出', () => {
  const f = scan('パーサ: `src/parser.ts`', { exists: (p) => p !== 'src/parser.ts' });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'path');
});

test('URL・glob・ただの単語は無視', () => {
  assert.equal(looksLikePath('https://example.com/x'), false);
  assert.equal(looksLikePath('src/**/*.ts'), false);
  assert.equal(looksLikePath('word'), false);
  assert.equal(looksLikePath('src/index.ts'), true);
});

test('整合が取れていれば0件', () => {
  const f = scan('`npm run poc` と `src/check.mjs`', { scripts: new Set(['poc']), exists: () => true });
  assert.equal(f.length, 0);
});

test('RESERVED サブコマンドは誤検出しない', () => {
  const f = scan('依存を入れる: `npm install`', { scripts: new Set(['poc']), exists: () => true });
  assert.equal(f.length, 0);
});

// --- llms.txt 参照整合（markdown リンク先の実在チェック）---

test('存在しない markdown リンク先を検出（llms.txt の本体機能）', () => {
  const f = scan('- [ガイド](docs/guide.md): 使い方', { exists: (p) => p !== 'docs/guide.md' });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'link');
  assert.match(f[0].msg, /docs\/guide\.md/);
});

test('存在する markdown リンク先は0件', () => {
  const f = scan('- [ガイド](docs/guide.md)', { exists: () => true });
  assert.equal(f.length, 0);
});

test('外部URL・サイト絶対パス・アンカー・mailto は無視', () => {
  const f = scan('[A](https://example.com/x) [B](/site/abs.html) [C](#sec) [D](mailto:a@b.com)', {
    exists: () => false,
  });
  assert.equal(f.length, 0);
});

test('タイトル付きリンク・アンカー付き相対パスも正しく解決', () => {
  // `docs/a.md "タイトル"` はパス部分だけ、`docs/a.md#sec` はアンカーを外して検査
  const f = scan('[x](docs/a.md "タイトル") と [y](docs/a.md#sec)', { exists: (p) => p === 'docs/a.md' });
  assert.equal(f.length, 0);
});

// --- fenced code block 内のパス抽出（opt-in: codeBlocks）---

const fenced = ['```bash', 'node src/index.js', 'python scripts/gen.py', '```'].join('\n');

test('codeBlocks 無効なら コードブロック内の裸パスは見ない（既定・誤検出ゼロ）', () => {
  const f = scan(fenced, { exists: () => false });
  assert.equal(f.length, 0);
});

test('codeBlocks 有効なら コードブロック内の存在しないパスを検出', () => {
  const f = scan(fenced, { exists: (p) => p === 'src/index.js', codeBlocks: true });
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, 'code-path');
  assert.match(f[0].msg, /scripts\/gen\.py/);
});

test('codeBlocks: フェンスマーカ行・npm/flag・拡張子なしは誤検出しない', () => {
  const body = ['```sh', 'npm install', 'npm run build', 'cd output/dir', 'node app.js --port 3000', '```'].join('\n');
  // build は script 未登録なら 1 件（既存の script 検査）。パスは app.js のみ検査対象。
  const f = scan(body, { scripts: new Set(['build']), exists: (p) => p === 'app.js', codeBlocks: true });
  assert.equal(f.length, 0);
});

// --- textlint ルールアダプタ ---

test('lineStartIndex: 行頭の文字インデックス', () => {
  const t = 'a\nbb\nccc';
  assert.equal(lineStartIndex(t, 1), 0);
  assert.equal(lineStartIndex(t, 2), 2);
  assert.equal(lineStartIndex(t, 3), 5);
});

test('toTextlintErrors: message に reflint: 接頭辞と絶対 index', () => {
  const out = toTextlintErrors([{ ln: 2, msg: 'x' }], 'a\nb');
  assert.equal(out.length, 1);
  assert.match(out[0].message, /^reflint: /);
  assert.equal(out[0].index, 2);
});

test('textlint rule: Document で findings を report する（mock context）', () => {
  const reported = [];
  const ctx = {
    Syntax: { Document: 'Document' },
    RuleError: class {
      constructor(message, opts) {
        this.message = message;
        Object.assign(this, opts);
      }
    },
    report: (node, err) => reported.push(err),
    getSourceCode: () => ({ text: '参照 `src/missing.ts`' }),
  };
  const handlers = reflintRule(ctx, { exists: (p) => p !== 'src/missing.ts', scripts: null });
  handlers['Document']({ type: 'Document' });
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /missing\.ts/);
});

// --- toJson (--format json) ---

test('toJson: results を機械可読な形へ', () => {
  const r = [
    { file: 'AGENTS.md', findings: [{ ln: 3, kind: 'path', msg: 'x' }] },
    { file: 'llms.txt', findings: [] },
  ];
  const j = toJson(r);
  assert.equal(j.ok, false);
  assert.equal(j.count, 1);
  assert.equal(j.findings[0].file, 'AGENTS.md');
  assert.equal(j.findings[0].line, 3);
  assert.equal(j.findings[0].message, 'x');
});

test('toJson: 空なら ok:true', () => {
  assert.deepEqual(toJson([{ file: 'a', findings: [] }]), { ok: true, count: 0, findings: [] });
});

test('Windows絶対パス・NASパスは対象外（性能＆誤検出防止）', () => {
  assert.equal(looksLikePath(String.raw`X:\01\a.md`), false);
  assert.equal(looksLikePath('C:/Users/x/a.md'), false);
  assert.equal(looksLikePath('src/a.md'), true);
});

test('絶対パス/スラッシュコマンド・プレースホルダは対象外', () => {
  assert.equal(looksLikePath('/newpage'), false);
  assert.equal(looksLikePath('foo_<slug>.md'), false);
  assert.equal(looksLikePath('src/a.md'), true);
});

test('散文中のフォーマット名（裸のファイル名）は誤検出しない', () => {
  const text = 'fail the PR when your `AGENTS.md`, `llms.txt`, or `CLAUDE.md` points at a dead path';
  assert.deepEqual(scan(text, { exists: () => false }), []);
});

test('ディレクトリ付きなら同じ名前でも参照として検査する', () => {
  const f = scan('see `docs/llms.txt`', { exists: () => false });
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /docs\/llms\.txt/);
});

test('--ignore で指定した参照は無視される', () => {
  const text = 'see `nope.md`';
  assert.equal(scan(text, { exists: () => false }).length, 1);
  assert.equal(scan(text, { exists: () => false, ignore: new Set(['nope.md']) }).length, 0);
});

test('コードブロック内でもフォーマット名は誤検出しない', () => {
  const text = '```\nAGENTS.md llms.txt src/gone.ts\n```';
  const f = scan(text, { exists: () => false, codeBlocks: true });
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /src\/gone\.ts/);
});
