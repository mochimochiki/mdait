# mdait — Markdown AI Translator

[![CI](https://github.com/mochimochiki/mdait/actions/workflows/ci.yml/badge.svg)](https://github.com/mochimochiki/mdait/actions/workflows/ci.yml) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Continuous, structure-aware Markdown translation for VS Code — powered by LLMs.**

---

## Key Features

- **Unit-based Sync** — Splits Markdown by heading level and tracks changes with CRC32 hashes. State lives in in-document HTML comment markers by default, or can be externalized to a single `.mdait/unit-state` file. No external DB; fully git-friendly.
- **AI Translation with Consistency** — Glossary + surrounding context injected into every prompt. Diff-Aware Revision sends only the changed diff to the LLM when the source has minor edits, preserving existing translations.
- **Translation Status Visualization** — Sidebar tree showing translation progress per directory, file, and unit. CodeLens and Hover for inline result inspection.
- **Terminology Management** — AI-powered term detection from source, expansion to target language, CSV/YAML glossary formats. Automatically injected during translation.
- **Translation Memory (TM)** — TMX-based storage with LLM-guard validated upsert. Auto-referenced during translation; optimizable via AI.
- **Copilot Chat Integration** — GitHub Copilot tools via LanguageModelTool API: `#mdaitStatus`, `#mdaitSync`, `#mdaitTranslate`.

---

## Quick Start

1. Click the 🌐 icon in the Activity Bar to open the mdait view.
2. Click **Create mdait.json** and configure your translation pairs.
3. Run **Sync** (🔄) to scan documents and insert markers.
4. Click ▶️ on a unit marker to translate, or translate an entire file/directory from the sidebar.
5. Hover over a translated unit to inspect the result and glossary suggestions.
6. Click **Source** to open a side-by-side comparison for review.

**Already have translated documents?** Run **✨Adopt Existing Translations** from the sidebar instead of translating from scratch. The wizard adopts your existing translations without overwriting them, AI-reviews the pairings, and can build the glossary and translation memory in the same run.

---

## Documentation

Guides are written in Japanese.

| Guide | Audience |
|---|---|
| [guide-user.md](docs/guide-user.md) | Translating and reviewing documents day to day. |
| [guide-admin.md](docs/guide-admin.md) | Setting up `mdait.json`, adopting existing translations, running the glossary and TM. |
| [guide-developer.md](docs/guide-developer.md) | Driving mdait from Copilot Chat or a coding agent. |

Architecture and design decisions: [docs/design.md](docs/design.md) / [docs/adr.md](docs/adr.md).

---

## Configuration

Create `.mdait/mdait.json` in your workspace root:

```json
{
  "transPairs": [
    {
      "sourceLang": "ja",
      "sourceDir": "docs/ja",
      "targetLang": "en",
      "targetDir": "docs/en"
    }
  ],
  "primaryLang": "ja",
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  },
  "sync": {
    "level": 3,
    "autoDelete": true,
    "autoSyncOnSave": true
  },
  "trans": {
    "contextSize": 1,
    "retryLimit": 1,
    "markdown": { "skipCodeBlocks": true },
    "frontmatter": { "keys": ["title", "description"] }
  },
  "tm": {
    "retryLimit": 1,
    "maxReferences": 5
  },
  "terms": {
    "filename": "terms.csv"
  }
}
```

| Key | Purpose |
|---|---|
| `transPairs` | Source/target language and directory pairs. |
| `primaryLang` | **Required.** Base language for glossary/TM (usually the source language). |
| `ai.provider` / `ai.model` | AI provider and model selection. |
| `sync.level` | Heading depth for unit splitting (e.g., `3` = h1–h3). |
| `trans.contextSize` | Number of surrounding units sent as context. |
| `trans.retryLimit` | Max retries on translation failure (1–5). |
| `tm.maxReferences` | Max TM entries referenced per translation. |
| `terms.filename` | Glossary filename (`terms.csv` or `terms.yaml`). |
| `markers.mode` | Marker storage: `"embedded"` (default, in-document HTML comments) or `"external"` (`.mdait/unit-state`). |
| `ignoredPatterns` | Glob pattern(s) for files/directories to exclude from all processing. Accepts a string or array of strings. Default: `"**/node_modules/**"`. |

---

## AI Providers

| Provider | ID | Notes |
|---|---|---|
| **VS Code Language Model API** | `vscode-lm` | **Recommended.** Uses LLM via GitHub Copilot. No extra setup. |
| **OpenAI** | `openai` | Requires an API key (`ai.openai.apiKey` — supports `${env:OPENAI_API_KEY}` syntax). |
| **Ollama** | `ollama` | Local Ollama server. Configure `ai.ollama.endpoint` and `ai.ollama.model`. |

Set `ai.provider` and `ai.model` in `mdait.json`. Provider-specific settings are also available in VS Code Settings.

---

## Terminology & Translation Memory

### Glossary

1. **Detect** — Run `term.detect` on source files to extract key terms with AI.
2. **Expand** — Run `term.expand` to generate target-language translations for detected terms.
3. Glossary entries (CSV or YAML) are automatically injected into translation prompts.

### Translation Memory

- **Commit** — `tm.commit` registers translated unit pairs into a TMX file with LLM-guard validation.
- **Reference** — During translation, relevant TM entries are auto-retrieved and supplied as context.
- **Optimize** — `tm.optimize` uses AI to deduplicate and improve TM quality.

---

## Copilot Chat Integration

The following tools are available in GitHub Copilot Chat:

| Tool | Description |
|---|---|
| `#mdaitStatus` | Check translation progress and status. |
| `#mdaitSync` | Synchronize markers across documents. |
| `#mdaitTranslate` | Translate a target file with AI. |
| `#mdaitAdopt` | Adopt existing translations (onboarding wizard; optional glossary/TM build). |
| `#mdaitAiReview` | AI-review translation pairs (triage need:review, audit quality). |
| `#mdaitResolve` | Resolve need flags (approve reviews, confirm deletions; no AI). |

---

## Prompt Instructions

Add domain-specific context to AI prompts by creating `.mdait/mdait-instructions.md`:

```markdown
---
prompts: ["trans.translate"]
---

# Domain Knowledge

This project documents a financial API.
- Settlement: 決済 (transaction finalization)
- Clearing: クリアリング (transaction reconciliation)
```

Omit the `prompts` field to apply instructions to all prompts.


---

## How It Works

By default, mdait embeds lightweight HTML comment markers into Markdown files during Sync:

```html
<!-- mdait {content-hash} from:{source-hash} need:{action} -->
```

| Field | Description |
|---|---|
| `{content-hash}` | CRC32 hash of the unit content. Auto-updated on any edit. |
| `from:{source-hash}` | Hash of the corresponding source unit. Detects source-side changes. |
| `need:{action}` | `need:translate` (new), `need:revise@{oldhash}` (changed), or omitted (up-to-date). |

State is fully git-tracked — changes appear naturally in `git diff` — with no external database.

### Embedded vs. externalized markers

Set `markers.mode` in `mdait.json` to choose where this state lives:

- **`embedded`** (default) — markers stay inline in each Markdown file. Self-contained, no sidecar files.
- **`external`** — markers are kept out of the document body and stored in a single `.mdait/unit-state` file (TSV: `path / order / level / titleHash / hash / from / need`, sorted by `path` then `order`). This also unifies state management for non-Markdown files (`.txt`, `.csv`, …) that cannot host inline comments.

Convert existing documents in place with the **`mdait: Externalize Markers`** and **`mdait: Embed Markers`** commands.

`.mdait/unit-state` is a single aggregated file, so concurrent translation of different documents could otherwise collide on it. mdait auto-generates `.mdait/.gitattributes` with `unit-state merge=union` and writes per-file blocks separated by blank-line anchors, so independent edits merge automatically and the next Sync re-normalizes the file.

---

## AI Usage and Data Handling

- Commands that use AI are marked with **✨[AI]** in their tooltips.
- Sync, status visualization, and marker management work **without any AI provider**.
- Supported providers: VS Code Language Model API (`vscode-lm`), OpenAI, Ollama.
- **No background communication** — AI calls are made only when you explicitly run a command.

---

## License

[Apache License 2.0](LICENSE)
