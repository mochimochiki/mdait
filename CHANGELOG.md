# Changelog

All notable changes to mdait will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- `mdait_resolve` Copilot Chat tool: programmatically clear `need:review` / `need:verify-deletion` flags (agents no longer hand-edit markers)
- `mdait_getStatus` with `detail: true` now lists per-unit needs (hash, title, need) so agents can target specific units
- UX master document `docs/ux.md`: journeys, touchpoint map, state-visibility matrix, pain-point ledger, and improvement roadmap for both human and agent users
- StatusTree: dedicated icons/tooltips for `need:verify-deletion` and `need:isolate`, and a distinct tooltip for `need:revise`
- StatusTree: "Go to Next Item Needing Attention" (`mdait.needsAttention.next`) — jump to the next review/deletion decision in one step, from the CodeLens decision row, the Needs Attention node, or `ctrl+alt+n` / `cmd+alt+n`
- StatusTree: Needs Attention items now show the file name and kind as a subtitle, and are always listed in a stable order (file path, then line)
- CodeLens: a single "More" menu (`$(kebab-vertical)`) collects the low-frequency unit actions — "Mark as Isolated" and "Note" — and is now available on source units too (source-side isolate stops propagation; source-side notes reach the AI during audit)
- Adopt wizard: the report is written to `.mdait/adopt-report.md` and opened in the Markdown preview; every unit row links to the exact line of the reviewed unit
- Reports and AI review prose now follow the VS Code display language: report headings/boilerplate are localized, and the AI is asked to write review `reason` / `issues` in that language (`{{responseLang}}` in `aiReview.verifyPairing` / `aiReview.verifyPairingBatch`)

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

- CodeLens: the standalone "Mark as Isolated" and "Note" buttons were replaced by the single "More" menu (commands `mdait.codelens.markIsolated` / `mdait.unit.editNote` are gone; use `mdait.codelens.otherActions`)
- Adopt wizard: the report is a real file (`.mdait/adopt-report.md`, overwritten per run) instead of a `mdait-adopt:` virtual document
- Item-argument commands (translate/term/tm-commit/ai-review variants) are hidden from the Command Palette; the ▶ (Translate Unit) inline button now appears only on units that trans will actually process
- Unmarked orphan target content is no longer deleted by the orphan policy; sync now flags it with `need:review` (no `from`) so a human decides between declaring it independent, isolating it, or deleting it
- `sync.orphanTargetPolicy` is narrowed to `"delete" | "verify"` and now applies only to managed orphans (units with a dangling `from`); legacy values `"keep"`/`"backfill"` are interpreted as `"verify"` with a warning
- TM commit filter is now inclusive: only units with `from` and no `need` are committed (unknown `need` values no longer slip through); pairs whose source unit still carries a `need` are skipped as `sourcePending`, and `need:verify-deletion` units are no longer committed
- StatusTree updates are now a single "something changed" signal, debounced (80ms, with a 300ms cap so long batches still paint) and applied as one full refresh, instead of per-node partial notifications (expanded/selected state is preserved via stable tree item ids)
- Needs Attention is now scoped to the selected translation pairs, matching the rest of the tree (items from unselected languages no longer appear)
- Workspace-wide status reported by the Copilot Chat tools (`mdait_getStatus`, `mdait_sync`, `mdait_aiReview`, `mdait_adopt`) is now scoped to the selected translation pairs too, so humans and agents see the same counts; `mdait_getStatus` names the scope in its summary (`workspace (targets: ja)`). Passing an explicit path still reports exactly that path.
- When a command refreshes a file that no longer exists on disk, it is now removed from the status tree instead of lingering until a full rebuild (there is still no file watcher, so deleting a file outside mdait is not picked up until something touches it)

### Removed

- `need:keep` and `need:backfill` flags and the backfill translation flow; sync migrates legacy markers deterministically (`keep` → plain-hash independent unit, `backfill` → `need:review` placeholder for manual resolution)

### Fixed

- TM Commit Directory and AI Translation Review (Directory) always failed when invoked from the status tree (`dirPath` vs `directoryPath` mismatch)
- Needs Attention count and contents went out of sync: translating, syncing, or AI-reviewing added `need:review` / `need:verify-deletion` units without refreshing the root, so the count stayed frozen at its last value while the file tree showed the new flags (a manual Sync happened to fix it, an auto-sync on save did not)
- Stale units lingered in the lookup index after their hash changed, so `getUnitByHash` / `getTargetUnitByFromHash` could return units that no longer exist
- Directory paths were compared by plain string prefix, so `docs/en` and `docs/en-US` were conflated in progress counts and subdirectory listings
- Tree nodes expanded during the initial load returned empty and stayed empty (concurrent `getChildren` calls no longer skip the in-flight initialization)
- English UI showed the raw key `AI_Usage_Confirmation` in the first-use AI consent dialog