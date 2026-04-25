<!-- mdait 93170cae -->
# Sync — 原文と訳文の差分を自動検出する

Sync は原文・訳文を見出し単位のブロック（**ユニット**）に分割し、変更箇所に `need` フラグを自動付与することで、翻訳すべき場所を明確にするコマンドです。

---

<!-- mdait 587d8971 -->
## 概要

`mdait.sync` を実行すると、設定した `transPairs` の原文ディレクトリと訳文ディレクトリを比較し、次を行います。

- 訳文が存在しない → 新規ファイルを作成して `need:translate` を付与
- 原文が変更された → 該当ユニットに `need:revise` を付与
- 原文のユニットが削除された → 訳文の対応ユニットを削除または保留

状態はすべて **HTML コメント形式のマーカー** で Markdown ファイル内に記録されるため、Git での差分管理と相性が良いです。

**起動方法:**

| 方法 | 説明 |
|---|---|
| コマンドパレット `mdait.sync` | transPairs 全ファイルを一括 sync |
| StatusTree の sync ボタン | 単一ファイルを sync |
| ファイル保存時の自動 sync | マーカーが存在するファイルのみ実行（`autoSyncOnSave: true` 時） |

---

<!-- mdait 1548160b -->
## マーカーの仕組み

Sync 後、各ユニット（見出しブロック）の直前に HTML コメントが挿入されます。

```

<!-- mdait 11111111 from:a1b2c3d4 need:revise@a1b2c3d4 -->
```

| フィールド | 意味 |
|---|---|
| （先頭の値） | 訳文ユニット本体の CRC32 ハッシュ（訳文変更検知用・省略可） |
| `from:` | このユニットが対応する原文ユニットのハッシュ |
| `need:` | 翻訳・改訂・確認が必要な状態フラグ |

<!-- mdait d6360d25 -->
### before / after 例

**Sync 前（訳文ファイルが存在しない）:**

```markdown
# Introduction
This is sample.

## Installation
Follow these steps.
```

**Sync 後（新規生成）:**

```markdown

<!-- mdait from:a1b2c3d4 need:translate -->
# Introduction

<!-- mdait from:b2c3d4e5 need:translate -->
## Installation
```

原文をコピーせず、マーカーだけを付与した空のユニットが生成されます。翻訳後に訳文を書き込みます。

**原文が変更された後の再 Sync:**

```markdown

<!-- mdait a1b2c3d4 from:newHash need:revise@a1b2c3d4 -->
# Introduction
（古い訳文がここに残る）
```

先頭のハッシュ（訳文自体のハッシュ、`a1b2c3d4`）は変わらず、`from` が新しい原文ハッシュ（`newHash`）に更新され、`need:revise@旧ハッシュ` が付与されます。`@` 以降は「改訂の基準点（変更前の原文ハッシュ）」で、TM 差分参照に使われます。

---

<!-- mdait be1e77ca -->
## need フラグ一覧

| フラグ | 発生条件 | ユーザーへの意味 |
|---|---|---|
| `translate` | ターゲットユニットが存在しない | 未翻訳。新規翻訳が必要 |
| `revise@{旧hash}` | 原文の CRC32 ハッシュが変化した | 原文が変わった。訳文の改訂が必要 |
| `review` | 翻訳実行後に構造不一致を検出 | 訳文の構造を手動で確認が必要 |
| `verify-deletion` | 対応する原文が削除された（`autoDelete: false` 時） | 原文削除済み。訳文を削除してよいか確認 |

`need` フラグがないユニットは「同期済み・翻訳不要」の状態です。

---

<!-- mdait 7ea89b0c -->
## 自動 Sync（autoSyncOnSave）

`sync.autoSyncOnSave: true`（デフォルト）の場合、**マーカーが存在するファイル** を保存すると自動的に Sync が実行されます。

- 新規ファイル（マーカーなし）では自動 Sync は動作しません
- 自動 Sync でエラーが発生しても UI はブロックされません（ログに記録）
- 原文・訳文どちらを保存しても Sync は動作します

手動での Sync は `autoSyncOnSave: false` に設定するか、コマンドパレットから任意のタイミングで実行します。

---

<!-- mdait 80632c0a -->
## 孤立ユニットの処理（autoDelete）

原文からユニットが削除されると、訳文側に「孤立ユニット」が発生します。

```json
"sync": {
  "autoDelete": true
}
```

| `autoDelete` | 動作 |
|---|---|
| `true`（デフォルト） | 孤立ユニットを自動削除 |
| `false` | `need:verify-deletion` を付与して残す |

`autoDelete: false` は、訳文側に独自コンテンツがある場合や、削除判断を手動で行いたい場合に使います。確認後、マーカーを手動で削除するか `mdait.sync` を再実行すれば解消します。

