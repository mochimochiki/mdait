<!-- mdait 36a5dc98 -->
# Trans — AIでユニットを自動翻訳する

`need:translate` / `need:revise` が付いたユニットを AI に送り、最小限の変更で訳文を生成・更新するコマンドです。

---

<!-- mdait 7a6ef669 -->
## 概要

`mdait.trans` を実行すると、設定した `transPairs` を走査し、未翻訳・要改訂のユニットを AI で翻訳します。

- `need:translate` → 新規翻訳を生成
- `need:revise` → 差分（変更箇所）のみ AI に送り、既存訳文を最大限保持（**diff-aware revise**）
- 翻訳後に構造不一致を検出した場合は `need:review` を付与

**起動方法:**

| 方法 | 説明 |
|---|---|
| StatusTree のディレクトリ行の ▶ ボタン | ディレクトリ内の全ファイルを翻訳 |
| StatusTree のファイル行の ▶ ボタン | 単一ファイルを翻訳 |
| CodeLens「Translate Unit」 | カーソル位置のユニットだけを翻訳 |

---

<!-- mdait edac3ede -->
## 翻訳の粒度

コマンドの呼び出し方によって翻訳範囲が変わります。

| 粒度 | 操作 | 対象 |
|---|---|---|
| ユニット | CodeLens「Translate Unit」 | 1 つの見出しブロック |
| ファイル | StatusTree のファイル行の ▶ ボタン | 1 ファイル内の全 `need` ユニット |
| ディレクトリ | StatusTree のディレクトリ行の ▶ ボタン | ディレクトリ配下の全ファイル |

小規模な修正はユニット単位、一括処理はディレクトリ単位が効率的です。

---

<!-- mdait 88e35d0c -->
## diff-aware revise の仕組み

`need:revise` は「原文が一部変わった」状態です。訳文全体を作り直すのではなく、**変更された差分だけを AI に渡す**ことで翻訳コストを下げ、既存訳文のトーンや用語を維持します。

**原文の変更（差分）:**

```diff
- This extension helps translate Markdown files.
+ This extension helps translate Markdown files using AI.
```

**revise 前（既存の訳文）:**

```markdown
この拡張機能はMarkdownファイルの翻訳を支援します。
```

**revise 後（AI が差分のみ適用）:**

```markdown
この拡張機能はAIを使ってMarkdownファイルの翻訳を支援します。
```

AI に渡すのは「追加された部分」と「削除された部分」のパッチのみです。訳文全体の書き直しは起きません。

---

<!-- mdait d5c07a3d -->
## FrontMatter 翻訳

FrontMatter（YAML ヘッダー）も通常のユニットと同じ `need` フラグで管理されます。

```yaml
---
title: Getting Started
description: Quick start guide
mdait:
  front: b2c3d4e5 from:a1b2c3d4 need:translate
---
```

翻訳するキーは `trans.frontmatter.keys` で明示的に指定します。

```json
"trans": {
  "frontmatter": {
    "keys": ["title", "description"]
  }
}
```

指定しないキー（例: `date`, `slug`）は翻訳対象外のまま維持されます。

---

<!-- mdait 52a21f67 -->
## 非 MD ファイルの翻訳（extensions 設定）

デフォルトでは `.md` のみが対象ですが、`trans.extensions` で追加できます。

```json
"trans": {
  "extensions": [".txt", ".mdx"],
  "maxFileSize": 51200
}
```

- `extensions` に指定した拡張子のファイルはファイル全体をそのまま AI に送信します
- `maxFileSize`（デフォルト 51200 バイト = 50 KB）を超えるファイルはスキップされます
- コードブロックのスキップ（`skipCodeBlocks`）は MD 専用の設定で、他拡張子には適用されません

---

<!-- mdait d164cd92 -->
## `need:review` の対処

翻訳後にユニット数や見出し構造がソースと一致しない場合、mdait は `need:review` を付与します。

**原因の典型例:**
- AI がユニットを分割・結合した
- 見出しレベルが変わった
- AI 応答に余分なテキストが含まれた

**対処方法:**

| 方法 | 操作 |
|---|---|
| CodeLens「Mark as Reviewed」 | ボタンをクリックしてフラグをクリア |
| 手動修正 + 再 Sync | 訳文を編集して `mdait.sync` を再実行 |

内容に問題がないと判断したら「Mark as Reviewed」が最も手早い解消手段です。

---

<!-- mdait d4c6856e -->
## contextSize と retryLimit

