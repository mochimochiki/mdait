# Task-260805-01: 段階1 — 孤立訳文の可視化（削除ではなく要対応に倒す）

## WHY: Background
リネーム・移動・原文削除で訳文が「原文と結びついていない」状態になっても、いまは画面のどこにも出ず、
external では状態が消えることもある（unit-state.md §6・§7）。embedded の F-10（ux.md）と同根。
2026-08-05 の質疑（unit-state.md §16）で実装順を「確認待ちの出口 → **段階1** → 段階2」と決めた。

## WHAT: Goal
「訳文から導出した原文が実在するか」で孤立を判定し、削除せずツリーに可視化する。
人が再リンク（段階4の前段）または破棄を選べる状態にする。内容照合はこの段階ではやらない。

## HOW: Design
ux.md §3.3 の役割分担に従う: 状態＝ツリー（「原文と結びついていない訳文」ノード）、
操作＝ツリー行のインライン、解説＝Hover、気づき＝ステータスバー。破棄は modal 確認。
書き換えは ADR-260726-01 どおり `FileHandler` のメソッドとして足す（サーフェスが store を直接触らない）。
一括確定（Task 完了済み・ADR-260805-01）のファイル行ボタンが先例になる。

## Decisions
- 着手前に §8 の未決事項を詰める設計セッション（grill）を挟む。特に:
  - sync は訳文ディレクトリを列挙していない — 列挙の新設とコスト・ignore パターンの扱い
  - 孤立行のライフサイクル（明示破棄のみか、N回連続で退避か）
  - 「走査対象外 / 実体が無い / 導出した原文が無い」の3分割との整合（§13 で実装済みの区分を崩さない）
- 原文への id 1行は書かない（§7 の 2026-08-05 決定。再訪条件つき）
- 段階1の前の最安の一手: `attachMarkers` の titleHash 不一致を debug ログから sync 結果へ引き上げる（§7）

## Relevant files
- `docs/design/unit-state.md` — §7（段階表）・§8（未決事項）・§16（今回の決定）
- `docs/ux.md` — §3.3 サーフェスの役割分担、F-10
- `src/commands/sync/sync-command.ts` — 走査と孤立掃除（`cleanupOrphansInScope`）
- `src/commands/markers/unit-mutation.ts` — 書き換えの共通経路（複数パス版 `withFileMutation` が要る可能性）
- `src/commands/markers/status-tree-need-handler.ts` — ツリー操作の先例（一括確定）

## Steps
- [ ] 設計セッションで §8 の未決事項を確定し、本チケットの HOW を具体化する
- [ ] 孤立判定（訳文→導出原文の実在チェック）と列挙の実装
- [ ] ツリーの「原文と結びついていない訳文」ノードと操作・Hover・ステータスバー
- [ ] 破棄操作（modal）を `FileHandler` 経由で実装
- [ ] probe / sweep に受け入れシナリオを追加（S6〜S9 系の再測定）

## Gates
- [ ] リネーム・原文削除で訳文の状態が黙って消えない（probe で embedded と突き合わせ）
- [ ] 孤立がツリーに出て、人が破棄を確定できる（破棄は modal）
- [ ] 定常 sync の決定性・冪等性を維持（ADR-260705-01）
- [ ] npm test / probe / sweep がすべて通る

## Review
<!-- reviewer記入 → coder対応 → reviewer✅ -->
**評価:**

## Notes
- 2026-08-05 の grill セッション要約は unit-state.md §16 を参照。
- PR #97 のレビューで判明: LM Tool 層（`mdait_resolve` 等）は**どのアクションもツール層の単体テストが無い**
  （invoke の入力検証・エンベロープ形状・確認UIの契約が未固定）。基盤を作るなら別チケットに切り出すこと。
