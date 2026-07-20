// textlint rule adapter for reflint（experimental）。
// 既に textlint をドキュメントに回しているなら、別のCIステップを足さずに
// reflint の「参照整合」検査を同じ textlint パスへ相乗りさせるためのルール。
//
// 使い方（プログラマティック・@textlint/kernel、最も確実）:
//   import { TextlintKernel } from "@textlint/kernel";
//   import reflint from "@hyuga/reflint/textlint-rule";
//   kernel.lintText(text, { ..., rules: [{ ruleId: "reflint", rule: reflint }] });
//
// textlint 本体の位置APIはバージョン差があるため、報告は index パディングで行う。
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { scan } from './check.mjs';

function loadScripts(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

/** 1-based 行番号 → その行頭の 0-based 文字インデックス。 */
export function lineStartIndex(text, line) {
  const parts = String(text).split('\n');
  let idx = 0;
  for (let i = 0; i < line - 1 && i < parts.length; i++) idx += parts[i].length + 1;
  return idx;
}

/** scan の findings を textlint 報告用（message + 絶対 index）に整形（純粋・テスト可能）。 */
export function toTextlintErrors(findings, text) {
  return findings.map((f) => ({
    message: `reflint: ${f.msg}`,
    index: lineStartIndex(text, f.ln || 1),
    line: f.ln || 1,
  }));
}

/**
 * textlint ルール本体。context は textlint が注入する。
 * options: { codeBlocks?, cwd?, exists?, scripts? }（exists/scripts は主にテスト用の差し込み）。
 */
const reflintRule = (context, options = {}) => {
  const { Syntax, RuleError, report } = context;
  const root = options.cwd || process.cwd();
  const exists = options.exists || ((p) => existsSync(resolve(root, p)));
  const scripts = options.scripts !== undefined ? options.scripts : loadScripts(root);
  const getText = () =>
    (context.getSourceCode && context.getSourceCode().text) ||
    (context.getSource && context.getSource()) ||
    '';
  return {
    [Syntax.Document](node) {
      const text = getText();
      const findings = scan(text, { scripts, exists, codeBlocks: !!options.codeBlocks });
      for (const e of toTextlintErrors(findings, text)) {
        report(node, new RuleError(e.message, { index: e.index }));
      }
    },
  };
};

export default reflintRule;
