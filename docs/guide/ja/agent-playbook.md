# エージェント・プレイブック — サイト全体翻訳のオーケストレーション

AIエージェント（Copilot Chat 等）が mdait の LM Tools を使ってサイト全体の翻訳・用語集・翻訳メモリを完成させるための手順書。エージェントが読むことを前提に、手順は番号付き・判定条件は機械的に書く。

## 前提

- `.mdait/mdait.json` に `transPairs` と `primaryLang` が設定済みであること（未設定なら `mdait.setup.createConfig` から）
- ワークスペースが git 管理されており、開始前にコミット済みであること
- 全ツールは JSON エンベロープ `{ schemaVersion, ok, summary, data, nextActions }` を返す。`ok:false` のときは `error.code` / `error.message` と `nextActions` を見る

## 使用ツール

| ツール | 役割 | 副作用 | 何度でも呼べるか |
|---|---|---|---|
| `mdait_getStatus { path?, detail? }` | 状態観測 | なし | ✅ 無料 |
| `mdait_validate { path?, checks? }` | 構造・用語一貫性の検証 | なし | ✅ 無料 |
| `mdait_sync { adopt? }` | マーカー同期 | マーカー書換 | ✅ 冪等 |
| `mdait_translate { path }` | 翻訳（ファイル/ディレクトリ） | 訳文書換・AI使用 | ✅ 翻訳済みはスキップ |
| `mdait_term { action, path? }` | 用語集の検出/展開 | terms書換・AI使用 | ✅ 差分のみ処理 |
| `mdait_tm { action, path? }` | TMコミット/最適化 | tmx書換・AI使用 | ✅ 既存TUはスキップ |
| `mdait_aiReview { path?, dryRun? }` | 採用ペアのAIトリアージ（`need:review` の自動承認/エスカレーション） | マーカー書換・AI使用 | ✅ 承認済みは再検証しない |
| `mdait_adopt { dryRun?, buildGlossary?, buildTm? }` | 取り込みウィザード: `sync(adopt+align) → AIレビュー`＋オプションで用語集/TM構築 | マーカー・terms・tmx書換・AI使用 | ✅ 冪等（管理済みサイトでは align no-op） |

**基本ループ**: `mdait_getStatus` で観測 → ツールを1つ実行 → また観測。全コマンドは冪等なので、途中で失敗・中断してもループを再開するだけで復帰できる。

## 完成状態の判定基準（ゴール）

以下がすべて成立したとき完了と判定する。各条件はツール出力から機械的に確認できる:

1. `mdait_getStatus` の `data.needs` で `translate / revise / review / verifyDeletion / other` がすべて 0（`isolate` は定常状態なので除外してよい）
2. `mdait_validate` の `data.violations` が空配列
3. `mdait_term (detect)` → `data.pairs[].newTerms` 合計 0 かつ `unexpanded` 合計 0
4. `mdait_tm (commit)` → `data.newEntries` が 0（`data.skipped` の needTranslate/needRevise/needReview も 0）
5. `mdait_sync` を再実行して `data.units` の added/modified/deleted/revisionsNeeded/adopted がすべて 0

## S1: 新規翻訳（原文のみのサイトを丸ごと翻訳）

1. `mdait_getStatus` で現状を観測する
2. `mdait_sync` を実行する（初回はターゲットファイルが生成され `need:translate` が付く）
3. `mdait_translate { path: "<targetDir>" }` をディレクトリ単位で実行する（承認はスコープ単位で1回）
4. `mdait_validate` を実行し、違反があれば「違反への対処」（下記）を行う
5. `mdait_term { action: "detect" }` → `mdait_term { action: "expand" }` で用語集を構築する
   - 注: 用語集の効果を最初から効かせたい場合は、代表的な数ファイルを手順3で先に翻訳→ detect/expand → 残りを翻訳、の順にする
6. `mdait_tm { action: "commit" }` で翻訳済みユニットをTMに登録する
7. 完成状態の判定基準をすべて確認し、満たさない項目のツールを再実行する

## S2: 既存対訳の取り込み（既訳のあるサイトを管理下に置く）

**重要**: フェーズ2（知識構築）を残りの翻訳より先に行う。既訳ペアから用語集とTMを構築してから翻訳することで、新規翻訳が最初から既訳の用語・文体に揃う。

### フェーズ1: 取り込み

1. git コミットを確認する（取り込みはマーカー書き込みを伴う）
2. 訳文側にしかないセクション（マーカーなし）は sync が削除せず `need:review`（`from` なし）で保護するため、事前のポリシー設定は不要。取り込み後にユーザーへ「独立ユニット化（素 hash） / `need:isolate` / 削除」の判断を求める（[adopt.md](adopt.md)）
3. 取り込みを実行する。次のいずれか:
   - **AI支援（推奨・見出しズレのあるサイト）**: `mdait_adopt` を1回呼ぶ。`sync(adopt+align)` で位置ズレをAI補正して採用し、続けてAI翻訳レビューで高確信の一致を自動承認・誤ペア/訳抜けをエスカレーションする。`buildGlossary`/`buildTm` を渡せばフェーズ2（知識構築）も同時に実行できるが、エスカレーションが多い場合は TM がほぼ空になるため、レビュー解消後にフェーズ2を個別実行する方が確実。`data.sync.adopted`/`alignCorrections` と `data.review.*`・`data.escalations` を観測する
   - **決定的のみ**: `mdait_sync { adopt: true }` を実行する。`data.units.adopted` = 採用された既訳数（`need:review` 付与・本文は不変）、`data.units.kept` = 独立ユニットの保持数、`orphanReviewed` = マーカーなし孤立の一次受け（`need:review` 付与）数。任意で `mdait_aiReview` を後追いでかけてトリアージできる