| オプション | デフォルト | 意味 |
|---|---|---|
| `trans.contextSize` | `1` | 翻訳時に前後のユニットを何件 AI に渡すか |
| `trans.retryLimit` | `1` | 翻訳失敗時（バリデーションエラー含む）の最大リトライ数（1〜5） |

- `contextSize` を増やすと文脈が豊かになる反面、トークン消費が増えます
- `retryLimit` を増やすと不安定な AI 応答でのリカバリー率が上がりますが、速度が落ちます

---

<!-- mdait eb8194af -->
## AI プロバイダー設定

`.mdait/mdait.json` の `ai` フィールドでプロバイダーを選択します。

| プロバイダー | `provider` 値 | 概要 |
|---|---|---|
| VS Code Language Model API | `vscode-lm` | **推奨**。GitHub Copilot 経由。追加設定不要 |
| OpenAI | `openai` | API キーが必要 |
| Ollama | `ollama` | ローカルサーバー。`endpoint` と `model` が必要 |

**vscode-lm（推奨）:**

```json
{
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  }
}
```

**OpenAI:**

```json
{
  "ai": {
    "provider": "openai",
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}",
      "baseURL": "https://api.openai.com/v1",
      "model": "gpt-4o"
    }
  }
}
```

`${env:...}` 構文で環境変数から API キーを読み込めます。設定ファイルへの直書きは避けてください。

**Ollama（ローカル）:**

```json
{
  "ai": {
    "provider": "ollama",
    "ollama": {
      "endpoint": "http://localhost:11434",
      "model": "llama3"
    }
  }
}
```

---

<!-- mdait 13a71a1c -->
## mdait-instructions.md によるプロンプトカスタマイズ

`.mdait/mdait-instructions.md` を置くことで、AI に渡すプロンプトをプロジェクト固有の内容で補強できます。

**ファイル形式:**

```markdown
---
prompts: ["trans.translate"]
---

# ドメイン知識
この製品では「ユニット」はMarkdown見出し単位のブロックを指す。
専門用語「TM」は「翻訳メモリ」と訳さず、そのまま「TM」を使うこと。
```

- `prompts` フィールドで適用対象のプロンプト ID を絞れます（省略時は全プロンプトに適用）
- ドメイン用語の統一、トーン指定、禁止表現の列挙などに有効です
- ファイルが存在しない場合はデフォルトプロンプトのみで動作します

---

<!-- mdait c059c715 -->
## 設定オプション詳細

`.mdait/mdait.json` の `trans` セクションで設定します。

| フィールド | デフォルト | 説明 |
|---|---|---|
| `trans.contextSize` | `1` | 翻訳時に渡す周辺ユニット数 |
| `trans.retryLimit` | `1` | 翻訳失敗時の最大リトライ数（1〜5） |
| `trans.markdown.skipCodeBlocks` | `true` | コードブロックを翻訳対象から除外 |
| `trans.frontmatter.keys` | `["title", "description"]` | 翻訳対象とする FrontMatter キー |
| `trans.extensions` | `[]` | 追加翻訳対象拡張子（例: `[".txt"]`） |
| `trans.maxFileSize` | `51200` | 非 MD ファイルのサイズ上限（バイト） |

---

<!-- mdait 44e5fe96 -->
## よくあるユースケースと注意点

**専門用語を固定したい**
→ `mdait-instructions.md` に「〜は〜と訳すこと」を明記します。TM（翻訳メモリ）に蓄積された用語も参照されます。

**コードブロック内のコメントも翻訳したい**
→ `trans.markdown.skipCodeBlocks: false` に設定します。ただし、コードの意味が壊れるリスクがあるため注意が必要です。

**大量のファイルを一括翻訳するとタイムアウトする**
→ `trans.retryLimit` を増やすより、ファイル単位で分割して実行する方が安定します。

**OpenAI の API キーをチームで共有したくない**
→ `${env:OPENAI_API_KEY}` 構文で環境変数から読み込み、`.mdait/mdait.json` は `.gitignore` に追加しないで済む構成にします。

**訳文が毎回ぶれる**
→ `contextSize` を増やして文脈を補強するか、`mdait-instructions.md` でトーン・文体を指定します。

---

<!-- mdait a7c43a36 -->
## 次のステップ

- [用語集管理（Term）](term.md) — ドメイン用語を登録して翻訳精度を上げる
- [翻訳メモリ（TM）](tm.md) — 過去の翻訳を蓄積・再利用する
- [設定リファレンス](config-reference.md) — 全設定オプションの詳細
