# mdait - Markdown AI Translator

![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/badge/version-1.0.0-green) ![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

AIを活用したMarkdown文書の翻訳・同期ツール。翻訳メモリと用語集の管理機能を備え、技術文書の多言語化を効率化する。

## インストール

```bash
code --install-extension mdait
# または開発版をローカルビルド
git clone https://github.com/example/mdait.git
cd mdait && npm install && npm run compile
```

## 主な機能

- **翻訳コマンド**: Markdownファイルを指定言語に翻訳
- **同期コマンド**: 原文の変更を検出し、翻訳ファイルを差分更新
- **翻訳メモリ**: 過去の翻訳ペアを蓄積・再利用（[詳細](https://example.com/docs/tm)）
- **用語集管理**: プロジェクト固有の用語を一元管理

## 使い方

```bash
mdait setup                                         # 設定初期化
mdait translate --source ja --target en document.md  # 翻訳
mdait tm-commit                                      # TMコミット
```

## 設定例

プロジェクトルートに `.mdait/config.json` を配置する。

```json
{
  "primaryLang": "ja",
  "secondaryLangs": ["en"],
  "llm": {
    "provider": "openai",
    "model": "gpt-4o"
  }
}
```

<details>
<summary>よくある質問</summary>

**Q: 対応ファイル形式は？** — Markdown（`.md`）のみ対応。

**Q: LLMプロバイダは変更できる？** — [OpenAI](https://openai.com)、[Azure OpenAI](https://azure.microsoft.com/products/ai-services/openai-service)、[Anthropic](https://www.anthropic.com) を選択可能。

</details>

## ライセンス

[MIT License](LICENSE) に基づき公開。詳細はライセンスファイルを参照。
