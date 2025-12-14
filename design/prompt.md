# プロンプト

mdaitの各コマンドで使用されているAIプロンプトの一覧です。

## 翻訳 (trans)

**ファイル**:
[`src/commands/trans/translator.ts`](../src/commands/trans/translator.ts)

**概要**:
指定言語ペアでMarkdownセクションを翻訳し、新規用語候補を提案します。

**主要ロジック**:
周辺テキストと用語集を活用した文脈保持翻訳。コードブロックはプレースホルダー化して保護。翻訳後に用語集未登録の用語を自動検出して提案。

**Input**:
- 翻訳対象テキスト（コードブロック除去済み）
- コンテキスト（周辺テキスト、用語集）

**Output**:
```json
{
  "translation": "翻訳テキスト",
  "termSuggestions": [
    {"source": "元の用語", "target": "訳語", "reason": "追加理由"}
  ]
}
```

---

## 用語検出 (term-detect)

**ファイル**:
[`src/commands/term/term-detector.ts`](../src/commands/term/term-detector.ts)

**概要**:
テキストから技術用語、製品名、UI要素などの重要な用語を抽出します。

**主要ロジック**:
テキスト長に応じた適応的スケーリング（目安: 短文3-10、中文10-20、長文20-40用語）、5つの識別基準（ドメイン特異性、用語安定性、参照有用性、明確性、参照的使用）に基づく抽出。

**Input**:
- テキストコンテンツ（複数セクション結合可）
- 既存用語リスト（重複除外用）

**Output**:
```json
[
  {"term": "用語", "context": "用語を含む実際の文"}
]
```

---

## 用語展開 (term-expand)

### 用語抽出

**ファイル**:
[`src/commands/term/term-expander.ts`](../src/commands/term/term-expander.ts)

**概要**:
ソース-ターゲット対訳ペアから用語対応を抽出します。

**主要ロジック**:
複数の対訳ペア（最大10）を分析し、一貫した翻訳パターンを検出。両方のテキストに出現する用語のみ抽出。

**Input**:
- 対訳ペアリスト（source/target content）
- 抽出対象用語リスト

**Output**:
```json
{
  "source term 1": "target term 1",
  "source term 2": "target term 2"
}
```

### AI翻訳

**概要**:
未解決用語を直接AI翻訳します。

**主要ロジック**:
技術用語翻訳に特化。各用語のコンテキストを考慮し、技術文書標準に準拠した訳語を生成。

**Input**:
- 用語リスト（term + context）

**Output**:
```json
{
  "source term 1": "translated term 1",
  "source term 2": "translated term 2"
}
```
