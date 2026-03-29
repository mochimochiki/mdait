# Changelog

All notable changes to mdait will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

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