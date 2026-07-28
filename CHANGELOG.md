# Changelog

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
