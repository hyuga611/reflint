import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, looksLikePath } from '../src/check.mjs';

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
