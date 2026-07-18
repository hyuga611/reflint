# agents-lint

**Does your `AGENTS.md` point at commands, scripts, and files that no longer exist?**
A reference-integrity linter for agent config files (`AGENTS.md` / `llms.txt` / `CLAUDE.md`). Language-agnostic. Runs in CI on every PR.

**あなたの `AGENTS.md` は、もう存在しないコマンドやパスを指していませんか？**
AIエージェント向け設定ファイルの **参照整合性 (reference integrity)** を CI で検証するリンタ。表記や文体ではなく、AIに渡す **"嘘の指示" そのもの** を落とす。

---

## Why / なぜ

Agent config rots silently. When it tells the agent to run a script that was renamed, or points at a path that was deleted, the agent trusts it and breaks things. `agents-lint` fails CI before that happens. It checks *facts*, not prose — so it works in any language, and English-speaking repos (where `AGENTS.md` is dense) get it for free.

## Use as a GitHub Action / CIで使う（定着の本体）

```yaml
# .github/workflows/agents-lint.yml
name: agents-lint
on: [push, pull_request]
jobs:
  agents-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <you>/agents-lint@v1     # auto-detects AGENTS.md / llms.txt / CLAUDE.md
```

Findings show up as inline PR annotations, and the job fails (exit 1) so a stale config can't be merged.

## Use as a CLI / ローカルで使う

```bash
npx agents-lint            # AGENTS.md / llms.txt / CLAUDE.md を自動検出
npx agents-lint docs/AGENTS.md llms.txt
```

What it catches:
- `npm run <script>` / `pnpm <script>` etc. that isn't in `package.json` (suggests the nearest name)
- Back-quoted paths that don't exist on disk
- Exit code 1 when anything is wrong = a CI gate

## Roadmap

- [x] Reference-integrity core: npm scripts + file paths (zero-dep) — `src/check.mjs`
- [x] **GitHub Action** (`action.yml`) + inline PR annotations + self-CI
- [ ] Extract commands / paths inside fenced code blocks (remark AST)
- [ ] `llms.txt` link 404 check
- [ ] textlint / markdown-link-check エコシステムへの相乗り

## Dev

```bash
node --test                 # unit tests
npm run poc                 # サンプル(意図的に不整合)で検出デモ → exit 1
node src/check.mjs          # このリポジトリ自身の AGENTS.md を検査 → exit 0
```

MIT
