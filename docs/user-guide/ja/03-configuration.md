# 設定ファイル詳細

このセクションでは、`mdait.json`の各設定項目について詳しく説明します。

## 設定ファイルの構造

`mdait.json`は、以下のセクションで構成されています：

```json
{
  "transPairs": [...],
  "ignoredPatterns": [...],
  "sync": {...},
  "ai": {...},
  "trans": {...},
  "terms": {...}
}
```

## transPairs（翻訳ペア）

翻訳元と翻訳先のディレクトリペアを定義します。複数のペアを設定可能です。

```json
{
  "transPairs": [
    {
      "sourceLang": "ja",
      "sourceDir": "docs/ja",
      "targetLang": "en",
      "targetDir": "docs/en"
    }
  ]
}
```

### パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| sourceLang | string | ○ | 原文の言語コード（例: `ja`, `en`, `de`） |
| sourceDir | string | ○ | 原文が配置されているディレクトリ（ワークスペース相対パス） |
| targetLang | string | ○ | 訳文の言語コード |
| targetDir | string | ○ | 訳文を配置するディレクトリ（ワークスペース相対パス） |

### 多段翻訳の設定

日本語→英語→ドイツ語のような多段翻訳も設定できます：

```json
{
  "transPairs": [
    {
      "sourceLang": "ja",
      "sourceDir": "docs/ja",
      "targetLang": "en",
      "targetDir": "docs/en"
    },
    {
      "sourceLang": "en",
      "sourceDir": "docs/en",
      "targetLang": "de",
      "targetDir": "docs/de"
    }
  ]
}
```

この場合、英語版は日本語から翻訳され、ドイツ語版は英語から翻訳されます。

## ignoredPatterns（除外パターン）

同期・翻訳処理から除外するファイルパターンを指定します。

```json
{
  "ignoredPatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/.git/**"
  ]
}
```

glob形式のパターンを使用できます。

## sync（同期設定）

ユニット分割と同期処理の動作を設定します。

```json
{
  "sync": {
    "level": 3,
    "autoDelete": true
  }
}
```

### パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| level | number | 2 | ユニット分割の見出しレベル（1-6）。このレベル以下の見出しがユニット境界となる |
| autoDelete | boolean | true | 原文が削除されたユニットを訳文から自動削除するかどうか |

### level設定の例

**level: 2の場合**
```markdown
# Level 1 (ユニット境界)
## Level 2 (ユニット境界)
### Level 3 (ユニット境界ではない)
```

**level: 3の場合**
```markdown
# Level 1 (ユニット境界)
## Level 2 (ユニット境界)
### Level 3 (ユニット境界)
#### Level 4 (ユニット境界ではない)
```

## ai（AI設定）

AIプロバイダーとモデルの設定を行います。

```json
{
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  }
}
```

### 共通パラメータ

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| provider | string | ○ | AIプロバイダー（`vscode-lm`, `ollama`, `openai`） |
| model | string | ○ | 使用するモデル名 |

各プロバイダー固有の設定については、[AIプロバイダー設定](./07-ai-providers.md)を参照してください。

## trans（翻訳設定）

翻訳処理の動作をカスタマイズします。

```json
{
  "trans": {
    "markdown": {
      "skipCodeBlocks": true
    },
    "contextSize": 1,
    "qualityRetryLimit": 1
  }
}
```

### パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| markdown.skipCodeBlocks | boolean | true | コードブロック内の翻訳をスキップするかどうか |
| contextSize | number | 1 | 翻訳時に参照する前後のユニット数（0-3） |
| qualityRetryLimit | number | 1 | 翻訳品質チェックで問題が見つかった場合に再翻訳を試行する最大回数 |

### contextSizeについて

翻訳対象ユニットの前後のコンテキストをAIに提供することで、より文脈に沿った翻訳が可能になります：

- **0**: コンテキストなし（最速だが文脈が限定的）
- **1**: 前後1ユニット（推奨、バランスの良い設定）
- **2-3**: 前後2-3ユニット（より広い文脈、ただしトークン消費増加）

## terms（用語集設定）

用語集ファイルの設定を行います。

```json
{
  "terms": {
    "filename": "terms.csv",
    "primaryLang": "en"
  }
}
```

### パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|-----------|-----|----------|------|
| filename | string | "terms.csv" | 用語集ファイル名（`.mdait/`ディレクトリからの相対パス） |
| primaryLang | string | "en" | 用語集の基準言語 |

用語集の詳細については、[用語集管理](./05-terms.md)を参照してください。

## 環境変数の使用

設定値に環境変数を使用できます：

```json
{
  "ai": {
    "provider": "openai",
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}"
    }
  }
}
```

`${env:変数名}`形式で環境変数を参照できます。APIキーなどの機密情報は、この方法で設定してください。

## 次のステップ

[次の章](./04-basic-workflow.md)では、mdaitの基本的な翻訳ワークフローについて説明します。
