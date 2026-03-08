# TM（翻訳メモリ）機能まとめ

> 2026-03-08 時点の全体像

---

## 1. TM機能とは

翻訳済みの対訳（原文と訳文のペア）を**文単位**でTMXファイルに蓄積し、次回以降の翻訳時にLLMプロンプトの参考情報として提供する機能。翻訳表現の一貫性を高めることが目的。

**TMXファイル**: `.mdait/translations.tmx`（TMX 1.4準拠のXML形式）

---

## 2. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                    ユーザー操作                          │
│  StatusTree → tm-commit.file / tm-commit.directory      │
│  StatusTree → status.openTm（TMXファイルを開く）         │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│              Commands層                                  │
│                                                          │
│  【TM登録（書き込み）】                                    │
│  tm-commit-command.ts                                    │
│    → tm-commit-filter.ts   (対象判定)                     │
│    → tm-commit-processor.ts (登録処理)                    │
│      → sentence-aligner.ts (LLMで文アライメント)          │
│                                                          │
│  【TM参照（読み取り）】                                    │
│  trans-command.ts → lookupTmReferences()                 │
│    → sentence-splitter.ts (正規表現で文分割)              │
│    → tmx-store.lookupBatch() (ハッシュ一括検索)           │
│    → tm-reference-formatter.ts (プロンプト用整形)         │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│              Core層                                      │
│                                                          │
│  tmx-store.ts        TMXのI/O、インメモリインデックス     │
│  types.ts            TmEntry, TmMatch, SentencePair      │
│  tm-text-normalizer  stripMarkdown, isWorthyForTm        │
│  sentence-splitter   Intl.Segmenter ベース文分割          │
│  tm-reference-formatter  TM参照のテキスト整形             │
└─────────────────────────────────────────────────────────┘
```

---

## 3. コマンド体系

| コマンド | 粒度 | UI起点 | 説明 |
|---|---|---|---|
| `mdait.tm-commit.file` | ファイル単位 | StatusTree コンテキストメニュー | ファイル内の全対象ユニットをTM登録 |
| `mdait.tm-commit.directory` | ディレクトリ単位 | StatusTree コンテキストメニュー | ディレクトリ内の全ファイルを一括TM登録 |
| `mdait.status.openTm` | - | StatusTree ナビゲーション | TMXファイルをエディタで開く |

> **廃止**: `mdait.tm-commit.unit`（ユニット単位）は廃止済み。TM登録は一括処理が基本のため。

---

## 4. TM登録フロー（tm-commit）

### 4.1 対象判定

| 条件 | 判定 | 理由 |
|---|---|---|
| `from`属性あり + `need`なし | **処理対象** | 翻訳済み |
| `from`属性あり + `need:review` | スキップ | レビュー待ち |
| `from`属性あり + `need:revise@*` | スキップ | 訳文が旧版 |
| `from`属性あり + `need:translate` | スキップ | 未翻訳 |
| `from`属性なし | スキップ | ソースファイルまたは未リンク |

### 4.2 sourceHashベーススキップ

TMXの`x-source-hash`プロパティを活用し、**既にTM登録済みのユニットをスキップ**する。

- 各ユニットの `marker.hash`（原文コンテンツのCRC32ハッシュ）がTMXに存在するかチェック
- 存在すればスキップ（原文が**一文字でも**変わっていれば再処理される）
- `TmxStore.hasSourceHash()` は `Set<string>` の二次インデックスによりO(1)で検索

**効果**: 大量のファイルに対してtm-commitを実行しても、未登録・変更済みのユニットのみが処理される。

### 4.3 処理パイプライン

```
ユニット取得 → 対象判定(isTmCommitTarget) → sourceHashスキップ
  → ソースユニット内容取得(from hash経由)
  → SentenceAligner（LLMで対訳を文ペアに分割）
    → stripMarkdown（Markdown除去）
    → LLM API呼び出し（tm.splitSentencesプロンプト）
    → JSON解析 → SentencePair[]
  → 各文ペア:
    → isWorthyForTm（翻訳価値判定）
    → sentenceHash = CRC32(normalize(source))
    → TmxStore.addEntry（新規追加 or 既存更新）
  → TmxStore.save（永続化）
```

### 4.4 品質フィルタリング（二段階）

**第1段階: LLM側フィルタリング** (`tm.splitSentences`プロンプト)
- ランダム文字列・プレースホルダー・数字のみ等を自動除外

**第2段階: クライアント側フィルタリング**
- `stripMarkdown()`: コードブロック/リンク/太字等のMarkdown記法を除去
- `isWorthyForTm()`: 短文・数値のみ・URL等、翻訳価値のない断片を除外

---

## 5. TM参照フロー（trans時の読み取り）

翻訳 (`trans`) コマンド実行時に、TMから過去の対訳を検索してプロンプトに注入する。

```
trans実行 → ソースユニットをstripMarkdown
  → SentenceSplitter（正規表現で文分割）
  → 各文のsentenceHashを計算
  → TmxStore.lookupBatch（一括検索、O(1)×N）
  → maxReferences件まで選定
  → formatTmReferences（テキスト整形）
  → プロンプトの{{tmReferences}}に注入
