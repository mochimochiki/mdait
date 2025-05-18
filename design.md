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

### 2.1 タグ定義：

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

## 4. コマンド設計

### 4.1 syncコマンド

- 目的：source.mdとtarget.mdを比較し、セクション単位でハッシュ・src追跡・needフラグの同期を行う。
- 主な処理フロー：
  1. source側の各セクションごとに正規化＋ハッシュ計算
  2. 既存ファイルにmdaitヘッダーがない場合、自動でmdaitヘッダーを生成。
  3. target側でsrc一致セクションを探索し、対応付け・新規挿入・need:translate付与
  4. target側の余剰セクションはauto-delete設定に応じて削除またはneed:verify-deletion付与
  5. src重複時は、すべての該当targetセクションを同期対象とする
  6. Markdown構造を再構築しtarget.mdとして保存
- 設定値：auto-delete（デフォルトtrue）

### 4.3 初回実行の流れ

既存ファイル導入時の処理:

1. **自動ヘッダー生成**:
  初回sync時、source（ja.md）にmdaitヘッダーがなければ自動で生成

2. **ハッシュ計算**:
  - source（ja.md）の各セクション本文を正規化しハッシュ値を計算
  - target（en.md）も同様にハッシュ値を計算

3. **srcの付与 (セクション対応付け)**:
  - targetの各セクションがsourceのどのセクションに対応するかを推定
    - セクションの順序 / 見出し構造 / 内容の類似性
    - ※ 対応付けロジックは拡張を考慮し、入れ替え可能な設計とする
  - 対応が見つかったtargetセクションに`src:xxxx`（sourceのハッシュ値）を付与

#### 注意点

- `src:` が `target.md` 内で重複している場合は **すべての該当セクションを同期対象とする**
- セクション削除については **設定可能** とする：

  - `auto-delete: true` の場合（デフォルト）→ `source` 側から削除されたセクションは `target` からも即時削除
  - `auto-delete: false` の場合 → 対象に `need:verify-deletion` を付与し、残す形でマーキング


### 4.2 transコマンド

- 目的：target.md内のneed:translateまたはneed:reviewなセクションをAI翻訳し、翻訳結果・ハッシュ更新・needタグ除去を行う。
- 主な処理フロー：
  1. target.mdをパースし、Markdownオブジェクトへ変換
  2. need:translateまたはneed:reviewなセクションを列挙
  3. srcでsource.md側の対応セクションを取得し、AI翻訳
  4. 翻訳結果を反映し、ハッシュ更新・needタグ除去
  5. Markdown構造を再構築しtarget.mdとして保存

---

## 5. 多段翻訳への拡張（例：ja → en → de）

- `src` を用いて追跡できるため、任意の言語ペアで同期・翻訳が可能。
- 中間言語（例：英語）を編集しても再度 `sync` によって差分検出できる。
- 多段でも `src` は常に 1 つに制限し、構造をシンプルに保つ。

---

## 6. リポジトリ構成

本プロジェクトは、以下の構成でソースコードを管理します。

```
src/
  extension.ts           # エントリーポイント（コマンド登録など）
  commands/
    sync/                # syncコマンド関連処理
    trans/               # transコマンド関連処理
  core/                  # 共通コア機能
    markdown/            # Markdownの構造解析、セクション分割、コメント処理など。
    hash/                # 文書の正規化とハッシュ計算アルゴリズムを提供。
  config/
    configuration.ts     # 設定管理
  utils/
    file-utils.ts        # ファイル操作など汎用的なユーティリティ。
```

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

## 8. Markdownオブジェクトとフロントマター設計

### 8.1 Markdownオブジェクトの構造

Markdown文書全体を表す上位オブジェクトとして `Markdown` を導入する。

```ts
interface Markdown {
  frontMatter?: FrontMatter; // yaml対応
  sections: MarkdownSection[];
}

interface FrontMatter {
  [key: string]: any;
}

interface MarkdownSection {
  mdaitHeader?: MdaitHeader;
  title: string;
  headingLevel: number;
  content: string;
}
```

- frontMatterはYAMLに対応する。
- セクションごとのmdaitHeaderは見出し直前のmdaitコメントで管理。
- frontMatterはMarkdownSectionより上位のMarkdownオブジェクトで一元管理する。

### 8.2 パース・出力例

```markdown
---
title: サンプル
---
<!-- mdait zzzz9999 src:yyyy8888 need:review -->
# セクション1
本文1
```

- `Markdown.sections[0].header.hash === "zzzz9999"`
- `Markdown.sections[0].title === "セクション1"`

---
