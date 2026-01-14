# Getting Started

このセクションでは、mdaitのインストールから最初の翻訳実行までの手順を説明します。

## インストール

1. [GitHubリリースページ](https://github.com/mochimochiki/mdait/releases)から最新のVSIXファイルをダウンロードします。
2. VS Codeで、拡張機能ビューを開き、右上の「...」メニューから「VSIXから拡張機能をインストール...」を選択します。
3. ダウンロードしたVSIXファイルを選択してインストールします。

## 初期設定

### 1. mdaitビューを開く

アクティビティバーから🌐（地球儀）アイコンをクリックして、mdaitビューを開きます。
✏初回起動時は、設定ファイルの作成を促すWelcome Viewが表示されます。

### 2. 設定ファイルの作成

「mdait.jsonを作成」ボタンをクリックすると、ワークスペースのルートディレクトリに`mdait.json`ファイルが作成され、エディタで開きます。

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
    "model": "gpt-5 mini"
  },
  "trans": {
    "contextSize": 1
  },
  "sync": {
    "level": 3
  },
  "terms": {
    "primaryLang": "en"
  }
}
```

### 3. 翻訳ペアの設定

`transPairs`に、原文と訳文のディレクトリペアを設定します：

- **sourceLang**: 原文の言語コード（例: `ja`, `en`）
- **sourceDir**: 原文が配置されているディレクトリ
- **targetLang**: 訳文の言語コード
- **targetDir**: 訳文を配置するディレクトリ

複数の翻訳ペアを設定することもできます：

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
      "sourceLang": "ja",
      "sourceDir": "docs/ja",
      "targetLang": "de",
      "targetDir": "docs/de"
    }
  ]
}
```

### 4. AIプロバイダーの選択

`ai.provider`で使用するAIサービスを選択します：

- **vscode-lm**: VS Code Language Model API（GitHub Copilot）
- **ollama**: ローカル実行のOllama
- **openai**: OpenAI公式API

詳細な設定方法は、第7章「AIプロバイダー設定」を参照してください。

## 最初の同期

設定ファイルを保存したら、最初の同期を実行します。

### 1. 同期の実行

mdaitビューのツールバーにある🔄（Sync）ボタンをクリックします。

### 2. 同期の動作

同期処理では、以下の操作が実行されます：

1. **原文ファイルの解析**: 指定した見出しレベルでユニットに分割
2. **mdaitマーカーの付与**: 各ユニットにハッシュ付きHTMLコメントを挿入
3. **訳文ファイルの作成または更新**: 原文に対応する訳文ファイルを生成
4. **対応関係の確立**: 原文と訳文のユニット間で対応関係を確立
5. **変更検出**: 原文が変更されたユニットに`need:translate`フラグを付与

### 3. mdaitマーカーの確認

同期完了後、原文と訳文のMarkdownファイルを開くと、見出しの前にmdaitマーカーが挿入されています：

```markdown
<!-- mdait 3f7c8a1b -->
## はじめに

mdaitは、Markdownドキュメントを継続的に多言語運用するための...
```

訳文ファイルには、原文との対応を示す`from`フィールドが含まれます：

```markdown
<!-- mdait 2d5e9c4f from:3f7c8a1b need:translate -->
## Introduction

(This section needs translation)
```

✏このマーカーが、mdaitが利用する唯一の管理情報です。管理情報はMarkdownファイル内で完結しているため、手動で編集することも可能です。mdaitマーカーを原文に手動で追加して翻訳単位を分割することすらできます。

## 最初の翻訳

### 1. 翻訳対象の確認

mdaitビューには、ユニットが一覧表示されます。`need:translate`フラグが付与されたユニットは、〇アイコンで表示されます。

### 2. ユニットの翻訳

訳文ファイルを開き、mdaitマーカー上に表示される▶️（翻訳）ボタンをクリックすると、そのユニットの翻訳が開始されます。翻訳が完了すると、ユニットの内容が更新され、`need:translate`フラグが削除され、mdaitビューのユニットが✅アイコンに変わります。

### 3. 翻訳結果の確認

翻訳完了後、マーカー行にマウスオーバーすると、翻訳サマリが表示されます：

- 処理時間
- 使用トークン数
- 用語集追加候補
- 品質チェック警告

✏[用語集に追加]ボタンをクリックすると、表示されている用語候補が`terms.csv`に追加されます。

### 4. 原文との比較

マーカー上の「原文」リンクをクリックすると、原文との比較ビューが開き、翻訳内容を確認できます。

## まとめ

これで、mdaitの基本的な設定と最初の翻訳実行が完了しました。[次の章](./03-configuration.md)では、設定ファイルのより詳細な項目について説明します。
