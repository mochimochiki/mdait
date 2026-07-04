<!-- mdait c2d0c165 -->
# 設定リファレンス — mdait.json

`.mdait/mdait.json` で使用できる全設定項目の完全リファレンスです。

---

<!-- mdait 8dede788 -->
## 早見表

| フィールド | 型 | デフォルト | 概要 |
|---|---|---|---|
| `transPairs` | 配列 | 必須 | 翻訳ペア（ソース/ターゲットのディレクトリと言語） |
| `primaryLang` | 文字列 | 必須 | 用語集・TMの基準言語 |
| `ignoredPatterns` | 文字列[] | `"**/node_modules/**"` | 翻訳・同期を除外するglobパターン |
| `sync.level` | 数値 | `3` | ユニット境界の見出しレベル（h1〜hN） |
| `sync.autoSyncOnSave` | 真偽値 | `true` | 保存時に自動同期 |
| `sync.autoDelete` | 真偽値 | `true` | 孤立ユニット自動削除（旧設定。`orphanTargetPolicy` 推奨） |
| `sync.orphanTargetPolicy` | 文字列 | `"delete"` | 孤立ユニットの処理（`delete`/`verify`/`keep`/`backfill`） |
| `sync.copyAssets` | 真偽値 \| 文字列[] | `true` | sync 時に差分ユニット内のアセットをターゲットにコピー。`true`/`false` または拡張子ホワイトリスト |
| `ai.provider` | 文字列 | — | `vscode-lm` / `openai` / `ollama` |
| `ai.model` | 文字列 | — | 使用するモデル名 |
| `trans.contextSize` | 数値 | `1` | 翻訳プロンプトに渡す周辺ユニット数 |
| `trans.retryLimit` | 数値 | `1` | 翻訳失敗時のリトライ上限 |
| `trans.markdown.skipCodeBlocks` | 真偽値 | `true` | コードブロックを翻訳除外 |
| `trans.frontmatter.keys` | 文字列[] | `["title", "description"]` | 翻訳対象のFrontmatterキー |
| `trans.extensions` | 文字列[] | `[]` | 追加翻訳対象の拡張子 |
| `trans.concurrency` | 整数 | `3` | ディレクトリ翻訳のファイル単位同時実行数（1〜8） |
| `trans.maxFileSize` | 数値 | `51200` | 非MDファイルのサイズ上限（バイト） |
| `tm.enabled` | 真偽値 | `true` | TM機能の有効/無効 |
| `tm.maxReferences` | 数値 | `5` | プロンプトに含めるTM参照の最大数 |
| `tm.retryLimit` | 数値 | `1` | tm-commitのリトライ上限 |
| `tm.minQueryLength` | 数値 | `10` | TM検索の最小クエリ長（文字数） |
| `terms.filename` | 文字列 | `"terms.csv"` | 用語集ファイル名（.csv/.yaml対応） |

---

<!-- mdait 720896cf -->
## transPairs

翻訳の対象ディレクトリと言語のペアを定義します。**必須項目。**  
パスは `.mdait/mdait.json` の親ディレクトリ（通常はリポジトリルート）からの相対パスです。

| フィールド | 型 | 説明 |
|---|---|---|
| `sourceLang` | 文字列 | ソース言語コード（例: `"ja"`） |
| `sourceDir` | 文字列 | ソースディレクトリのパス |
| `targetLang` | 文字列 | ターゲット言語コード（例: `"en"`） |
| `targetDir` | 文字列 | ターゲットディレクトリのパス |
| `copyAssets` | 真偽値 \| 文字列[] | `sync.copyAssets` のペア単位上書き（省略時はグローバル設定を参照）。型は `sync.copyAssets` と同じ |

```json
"transPairs": [
  {
    "sourceLang": "ja",
    "sourceDir": "docs/ja",
    "targetLang": "en",
    "targetDir": "docs/en"
  }
]
```

複数ペアを登録でき、1ソースから複数言語への翻訳も可能です。

---

<!-- mdait 5dc7af85 -->
## primaryLang

用語集（terms）とTM（Translation Memory）で使う基準言語コードです。**必須項目。**

