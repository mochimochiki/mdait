# Task-260806-02: LM Tool 層のテスト基盤を作る

## WHY: Background
PR #97 のレビューで判明した積み残し。**LM Tool（`mdait_resolve` 等9種）は、どのアクションも
ツール層の単体テストが無い。** invoke の入力検証・共通エンベロープの形状（`schemaVersion / ok /
summary / data / nextActions`）・確認UIの契約がどれも固定されていない。

ADR-260805-01 で「ツリー・CodeLens・LM Tool の3接点が同じ経路を通る」対称性を不変条件にしたが、
3接点のうち LM Tool だけが**テストで守られていない**。コア側の入口（`keepUnits` 等）を変えたとき、
ツールの引数の受け渡しが壊れても誰も気づかない。

## WHAT: Goal
LM Tool 層に単体テストの土台を作り、少なくとも1つのツールで
「入力検証・エンベロープ形状・コア入口の呼び出し」を固定する。以降は同じ型で足せる状態にする。

## HOW: Design
`src/test/unit/__mocks__/register-vscode-mock.js` のモックに乗せて VS Code 非依存で動かす
（単体テストの層の作法は `docs/design/test.md`）。まず `mdait_resolve` を題材にし、
`action` ごとの引数検証と、`keepUnits` / `resolveNeed` / `deleteUnit` のどれを呼ぶかを固定する。

## Decisions
- 2026-08-06 の質疑で、Task-260805-01（段階1）には**含めない**と決めた。段階1で LM Tool に足すのは
  `mdait_getStatus` の出力項目1つだけで、基盤をゼロから作る動機にはならないため
- ロードマップ（roadmap-v01）の外に置く技術債。着手時期は未定

## Relevant files
- `src/lm-tools/*.ts` — 対象。まず `resolve-tool.ts`
- `src/test/unit/__mocks__/register-vscode-mock.js` — モック登録
- `docs/design/tools.md` — 共通エンベロープの仕様
- `docs/design/test.md` — テスト3層の作法

## Steps
- [ ] LM Tool を単体テストから呼べるようにする（モックの不足分を補う）
- [ ] `mdait_resolve` の入力検証とエンベロープ形状をテストで固定する
- [ ] 残り8ツールへ広げるかを判断し、判断を本チケットに残す

## Gates
- [ ] `npm test` に LM Tool 層のテストが含まれる
- [ ] コア入口（`unit-mutation.ts`）の引数を変えるとテストが落ちる

## Review
<!-- reviewer記入 → coder対応 → reviewer✅ -->
**評価:**

## Notes
- 出所は Task-260805-01 の Notes（PR #97 レビュー）。
