---
name: explore-sweep
description: "Extension Host 非依存の探索スイープ（scripts/exploratory、npm run test:explore）を使って commands 層の機構バグ・UX/挙動リグレッションを自律的に炙り出すためのSkillです。特に sync の冪等性やマーカー同期の退行検出に使う。Use when: hunting for behavior/UX regressions in a cloud/headless environment, verifying sync idempotency, expanding exploratory coverage beyond unit tests, or when VS Code Extension Host cannot be launched."
---

# Explore Sweep — Extension Host 非依存の探索的テスト

VS Code の Extension Host を起動せずに、`out/` のコンパイル済み commands 層を Node から
vscode モック越しに直接駆動し、「機構（挙動）」を決定的に検証してバグ・UX問題を炙り出すための Skill。
クラウド等 VS Code をヘッドレス起動できない環境で、単体テストより広い挙動リグレッションを自律検出する。

土台: `scripts/exploratory/`（`vscode-shim.js` / `fake-ai.js` / `run-sweep.js`）、`npm run test:explore`。
位置付けは `docs/design/test.md` の「探索的スイープ」を参照。

## いつ使うか

- `sync` の冪等性・マーカー整合・need フラグのライフサイクルに退行がないか確かめたい
- 新機能/リファクタ後に、単体テストではカバーしきれない挙動を広く総なめしたい
- クラウド/ヘッドレスで実 Extension Host が起動できない

## 実行手順

1. `npm ci && npm run compile`。まず `npm run test:explore` を回し、現状の緑/赤（FAIL/INFO）を把握する。
2. カバレッジを能動的に広げる。既存 run-sweep.js は sync/trans/revise の骨格のみ。優先的に叩く未カバー領域:
   - 非MD（csv/txt）の file-handler 分岐（`PlainFileHandler`）
   - `term.detect` / `term.expand`、`tm.commit`、`ai-review` の各経路
   - external マーカーモード（`markers.mode="external"`）での sync/trans
   - エッジ sample の深掘り（`structure_mismatch` / empty-marker / no_marker / frontmatter-only / 見出しレベル境界）
   - `adopt`/`align`、`trans-selection`、frontmatter 翻訳
   - 多言語ペア・ネスト階層・大きめ入力での冪等性
3. 新しいシナリオは `scripts/exploratory/` に追記するか、同ディレクトリに使い捨て repro を置いて調べる。

## 判定の規律（最重要：狼少年を避ける）

- 逸脱は必ず **単独 repro スクリプト**で再現してから報告する。
- **純 sync（AI非使用）で出た逸脱＝本物の製品バグ**。**フェイク訳が絡むもの＝mock限界（実LLM要）** として
  明確に分類し、断定しない（`run-sweep.js` は前者を FAIL、後者を INFO にしている。踏襲する）。
- 収束/振動/成長は複数回実行で確認する（例: sync を 4 回回して byte 差分を追い、無限成長か1回遅れかを見極める）。
- 根本原因は「トレースを1点ずつ挿して」データで確定してから直す（推測で直さない）。

## 既知の落とし穴

- ハーネスは共有 `src/test/unit/workspace/.mdait/mdait.json` を書き換える → 必ず snapshot/restore する
  （`run-sweep.js` は対応済み。新規スクリプトでも徹底。壊れた transPairs を引き継ぐと偽の回帰に化ける）。
- sample の `child2_1`/`child2_2` は title 接頭辞が `child_ja_new` と衝突する →
  トレースの絞り込みは title 部分一致でなく **ファイルパス厳密一致**で行う。
- `default` プロバイダはプレーンテキストを返し trans 検証に落ちる → 正常系検証は `fake-ai.js`
  （`{"translation":...}` を返す構造化フェイク）を `install()` で注入する。
- `SelectionState` は初期状態が空 → sync 前に
  `SelectionState.getInstance().updateSelection(sel.getSelectableTargets().map(t => t.key))` で全ペアを選択する。
- モックが未実装の vscode API に当たったら `vscode-shim.js` を増補する（withProgress/commands/findFiles の要領）。

## 成果物

- findings は「ファイル別・重大度・単独 repro 手順・real/mock 分類」で 1 本のレポートにまとめ、チャットに要約。
- 本物のバグは **根本修正 ＋ 単体回帰テスト**（`src/test/unit/...` に固定）＋ **ハーネスのアサーション追加**。
  参考: 過去に検出した frontmatter 非冪等2件は `src/test/unit/core/markdown/frontmatter-idempotency.test.ts` で固定。
- `npm test` と `npm run test:explore` を両方緑にしてから、指定ブランチにコミット → PR。
- 修正が自明でない/設計影響が大きい場合は、着手前に確認を取る。

## 参照

- ハーネス: `scripts/exploratory/README.md`
- テスト戦略: `docs/design/test.md`
- 冪等・マーカー等の不変条件: `AGENTS.md`
