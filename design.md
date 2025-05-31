# 📘 設計書：mdait (Markdown AI Translator)

## 1. 概要

**mdait**（Markdown AI Translator）は、Markdown 文書の構造を活かして AI 翻訳を支援するツールです。文書を翻訳・管理の単位である「ユニット」に分割し、各ユニットごとに短縮ハッシュを用いた差分管理と翻訳状態の記録を行い、**変更検出・翻訳差分・多段翻訳**などに対応できるよう設計されています。

---

## 2. mdaitUnit

### 2.1 概要

`mdaitUnit` は、mdaitが管理する「ユニット」そのものを定義する設計上の概念であり、Markdown文書内では `<!-- mdait ... -->` というコメント形式のマーカー（以下、marker）として表現されます。文書内に配置された各markerが、翻訳や差分管理の単位であるユニットの開始点を示します。

通常、markerはMarkdownの構造的な見出し（例: `## タイトル`）の直前に配置され、その見出しをユニットのタイトルとして関連付けます。これにより、既存のMarkdown文書の構造を活かした管理が可能です。ユーザーは必要に応じて、見出しのない場所に手動でmarkerを挿入し、より細かい粒度でユニットを定義することもできます。

markerがユニットの開始を示し、その管理対象となるコンテンツは、次のmarkerの直前、またはファイルの末尾までとします。ハッシュアルゴリズムはデフォルトでCRC32を使用します。

```markdown
<!-- mdait abcd1234 from:efgh5678 need:translate -->
## 見出し

このmarkerに紐づくコンテンツ。
次のmarkerまで、あるいはファイルの末尾までがユニットの範囲となる。

<!-- mdait ijkl9012 -->
このコンテンツは上記とは別のユニット。
```

### 2.2 mdaitMarker

```markdown
<!-- mdait <hash> [from:<from-hash>] [need:<flag>] -->
```

| タグ名      | 説明                                                                     |
| ----------- | -------------------------------------------------------------------------|
| `abcd1234`  | ユニット本文の正規化後の 8 文字短縮ハッシュ（markerの先頭に配置） |
| `from`      | 翻訳元のユニットのハッシュ値（翻訳由来追跡用）                           |
| `need`      | 翻訳の必要性を表すフラグ。`translate` など。翻訳完了時は削除される       |

### 2.3 need flag

`need`フラグは、ユニット間の「同期」を完了させるために必要なアクションを示します。同期できているユニットには、`need` フラグは付与されません。

`need:translate` : 翻訳が必要なユニット。AI翻訳を実行する対象。
`need:review` : 翻訳済みだがレビューが必要なユニット。AI翻訳後の確認を行う対象。
`need:verify-deletion` : 対応する翻訳元が削除されたユニット。削除の確認が必要。
`need:solve-conflict` : 双方向編集で競合が発生したユニット。解決が必要。


---

## 3. 全体の流れ

```plaintext
----------------          ----------------          ----------------
| documentA.md | ◀------▶ | documentB.md │◀------▶ | documentC.md |
| (e.g. ja.md) |   hash   | (e.g. en.md) │  hash   | (e.g. de.md) |
----------------          ----------------          ----------------
```

- `sync`: ユニット単位のハッシュ・翻訳元追跡用の `from` の同期を行う。差分の抽出、未翻訳検出、翻訳対象ユニットの挿入を行う。
- `trans`: `need:translate` を対象に AI 翻訳を実行し、翻訳結果・ハッシュの更新と `need` タグの除去を行う。
- `sync` は何度繰り返しても破綻しない設計。いずれかのドキュメントが編集されても、再度 sync を実行すれば変更が関連ドキュメントのユニットに伝播します。

---

## 4. コマンド

### 4.1 syncコマンド

関連付けられたMarkdownファイル群内のmarkerで定義されるユニット単位で、ハッシュ・`from`追跡・`need`フラグの同期を行う。