```json
"primaryLang": "en"
```

---

<!-- mdait fc1d5dee -->
## ignoredPatterns

翻訳・同期処理から除外するファイルを glob パターンで指定します。

| 型 | デフォルト |
|---|---|
| `string` \| `string[]` | `"**/node_modules/**"` |

```json
"ignoredPatterns": [
  "**/draft/**",
  "**/_*.md",
  "**/CHANGELOG.md"
]
```

**よく使うパターン例:**

| パターン | 除外対象 |
|---|---|
| `**/draft/**` | `draft/` フォルダ以下のすべてのファイル |
| `**/_*.md` | アンダースコアで始まる Markdown ファイル |
| `**/CHANGELOG.md` | すべての CHANGELOG.md |
| `docs/internal/**` | `docs/internal/` 以下を除外 |

> パスはワークスペースルートからの相対 glob として評価されます。`sourceDir` / `targetDir` 両方に適用されます。

---

<!-- mdait d6ce507f -->
## sync

ファイルの構造同期に関する設定です。

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `level` | 数値 | `3` | ユニット境界とする見出しの最大レベル（例: `3` = h1〜h3） |
| `autoSyncOnSave` | 真偽値 | `true` | ファイル保存時に自動で同期を実行 |
| `autoDelete` | 真偽値 | `true` | ソースに存在しない孤立ユニットを自動削除（`true`→`delete`、`false`→`verify` に対応する旧設定） |
| `orphanTargetPolicy` | 文字列 | `"delete"` | 孤立ユニットの処理ポリシー: `"delete"`（自動削除）/ `"verify"`（`need:verify-deletion` 付与）/ `"keep"`（`need:keep` で恒久保持）/ `"backfill"`（原文側へ逆翻訳で埋め戻し）。`autoDelete` より優先 |
| `copyAssets` | 真偽値 \| 文字列[] | `true` | sync 時に差分ユニット内のアセットをターゲットにコピー。`true`=全コピー / `false`=コピーしない / `[".png", ".jpg"]` のような拡張子ホワイトリスト |

```json
"sync": {
  "level": 3,
  "autoSyncOnSave": true,
  "autoDelete": true,
  "copyAssets": true
}
```

`copyAssets` を拡張子ホワイトリストにすると、画像だけ自動コピーして CSV や PDF は手動管理にする等の運用ができます（[guide/ja/sync.md](sync.md) 参照）。

`level: 2` にすると h1〜h2 のみをユニット境界とし、h3以下はまとめて1ユニットとして扱います。

---

<!-- mdait ce1805e2 -->
## ai

AIプロバイダーの接続設定です。`provider` によって使うフィールドが変わります。

| フィールド | 型 | 説明 |
|---|---|---|
| `provider` | 文字列 | `"vscode-lm"` / `"openai"` / `"ollama"` |
| `model` | 文字列 | 使用するモデル名 |

<!-- mdait 3033ab1c -->
### vscode-lm（推奨）

GitHub Copilot のモデルを利用します。APIキー不要。

```json
"ai": {
  "provider": "vscode-lm",
  "model": "gpt-4.1"
}
```

<!-- mdait 04a62601 -->
### openai

OpenAI API または互換エンドポイントを利用します。

| フィールド | 型 | 説明 |
|---|---|---|
| `ai.openai.apiKey` | 文字列 | APIキー（`${env:OPENAI_API_KEY}` 構文でenv参照可） |
| `ai.openai.baseURL` | 文字列 | OpenAI互換エンドポイントURL（省略時はOpenAI公式） |

```json
"ai": {
  "provider": "openai",
  "model": "gpt-4o",
  "openai": {
    "apiKey": "${env:OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1"
  }
}
```

<!-- mdait 183c906e -->
### ollama

ローカルで動作するOllamaサーバーを利用します。

| フィールド | 型 | 説明 |
|---|---|---|
| `ai.ollama.endpoint` | 文字列 | OllamaサーバーのURL |
| `ai.ollama.model` | 文字列 | 使用するOllamaモデル名 |

```json
"ai": {
  "provider": "ollama",
  "ollama": {
    "endpoint": "http://localhost:11434",
    "model": "llama3"
  }
}
```

