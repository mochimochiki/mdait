# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mdait is a VS Code extension for continuous, structure-aware Markdown translation powered by LLMs. It splits Markdown into "units" by heading level, tracks changes with CRC32 hashes embedded as HTML comment markers (`<!-- mdait {hash} from:{hash} need:{flag} -->`), and re-translates only changed units. No external DB — all state lives in the documents themselves (git-friendly, idempotent, recoverable via `sync`).

## Commands

```bash
npm run compile        # TypeScript compile (tsc → out/)
npm run lint           # Biome lint (config: .config/biome.json)
npm test               # compile + lint + unit tests (mocha, TDD UI)
npm run test:vscode    # VS Code integration tests (manual, not in CI)
npm run watch          # esbuild watch for development
npm run bundle         # production bundle (esbuild → dist/extension.js)
npm run copy-test-files  # reset test workspace from src/test/unit/sample-content
```

Run a single test file (tests run against compiled JS in `out/`):

```bash
npm run compile && npx mocha --config .config/.mocharc.json --ui tdd "out/test/unit/core/hash/**/*.test.js"
# or filter by test name (test names are written in Japanese):
npm run compile && npx mocha --config .config/.mocharc.json --ui tdd "out/test/unit/**/*.test.js" --grep "正規化"
```

CI (`.github/workflows/ci.yml`) runs: `npm ci` → `compile` → `lint` → `test` → `bundle` → vsce package.

## Architecture

**`docs/architecture.md` is the canonical architecture document** (in Japanese) — consult it before designing features or making trade-offs. Detailed per-module docs live in `docs/design/*.md`. ADRs are recorded in `docs/adr.md` (newest entry on top; use the `adr-recording` skill in `.github/skills/`).

Layers (lower layers never depend on higher ones):

- **`src/core/`** — Pure translation logic, **no VS Code API dependency**: markdown parsing (markdown-it), hash/normalization, status, unit-registry, diff, TM, file-state. Fully unit-testable.
- **`src/commands/`** — Workflows composing core functions: `sync`, `trans`, `term`, `tm`, `setup`, `trans-selection`, plus the `file-handler/` Strategy (MD vs. non-MD branching point). Owns progress/error/cancellation handling.
- **`src/infra/`** — config (`.mdait/mdait.json` via the `Configuration` singleton), llm (`AIService` abstraction with vscode-lm / OpenAI / Ollama providers), logging, workspace file discovery, debug IPC, onboarding.
- **`src/ui/`** — StatusTreeProvider, CodeLens, Hover, Welcome view; sticks to VS Code standard UI patterns.
- **`src/lm-tools/`** — LanguageModelTool API wrappers (`mdait_getStatus` / `mdait_sync` / `mdait_translate`) for Copilot Chat.
- **`src/prompts/`** — AI prompt definitions; all system prompts overridable via external files.

Core data flow: source change → `sync` detects hash diff and tags units `need:translate` / `need:revise@{oldhash}` → `trans` translates (diff-aware revise sends only the diff + previous translation to the LLM, preserving manual edits) → `sync` re-run clears `need`. All commands are idempotent.

### Fixed invariants (do not change)

- Marker format `<!-- mdait hash from:xxx need:yyy -->` and the CRC32 hash algorithm (compatibility with existing markers)
- markdown-it as the parser; heading-level-based unit boundaries
- File path construction is centralized in the `Configuration` class — never build `.mdait/` paths directly in the command layer
- Raw-regex marker boundary searches must exclude code-block lines via `getCodeBlockLineSet` (avoid matching sample markers inside code blocks)
- Text normalization (e.g., `normalizeForTm`) stays internal to the module that needs it; callers pass raw text

## Testing

Three tiers (see `docs/design/test.md`):

1. **Unit** (`npm test`, CI): core + VS Code-independent command logic. VS Code-dependent modules use the mock registered in `src/test/unit/__mocks__/register-vscode-mock.js`; tests can set `global.__vscodeMockWorkspaceRoot`.
2. **Integration** (`npm run test:vscode`, manual): `src/test/gui/**` via VS Code Test Runner.
3. **Exploratory debug IPC**: file-based IPC with `MDAIT_DEBUG_IPC=1` for multi-step E2E scenarios — see the `debug-ipc` skill in `.github/skills/debug-ipc/`.

Conventions: TDD style (`suite`/`test`), **test names in Japanese stating the expected behavior**. New edge cases should be added to `src/test/unit/sample-content/` (synced to the test workspace by `copy-test-files`).

## Conventions

- **Documentation output is in Japanese** (design docs, ADRs, tickets, test names).
- Formatting via Biome: tabs, 120-char line width, double quotes.
- Work is tracked as tickets in `.tasks/do/<YYMMDD>-<NN>_<name>.md` (NN is a 2-digit sequence per day across `.tasks/do/` and `.tasks/done/`); the template is in `.github/copilot-instructions.md`. On completion, move with `pwsh -File .github/scripts/done.ps1 -TicketName <YYMMDD-NN_name>`.
- Design decisions get an ADR entry in `docs/adr.md` (short, one screen max, newest on top).
- l10n: user-facing strings go through VS Code l10n (`l10n/bundle.l10n.json` + `.ja.json`, `package.nls.json` + `.ja.json`); regenerate with `npm run l10n`.