**コンセプト：**
言語間をグラフ構造とみなし、markerをユニットの単位とする。marker内のハッシュと、マーカーに続く現在のコンテンツから計算したハッシュを比較することで、全言語の変更分ユニットを抽出可能。複数言語話者たちが共同作業をしているときにはja->enのケースやen->jaのケースが混在する可能性があるが、グラフ構造とすることでこのような場合にも対応できる。
**処理フロー：**
  1. 全てのMarkdownファイルをパースし、各markerとそれに対応するコンテンツから正規化・計算したハッシュを取得。このまとまりを「ユニット」とする。
  2. **変更検出:** 各ユニットにおいて、markerに記録された自身のハッシュと、現在のコンテンツから計算したハッシュを比較。不一致の場合は「変更あり」とマーク。
  3. **影響伝播（グラフ同期）:** 「変更あり」とマークされたユニットの影響を受ける関連ファイルのユニットを探索し、影響を伝播させる。影響を受けたユニットには `need:translate` を付与し、`from` ハッシュを更新。
  4. **マーカー自動挿入（初回など）:** ファイル内にmarkerがない場合、Markdown見出しの直前にmarkerを自動挿入する（対象とするレベルは設定可）。
  5. 関連ファイル間で `from` ハッシュを元に対応付けを行い、新規挿入されたユニットや、`from` が見つからないユニットには適切に `need:translate` や `need:review` を付与。
  6. 関連ファイル間で、対応する `from` が存在しなくなったユニットは、`auto-delete` 設定に応じて削除または `need:verify-deletion` を付与。
  7. Markdown構造（markerとそのコンテンツ）を再構築し、各ファイルを保存。
- 設定値：auto-delete（デフォルトtrue）

#### 初回実行の流れ

既存ファイル導入時の処理:

1. **マーカーの挿入**:
   初回sync時、またはユーザーの指示により、対象Markdownファイル内の主要な見出し（例：H1, H2, H3など設定可能）の直前にmarkerを自動的に挿入します。ユーザーは挿入されたマーカーを確認し、必要に応じて手動で追加・削除・移動することができます。
2. **ハッシュ計算**:
   - sourceファイルの各ユニット本文を正規化しハッシュ値を計算
   - targetファイルの各ユニット本文も同様にハッシュ値を計算
3. **fromの付与 (ユニット対応付け)**:
   - targetの各ユニットがsourceのどのユニットに対応するかを推定
     - ユニットの順序 / 見出し構造 / 内容の類似性
     - ※ 対応付けロジックは拡張を考慮し、入れ替え可能な設計とする
   - 対応が見つかったtargetユニットのmarkerに`from:xxxx`（sourceのユニットハッシュ値）を付与

#### 注意点

- marker内の`from:` が単一ファイル内で重複している場合は **すべての該当ユニットを同期対象とする**
- ユニット削除については **設定可能** とする：
  - `auto-delete: true` の場合（デフォルト）→ `source` 側から削除されたユニットは `target` からも即時削除
  - `auto-delete: false` の場合 → 対象ユニットに `need:verify-deletion` を付与し、残す形でマーキング


### 4.2 transコマンド

- 目的：対象ファイル内の`need:translate`または`need:review`なユニットをAI翻訳し、翻訳結果・ハッシュ更新・needタグ除去を行う。
- 主な処理フロー：
  1. 対象ファイルをパースし、Markdownオブジェクトへ変換
  2. `need:translate`または`need:review`なユニットを列挙
  3. `from`で翻訳元ファイルの対応ユニットを取得し、AI翻訳（翻訳元がない場合はユニット自身のコンテンツを翻訳）
  4. 翻訳結果をユニットのコンテンツに反映し、marker内のハッシュ更新・needタグ除去
  5. Markdown構造を再構築しファイルを保存

### 4.2.3 AIサービス層

AIサービス層は、具体的なAIプロバイダ（OpenAI、Anthropic、VSCode LM APIなど）とのやり取りを抽象化します。

