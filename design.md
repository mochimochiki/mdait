# 📘 設計書：mdait (Markdown AI Translator)

## 1. 概要

**mdait**（Markdown AI Translator）は、Markdown 文書の構造を活かして AI 翻訳を支援するツールです。セクションごとに短縮ハッシュを用いた差分管理と翻訳状態の記録を行い、**変更検出・翻訳差分・多段翻訳**などに対応できるよう設計されています。

---

## 2. mdait コメント構文

各セクションの直前に、mdait メタデータコメントを挿入します。

```markdown
<!-- mdait abcd1234 src:efgh5678 need:translate -->

## セクションタイトル

本文内容...
```

### タグ定義：

| タグ名     | 説明                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| `abcd1234` | セクション本文の正規化後の 8 文字短縮ハッシュ（先頭に配置）                  |
| `src`      | 翻訳元のセクションのハッシ値（翻訳元追跡用）                                 |
| `need`     | 翻訳の必要性を表すフラグ。`translate`, `review` など。翻訳完了時は削除される |

---

## 3. 全体の流れ

```plaintext
┌─────────────────────────────────────┐       ┌─────────────────────────────────────┐       ┌─────────────────────────────────────┐
│ source.md  │ ──→ sync ──→ │ target.md  │ ──→ trans ──→ │ translated.md │
└─────────────────────────────────────┘       └─────────────────────────────────────┘       └─────────────────────────────────────┘
```

- `sync`: セクション単位のハッシュ・翻訳元追跡用の `src` の同期を行う。差分の抽出、未翻訳検出、翻訳対象の挿入を行う。
- `trans`: `need:translate` または `need:review` なセクションを対象に AI 翻訳を実行し、翻訳結果・ハッシの更新と `need` タグの除去を行う。
- `sync` は何度繰り返しても破綻しない設計。source のみを編集して再度 `sync` すれば、target に変更が伝播する。

---

## 4. セクション処理の概念

### 4.1 正規化とハッシュ

- 正規化：トリム・余分な空白除去など（将来的にオプション拡張可能）
- ハッシュ：`sha256(normalized_text).slice(0, 8)` のような 8 文字短縮

### 4.2 セクション対応の基本ロジック（`sync`）

#### 4.2.1 sync 処理ロジック詳細

##### 基本方針

- `source.md`を主に走査し、毎セクションごとに正規化・ハッシ計算を行い、`target.md`側のセクションと対応付けを試みる。
- 対応が見つからない場合は `target.md`に新規セクションとして挿入し、`need:translate`を付与する。
- 挿入・対応付けの順序は、**source のセクション順を優先**する。

##### 処理フロー映像（擬似コード）

```ts
for section in source:
  hash = calcHash(section.body)

  match = find section in target where src == hash

  if match:
    update head hash if needed
  else:
    insert to target:
      <!-- mdait {newHash} src:{hash} need:translate -->

      ## section.title
      (empty body)
```

##### 処理上の注意点

- `src:` が `target.md` 内で重複している場合は **上から順に 1 つ目のみを対象として処理し、以降は無視する**（整合性が曖昧になるため）
- `src:` 重複が見つかった場合は **ログに警告として出力する**（自動修正は行わない）
- セクション削除については **設定可能** とする：

  - `auto-delete: true` の場合（デフォルト）→ `source` 側から削除されたセクションは `target` からも即時削除
  - `auto-delete: false` の場合 → 対象に `need:verify-deletion` を付与し、残す形でマーキング

### 4.3 翻訳処理（`trans`）

```ts
for section in target:
  if need in ['translate', 'review']:
    srcText = find source section by src
    translated = aiTranslate(srcText)
    update section text + head hash
    remove need
```

---

## 5. 多段翻訳への拡張（例：ja → en → de）

- `src` を用いて追跡できるため、任意の言語ペアで同期・翻訳が可能。
- 中間言語（例：英語）を編集しても再度 `sync` によって差分検出できる。
- 多段でも `src` は常に 1 つに制限し、構造をシンプルに保つ。

---

## 6. コメントタグ設計原則

- コメントは `<!-- mdait ... -->` という形で明確に識別で

---

## 7. リポジトリ構成

本プロジェクトは、以下の構成でソースコードを管理します。

```
src/
  extension.ts           # エントリーポイント（コマンド登録など）
  commands/
    sync/                # syncコマンド関連処理
      sync-command.ts    # syncコマンドの実装
      section-matcher.ts # セクション対応処理
      diff-detector.ts   # 差分検知
    trans/           # transコマンド関連処理
      trans-command.ts  # transコマンドの実装
      translation-provider.ts  # 翻訳プロバイダーインターフェース
  core/                  # 共通コア機能
    markdown/
      parser.ts          # Markdownパーサー
      section.ts         # セクション管理
      comment.ts         # mdaitコメント処理
    hash/
      normalizer.ts      # 正規化処理
      hash-calculator.ts # ハッシュ計算
  config/
    configuration.ts     # 設定管理
  utils/
    file-utils.ts        # ファイル操作関連
```

### 7.1 責任分担

- **commands**: 各コマンド固有のロジックを実装。ユーザー操作との橋渡し役。
  - **sync**: Markdown文書間の同期処理を担当。
  - **trans**: 翻訳対象の特定と翻訳処理の実行を担当。

- **core**: 複数のコマンドで共有される基本機能を実装。
  - **markdown**: Markdownの構造解析、セクション分割、コメント処理など。
  - **hash**: 文書の正規化とハッシュ計算アルゴリズムを提供。

- **config**: 設定値の管理と構成。

- **utils**: ファイル操作など汎用的なユーティリティ。

### 7.2 主要コンポーネント

#### 7.2.1 Markdownパーサー

Markdown文書をセクション単位に分割し、mdaitメタデータコメントと関連付ける。
セクション抽出には見出し(`#`, `##`など)を基準とし、コメント部分は特殊処理する。

#### 7.2.2 ハッシュ管理

テキストの正規化（余分な空白除去など）を行い、一貫したハッシュを生成する。
短縮ハッシュを使うことで人間にも扱いやすい識別子とする。

#### 7.2.3 セクション対応処理

源文書と対象文書のセクション間の対応関係を構築し、翻訳状態を追跡する。
`src`タグによる翻訳元の追跡を基に、差分の検出と翻訳フラグの設定を行う。

#### 7.2.4 翻訳プロバイダー

複数の翻訳エンジンに対応できるよう抽象インターフェースを提供。
デフォルトプロバイダーと拡張可能なプラグイン構造を持たせる。
