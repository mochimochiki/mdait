# プロンプト

> [architecture](../architecture.md) > **Prompt**

## このドキュメントの責務

mdaitが各コマンドでAIに送信するプロンプトの設計と、カスタマイズ方法を定義します。

---

## プロンプトカスタマイズ

### 基本方針

すべてのシステムプロンプトは外部ファイルで上書き可能です。これにより、プロジェクト固有の翻訳スタイルやドメイン知識を反映できます。

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

### system / user-section 分割（プレフィックスキャッシュ対応）

翻訳系プロンプト（`trans.translate` / `trans.revisePatch` / `trans.translatePlain` / `trans.revisePatchPlain`）は、テンプレート内の分割マーカーで **system部** と **user-section部** に分かれます。

```
（静的な指示・出力フォーマット仕様 — system prompt になる）
<!-- mdait:user-section -->
（可変データの条件ブロック — user message の先頭に配置される）
```

- **system部**: マーカーより前。**変数を一切含まない完全静的なテキスト**であり、プロンプト種別ごとに全ワークスペース共通の単一プレフィックスとなる（言語ペアやファイル拡張子が違ってもキャッシュを共有できる）。AIプロバイダーのプロンプトキャッシュ（OpenAIの自動プロンプトキャッシュ、Ollamaのkv-cache再利用など）が効く
- **user-section部**: マーカーより後。先頭の `Translation Direction`（`{{sourceLang}}`・`{{targetLang}}`・`{{contextLang}}`・`{{fileExtension}}`）と、ユニットごとに変わる可変データ（`{{terms}}`・`{{tmReferences}}`・`{{surroundingText}}`・`{{previousTranslation}}`・`{{sourceDiff}}`）の条件ブロックを置く。言語指定もここに含まれるため、system部は翻訳方向に依存しない
- user message は「user-sectionのレンダリング結果 + 区切り行 `=== SOURCE TEXT ===` + 翻訳対象本文」の形に組み立てられる（`buildUserMessage`）。区切り行の意味はsystem部の `USER MESSAGE STRUCTURE` で説明される
- リトライ時の補足プロンプトも user message 側に付与され、system部はセッションを通じて不変

**カスタムプロンプトとの後方互換**: マーカーを含まないテンプレート（既存のカスタム上書きプロンプト）は**レガシーモード**として従来通り全体が system prompt になり、user message は本文のみとなる。挙動は従来と完全に同一（キャッシュ最適化の恩恵がないだけ）。カスタムプロンプトをキャッシュ対応させるには、可変ブロックの直前に `<!-- mdait:user-section -->` の行を追加する。

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

### 実装

- デフォルトプロンプト: [`src/prompts/defaults.ts`](../../src/prompts/defaults.ts)
- プロンプト提供サービス: [`src/prompts/prompt-provider.ts`](../../src/prompts/prompt-provider.ts)

---

## プロンプトID一覧

| ID | 概要 | 使用コマンド |
|---|---|---|
| `trans.translate` | Markdown翻訳 | trans |
| `trans.revisePatch` | 改訂時の差分パッチ翻訳 | trans（revise時） |
| `trans.translatePlain` | 非MDファイル翻訳 | trans（非MDファイル） |
| `trans.revisePatchPlain` | 非MDファイルの改訂パッチ翻訳 | trans（非MDファイルrevise時） |
| `term.detect` | テキストからの用語検出 | term.detect |
| `term.extractFromTranslations` | 対訳ペアからの用語抽出 | term.expand |
| `term.translateTerms` | 用語のAI翻訳 | term.expand |
| `tm.splitSentences` | 対訳文の文単位アライメント | tm-commit |

---

## プロンプト詳細

### trans.translate - 翻訳

**ファイル**: [`src/commands/trans/translator.ts`](../../src/commands/trans/translator.ts)

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

**ファイル**: [`src/commands/trans/translator.ts`](../../src/commands/trans/translator.ts)

#### 概要
原文差分がある改訂翻訳時に、**前回訳文へのパッチのみ**を返却させるプロンプトです。全文再生成を避け、差分外の文は維持します。

#### 設計意図
これが[architecture.md](../architecture.md) P4「LLMをdiff-aware reviseの主戦力とする」の中核です：
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

**ファイル**: [`src/commands/term/term-detector.ts`](../../src/commands/term/term-detector.ts)

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

**ファイル**: [`src/commands/term/term-expander.ts`](../../src/commands/term/term-expander.ts)

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

**ファイル**: [`src/commands/term/term-expander.ts`](../../src/commands/term/term-expander.ts)

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

### tm.splitSentences - TM登録計画生成

**ファイル**: [`src/commands/tm/tm-entry-generator.ts`](../../src/commands/tm/tm-entry-generator.ts)

#### 概要
`primaryUnit` / `localUnit` と既存 TM 情報を受け取り、TM 登録用の `new|update` 計画を返します。

#### 設計意図
- tm-commit の正準軸を source/target から primary/local へ切り替える
- 既存 TU 更新と新規 TU 追加を一度の応答で分離する
- `update必須tuid` を欠落させない制約付き応答を生成する
- `primary` / `local` を unit 全体のサブセットとして保持し、勝手な言い換えを防ぐ
- primary sentence を基準にした TU reuse を優先し、non-primary 側だけでの新規作成を防ぐ
- Professional TM curator roleにより、LLM側でノイズや意味のない文字列を自動除外
- クライアント側`isWorthyForTm`と合わせて二段階の品質確保

#### 変数
- `{{primaryLang}}`: primary 言語コード
- `{{localLang}}`: 今回登録する local 言語コード
- `{{primaryUnit}}`: primaryLang 側ユニット本文
- `{{localUnit}}`: localLang 側ユニット本文
- `{{ExistingTmEntries}}`: `{tuid, primarySentence, localSentence|null}` 配列
- `{{requiredUpdateTuids}}`: 欠落不可の既存 tuid 一覧
- `{{retryMissingTuids}}`: 再試行時に補完対象とする tuid 一覧（初回は空）
- `{{retryReason}}`: 再試行理由の要約（初回は空）

#### Output
```json
[
  {
    "type": "new",
    "tuid": "-",
    "primary": "primary sentence 1",
    "local": "local sentence 1"
  },
  {
    "type": "update",
    "tuid": "e1f2g3h4",
    "primary": "primary sentence 2",
    "local": "local sentence 2"
  }
]
```

#### 補足
- `type=update` の `tuid` は必ず入力済み `ExistingTmEntries` を参照する
- `type=new` の `tuid` はプレースホルダー `"-"` とし、実際の tuid はクライアントが `primary` から計算する
- 再試行では `retryMissingTuids` に含まれる `tuid` の `local` 補完だけを返す契約とし、新規候補や既に確定済みの update を再送させない

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
