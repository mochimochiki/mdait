# Changelog

All notable changes to mdait will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- `mdait_resolve` Copilot Chat tool: programmatically clear `need:review` / `need:verify-deletion` flags (agents no longer hand-edit markers)
- `mdait_getStatus` with `detail: true` now lists per-unit needs (hash, title, need) so agents can target specific units
- UX master document `docs/ux.md`: journeys, touchpoint map, state-visibility matrix, pain-point ledger, and improvement roadmap for both human and agent users
- StatusTree: dedicated icons/tooltips for `need:verify-deletion` and `need:isolate`, and a distinct tooltip for `need:revise`

- Unit-based Markdown synchronization with CRC32 hash tracking
- AI translation with glossary and context injection (VS Code LM API, OpenAI, Ollama)
- Diff-Aware Revision for incremental source changes
- Translation status visualization in sidebar, CodeLens, and Hover
- Terminology detection and expansion (CSV/YAML)
- Translation Memory (TMX) with LLM-guard validated commit
- GitHub Copilot Chat integration (`#mdaitStatus`, `#mdaitSync`, `#mdaitTranslate`)
- Custom prompt instructions via `.mdait/mdait-instructions.md`
- Selection translation from editor context menu
- Frontmatter translation support
- Auto-sync on file save
- `need:isolate` flag: preserve a unit and stop downstream propagation (no target generation, no translate/revise on paired targets; hash/from still tracked)
- Independent units: target units with a persisted `from`-less marker are kept as-is, excluded from matching, orphan handling, translation, and TM commit

### Changed

- Item-argument commands (translate/term/tm-commit/ai-review variants) are hidden from the Command Palette; the ▶ (Translate Unit) inline button now appears only on units that trans will actually process
- Unmarked orphan target content is no longer deleted by the orphan policy; sync now flags it with `need:review` (no `from`) so a human decides between declaring it independent, isolating it, or deleting it
- `sync.orphanTargetPolicy` is narrowed to `"delete" | "verify"` and now applies only to managed orphans (units with a dangling `from`); legacy values `"keep"`/`"backfill"` are interpreted as `"verify"` with a warning
- TM commit filter is now inclusive: only units with `from` and no `need` are committed (unknown `need` values no longer slip through); pairs whose source unit still carries a `need` are skipped as `sourcePending`, and `need:verify-deletion` units are no longer committed

### Removed

- `need:keep` and `need:backfill` flags and the backfill translation flow; sync migrates legacy markers deterministically (`keep` → plain-hash independent unit, `backfill` → `need:review` placeholder for manual resolution)

### Fixed

- TM Commit Directory and AI Translation Review (Directory) always failed when invoked from the status tree (`dirPath` vs `directoryPath` mismatch)
- English UI showed the raw key `AI_Usage_Confirmation` in the first-use AI consent dialog