- **`AIServiceBuilder`**: 設定に基づいて適切な`AIService`プロバイダを構築・返却します。
  - `mdait.trans.provider` 設定値を参照し、指定されたプロバイダをインスタンス化します。
  - サポートされるプロバイダ:
    - `default`: モック翻訳プロバイダ（初期実装）
    - `vscode-lm`: VS Code Language Model API を利用するプロバイダ。
    - (将来的に `ollama`, `openai` などを追加予定)
  - 指定されたプロバイダが存在しない場合や利用不可能な場合は、`default`プロバイダにフォールバックします。
- **各プロバイダ実装**: `src/api/providers/` 以下に配置。
  - `DefaultAIProvider`: 固定の翻訳結果を返すモック。
  - `VSCodeLMProvider`: `vscode.lm` APIを利用して翻訳を実行。

---

## 5. 設定

### 5.1 設定ファイル

設定はVSCode拡張として標準的なsettings.json形式で行います。以下は設定ファイルの例です。

```json
{
  // 翻訳ペア
  "mdait.transPairs": [
    {
      "sourceDir": "content/ja",
      "targetDir": "content/en"
    },
    {
      "sourceDir": "content/en",
      "targetDir": "content/de"
    }
  ],
  // 除外パターン
  "mdait.ignoredPatterns": "**/node_modules/**",
  // sync実行時にマーカーを自動挿入する見出しレベル(このレベルまでの見出しの直前にマーカーを挿入)
  "mdait.sync.autoMarkerLevel": 2,
  // 自動削除設定
  "mdait.sync.autoDelete": true,
  // 翻訳プロバイダ
  "mdait.trans.provider": "default",
  // Markdown:コードブロックをスキップするか
  "mdait.trans.markdown.skipCodeBlocks": true
}
```

## 6. 多段翻訳

### 6.1 翻訳パターン

**from制約**: 各ユニットは最大1つの`from`のみ。以下のパターンをサポート。

#### パターン1: 片方向チェーン
```
ja -> en -> de/fr
```
母語から多言語への標準ワークフロー。

#### パターン2: ハブ言語双方向
```
ja <-> en -> de/fr
```
母語とハブ言語（英語）で双方向編集、他は一方向。

### 6.2 動作例

#### 片方向（en編集 → de更新）
```markdown
<!-- en/doc.md -->
<!-- mdait xyz789 from:abc123 -->
# Modified English Heading

<!-- de/doc.md -->
<!-- mdait ghi789 from:xyz789 need:translate -->
# Deutsche Überschrift
```

#### 双方向 (ja編集 → en更新)
```markdown
<!-- ja/doc.md -->
<!-- mdait new_abc123 from:def456 -->
# 日本語の見出し編集済

<!-- en/doc.md -->
<!-- mdait def456 from:new_abc123 need:translate -->
# English Heading
```


#### 双方向競合（両方編集）
```markdown
<!-- ja/doc.md -->
<!-- mdait abc123 from:def456 need:solve-conflict -->
# 日本語の見出し編集済

<!-- en/doc.md -->
<!-- mdait def456 from:abc123 need:solve-conflict -->
# Modified English Heading
```
**解決**:
1. 優先したい言語の`mdaitMarker`の`from`を削除
2. sync実行により、`from`がついている言語に`need:translate`付与

### 6.3 制約
1. **単一ソース**: 各ターゲットは1つの`from`のみ付与
2. **双方向制限**: 最大1つの双方向ペア
3. **循環禁止**: 3つ以上の言語循環は不可

---

## 7. リポジトリ構成

本プロジェクトは、以下の構成でソースコードを管理します。

```
src/
  extension.ts           # エントリーポイント（コマンド登録など）
  commands/
    sync/                # syncコマンド関連処理
    trans/               # transコマンド関連処理
  core/                  # 共通コア機能
    markdown/            # Markdownの構造解析、ユニット分割、marker処理など。
    hash/                # 文書の正規化とハッシュ計算アルゴリズムを提供。
  config/
    configuration.ts     # 設定管理
  utils/
    file-utils.ts        # ファイル操作など汎用的なユーティリティ。
```

## 8. 主要コンポーネント

### 8.1 Markdownパーサー

