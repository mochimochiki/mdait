<!-- mdait c06cdf20 -->
# Copilot Chat 統合 — チャットから翻訳を操作する

GitHub Copilot Chat のツール呼び出し（`#mdaitStatus` / `#mdaitSync` / `#mdaitTranslate`）を使って、エディタを離れずに翻訳の確認・同期・実行を行うガイドです。

---

<!-- mdait 6beb76f9 -->
## 概要

mdait は VS Code の **LanguageModelTool API** を使い、3 つのツールを Copilot Chat に公開しています。
コマンドパレットを開かなくても、チャット画面から自然な言葉で翻訳ワークフローを動かせます。

> **前提条件:** GitHub Copilot 拡張機能のインストールと有効なサブスクリプションが必要です。

---

<!-- mdait 6bc07e9c -->
## ツール一覧

| ツール | 主な用途 | 副作用 | 対応コマンド |
|---|---|---|---|
| `#mdaitStatus` | 翻訳進捗の確認 | なし（読み取り専用） | StatusTree 相当 |
| `#mdaitSync` | マーカーの同期 | ファイル書き換えあり（確認UI） | `mdait.sync` 相当 |
| `#mdaitTranslate` | AI 翻訳の実行 | ファイル書き換えあり（確認UI） | StatusTree の ▶ ボタン相当 |

---

<!-- mdait 65e16733 -->
## `#mdaitStatus` — 翻訳状況を確認する

ワークスペース全体、または特定ファイルの翻訳進捗をテキストで返します。
**読み取り専用**のため、確認UIは表示されません。

**チャット入力例:**

```
#mdaitStatus docs/ja の翻訳状況を教えて
```

```
#mdaitStatus docs/ja/index.md のステータスを確認して
```

**出力例（全体）:**

```
Overall translation status:
- Total units: 42
- Translated: 35
- Untranslated: 7
- Error: 0
```

**出力例（ファイル指定）:**

```
Translation status for docs/ja/index.md:
- Total units: 8
- Translated: 6
- Needs translation: 1
- Needs revision: 1
```

> ファイルパスは省略可能です。省略するとワークスペース全体のサマリが返ります。

---

<!-- mdait eeaed850 -->
## `#mdaitSync` — マーカーを同期する

原文の変更を検知してターゲットファイルの翻訳マーカー（`need:translate` / `need:revise`）を更新します。
**ファイルを書き換えるため、実行前に確認ダイアログが表示されます。**

**チャット入力例:**

```
#mdaitSync マーカーを同期して
```

**確認UI の流れ:**

1. Copilot Chat に確認ダイアログが表示される
2. **「Continue」** をクリックすると同期を実行
3. 実行後、更新されたユニット数・残存未翻訳数が返る

**出力例:**

```
Synchronization completed.

Current translation status:
- Total units: 42
- Translated: 35
- Untranslated: 7
- Error: 0
```

> `#mdaitSync` は入力パラメータ不要です。`transPairs` 設定に基づいて全ペアを走査します。

---

<!-- mdait aa82bd42 -->
## `#mdaitTranslate` — ファイルを AI 翻訳する

指定したターゲットファイルの `need:translate` / `need:revise` ユニットを AI で翻訳します。
**ファイルを書き換えるため、実行前に確認ダイアログが表示されます。**

**チャット入力例:**

```
#mdaitTranslate docs/ja/index.md を翻訳して
```

**確認UI の流れ:**

1. 翻訳対象ファイルとユニット数が確認ダイアログに表示される
2. **「Continue」** をクリックすると AI 翻訳を実行
3. 実行後、翻訳済みユニット数・残存 need 数が返る

**出力例:**

```
Translation completed for: docs/ja/index.md

Status:
- Total units: 8
- Translated: 8
- Still needs translation: 0
- Still needs revision: 0
```

> 対象は **ターゲットファイル**（`targetDir` 配下）のみです。ソースファイルを指定するとエラーになります。

---

<!-- mdait 1215fdc3 -->
## ツールの使い分け

**典型的なワークフロー:**

1. `#mdaitStatus` で全体進捗を把握する
2. 原文に変更があれば `#mdaitSync` でマーカーを更新する
3. `#mdaitTranslate` で未翻訳ユニットを AI 翻訳する

**使い分けのポイント:**

- 状況確認だけなら `#mdaitStatus`（副作用なし）
- 翻訳前に必ず `#mdaitSync` でマーカーを最新化する
- `#mdaitTranslate` は 1 ファイルずつ指定する

---

<!-- mdait 4d4db173 -->
## 注意点

- `#mdaitSync` と `#mdaitTranslate` は **確認UIで「Continue」を押すまで**ファイルを変更しません
- `#mdaitTranslate` の実行には GitHub Copilot の **AI モデルへのアクセス**が必要です
- 初回の AI 翻訳時は AI 利用確認ダイアログが表示されます

---

<!-- mdait 5d488dc1 -->
## 次のステップ

- 翻訳コマンドの詳細 → [translate.md](translate.md)
- 設定リファレンス → [config-reference.md](config-reference.md)
