# Task-260805-01: 段階1 — 孤立訳文の可視化（削除ではなく要対応に倒す）

## WHY: Background
リネーム・移動・原文削除で訳文が「原文と結びついていない」状態になっても、いまは画面のどこにも出ず、
external では状態が消えることもある（unit-state.md §6・§7）。embedded の F-10（ux.md）と同根。
2026-08-05 の質疑（unit-state.md §16）で実装順を「確認待ちの出口 → **段階1** → 段階2」と決めた。
2026-08-06 の質疑（unit-state.md §17）で §8 の未決事項を確定した。ロードマップの P01。

## WHAT: Goal
「訳文から導出した原文が実在するか」で孤立を判定し、削除せずツリーに可視化する。
人が破棄（ごみ箱へ移動）を選べる状態にする。内容照合はこの段階ではやらない。
あわせて S68（訳文を空にして貼り戻すと external だけ全ユニット `need:translate` 固定）を直す。

## HOW: Design
判定は **「その訳文ファイルは実在する ∧ そこから導いた原文ファイルは実在しない」** の一点。
**記録は持たず毎回ディスクから計算する**（ADR-260806-01）。新しいディレクトリ列挙は不要 —
ツリーは既に訳文ディレクトリを列挙しており（`status-collector.ts`）、sync 側は `unit-state` の行の
`path` に実在確認をかければ「行があるのに実体が無い」と「実体はあるが原文が無い」が割れる。

| 層 | 変更 |
|---|---|
| 判定 | 孤立判定を1箇所に置く（`getSourcePath` + 実在確認） |
| sync | `cleanupOrphansInScope` に「ディスクに実在するなら消さない」を追加 |
| ツリー | ファイル行にその場で印（アイコン＋副題）。専用ノードは作らない |
| 操作 | 破棄＝ごみ箱へ移動（modal）。`FileHandler` 経由（ADR-260726-01） |
| 気づき | ステータスバーに常駐件数＋新規に孤立したときだけ1回通知 |

S68 は ADR-260803-06 の対称化として直す（訳文のユニットが0件なら sync を中止する）。

## Decisions
2026-08-06 の質疑（unit-state.md §17）で確定:
- **孤立は記録しない。毎回ディスクから計算する**（ADR-260806-01）。→ §8 の「孤立行のライフサイクル」は
  寿命という概念ごと消える。「訳文ディレクトリ列挙の新設」も不要になった
- **ignore の扱い**: ignore された訳文はツリーに出ず、実在するので行は残る（＝確かめていないものは消さない側）
- **人が取れる行動は破棄だけ**。手動再リンクは段階4（P04）へ、独立化宣言は段階2完了後に再訪
- **破棄はごみ箱へ移動**（`workspace.fs.delete({ useTrash: true })`）。modal に「ごみ箱へ移動します」と明記
- **ツリーは既存のファイル行にその場で印を付ける**。集約用の仮想ノードは作らない
- **通知は新しく孤立したファイルが出たときだけ**（記憶の単位は件数ではなくパスの集合）
- **S68 は「訳文が空なら触らない」で直す**（ADR-260806-02）。rebuild 検知の拡張は採らない
- **ユニット単位の状態喪失は今回覆わない**。Task-260806-01 に切り出し、probe シナリオだけ足す
- **LM Tool には孤立を出力に出すが破棄操作は出さない**。テスト基盤は Task-260806-02
- 原文への id 1行は書かない（§7 の 2026-08-05 決定。再訪条件つき）

## Relevant files
- `src/commands/file-handler/status-collector.ts` — 訳文ディレクトリの列挙（既存）。孤立判定の付与
- `src/core/status/status-item.ts` — `FileStatusItem` に判定結果
- `src/ui/status/status-tree-provider.ts` — 印・`contextValue`・Hover
- `src/commands/sync/sync-command.ts` — 掃除の実在確認、訳文空の中止、通知
- `src/core/unit-state/unit-state-store.ts` — `cleanupOrphansInScope`
- `src/commands/markers/unit-mutation.ts` — 破棄の共通経路
- `scripts/exploratory/probe-robustness.js` — 受け入れシナリオ

## Steps
- [x] 設計セッションで §8 の未決事項を確定し、本チケットの HOW を具体化する
- [x] 孤立判定を1箇所に置く（VS Code 非依存の純粋関数として）
- [x] `cleanupOrphansInScope` に実在確認を足し、孤立行を消さない
- [x] ツリーのファイル行に印と Hover、破棄操作（ごみ箱・modal）
- [x] ステータスバーの常駐件数と、新規孤立時の1回通知
- [x] 訳文のユニットが0件のとき sync を中止する（S68）
- [x] probe に孤立とユニット単位の状態喪失のシナリオを追加（S75）
- [ ] 敵対的レビュー（正しさ・不変条件・エッジケース）

## Gates
- [x] リネーム・原文削除で訳文の状態が黙って消えない（probe S6 / S9 が embedded と一致）
- [x] 孤立がツリーに出て、人が破棄を確定できる（破棄は modal・ごみ箱経由）
- [x] 訳文を空にして貼り戻すと状態が復帰する（S68・embedded と一致）
- [x] 定常 sync の決定性・冪等性を維持（ADR-260705-01。中止は状態を変えないので冪等）
- [x] npm test（1600件）/ probe（想定外の差 0）/ sweep（FAIL=0）がすべて通る

## Review
<!-- reviewer記入 → coder対応 → reviewer✅ -->
**評価:**

## Notes
- 2026-08-05 の grill セッション要約は unit-state.md §16、2026-08-06 は §17 を参照。
- ロードマップ: `docs/roadmaps/roadmap-v01_external-markers.md` の P01。
