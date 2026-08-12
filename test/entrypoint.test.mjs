import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `npm i -g` と `npx` は、どちらもシンボリックリンク越しに CLI を呼ぶ。そのとき argv[1] は
// リンクのパスで、解決済みの実パスである import.meta.url とは一致しない。リンクを解決せずに
// 比較していたため、install した版の CLI は何もせず exit 0 で終わっていた。リンタにとって
// これは最悪の壊れ方で、「問題を見つけなかった」と「一度も動いていない」が区別できず、
// 終了コードを見る CI からも同じに見える。0.9.1 はその状態で公開されていた。
//
// 既存のテストはすべて関数を import して確かめており、bin を一度も実行していなかったので
// 何も気づけなかった。このテストは install と同じ経路で入口を叩く。
// src/check.mjs の realpathSync を戻すと、出力ゼロで落ちる。
test('シンボリックリンク経由でも CLI が動く（npm i -g / npx と同じ経路）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'));
  try {
    const link = join(dir, 'cli.mjs');
    try {
      symlinkSync(resolve('src/check.mjs'), link);
    } catch {
      return; // シンボリックリンクを作る権限が無い環境（開発者モード無効の Windows 等）
    }
    writeFileSync(join(dir, 'AGENTS.md'), '# t\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{}}');

    let out = '';
    try {
      out = execFileSync(process.execPath, [link, dir], { encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '') + String(e.stderr ?? '');
    }
    assert.notEqual(out.trim(), '', 'リンク経由で呼ぶと CLI が何も出力しない＝入口判定が壊れている');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