4. 残った `need:review` ユニットをレビューする。`mdait_getStatus { detail: true }` で対象ファイルを特定し、原文と訳文の対応が正しいか確認する（`mdait_adopt`/`mdait_aiReview` の `data.escalations` は mismatch=誤ペア・partial=訳抜けの疑いとして先に見る）。問題なければマーカーの `need:review` を除去する（`hash`/`from` は変更しない）。ユーザーからレビューを委任されていない場合は、ユーザーに承認を求める
5. `mdait_sync` を再実行し、`data.status.needs.review` が 0 であることを確認する

### フェーズ2: 知識構築（既訳から先に抽出）

6. `mdait_term { action: "detect" }` — 既訳ペアの両言語から用語を抽出する
7. `mdait_term { action: "expand" }` — 未展開用語を既訳から解決する
8. `mdait_tm { action: "commit" }` — レビュー承認済みの既訳をTMに登録する

### フェーズ3: 翻訳・検証ループ

9. `mdait_translate { path: "<targetDir>" }` — 残りの `need:translate`（原文側にしかなかったセクション）を翻訳する
10. `mdait_validate` — 違反があれば「違反への対処」を行い、9〜10 を違反0件まで繰り返す
11. 新規翻訳分を `mdait_tm { action: "commit" }` で登録する
12. 完成状態の判定基準をすべて確認する

## 違反への対処（mdait_validate）

- `check: "terms"` の違反: 違反ごとにどちらかを選ぶ。判断基準を機械的に:
  - 訳文が用語集から逸脱している（誤訳・揺れ）→ 該当ユニットの訳文を期待訳語を使うよう修正する
  - 逸脱が正当な同義語 → terms ファイルの該当用語の variants に追加する
- `check: "structure"` の違反: 該当ユニットの訳文の Markdown 構造（見出し・リスト・コードブロック・リンク数）を原文に揃える
- 修正後は必ず `mdait_validate` を再実行して違反が消えたことを確認する

## 失敗時のリカバリ

すべて冪等なので「`mdait_sync` して観測からやり直す」が基本:

- **翻訳が途中で失敗/キャンセルされた**: 同じ `mdait_translate` を再実行する。翻訳済みユニットはスキップされ、残りだけ処理される
- **ツールが `ok:false` を返した**: `error.code` と `nextActions` に従う。`no_workspace`/`invalid_path` は入力を直す。`internal_error` は `mdait_sync` → `mdait_getStatus` で状態を観測し直す
- **エラーユニットがある**（`data.errorUnits > 0`）: `mdait_getStatus { detail: true }` で対象を特定し、原因（AI到達性は `mdait.setup.diagnose`）を解消して `mdait_translate` を再実行する
- **状態が不明になった**: `mdait_sync` → `mdait_getStatus { detail: true }`。マーカーはすべて文書内にあるので、これで必ず現状が観測できる

## やってはいけないこと

- マーカー（`<!-- mdait ... -->`）の `hash`/`from` を手書きで編集・生成しない（`need` フラグの除去だけは正当な操作）
- `.mdait/` 配下（`unit-state`・`unit-registry`・`translations.tmx`）を直接編集しない（`terms.csv` の variants 追加は正当な操作）
- `need` フラグの意味を理解せずに削除しない（`need:verify-deletion` の除去は「削除しない」判断、ユニットごと削除は「削除する」判断）
- 承認UIをバイパスするために操作を細切れにしない（承認回数はディレクトリ単位のスコープ拡大で減らす）
- 知識構築（term/tm）と翻訳を同時並行で走らせない（用語集・TMのキャッシュ整合性のため、知識構築→翻訳の順に行う）

## スケールに関する注意

- ディレクトリ翻訳はファイル単位で並列実行される（`trans.concurrency`、デフォルト3）。レート制限エラーが出る場合は `1` に下げる
- `mdait_getStatus { detail: true }` は need のあるファイルのみを返すため、数百ファイル規模でも出力は膨れない
- `mdait_validate` は読取専用・AI不使用なのでループ内で何度呼んでもよい

## 関連

- [copilot-chat.md](copilot-chat.md) — 各ツールの個別説明
- [adopt.md](adopt.md) — 既存対訳の取り込み詳細
- [sync.md](sync.md) — need フラグと orphanTargetPolicy
- [../../design/agent-orchestration.md](../../design/agent-orchestration.md) — 設計とロードマップ
