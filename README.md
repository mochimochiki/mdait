# mdait — Markdown AI Translator

mdait is a VS Code extension designed for the **continuous multilingual operation of Markdown documents**.
Rather than performing one-off translations, it tracks changes based on document structure and continuously applies AI translation **only to the parts that require re-translation**, while preserving terminology and context.

## Use Cases

* Internal documents managed in multiple languages  
* OSS documentation provided in English plus local languages  
* Technical documents that continue to be updated after release  

In these environments, the following issues commonly arise:

* It is unclear which parts need to be re-translated when a document is updated  
* Managing translation status—such as translated vs. untranslated, or up-to-date vs. outdated—tends to become complex  
* File-level chat-based AI translation can lead to inconsistent wording and low reproducibility in ongoing operations  
* Traditional sentence-level machine translation often fails to consider surrounding context or overall document structure, making it difficult to maintain stable quality  
* Even when a glossary exists, there is no reliable mechanism to consistently apply and maintain it during actual translation work  

mdait is a tool designed to solve these **“translation operations” challenges**.

## Key Features

mdait splits Markdown documents into appropriate units based on document structure, tracks and visualizes the state of each unit, and enables AI translation and terminology extraction with a clear understanding of what needs to be translated.

### Unit-Based Synchronization

* Automatically splits Markdown into units at a specified heading level  
* Associates source and translated units using a per-unit content hash (CRC32), detects source changes, and flags units that require re-translation  

### Translation Flow Visualization

* Displays translation status for each unit in the sidebar  
* Supports translation at the directory, file, and unit levels  
* Assists review work with a comparison view against the source text  

### AI Translation with Consistency

* **Context-aware AI translation** using glossary data and surrounding context of the target unit  
* **Suggestions for glossary additions after translation**, with one-click updates to the glossary  

In multilingual documents, consistency in terminology and phrasing directly affects quality.  
mdait treats translation not as isolated sentences or files, but as part of the overall document flow and terminology system.


## Quick Start

1. Create `mdait.json` in your workspace  
2. Configure source and target directories  
3. Run 🔄 (Sync) from the mdait view  
4. Start translation with the ▶️ (Translate) button  
5. Hover over `Translation complete` to review the result summary and glossary addition candidates  

### Example Configuration

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
    "autoMarkerLevel": 3
  }
}
```

## mdait Markers

The information required by mdait for management (mdait markers) is embedded into Markdown files as HTML comments via 🔄 (Sync).

```
<!-- mdait {content-hash} from:{source-hash} need:{action} -->
```

* `content-hash`: The content hash of the unit. It changes if even a single character is modified.
* `source-hash`: The content hash of the corresponding source unit. It is used to link translations to their source. If the source is updated, the `source-hash` in the translated unit will no longer match the source unit’s `content-hash`, and the unit will be marked as requiring re-translation.
* `need`: The required action (e.g., `translate`). Indicates whether translation is needed.

These markers are the **only data mdait uses to manage translation information**. No external files are generated. This enables highly flexible operation.

* You can manually edit translations after translation. The `from:` marker is preserved, so the linkage to the source text remains intact.
* By manually adding or removing the `need:translate` marker, you can explicitly mark specific units as requiring re-translation or as already translated.
* You can also manually add markers to source documents. This is useful when you want to manage translation at a finer granularity than heading levels allow.

## AI Usage and Data Handling

* mdait uses LLMs to perform tasks such as translation and terminology detection. Commands that use AI are indicated with `✨[AI]` in their tooltips.
* Supports VS Code Language Model API (vscode-lm), Ollama, and more.
* No other background analysis or undisclosed communication is performed.

## License

Apache License 2.0
See the [LICENSE](LICENSE) file for details.
