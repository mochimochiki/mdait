# 開発者ガイド

mdait を GitHub Copilot Chat やコーディングエージェントから動かし、サイト全体の翻訳を自動で進めるためのガイド。エージェントが読むことも想定して、判定条件は機械的に書く。人が手で操作する場合は [利用者ガイド](guide-user.md)、設定は [管理者ガイド](guide-admin.md) を参照。

## ツール早見表

mdait は VS Code の LanguageModelTool API で 9 つのツールを公開する。チャットでは `#mdaitStatus` のように参照名で呼び、エージェントからはツール ID で呼ぶ。

| ツール ID | チャット参照名 | 役割 | 副作用 |
|---|---|---|---|
| `mdait_getStatus { path?, detail? }` | `#mdaitStatus` | 状態観測 | なし |
| `mdait_validate { path?, checks? }` | `#mdaitValidate` | 構造・用語の一貫性検証 | なし。AI 不使用 |
| `mdait_sync { adopt?, align? }` | `#mdaitSync` | マーカー同期 | マーカー書換 |
| `mdait_translate { path }` | `#mdaitTranslate` | 翻訳（ファイル／ディレクトリ） | 訳文書換・AI 使用 |
| `mdait_term { action, path? }` | `#mdaitTerm` | 用語集の `detect` / `expand` | 用語集書換・AI 使用 |
| `mdait_tm { action, path? }` | `#mdaitTm` | 翻訳メモリの `commit` / `optimize` | tmx 書換・AI 使用 |
| `mdait_aiReview { path?, mode?, dryRun? }` | `#mdaitAiReview` | 対訳ペアの AI 判定（`pending` / `audit`） | マーカー書換・AI 使用 |
| `mdait_adopt { dryRun?, buildGlossary?, buildTm? }` | `#mdaitAdopt` | 既存翻訳の取り込みウィザード | マーカー・用語集・tmx 書換・AI 使用 |
| `mdait_resolve { path, action?, unitHashes?, needs? }` | `#mdaitResolve` | `need` フラグの裁定 | マーカー・本文書換。AI 不使用 |

書き込みを伴うツールは実行前に確認ダイアログが出る。承認されるまでファイルは変わらない。翻訳には Copilot などの AI モデルへのアクセスが必要。

`mdait_translate` の対象は訳文側（`targetDir` 配下）のみで、原文を指定するとエラーになる。

## 出力の形と基本ループ

全ツールが共通のエンベロープを返す。

```jsonc
{
  "schemaVersion": 1,
  "ok": true,
  "summary": "人間向けの1行サマリ",
  "data": { /* 機械可読な詳細 */ },
  "nextActions": ["次に呼ぶべき操作の示唆"]
}
```

`ok:false` のときは `error.code` と `error.message` を見る。

進め方は **観測 → ツールを 1 つ実行 → また観測** の繰り返し。全コマンドが冪等なので、途中で失敗・中断してもループを再開するだけで復帰できる。状態はすべて文書と `.mdait/` の中にあるため、`mdait_sync` → `mdait_getStatus { detail: true }` を打てば必ず現状を観測し直せる。

## 完成の判定基準

次がすべて成立したときに完了と判定する。いずれもツール出力から機械的に確認できる。

1. `mdait_getStatus` の `data.needs` で `translate` / `revise` / `review` / `verifyDeletion` / `other` がすべて 0（`isolate` は定常状態なので除外してよい）
2. `mdait_validate` の `data.violations` が空
3. `mdait_term { action: "detect" }` の `data.pairs[].newTerms` 合計が 0、かつ `unexpanded` 合計が 0
4. `mdait_tm { action: "commit" }` の `data.newEntries` が 0、かつ `data.skipped` の needTranslate / needRevise / needReview が 0
5. `mdait_sync` を再実行して `data.units` の added / modified / deleted / revisionsNeeded / adopted がすべて 0

## 新規翻訳（原文だけがあるリポジトリ）

前提として `transPairs` と `primaryLang` が設定済みであること（未設定なら `mdait.setup.createConfig`）、およびワークスペースが Git 管理下でコミット済みであること。

1. `mdait_getStatus` で現状を観測する
2. `mdait_sync` を実行する。訳文ファイルが生成され `need:translate` が付く
3. `mdait_translate { path: "<targetDir>" }` をディレクトリ単位で実行する。承認はスコープごとに 1 回で済む
4. `mdait_validate` を実行し、違反があれば後述の手順で解消する
5. `mdait_term { action: "detect" }` → `mdait_term { action: "expand" }` で用語集を作る
6. `mdait_tm { action: "commit" }` で翻訳済みユニットを翻訳メモリに登録する
7. 完成の判定基準を確認し、満たさない項目のツールを再実行する

用語集を最初から効かせたい場合は、代表的な数ファイルだけを手順 3 で先に翻訳し、detect / expand を済ませてから残りを翻訳する。

## 既存対訳の取り込み

既訳のあるリポジトリを管理下に置く場合、**知識構築を残りの翻訳より先に行う**。既訳から用語集と翻訳メモリを作ってから翻訳することで、新規訳が最初から既訳の用語・文体に揃う。

### 取り込み

