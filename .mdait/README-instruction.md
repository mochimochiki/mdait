# プロンプト追加指示機能の使い方

## 概要

`.mdait/mdait-instruction.md`にフロントマター付きのMarkdownを配置することで、AIプロンプトに追加の指示を与えることができます。

## 基本的な使い方

### 1. ファイルの作成

ワークスペースルートに`.mdait/mdait-instruction.md`を作成します。

```markdown
---
---

# 背景知識

このプロジェクトは○○に関するドキュメントです。
以下の用語は特別な意味を持ちます：
- 用語A: 説明
- 用語B: 説明
```

### 2. 適用範囲の指定（オプション）

フロントマターの`prompts`フィールドで、特定のプロンプトにのみ適用することができます。

```markdown
---
prompts: ["trans.translate", "term.translateTerms"]
---

翻訳に関する追加指示をここに記載します。
```

指定できるプロンプトID:
- `trans.translate` - Markdown翻訳
- `term.detect` - 用語検出（廃止予定）
- `term.detectPairs` - 対訳ペアからの用語検出
- `term.detectSourceOnly` - ソース単独からの用語検出
- `term.extractFromTranslations` - 対訳ペアからの用語抽出
- `term.translateTerms` - 用語のAI翻訳

### 3. すべてのプロンプトに適用

`prompts`フィールドを省略すると、すべてのプロンプトに適用されます。

```markdown
---
---

全プロンプト共通の指示をここに記載します。
```

## 使用例

### 例1: 翻訳専用の背景知識

```markdown
---
prompts: ["trans.translate"]
---

# プロジェクト背景

このドキュメントは金融業界向けのAPIドキュメントです。

## 重要な用語

- Settlement: 決済（取引の最終確定）
- Clearing: クリアリング（取引の照合・計算）
- Liquidity: 流動性

## 翻訳スタイル

- 専門用語は正確性を最優先してください
- 曖昧な表現は避けてください
```

### 例2: 全プロンプト共通の指示

```markdown
---
---

このプロジェクトはオープンソースソフトウェアのドキュメントです。
技術的な正確性を保ちながら、初心者にも理解しやすい表現を心がけてください。
```

## 注意事項

- ファイルは`.mdait/mdait-instruction.md`に配置してください（他の場所には対応していません）
- 内容はキャッシュされるため、変更した場合はVS Codeの再読み込みが必要な場合があります
- フロントマターはYAML形式で記述してください

## トラブルシューティング

### 指示が反映されない場合

1. ファイルパスが正しいか確認してください（`.mdait/mdait-instruction.md`）
2. フロントマターの構文が正しいか確認してください
3. VS Codeを再読み込みしてください（Developer: Reload Window）

### 特定のプロンプトにのみ適用したい場合

フロントマターの`prompts`配列に対象のプロンプトIDを指定してください。

```yaml
---
prompts: ["trans.translate"]
---
```