---

<!-- mdait 4a947322 -->
## アセット（画像・添付ファイル）の自動コピー

Sync 時、**新規ユニット**または**原文が変更されたユニット**に含まれる相対パスの画像・添付ファイルを、sourceDir から targetDir に自動コピーします。原文に挿入した画像を手動でコピーし直す手間をなくすための機能です。

- 対象: `![alt](./img.png)` / `[file](./data.csv)` のような相対パス
- 対象外: 外部URL（http/https）、絶対パス、sourceDir の外、存在しないファイル、`.md` など翻訳対象の拡張子（`trans.extensions` で追加した拡張子も対象外）
- 原文が変更されたユニットでは、**新旧原文の差分で新規に追加されたパスだけ**コピー（unit-registry に残る旧原文スナップショットと比較）
- 注意: targetDir に同名ファイルがある場合は上書きされます

<!-- mdait 0255066c -->
### `sync.copyAssets` の指定方法

3 通りの書き方を受け付けます:

```json
// (1) すべてコピー（デフォルト）
"sync": { "copyAssets": true }

// (2) コピーしない
"sync": { "copyAssets": false }

// (3) 拡張子ホワイトリスト — この拡張子だけコピー
"sync": { "copyAssets": [".png", ".jpg", ".svg"] }
```

特定のペアだけ挙動を変えたい場合は `transPairs[].copyAssets` で同じ型の値を指定すれば上書きできます（例: 多言語展開のうち画像差し替えが必要なペアだけ `true`、他は `false` 等）。

```json
"transPairs": [
  { "sourceDir": "docs/ja", "targetDir": "docs/en", "copyAssets": [".png"] },
  { "sourceDir": "docs/ja", "targetDir": "docs/de", "copyAssets": false }
]
```

---

<!-- mdait 2b361076 -->
## FrontMatter の同期

FrontMatter（YAML ヘッダー）も通常のユニットと同様に同期されます。

**マーカー形式:**
```yaml
---
title: Getting Started
description: Quick start guide
mdait:
  front: b2c3d4e5 from:a1b2c3d4 need:translate
---
```

- ソース・ターゲット両方に `mdait.front` マーカーが付与されます
- 翻訳対象のキーは `trans.frontmatter.keys` で指定します（デフォルト: `["title", "description"]`）

```json
"trans": {
  "frontmatter": {
    "keys": ["title", "description"]
  }
}
```

キーを空配列 `[]` に設定すると、FrontMatter は翻訳対象になりません。

---

<!-- mdait 74428337 -->
## 設定オプション

`.mdait/mdait.json` の `sync` セクションで設定します。

| オプション | 型 | デフォルト | 説明 |
|---|---|---|---|
| `level` | integer | `3` | ユニット境界とする見出しレベル（h1〜hN）|
| `autoSyncOnSave` | boolean | `true` | 保存時の自動 Sync |
| `autoDelete` | boolean | `true` | 孤立ユニットの自動削除 |

<!-- mdait 11247ab5 -->
### sync.level の詳細

| `level` | ユニット境界 | 用途 |
|---|---|---|
| `2` | h1・h2 | 大きな章単位で管理したい場合 |
| `3`（デフォルト） | h1〜h3 | 標準。節単位での管理 |
| `4` 以上 | h1〜hN | 細かいサブセクションまで分割 |

ドキュメントごとに FrontMatter でオーバーライドできます。

```yaml
---
mdait:
  sync:
    level: 2
---
```

---

<!-- mdait f5036ec1 -->
## よくあるユースケースと注意点

**ユースケース 1: 新規翻訳ファイルの作成**
原文ファイルを作成し `mdait.sync` を実行すると、訳文ファイルが自動生成されます。すべてのユニットに `need:translate` が付き、あとは StatusTree の ▶ ボタンで翻訳するだけです。

**ユースケース 2: 原文の一部を修正した**
保存時の自動 Sync（または手動 Sync）で変更されたユニットのみ `need:revise` が付与されます。変更のないユニットはそのまま維持されます。

**ユースケース 3: 訳文を手動で修正した**
訳文を編集して保存すると、その訳文ユニットの `hash` が更新されます。`need` フラグには影響しません。

**注意: マーカーを手動編集しない**
マーカーを手動で削除・書き換えると、次回 Sync 時に予期しない動作が起きることがあります。フラグのリセットは `mdait.sync` の再実行で行ってください。

**注意: `level` を途中で変更する**
`sync.level` を変更すると、既存マーカーのユニット境界と食い違いが生じる場合があります。変更後に全ファイルを再 Sync することを推奨します。

---

<!-- mdait 7a44ffff -->
## 次のステップ

- [翻訳を実行する → translate.md](translate.md)
- [設定リファレンス → config-reference.md](config-reference.md)
