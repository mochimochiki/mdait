<!-- mdait c06cdf20 -->
# Copilot Chat 統合 — チャットから翻訳を操作する

GitHub Copilot Chat のツール呼び出し（`#mdaitStatus` / `#mdaitSync` / `#mdaitTranslate` / `#mdaitTerm` / `#mdaitTm` / `#mdaitValidate`）を使って、エディタを離れずに翻訳の確認・同期・実行・検証を行うガイドです。

---

<!-- mdait 6beb76f9 -->
## 概要

mdait は VS Code の **LanguageModelTool API** を使い、6 つのツールを Copilot Chat に公開しています。
コマンドパレットを開かなくても、チャット画面から自然な言葉で翻訳ワークフローを動かせます。

全ツールの出力は共通の JSON エンベロープ `{ schemaVersion, ok, summary, data, nextActions }` です。`summary` が人間向けの1行サマリ、`data` が機械可読な詳細、`nextActions` がエージェント向けの推奨次アクションです。サイト全体を任せる場合の手順は [agent-playbook.md](agent-playbook.md) を参照してください。

> **前提条件:** GitHub Copilot 拡張機能のインストールと有効なサブスクリプションが必要です。

---

<!-- mdait 6bc07e9c -->
## ツール一覧

| ツール | 主な用途 | 副作用 | 対応コマンド |
|---|---|---|---|
| `#mdaitStatus` | 翻訳進捗の確認（`detail:true` でファイル別内訳） | なし（読み取り専用） | StatusTree 相当 |
| `#mdaitSync` | マーカーの同期（`adopt:true` で既訳取り込み） | ファイル書き換えあり（確認UI） | `mdait.sync` 相当 |
| `#mdaitTranslate` | AI 翻訳の実行（ファイル/**ディレクトリ**） | ファイル書き換えあり（確認UI） | StatusTree の ▶ ボタン相当 |
| `#mdaitTerm` | 用語集の検出・展開 | terms 書き換えあり（確認UI） | `mdait.term.*` 相当 |
| `#mdaitTm` | TM コミット・最適化 | tmx 書き換えあり（確認UI） | `mdait.tm.*` 相当 |
| `#mdaitValidate` | 構造・用語一貫性の検証 | なし（読み取り専用・AI不使用） | （新規） |

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

**出力例（全体・JSONエンベロープ）:**

```jsonc
{
  "schemaVersion": 1,
  "ok": true,
  "summary": "Translation status for workspace: 42 total units, 35 translated, 7 untranslated, 0 error(s). Files needing work: 3.",
  "data": {
    "totalUnits": 42,
    "translatedUnits": 35,
    "needs": { "translate": 5, "revise": 2, "review": 0, "verifyDeletion": 0, "isolate": 0, "other": 0 },
    "filesWithNeeds": 3,
    "filesTranslated": 9
  },
  "nextActions": ["Run mdait_translate to translate 5 unit(s) flagged need:translate and revise 2 unit(s) flagged need:revise."]
}
```

`detail: true` を渡すと `data.files` に「作業が必要なファイルのみ」の内訳一覧が入ります。

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

指定したターゲット**ファイルまたはディレクトリ**の `need:translate` / `need:revise` ユニットを AI で翻訳します。
**ファイルを書き換えるため、実行前に確認ダイアログが表示されます**（ディレクトリはスコープ単位で1回・対象ユニット総数を提示）。
ディレクトリ翻訳はファイル単位で並列実行されます（`trans.concurrency`、デフォルト3）。

**チャット入力例:**

```
#mdaitTranslate docs/en 以下を全部翻訳して
```

```
#mdaitTranslate docs/en/index.md を翻訳して
```

**確認UI の流れ:**

1. 翻訳対象ファイルとユニット数が確認ダイアログに表示される
2. **「Continue」** をクリックすると AI 翻訳を実行
3. 実行後、翻訳済みユニット数・残存 need 数が返る

**出力例:**

```jsonc
{
  "schemaVersion": 1,
  "ok": true,
  "summary": "Translation completed for docs/en: 12 file(s) succeeded, 0 failed, 34 unit(s) translated.",
  "data": {
    "scope": "directory",
    "totals": { "files": 12, "succeeded": 12, "failed": 0, "skippedNonTarget": 0, "translatedUnits": 34 },
    "files": [ { "path": "...", "ok": true, "translatedUnits": 3 } ],
    "remainingNeeds": { "translate": 0, "revise": 0, "review": 1, "verifyDeletion": 0, "isolate": 0, "other": 0 }
  }
}
```

> 対象は **ターゲット**（`targetDir` 配下）のみです。ソースファイルを指定するとエラーになります。
> 途中で失敗・キャンセルしても、同じパスで再実行すれば翻訳済みユニットはスキップされ残りだけが処理されます。

---

<!-- mdait 1215fdc3 -->
## ツールの使い分け

**典型的なワークフロー:**

1. `#mdaitStatus` で全体進捗を把握する
2. 原文に変更があれば `#mdaitSync` でマーカーを更新する
3. `#mdaitTranslate` で未翻訳ユニットを AI 翻訳する（ディレクトリ指定可）
4. `#mdaitValidate` で構造・用語の一貫性を検証する
5. `#mdaitTerm`（detect→expand）で用語集を育て、`#mdaitTm`（commit）で翻訳メモリに蓄積する

**使い分けのポイント:**

- 状況確認だけなら `#mdaitStatus`、検証だけなら `#mdaitValidate`（どちらも副作用なし）
- 翻訳前に必ず `#mdaitSync` でマーカーを最新化する
- サイト全体・数百ファイル規模の依頼は [agent-playbook.md](agent-playbook.md) の手順に従う
- 既存の対訳サイトを取り込む場合は `#mdaitSync` に `adopt: true`（[adopt.md](adopt.md)）

---

<!-- mdait 4d4db173 -->
## 注意点

- `#mdaitSync` と `#mdaitTranslate` は **確認UIで「Continue」を押すまで**ファイルを変更しません
- `#mdaitTranslate` の実行には GitHub Copilot の **AI モデルへのアクセス**が必要です
- 初回の AI 翻訳時は AI 利用確認ダイアログが表示されます

---

<!-- mdait 5d488dc1 -->
## 次のステップ

- エージェントにサイト全体を任せる → [agent-playbook.md](agent-playbook.md)
- 既存対訳の取り込み → [adopt.md](adopt.md)
- 翻訳コマンドの詳細 → [translate.md](translate.md)
- 設定リファレンス → [config-reference.md](config-reference.md)