1. Git にコミット済みであることを確認する（マーカーの書き込みを伴う）
2. `mdait_adopt` を 1 回呼ぶ。`sync(adopt+align)` が位置ずれを AI で補正して既訳を採用し、続く AI レビューが高確信の一致を自動承認して誤ペア・訳抜けをエスカレーションする。`data.sync.adopted` / `alignCorrections` と `data.review.*` / `data.escalations` を観測する
   - AI を使わず決定的に進めたい場合は `mdait_sync { adopt: true }`（`align: true` を足すと位置ずれの AI 補正だけを併用できる。`adopt` なしでは無効）。`data.units.adopted` が採用数、`kept` が独立ユニットの保持数、`orphanReviewed` がマーカーなし孤立の一次受け数。後から `mdait_aiReview` をかけてもよい
   - `buildGlossary` / `buildTm` を渡せば次段も同時に走るが、エスカレーションが多いと翻訳メモリがほぼ空になる。レビューを片付けてから個別に実行する方が確実
3. 残った `need:review` を裁定する。`mdait_getStatus { detail: true }` で対象ファイルと `data.files[].units` のハッシュを特定し、原文と訳文の対応が正しいかを確認する。`data.escalations` は mismatch（誤ペア）・partial（訳抜けの疑い）なので先に見る。問題なければ `mdait_resolve { path, unitHashes }` で解決する（`hash` / `from` は変わらない）。レビューを委任されていなければ、人に承認を求める
4. `mdait_sync` を再実行し、`data.status.needs.review` が 0 になったことを確認する

訳文側にしかないセクションは、同期が削除せず `need:review`（`from` なし）で保護する。残すか消すかの判断は人に委ねる。委任されている場合、そのファイル限定で残す宣言は `mdait_resolve { action: "declare-isolate", unitHashes }` で行える。

### 知識構築と翻訳

5. `mdait_term { action: "detect" }` — 既訳ペアの両言語から用語を抽出する
6. `mdait_term { action: "expand" }` — 未展開の訳語を既訳から解決する
7. `mdait_tm { action: "commit" }` — 承認済みの既訳を翻訳メモリに登録する
8. `mdait_translate { path: "<targetDir>" }` — 原文側にしかなかったセクションを翻訳する
9. `mdait_validate` — 違反が 0 になるまで 8〜9 を繰り返す
10. 新規翻訳分を `mdait_tm { action: "commit" }` で登録し、完成の判定基準を確認する

## 検証違反への対処

`mdait_validate` の違反はチェック種別ごとに扱いが決まる。

- `terms` の違反 — 訳文が用語集から逸脱していれば、該当ユニットの訳文を期待訳語に直す。逸脱が正当な同義語なら、用語集の該当用語の `variants` に追加する
- `structure` の違反 — 該当ユニットの訳文の Markdown 構造（見出し・リスト・コードブロック・リンクの数）を原文に揃える

修正後は必ず `mdait_validate` を再実行し、違反が消えたことを確認する。

## 失敗時のリカバリ

すべて冪等なので「同期して観測からやり直す」が基本。

- **翻訳が途中で失敗・キャンセルされた** — 同じ `mdait_translate` を再実行する。翻訳済みユニットはスキップされ、残りだけが処理される
- **`ok:false` が返った** — `error.code` と `nextActions` に従う。`no_workspace` / `invalid_path` は入力の誤り。`internal_error` は `mdait_sync` → `mdait_getStatus` で状態を観測し直す
- **エラーユニットがある**（`data.errorUnits > 0`）— `mdait_getStatus { detail: true }` で対象を特定し、原因（AI への到達性は `mdait.setup.diagnose`）を解消してから翻訳し直す

## やってはいけないこと

- **マーカーを手書きで編集・生成しない。** `need` の解決・宣言・ユニット削除はすべて `mdait_resolve` で行う
- **`.mdait/` 配下（`unit-state` / `unit-registry` / `translations.tmx`）を直接編集しない。** `terms.csv` への variants 追加は正当な操作
- **`need` の意味を理解せずに裁定しない。** `mdait_resolve { action: "resolve" }` による `need:verify-deletion` の解決は「ユニットを保持する」判断であり、削除は `action: "delete"`（`unitHashes` 必須・Git でしか戻せない）。`translate` / `revise` は `mdait_translate` に処理させる（`needs` で明示しない限り `resolve` は解決しない）
- **承認 UI を避けるために操作を細切れにしない。** 承認回数はディレクトリ単位へのスコープ拡大で減らす
- **知識構築（term / tm）と翻訳を並走させない。** 用語集・翻訳メモリのキャッシュ整合性のため、知識構築 → 翻訳の順に行う

## 規模が大きいとき

ディレクトリ翻訳はファイル単位で並列に走る（`trans.concurrency`、既定 3）。レート制限に当たるなら `1` に下げる。1 回の実行で扱うユニット数は `trans.maxUnitsPerRun`（既定 300）で頭が抑えられている。

`mdait_getStatus { detail: true }` は `need` のあるファイルだけを返すため、数百ファイル規模でも出力は膨らまない。各ファイルの `units` は 50 件で切り詰められ、`unitsTruncated: true` が付く。そのファイルを解決してから取り直す。

`mdait_validate` は読み取り専用・AI 不使用なので、ループ内で何度呼んでもよい。

## mdait 自体を開発する

拡張機能そのものの構造・設計判断・ビルドとテストの手順は [設計書](design.md) にまとまっている。コマンドごとの詳細は [design/](design/) 配下、設計判断の履歴は [adr.md](adr.md) を参照。