---

<!-- mdait f1bf5e34 -->
## trans

翻訳処理の詳細設定です。

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `contextSize` | 数値 | `1` | 翻訳プロンプトに渡す前後のユニット数 |
| `retryLimit` | 数値 | `1` | 失敗時のリトライ上限（1〜5） |
| `markdown.skipCodeBlocks` | 真偽値 | `true` | コードブロックを翻訳対象から除外 |
| `frontmatter.keys` | 文字列[] | `["title", "description"]` | 翻訳するFrontmatterキー（空配列 `[]` で翻訳しない） |
| `extensions` | 文字列[] | `[]` | MD以外で翻訳対象とする拡張子（例: `[".txt"]`） |
| `concurrency` | 整数 | `3` | ディレクトリ翻訳のファイル単位同時実行数（1〜8。1で逐次実行。プロバイダーのレート制限に応じて調整） |
| `maxFileSize` | 数値 | `51200` | 非MDファイルの翻訳サイズ上限（バイト） |

```json
"trans": {
  "contextSize": 1,
  "retryLimit": 2,
  "markdown": { "skipCodeBlocks": true },
  "frontmatter": { "keys": ["title", "description"] },
  "extensions": [".txt"],
  "maxFileSize": 102400
}
```

---

<!-- mdait be0a14f2 -->
## tm

Translation Memory（TM）の設定です。

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `enabled` | 真偽値 | `true` | `false` でTM機能を完全無効化 |
| `maxReferences` | 数値 | `5` | プロンプトに含めるTM参照の最大数 |
| `retryLimit` | 数値 | `1` | tm-commitのリトライ上限 |
| `minQueryLength` | 数値 | `10` | TM検索に使う最小クエリ長（文字数） |

```json
"tm": {
  "enabled": true,
  "maxReferences": 5,
  "retryLimit": 1,
  "minQueryLength": 10
}
```

---

<!-- mdait e10a4989 -->
## terms

用語集の設定です。

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `filename` | 文字列 | `"terms.csv"` | 用語集ファイル名（`.csv` / `.yaml` 対応） |

```json
"terms": {
  "filename": "terms.csv"
}
```

用語集ファイルは `.mdait/` ディレクトリに配置します。

---

<!-- mdait 8f0e65f6 -->
## Frontmatter オーバーライド

ファイル単位で一部の設定を上書きできます。現在対応しているのは `sync.level` のみです。

```yaml
---
mdait:
  sync:
    level: 2
---
```

ドキュメントの構造に合わせてユニット粒度を調整したい場合に使います。

---

<!-- mdait 59efb761 -->
## mdait-instructions.md

プロジェクト固有のドメイン知識（用語・文体ルール・注意事項など）をAIに渡すためのファイルです。

- **場所:** `.mdait/mdait-instructions.md`
- frontmatterの `prompts` フィールドで適用するプロンプトを限定できます（省略時は全プロンプトに適用）

```markdown
---
prompts: ["trans.translate"]
---

# ドメイン知識

- 「〇〇」は「△△」と訳す
- 丁寧語で統一すること
```

---

<!-- mdait 54a7f970 -->
## 完全な設定例

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
  "primaryLang": "en",
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  },
  "sync": {
    "level": 3,
    "autoSyncOnSave": true,
    "autoDelete": true
  },
  "trans": {
    "contextSize": 1,
    "retryLimit": 1,
    "markdown": { "skipCodeBlocks": true },
    "frontmatter": { "keys": ["title", "description"] }
  },
  "tm": {
    "enabled": true,
    "maxReferences": 5,
    "retryLimit": 1,
    "minQueryLength": 10
  },
  "terms": {
    "filename": "terms.csv"
  }
}
```

---

<!-- mdait 65f5c5d6 -->
## 関連ページ

- [はじめよう](getting-started.md) — セットアップと最初の翻訳
- [Sync](sync.md) — 構造同期の詳細
- [Trans](translate.md) — AI翻訳の詳細
- [Term](term.md) — 用語集の使い方
- [TM](tm.md) — Translation Memoryの使い方
