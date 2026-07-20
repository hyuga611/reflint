# reflint

**In any language, fail the PR when your `AGENTS.md`, `llms.txt`, or `CLAUDE.md` points at a command, script, or path that no longer exists.**
`reflint` is a *reference-integrity* linter for agent config files. It doesn't grade style or prose — it checks whether the references are **real**: the scripts, paths, and files your config tells an AI agent to use. Zero-dependency, language-agnostic, runs in CI on every PR.

**`AGENTS.md` や `llms.txt` の中の「もう解決できない参照」を、どのスタックでも毎PRで落とす。**
AIエージェント向け設定ファイルの **参照整合性 (reference integrity)** を CI で検証するリンタ。表記や文体ではなく、AIに渡す **"嘘の指示" そのもの** ── 存在しないコマンド・スクリプト・パス ── を落とす。依存ゼロ・言語非依存。

---

## Why / なぜ

Agent config rots silently. When it tells the agent to run a script that was renamed, or points at a path that was deleted, the agent trusts it and breaks things. `reflint` fails CI before that happens. It checks *facts*, not prose — so it works in any stack (Go, Rust, Python, Ruby, JS…), and it treats `llms.txt` as a first-class target, which the rest of the ecosystem's format validators don't check for real references.

## Use as a GitHub Action / CIで使う（定着の本体）

```yaml
# .github/workflows/reflint.yml
name: reflint
on: [push, pull_request]
jobs:
  reflint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hyuga611/reflint@v1     # auto-detects AGENTS.md / llms.txt / CLAUDE.md
```

Findings show up as inline PR annotations, and the job fails (exit 1) so a stale config can't be merged.

## Use as a CLI / ローカルで使う

```bash
npx reflint            # AGENTS.md / llms.txt / CLAUDE.md を自動検出
npx reflint docs/AGENTS.md llms.txt
```

What it catches:
- Back-quoted paths/files that don't exist on disk — **language-agnostic** (works in any repo)
- `npm run <script>` / `pnpm <script>` etc. that isn't in `package.json` (suggests the nearest name) — for JS repos
- Exit code 1 when anything is wrong = a CI gate

## Roadmap

- [x] Reference-integrity core: file paths (any language) + npm scripts (zero-dep) — `src/check.mjs`
- [x] **GitHub Action** (`action.yml`) + inline PR annotations + self-CI
- [ ] `llms.txt` link/path referential integrity (the wedge no one else covers in CI)
- [ ] Extract commands / paths inside fenced code blocks (remark AST)
- [ ] textlint / markdown-link-check エコシステムへの相乗り

## Dev

```bash
node --test                 # unit tests
npm run poc                 # サンプル(意図的に不整合)で検出デモ → exit 1
node src/check.mjs          # このリポジトリ自身の AGENTS.md を検査 → exit 0
```

MIT
