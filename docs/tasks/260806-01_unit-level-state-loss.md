# Task-260806-01: ユニット単位の状態喪失（保留席の基準を「末尾」から「対応が付かなかった行」へ）

## WHY: Background
訳文の中ほどの章を1つ消して保存すると、その章の `unit-state` の行が**保留も刈り取りもされないまま消える**。
`detachMarkers`（`marker-provider.ts`）は行をユニットの並び順でそのまま上書きし、保留席へ移すのは
**末尾の行だけ**だからである。sync が原文からその章を復活させるとユニット数が元に戻るため、
`shouldPruneTail` は何もせず、消えた行は上書きされて痕跡も残らない（ログにも出ない）。

貼り戻すと本文は正しい訳に戻るのに、行は `need:translate` のまま固定される。`need:translate` は
「✨翻訳が上書きしてよい」という意味なので、**次に翻訳を回すと人の訳が AI 訳で潰される**。
embedded はマーカーが本文と一緒に貼り戻るので完全復帰する。つまりモード差の欠陥である。

## WHAT: Goal
訳文の章を消して保存し、あとで貼り戻したときに embedded と同じく状態が復帰するようにする。
あわせて §14(5) の残存リスク（保留席の行が「見出しだけ同じ別物の章」に拾われる）を閉じる。

## HOW: Design
保留席へ移す基準を「**末尾の行**」から「**対応が付かなかった行**」へ変える。
どの行が対応しなかったかが分かるのは**パース時**（`alignEntriesToUnits` の返り値に入らなかった行）だが、
保留を決めているのは**書き出し時**（`detachMarkers`）である。いまこの2点の間に情報の通り道が無いため、
パース → sync → 書き出しの経路に照合結果を運ぶ配管が要る。

あわせて、保留席の行を拾う規則を **本文ハッシュの完全一致だけ**に絞る（見出し一致では拾わない）。
保留席の行が増えるぶん、§14(5) のリスクに晒される行も増えるため、両者はセットでしか意味を持たない。

## Decisions
- 2026-08-06 の質疑で、Task-260805-01（段階1）とは**別 PR にする**と決めた。触る場所がまったく違い、
  混ぜると壊れたときの切り分けができないため。実質「段階3を今やるか」という問いで、
  ロードマップの最短距離（P01 → P02）とは別枠（roadmap-v01 の P03）
- 段階1の PR では、いま完全に無言で消えている経路に**ログを1行足すだけ**にした
- `markers-migration` の中間 stringify と embed 経路（ctx が無い呼び出し）への影響を必ず確認する

## Relevant files
- `src/core/markdown/marker-provider.ts` — `detachMarkers` / `shouldPruneTail`
- `src/core/unit-state/unit-state-align.ts` — `alignEntriesToUnits`（対応が付かなかった行が落ちる場所）
- `src/core/unit-state/unit-state-store.ts` — `parkEntriesFrom` / `pruneEntriesFrom`
- `scripts/exploratory/probe-robustness.js` — 段階1の PR で追加したユニット単位のシナリオ

## Steps
- [ ] 照合結果（対応が付かなかった行）をパースから書き出しまで運ぶ経路を作る
- [ ] 保留の基準を「対応が付かなかった行」に変える
- [ ] 保留席の行を拾う規則を本文ハッシュの完全一致だけに絞る（§14(5)）
- [ ] `markers-migration` / embed 経路への影響確認
- [ ] probe の既知欠陥からユニット単位のシナリオを外す

## Gates
- [ ] 章を1つ消して保存 → 貼り戻す で embedded と一致する
- [ ] 保留席の行が「見出しだけ同じ別物の章」に拾われない
- [ ] npm test / probe / sweep がすべて通る

## Review
<!-- reviewer記入 → coder対応 → reviewer✅ -->
**評価:**

## Notes
- 背景の詳細は `docs/design/unit-state.md` §14(5) と §17。