```

**プロンプト内での位置付け**: 参考情報として提示。LLMには文脈やニュアンスを優先させる指示。

### 文分割の非対称性

| 場面 | 方法 | 理由 |
|---|---|---|
| tm-commit（書き込み） | LLM (`tm.splitSentences`) | 高精度アライメント。一度だけ実行 |
| trans（検索） | 正規表現 (`SentenceSplitter`) | 毎翻訳で実行。即時性重視 |

分割結果の差異でTM参照を取りこぼす可能性があるが、「誤った参照の提示」よりも安全。

---

## 6. TMXファイル構造

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <body>
    <tu>
      <prop type="x-hash">a1b2c3d4</prop>           <!-- 文ハッシュ(CRC32) -->
      <prop type="x-unit">docs/guide.md</prop>       <!-- 出典パス -->
      <prop type="x-source-hash">e5f6a7b8</prop>     <!-- 原文ユニットのハッシュ(スキップ判定用) -->
      <tuv xml:lang="en"><seg>Download the installer</seg></tuv>
      <tuv xml:lang="ja"><seg>インストーラーをダウンロード</seg></tuv>
    </tu>
  </body>
</tmx>
```

| プロパティ | 用途 |
|---|---|
| `x-hash` | 文単位のsentenceHash（CRC32、主キー）|
| `x-unit` | 最初の出典ファイルパス |
| `x-source-hash` | 原文ユニットのコンテンツハッシュ。sourceHashベーススキップに使用 |

---

## 7. TmxStore（インメモリインデックス）

**シングルトン設計**: `TmxStore.getInstance(tmxFilePath)` でmtime判定による自動リロード。

**データ構造**:
- `Map<sentenceHash, TmEntry>`: 主インデックス（O(1)検索）
- `Set<string>`: sourceHash二次インデックス（O(1) hasSourceHashチェック）

**主要API**:
| メソッド | 用途 |
|---|---|
| `addEntry(entry)` | エントリー追加/更新 |
| `findByHash(hash)` | sentenceHashで単一検索 |
| `lookupBatch(hashes, src, tgt)` | 複数ハッシュ一括検索（TmMatch[]） |
| `hasSourceHash(hash)` | sourceHashの存在チェック（スキップ判定） |
| `searchBySource(text, lang)` | 原文テキスト完全一致検索 |
| `save(filePath)` | TMX XMLを書き出し |

---

## 8. 設定

`mdait.json` の `tm` セクション:

```json
{
  "tm": {
    "enabled": true,
    "maxReferences": 5
  }
}
```

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `enabled` | boolean | `true` | TM機能全体の有効/無効 |
| `maxReferences` | number | `5` | transプロンプトに含める最大TM参照数（1-20） |

---

## 9. ソースファイル一覧

### Core層 (`src/core/tm/`)
| ファイル | 責務 |
|---|---|
| `types.ts` | TmEntry, TmMatch, SentencePair 型定義 |
| `tmx-store.ts` | TMX I/O、インメモリCRUD、シングルトン |
| `tm-text-normalizer.ts` | stripMarkdown, isWorthyForTm |
| `sentence-splitter.ts` | Intl.Segmenterベース文分割（trans検索用） |
| `tm-reference-formatter.ts` | TM参照のプロンプト向け整形 |

### Commands層 (`src/commands/tm-commit/`)
| ファイル | 責務 |
|---|---|
| `tm-commit-command.ts` | コマンドエントリーポイント、進捗表示、sourceHashスキップ |
| `tm-commit-filter.ts` | 処理対象判定（isTmCommitTarget） |
| `tm-commit-processor.ts` | ユニット処理コアロジック（文ペア登録） |
| `sentence-aligner.ts` | LLMベース対訳文アライメント |

### trans連携 (`src/commands/trans/trans-command.ts`)
- `lookupTmReferences()`: TM参照検索＋プロンプト注入

### テスト (`src/test/core/tm/`)
- `tmx-store.test.ts`: TmxStoreの全APIテスト（295テスト中、TM関連約30テスト）
- `tm-text-normalizer.test.ts`: stripMarkdown, isWorthyForTmテスト
- `tm-reference-formatter.test.ts`: 参照フォーマットテスト
- `sentence-splitter.test.ts`: 文分割テスト

---

## 10. 設計上の重要な判断

| 判断 | 理由 |
|---|---|
| **ユーザー明示操作のみ** | プライバシー原則。バックグラウンド自動TM登録は行わない |
| **ユニット単位tm-commit廃止** | TM登録は一括処理が基本。ファイル/ディレクトリ単位のみ |
| **sourceHashスキップ** | 大量ファイル対応。原文が変わっていなければAI呼び出しをスキップ |
| **LLM文分割（書き込み）vs 正規表現（検索）** | 精度 vs 速度のトレードオフ |
| **冪等性** | tm-commitを何度実行しても結果は同じ（既存エントリーはunitPath更新のみ） |
| **TMX 1.4準拠** | 外部CATツールとの互換性 |
| **fixed状態の廃止** | 状態の増殖は複雑性の元。TM登録はシンプルに「翻訳済みならいつでも実行可能」 |
