# プロンプト設計

> **上位設計**: [architecture.md](architecture.md) P4「LLMをdiff-aware reviseの主戦力とする」参照

## このドキュメントの責務

mdaitが各コマンドでAIに送信するプロンプトの設計と、カスタマイズ方法を定義します。

---

## プロンプトカスタマイズ

### 基本方針

すべてのシステムプロンプトは外部ファイルで上書き可能です。これにより、プロジェクト固有の翻訳スタイルやドメイン知識を反映できます（[architecture.md](architecture.md) 「拡張可能にするもの」参照）。

### 設定方法

`mdait.json`の`prompts`セクションで、各プロンプトIDに対応するファイルパス（ワークスペースルートからの相対パス）を指定します。

```json
{
  "prompts": {
    "trans.translate": ".mdait/prompts/translate.txt",
    "trans.revisePatch": ".mdait/prompts/revise-patch.txt",
    "term.detect": ".mdait/prompts/term-detect.txt",
    "term.extractFromTranslations": ".mdait/prompts/term-extract.txt",
    "term.translateTerms": ".mdait/prompts/term-translate.txt"
  }
}
```

### 変数プレースホルダー

プロンプト内では`{{variable}}`形式のプレースホルダーを使用できます。

**単純変数**: 
```
翻訳元言語: {{sourceLang}}
```

**条件ブロック**:
```
{{#terms}}
用語集:
{{terms}}
{{/terms}}
```
変数が存在する場合のみブロック内容を展開します。

### 追加指示（Instruction）

`.mdait/mdait-instructions.md`にフロントマター付きのMarkdownを配置することで、プロンプトに追加情報を挿入できます。

#### ファイル形式

```markdown
---
prompts: ["trans.translate", "term.detect"]
---

# 背景知識

このプロジェクトは○○に関するドキュメントです。
以下の用語は特別な意味を持ちます：
- 用語A: 説明
- 用語B: 説明
```

#### フロントマター設定

- `prompts`: 適用するプロンプトIDの配列（省略時は全プロンプトに適用）

#### 用途

- 翻訳ドメインの背景知識を提供
- プロジェクト固有の用語説明
- 翻訳スタイルガイド

**設計意図**: プロンプトのコア部分は拡張機能側で管理し、プロジェクト固有の知識はInstructionで追加することで、バージョンアップ時の互換性を保ちます。

### 実装

- デフォルトプロンプト: [`src/prompts/defaults.ts`](../src/prompts/defaults.ts)
- プロンプト提供サービス: [`src/prompts/prompt-provider.ts`](../src/prompts/prompt-provider.ts)

---

## プロンプトID一覧

| ID | 概要 | 使用コマンド |
|---|---|---|
| `trans.translate` | Markdown翻訳 | trans |
| `trans.revisePatch` | 改訂時の差分パッチ翻訳 | trans（revise時） |
| `term.detect` | テキストからの用語検出 | term.detect |
| `term.extractFromTranslations` | 対訳ペアからの用語抽出 | term.expand |
| `term.translateTerms` | 用語のAI翻訳 | term.expand |
| `tm.splitSentences` | 対訳文の文単位アライメント | tm-commit |

---

## プロンプト詳細

### trans.translate - 翻訳

**ファイル**: [`src/commands/trans/translator.ts`](../src/commands/trans/translator.ts)

#### 概要
指定言語ペアでMarkdownセクションを翻訳し、新規用語候補を提案します。

#### 設計意図
- 周辺テキストと用語集を活用した**文脈保持翻訳**
- コードブロックはプレースホルダー化して保護
- 翻訳後に用語集未登録の用語を自動検出して提案

#### 変数
- `{{sourceLang}}`: 翻訳元言語コード
- `{{targetLang}}`: 翻訳先言語コード
- `{{contextLang}}`: context抽出元の言語コード
  - primaryLangがsourceLang/targetLangに含まれる場合はその値、含まれなければsourceLang
- `{{surroundingText}}`: 周辺テキスト（オプショナル）
- `{{terms}}`: 用語集（オプショナル）
- `{{previousTranslation}}`: 前回訳文（オプショナル、改訂時）
- `{{sourceDiff}}`: 原文の変更差分（unified diff形式、オプショナル、改訂時）

#### Output
```json
{
  "translation": "翻訳テキスト",
  "termSuggestions": [
    {
      "source": "元の用語",
      "target": "訳語",
      "context": "用語を含むcontextLang言語からの引用文",
      "reason": "(オプショナル) 追加理由"
    }
  ]
}
```

---

### trans.revisePatch - 改訂パッチ翻訳

**ファイル**: [`src/commands/trans/translator.ts`](../src/commands/trans/translator.ts)

#### 概要
原文差分がある改訂翻訳時に、**前回訳文へのパッチのみ**を返却させるプロンプトです。全文再生成を避け、差分外の文は維持します。

