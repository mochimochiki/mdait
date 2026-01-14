# AIプロバイダー設定

このセクションでは、mdaitで使用できる各AIプロバイダーの詳細な設定方法について説明します。

## 対応プロバイダー

mdaitは以下のAIプロバイダーに対応しています：

- **VS Code Language Model API (vscode-lm)**: GitHub CopilotやVS Code組み込みLM
- **Ollama**: ローカル実行のオープンソースLLM
- **OpenAI**: OpenAI公式API

## VS Code Language Model API

### 概要

VS Code Language Model APIは、VS Codeに統合されたLM機能を使用します。GitHub Copilot契約がある場合、追加の設定なしで利用できます。

### 設定例

```json
{
  "ai": {
    "provider": "vscode-lm",
    "model": "gpt-4.1"
  }
}
```

### パラメータ

| パラメータ | 説明 | 例 |
|-----------|------|-----|
| provider | プロバイダー名（固定） | `"vscode-lm"` |
| model | 使用するモデル名 | `"gpt-4.1"`, `"claude-3.5-sonnet"` |

## Ollama

### 概要

Ollamaは、ローカル環境でLLMを実行できるオープンソースツールです。インターネット接続なしでAI機能を使用でき、データがローカルに保持されます。

### 前提条件

1. Ollamaのインストール: https://ollama.ai/
2. モデルのダウンロード: `ollama pull llama2`

### 設定例

```json
{
  "ai": {
    "provider": "ollama",
    "ollama": {
      "endpoint": "http://localhost:11434",
      "model": "llama2"
    }
  }
}
```

### パラメータ

| パラメータ | 説明 | デフォルト |
|-----------|------|----------|
| provider | プロバイダー名（固定） | `"ollama"` |
| ollama.endpoint | OllamaサーバーのURL | `"http://localhost:11434"` |
| ollama.model | 使用するモデル名 | - |

## OpenAI

### 概要

OpenAI APIを直接使用して翻訳を実行します。高品質な翻訳が期待できますが、使用量に応じた料金が発生します。

### 設定例

```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o",
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}",
      "baseURL": "https://api.openai.com/v1",
      "maxTokens": 2048,
      "timeoutSec": 120
    }
  }
}
```

### パラメータ

| パラメータ | 説明 | デフォルト |
|-----------|------|----------|
| provider | プロバイダー名（固定） | `"openai"` |
| model | 使用するモデル名 | - |
| openai.apiKey | OpenAI APIキー（環境変数推奨） | - |
| openai.baseURL | APIエンドポイント | `"https://api.openai.com/v1"` |
| openai.maxTokens | 最大出力トークン数 | `2048` |
| openai.timeoutSec | リクエストタイムアウト（秒） | `120` |

### APIキーの管理

**セキュリティのため、APIキーは環境変数で管理してください**：
