# Changelog

## 0.9.2

- **`npm i -g` や `npx` で入れた CLI が、何もせずに終了していた。** 入口判定が `process.argv[1]` を
  そのまま `import.meta.url` と比べていた。この2つはシンボリックリンク越しに呼ばれると一致しない
  （`argv[1]` はリンク、`import.meta.url` は解決済みの実パス）ので、install した版は本体を一度も
  実行しないまま exit 0 で終わっていた。リンタにとってこれは最悪の壊れ方で、「問題を見つけなかった」
  と「一度も動いていない」が区別できない。終了コードを読む CI からも同じに見えるので、これを CI に
  入れていた人は、何も守られていない状態で緑を見ていたことになる。公開物を clean なコンテナに
  `npm i -g` して測った結果は、修正前が出力0バイト、修正後は出力あり。
- リンクを解決してから比較するようにし、`test/entrypoint.test.mjs` を追加した。既存のテストは
  すべて関数を import して確かめており、bin を一度も実行していなかったので何も気づけなかった。
  この修正を戻すと、このテストは落ちる（確認済み）。

## 0.9.1

- **The copyright holder in `LICENSE` is now `hyuga611`**, matching every other package
  published from this account. The terms were MIT either way; what changed is that the grant
  no longer appears to come from two different parties, which left anyone trying to work out
  who they had received permission from with two answers and no way to choose.
