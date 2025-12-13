# mdait - Markdown AI Translator

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**mdait**（Markdown AI Translator）は、Markdownドキュメント向けのAI翻訳機能を提供する強力なVS Code拡張機能です。ユニットベースの処理、ハッシュベースの変更検出、包括的な翻訳状態追跡を通じて、翻訳ワークフローをインテリジェントに管理します。

## ✨ 機能

### 🔄 スマート同期
- **ユニットベース処理**: Markdownドキュメントを翻訳可能なユニットに自動分割
- **ハッシュベース変更検出**: CRC32ハッシュを使用した効率的な変更識別
- **ドキュメント間同期**: 複数の言語バージョン間の一貫性を維持

### 🤖 AI翻訳
- **複数プロバイダー対応**: 
  - VS Code Language Model API
  - Ollama（ローカルLLMサポート）
- **バッチ翻訳**: 複数ユニットの効率的な処理
- **翻訳状態追跡**: 視覚的インジケーターによる進捗監視

## 🏃‍♂️ はじめに

### 1. 翻訳ペアの設定

ワークスペースルートに`mdait.yaml`ファイルを作成し、翻訳ディレクトリを設定してください：

```yaml
# mdait.yaml
transPairs:
  - sourceDir: docs/ja
    targetDir: docs/en
    sourceLang: ja
    targetLang: en
```

### 2. ドキュメントの初期化

1. ソースディレクトリにソースMarkdownファイルを作成
2. アクティビティバーでmdaitパネルを開く
3. **Sync**ボタンをクリックして、ターゲットディレクトリに翻訳マーカー付きの対応ファイルを作成

### 3. コンテンツの翻訳

1. アクティビティバーでmdaitパネルを開く
2. 翻訳状態ツリーを表示
3. 翻訳ボタンをクリックして操作：
   - **Translate Directory**ボタン: ディレクトリ内の全ファイルを処理
   - **Translate File**ボタン: 単一ファイルを処理
   - **Translate Unit**ボタン: 個別ユニットを処理

## ⚙️ 設定

### 翻訳ペア
```yaml
# mdait.yaml
transPairs:
  - sourceDir: content/ja    # ソース言語ディレクトリ
    targetDir: content/en    # ターゲット言語ディレクトリ
    sourceLang: ja
    targetLang: en
```

### AIプロバイダー設定
```yaml
# mdait.yaml
ai:
  provider: default              # VS Code LM APIを使用
  model: gpt-4o
  ollama:
    endpoint: http://localhost:11434  # OllamaサーバーURL
    model: gemma3                     # Ollamaモデル名
```

### 処理オプション
```yaml
# mdait.yaml
ignoredPatterns: "**/node_modules/**,**/.git/**"  # 除外パターン
sync:
  autoDelete: true                  # 孤立ユニットの自動削除
trans:
  markdown:
    skipCodeBlocks: true            # 翻訳時のコードブロック除外
```

## 🔧 AIプロバイダーセットアップ

### VS Code Language Model API
mdaitはVS Codeの内蔵言語モデル機能を使用します。実際のモデル使用にはGitHub Copilotアカウントが必要です。

### Ollama（ローカルLLM）
1. [Ollama](https://ollama.ai/)をインストール
2. Ollamaサーバーを起動：`ollama serve`
3. モデルをプル：`ollama pull gemma3`
4. `mdait.yaml`でOllamaプロバイダーを設定：
   ```yaml
   ai:
     provider: ollama
     ollama:
       model: gemma3
   ```

## 🛠️ 開発

### 前提条件
- Node.js 20.x以上
- VS Code 1.99.0以上

### セットアップ
```bash
# リポジトリをクローン
git clone https://github.com/mochimochiki/mdait.git
cd mdait

# 依存関係をインストール
npm install

# TypeScriptをコンパイル
npm run compile

# リンティングを実行
npm run lint

# テストを実行
npm run test

# 開発用ウォッチモード
npm run watch
```

### テスト
プロジェクトには包括的なテストカバレッジが含まれています：
- コア機能のユニットテスト
- VS Code拡張機能の統合テスト
- 翻訳ワークフローテスト用のサンプルコンテンツ

```bash
npm run test
```

## 📋 要件

- VS Code 1.99.0以上
- Ollamaサポート用：ローカルまたはリモートで実行されているOllamaサーバー

## 📄 ライセンス

このプロジェクトはApache License 2.0の下でライセンスされています - 詳細は[LICENSE](LICENSE)ファイルを参照してください。

## 📚 ドキュメント

- [設計ドキュメント](desing/design.md) - 包括的なアーキテクチャと設計の詳細
- [タスクドキュメント](tasks/) - 開発タスクの追跡と実装ノート

## 🌐 国際化

mdaitは複数の言語をサポートしています：
- English（デフォルト）
- Japanese（日本語）

UI要素はVS Codeのl10nシステムを使用してローカライズされています。