Markdown文書をパースし、markerを基準としてユニットに分割します。各ユニットは、markerと、それに続くMarkdownコンテンツ（次のmarkerの直前、またはファイルの末尾まで）で構成されます。

パーサーは、markerの直後にMarkdownの見出しが存在する場合、それをユニットのタイトルとして解釈することができますが、これはオプションの動作です。

### 8.2 ハッシュ管理

ユニットのテキストの正規化（余分な空白除去など）を行い、一貫したハッシュを生成する。
短縮ハッシュを使うことで人間にも扱いやすい識別子とする。

### 8.3 ユニット対応処理

- **関連ファイル間のユニットの順序を考慮**し、対応付けを行う。
- `from`ハッシュ一致を最優先、次に順序ベースで推定。

1. **`from`ハッシュ一致優先でマッチ**
   - targetユニットのmarker内の`from`がsourceユニットのハッシュと一致する場合、そのペアを即時マッチ確定とする。

2. **順序ベースで推定マッチ**
   - `from`一致でマッチしなかったsourceユニットと、**`from`が付与されていないtargetユニット**について、
     - すでにマッチ済みのユニット間ごとに分割し、
     - その区間内でsource/targetのユニットの順序をもとに1対1でマッチさせる（区間ごとに順序ベースで対応付け）。

3. **内容類似度によるマッチは行わない**
   - 類似度計算は現時点では実装しない。

4. **新規sourceユニットの挿入位置**
   - マッチしなかったsourceユニットは「新規」とし、**sourceファイル内での順序通りにtargetファイルに挿入する**。

5. **孤立targetユニットの扱い**
   - markerに`from`があるにもかかわらずマッチしなかったtargetユニットは「孤立」とみなし、`auto-delete`設定に従い削除または`need:verify-deletion`付与。

## 9. Markdownオブジェクト

### 9.1 Markdownオブジェクトの構造

Markdown文書全体を表すオブジェクトとして `Markdown` を定義します。このオブジェクトは、以下のような構造を持ちます。

```ts
interface Markdown {
  frontMatter?: FrontMatter; // yaml対応
  units: MdaitUnit[];    // markerで区切られたユニットのリスト
}

interface FrontMatter {
  [key: string]: any;
}


interface MdaitUnit {
  mdaitUnit: MdaitMarker; // 各ユニットは必ずmdaitUnit情報を持つ
  content: string;         // markerに続く、次のマーカーまたはファイルの末尾までのコンテンツ
}

// markerの情報を表すインターフェース
interface MdaitMarker {
  hash: string;
  from?: string;
  need?: string;
  // 他のカスタムタグもここに含めることができる
}
```

- frontMatterはYAMLに対応する。
- ユニットごとの`mdaitUnit`情報は、ユニットの開始を示す必須要素。
- frontMatterは`MdaitUnit`より上位の`Markdown`オブジェクトで一元管理する。

### 9.2 パース・出力例

```markdown
---
title: サンプル
---
<!-- mdait zzzz9999 from:yyyy8888 need:review -->
# ユニット1
本文1
```

- `MarkdownDocument.units[0].mdaitUnit.hash === "zzzz9999"`
- `MarkdownDocument.units[0].mdaitUnit.from === "yyyy8888"`
- `MarkdownDocument.units[0].mdaitUnit.need === "review"`

---

## 10. 開発・テスト環境

開発およびテスト時には、一貫したテストコンテンツの配置と、それを利用するための自動コピー処理を行います。

- **テストコンテンツ**: `src/test/sample-content/` にテスト用原稿を配置
- **コピー先**: テスト実行前に、上記コンテンツを `src/test/workspace/content/` へコピー
- **コピースクリプト**: `copy-test-files` を `package.json` に定義
- **コンテンツコピータスク**: `.vscode/tasks.json` に `copy-test-content` タスクを定義
- **デバッグ実行連携**: `launch.json` の `preLaunchTask` に `copy-test-content` を指定し、デバッグ実行前に自動でテストコンテンツをコピー