- Releases are now made by pushing a tag: the workflow runs the tests, refuses to publish if
  the tag and `package.json` disagree, and publishes with
  [provenance](https://docs.npmjs.com/generating-provenance-statements) using npm trusted
  publishing, so no long-lived token is stored anywhere.

## 0.9.0

**`--code-blocks` went from 0.75% precision to 50%, measured on 80 skills across 4 repositories.**

The flag existed because a reference is not always wrapped in backticks or link syntax. A path
written as a runnable command argument carries no markup at all, so a scanner that only reads
`` `code` `` spans and `[text](target)` cannot see it. That blind spot is not theoretical: in
`openclaw/openclaw`, `.agents/skills/control-ui-e2e/SKILL.md` told the agent to run a test file
that had been renamed, and the audit missed it. Eight lines above, the same file names a path in
prose with backticks — that one was caught. The only difference was the markup.

But reading fenced blocks naively made false positives the dominant output. Turning the flag on
across `openclaw/openclaw` (46 skills), `anthropics/skills` (18), `obra/superpowers` (14) and
`openclaw/clawsweeper` (2) produced **133 findings, of which 1 was a real defect.** Every one of
the other 132 was read individually; each turned out to carry its own disqualifying signal, in the
same document. The flag now uses them:

- **A bare filename is not a repository path.** `gh workflow run release.yml` passes a name that
  the tool resolves itself. Resolving it repository-relative reported workflows that plainly exist.
  A candidate now needs a `/`.
- **A path whose first segment does not exist has no foothold.** This is what `.artifacts/…` and
  `jobs/…` are — output locations, absent by design — and what another project's tree looks like.
- **`cd` out of the repository changes the frame of reference, and it stays changed.** One skill
  ran `cd ~/Projects/agent-scripts` in its first block and wrote paths relative to *that* checkout
  in later ones.
- **A naming pattern the document declares is something the reader creates.** A skill that says
  "name it `*.prototype.ts`" and then shows `src/wizard/setup.…prototype.ts` is not referencing a
  file it ships.
- **A fence can hold a transcript instead of a command.** `[Read plan file once: docs/…]` and
  `PLAN_OR_REQUIREMENTS: Task 2 from docs/…` name paths without asking anything to be read. A line
  must now look like a command invocation (leading `VAR=value` assignments are still read through).
- **`exact/path/to/file.py` and `skills/path/SKILL.md` are template blanks**, not references.

Result on the same corpus: **2 findings, 1 real.** The survivor is instructive and is the reason
this flag stays opt-in. `openclaw/clawsweeper`'s `crabbox` skill runs
`scripts/macos-host-region-preflight.sh`, which is absent from clawsweeper and present in
`openclaw/crabbox` — the sibling repository the skill exists to document. No signal inside the
document distinguishes that from a genuinely dead path, because the answer depends on which
checkout the agent is standing in. A cross-repository reference is irreducibly ambiguous here.

Also exported `declaredGlobMatcher` and `isCommandLine` so the two judgements can be tested and
reused. Default behaviour is unchanged: without `--code-blocks`, fenced content is still skipped.

## 0.8.3

- **Stopped reporting home-relative paths as broken references.** A reference beginning with
  `~` — `~/.claude/settings.json`, `~/.config/app/config.toml` — was resolved against the
  repository, where it could never exist, so reflint called it broken even when the file was
  plainly there on the machine. Any config file documenting where a tool keeps its data hit this.
  Such paths are now left alone: they describe the reader's machine, and reflint has no way to
  check them. Repository-relative paths are unaffected.
- **Exported `nearestScripts`, `existsInRepo` and `isGitIgnored`.** `scan()` was already public, but
  the resolvers its accuracy depends on were not: an outside caller could not reproduce the
  `exists` predicate `main()` builds (file dir → repo root → repo-wide index → `.gitignore`), and a
  naive `existsSync` substitute reports references as missing that reflint itself does not. Callers
  can now compose the same predicate. No behaviour change to the CLI or its output.
- **Replaced the two raw NUL bytes in `diffFindings`'s composite key with `\u0000` escapes.** The
  key still separates its fields with U+0000 — the string the code builds is byte-for-byte what it
  was — but the source file is now plain text. As literal bytes they made `grep`, `git diff` and
  every other line-oriented tool treat the file as binary, and any editor or transport that strips
  control characters would have silently corrupted the delimiter.

## 0.8.1

- `--format json` now actually emits the `ref` field 0.8.0 said it did (`null` when a finding has
  none). Caught by running the published package against a fixture repository rather than the
  working copy.

## 0.8.0

**Adoptable on a repository that already has stale references.**

The 2026-07 audit left reflint reporting something in 40% of real-world documents. About 80% of
those are genuine — a document really does point at a file that isn't there — but they are *old*
breakage, and a linter whose first run turns the PR red gets removed before it ever catches
anything. So the gate moved from "everything must resolve" to "don't break anything new".

- **`--since <ref>` diff gate.** Only references broken by the current change fail the run;
  pre-existing ones are reported as a count and named in the summary line. On `pull_request` this
  defaults to the PR base, so the Action needs no configuration — `since: off` restores the old
  always-check-everything behaviour, and `REFLINT_SINCE` works too.
- **The comparison is made against the base commit's tree**, not the working tree, so it catches
  both directions: a document edited to point at something absent, *and* a file deleted while a
  document still points at it. Same for `npm run` scripts, which are diffed against the base
  `package.json`.
- Findings now carry a stable `ref` (the referenced path or script name), so moving a line is not
  read as new breakage. It is also present in `--format json` output.
- New `src/git.mjs` — zero-dependency, shells out to git. No git, or an unresolvable ref, degrades
  to checking every reference and says so rather than silently passing.

## 0.7.0

Precision hardening, driven by a real-world audit of **139 public `AGENTS.md` / `CLAUDE.md` /
`llms.txt` documents from 138 repositories** (2026-07), each checked against that repository's
actual file tree. v0.6.0 reported **608 broken references in 94 of 139 documents (68%)**.
Reviewed one by one, the large majority were not broken: v0.7.0 reports **181**, and ~80% of the
remaining path findings are genuine (a document pointing at a file that really isn't there).

- **References now resolve anywhere in the repository.** 47% of v0.6.0's findings were files that
  exist — just not at the path as written (`interactive_mode_test.go` in a doc,
  `internal/cli/interactive_mode_test.go` on disk). The CLI now builds a repository index and
  resolves a bare name by basename and a nested path by suffix, after trying the document's
  directory and the repository root.
- **`.gitignore` is respected.** A reference that git is told to ignore is absent on purpose —
  build output, runtime config, generated files. One audited document literally annotated its
  reference as "gitignored" and was still failed by the linter.
- **Extension-less references are only treated as paths when their first segment is a real
  directory.** Without this, repository names (`arnica/depsguard`), external repos
  (`aosp-mirror/platform_frameworks_base`), API groups (`coordination.k8s.io/leases`) and word
  pairs (`async/await`) were all reported as missing files. *Trade-off:* a genuinely broken
  extension-less path whose parent directory also doesn't exist is no longer reported.
- **`path::symbol` and `path:Symbol` resolve to the file part** (`src/pruner/budget.rs::find_x`,
  `utils/file_utils.py:FileProcessor`). Previously the whole string was looked up and never found.
- **More non-paths excluded**: `{placeholder}`, pseudocode with parentheses, quoted C includes,
  `...` ellipses, bare extensions (`.ts` in prose), leading `-` (CLI flags / CSS custom property
  lists), host-prefixed module paths, build output (`dist/`, `target/`, `.output/`, `.venv/` …),
  and expressions like `process.env`.
- Regression tests distilled from the audit: 11 false-positive shapes that must stay silent, plus
  genuine broken references that must stay caught.

## 0.6.0

`--ignore` / `REFLINT_IGNORE`, and prose format names (`llms.txt` written as a format, not a path)
are no longer treated as references.

## 0.5.1

False-positive and performance fixes found by running the linter over 32 real skills.

## 0.5.0

`--format json` and monorepo support (nearest `package.json` for scripts).

## 0.4.0

textlint-compatible rule (`@hyuga/reflint/textlint-rule`, experimental).

## 0.3.0

Opt-in scanning of fenced code blocks (`--code-blocks`).

## 0.2.0

`llms.txt` reference integrity: markdown link targets are verified against the repository.

## 0.1.0

Initial release. Reference-integrity linter for AGENTS.md / llms.txt / CLAUDE.md: missing npm
scripts and non-existent paths fail CI. Zero-dependency, language-agnostic, GitHub Action with
PR annotations.