#### 設計意図
これが[architecture.md](architecture.md) P4「LLMをdiff-aware reviseの主戦力とする」の中核です：
- 原文の変更差分（unified diff）と前回訳文をLLMに提示
- 訳文への差分パッチのみを生成させる
- 変更箇所以外は既存訳文を維持し、人間の修正を尊重

#### 変数
- `{{sourceLang}}`: 翻訳元言語コード
- `{{targetLang}}`: 翻訳先言語コード
- `{{contextLang}}`: context抽出元の言語コード
- `{{surroundingText}}`: 周辺テキスト（オプショナル）
- `{{terms}}`: 用語集（オプショナル）
- `{{previousTranslation}}`: 前回訳文（**必須**）
- `{{sourceDiff}}`: 原文の変更差分（unified diff形式、**必須**）

#### Output
```json
{
  "targetPatch": "unified diff against previous translation",
  "termSuggestions": [
    {
      "source": "元の用語",
      "target": "訳語",
      "context": "用語を含むcontextLang言語からの引用文",
      "reason": "(オプショナル) 追加理由"
    }
  ],
  "warnings": ["(optional) patch risk or ambiguity"]
}
```

**重要**: `targetPatch`は前回訳文に適用可能な形式で返却すること。可能な限り差分パッチのみを返却し、全文再生成は避ける。

パッチ適用に失敗した場合はフォールバックとして全文翻訳に切り替わります。

---

### term.detect - 用語検出

**ファイル**: [`src/commands/term/term-detector.ts`](../src/commands/term/term-detector.ts)

#### 概要
テキストから技術用語、製品名、UI要素などの重要な用語を抽出します。

#### 設計意図
- テキスト長に応じた適応的スケーリング（目安: 短文3-10、中文10-20、長文20-40用語）
- 5つの識別基準に基づく抽出：
  1. ドメイン特異性
  2. 用語安定性
  3. 参照有用性
  4. 明確性
  5. 参照的使用

#### 変数
- `{{lang}}`: 対象言語コード
- `{{existingTerms}}`: 既存用語リスト（オプショナル、重複除外用）

#### Output
```json
[
  {"term": "用語", "context": "用語を含む実際の文"}
]
```

---

### term.extractFromTranslations - 用語抽出

**ファイル**: [`src/commands/term/term-expander.ts`](../src/commands/term/term-expander.ts)

#### 概要
ソース-ターゲット対訳ペアから用語対応を抽出します。

#### 設計意図
- 複数の対訳ペア（最大10）を分析し、一貫した翻訳パターンを検出
- 両方のテキストに出現する用語のみ抽出

#### 変数
- `{{sourceLang}}`: ソース言語コード
- `{{targetLang}}`: ターゲット言語コード

#### Output
```json
{
  "source term 1": "target term 1",
  "source term 2": "target term 2"
}
```

---

### term.translateTerms - 用語AI翻訳

**ファイル**: [`src/commands/term/term-expander.ts`](../src/commands/term/term-expander.ts)

#### 概要
未解決用語を直接AI翻訳します。

#### 設計意図
- 技術用語翻訳に特化
- 各用語のコンテキストを考慮
- 技術文書標準に準拠した訳語を生成

#### 変数
- `{{sourceLang}}`: ソース言語コード
- `{{targetLang}}`: ターゲット言語コード

#### Output
```json
{
  "source term 1": "translated term 1",
  "source term 2": "translated term 2"
}
```

---

### tm.splitSentences - 対訳文アライメント

**ファイル**: [`src/commands/tm-commit/sentence-aligner.ts`](../src/commands/tm-commit/sentence-aligner.ts)

#### 概要
ソーステキストとターゲットテキストを受け取り、1:1にアラインされた対訳文ペアの配列を返します。

#### 設計意図
- tm-commitで使用する高精度な文分割
- ソースとターゲットの対応関係を正確に把握
- 非1:1対応（1文→複数文など）は結合して1ペアにまとめる
- 原文を忠実に保持（改変・意訳禁止）
- Markdown構造（リンク、太字、コード等）は文内で保持

#### 変数
- `{{sourceLang}}`: ソース言語コード
- `{{targetLang}}`: ターゲット言語コード
- `{{sourceText}}`: ソースユニット本文
- `{{targetText}}`: ターゲットユニット本文

#### Output
```json
[
  {"source": "source sentence 1", "target": "target sentence 1"},
  {"source": "source sentence 2", "target": "target sentence 2"}
]
```

---

### trans.translate TM参照変数

`trans.translate` および `trans.revisePatch` プロンプトに以下の条件ブロックを追加:

```
{{#tmReferences}}
## Translation Memory Reference

The following are past translations of similar sentences.
Use them as reference for consistency, but prioritize accuracy and context.

{{tmReferences}}
{{/tmReferences}}
```

**設計意図**: 過去対訳が100%正しいとは限らないニュアンスを保つ。LLMには参考情報として提示し、文脈を優先させる。
