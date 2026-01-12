# mdait — Markdown AI Translator

mdait is a VS Code extension for **continuous multilingual management** of Markdown documents. Rather than one-time translation, it tracks changes based on document structure and enables continuous AI translation of "only the parts that need re-translation" while maintaining terminology and context.

---

## Use Cases

* Internal documentation managed in multiple languages
* OSS documentation providing English + local languages
* Technical documents that are continuously updated after release

In these environments, the following challenges often arise:

* When documents are updated, it's unclear which parts need re-translation
* Chat AI translation can have issues with inconsistent results and difficulty reproducing the same translation, causing problems in daily use
* Traditional sentence-based machine translation often doesn't fully consider surrounding context and overall document structure, making it hard to maintain consistent quality
* Even when glossaries are prepared, there's no easy way to make sure they're used consistently in actual translation work

mdait is a tool designed to **solve these 'translation operations' challenges.**

---

## Key Features

mdait divides Markdown documents based on document structure, tracks and visualizes the status of each part, enabling you to proceed with AI translation and term extraction while clearly identifying translation targets.

### Unit-based Synchronization

* Automatic division of Markdown into units based on specified heading levels
* For each unit, a content hash (CRC32) is used to map translations to originals, detect source changes, and flag units that need translation

### Translation Flow Visualization

* Display translation status for each unit in the sidebar
* Translation at directory, file, and unit levels
* Support for review work through comparison view with source text

### AI Translation with Consistency

* **Context-aware AI translation** using glossary and surrounding context of target units
* **Glossary addition suggestions** after translation with one-click glossary updates

In multilingual documentation, consistency in terminology and phrasing directly affects quality.
mdait is designed to handle translations not as separate sentences or files, but as part of the entire document flow and terminology system.

---

## Quick Start

1. Open the mdait view by clicking the 🌐 (globe) icon in the activity bar
2. Create mdait.json with the `Create mdait.json` button and configure source/target languages and directories in `transPairs`
3. Execute 🔄 (Sync) from the mdait view
4. Open a .md file in the target language and start unit translation by clicking the ▶️ (Translate) button on the mdait marker attached to headings
5. Mouse over `Translation completed` to view the result summary and glossary addition suggestions
6. Click the `Source` button to compare with the source and review

### Configuration Example

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
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  },
  "sync": {
    "level": 3
  }
}
```

---

## mdait Markers

The information mdait needs for management (mdait markers) is embedded in Markdown files as HTML comments by 🔄 (Sync).

```
<!-- mdait {content-hash} from:{source-hash} need:{action} -->
```

`content-hash`: Content hash of the unit. Changes whenever the content changes even by one character. mdait uses this hash to detect unit correspondence and changes.
`source-hash`: Content hash of the corresponding source unit. Maps to the source text. When the source is modified, the translation unit's `source-hash` and source unit's `content-hash` become mismatched, indicating re-translation is needed.
`need`: Required action. When translation is needed, it's `need:translate`; when translated, the item itself is omitted.

This marker is the only data mdait uses to manage translation information. No external files are generated for management information. It's also independent of version control systems like git. This enables flexible operations:

- You can freely modify translations after translation. Since `from:{source-hash}` is maintained, the connection to the source is preserved even after modification.
- You can manually add/remove `need:translate` to mark specific units for re-translation or mark them as already translated.
- You can also manually add `<!-- mdait -->` to the source text. This is useful, for example, when you want to manage translation at a more detailed level than heading levels. After adding markers, execute 🔄 (Sync) and mdait will automatically calculate hashes and start managing them.

---

## AI Usage and Data Handling

* mdait uses LLMs to perform operations such as translation and term detection. Commands that use AI display `✨[AI]` in their tooltips.
* Even without using AI, you can use mdait as a tool to solve 'translation operations' challenges through features like unit-based synchronization and translation status visualization.
* Supports VS Code Language Model API (vscode-lm), Ollama, and more.
* No background analysis or undisclosed communications are performed.

---

## Prompt Instructions

You can add domain-specific context to AI prompts by placing a Markdown file at `.mdait/mdait-instructions.md`. The content will be appended to prompts.

**Example:**

```markdown
---
prompts: ["trans.translate"]
---

# Domain Knowledge

This project documents a financial API.
- Settlement: 決済 (transaction finalization)
- Clearing: クリアリング (transaction reconciliation)
```

Omit the `prompts` field in frontmatter to apply to all prompts. See `design/prompt.md` for details.

---

## License

Apache License 2.0
See the [LICENSE](LICENSE) file for details.