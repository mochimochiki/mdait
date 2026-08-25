# シナリオを足す・広げる

`lab sweep` と `lab probe` は、どちらも `scripts/lab/scenarios/` に置いた**手順の列**である。
駆動（ホストの起こし方）・記録（run ディレクトリ）・判定の出し方は土台が持つので、
新しいシナリオを足すときに書くのは**手順とアサーションだけ**でよい。

## 3つの性格の違い

| | `sweep`（`scenarios/sweep.mjs`） | `probe`（`scenarios/probe.mjs`） | `ux`（`scenarios/ux.mjs`） |
|---|---|---|---|
| 目的 | 決まった期待に対する**判定** | 何が起きるかの**観察** | **実 UI にしか無いもの**を撮って文字に落とす |
| 出口 | FAIL があれば exit 1 | 常に 0。前回の run との差分を出す | FAIL があれば exit 1 |
| 中身 | P1〜P14（sync 冪等・マーカー整合・translate・revise・非MD・external・モード切替・無言削除の禁止・本文喪失の禁止・用語・TM・レビュー・取り込み・端の原稿・見出しレベル） | S0〜S14（編集・章の挿入/削除/並べ替え・リネーム・フォルダ移動・削除・外部変更） | U1〜U5（ツリーの行とアイコン・確認ダイアログ・翻訳中の回転・CodeLens・通知） |
| 特徴 | AI は `echo`（決定的） | **embedded と external の両方を同じ手順で流して並べる** | **code-server ホスト専用**。`echo --delay` で翻訳をわざと遅くする |
| 入口 | `npm run test:explore` | `lab probe [--only S3,S13]` | `lab ux [--only U1,U4]` |

`probe` が判定しないのは意図的である。両モードの性質は正反対で（embedded は文書の中の変化に強く、
external は文書の外の処理に強い）、「どちらが正しい」と決められない差が出るため。差の意味は
`docs/design/unit-state.md` を見る。

## 優先して広げたいところ

いま叩けていない経路。上から順に価値が高い。

- 多言語ペア・深い階層・大きめの入力での冪等性
- 実 UI の続き（`lab ux` の U4 の先）— ホバーで出る行アクション、右クリックのメニュー、
  QuickPick の候補一覧、設定画面（カスタムエディタ）
- `MDAIT_LAB_DIALOG=no` で**取り消し側**（No / Cancel を押す）を通す

済んだもの: `term` / `tm` / `ai-review` / `adopt`（sweep P9〜P12）、external での sync / trans（P5・P6）、
非 Markdown（P4）、端の原稿と見出しレベル（P13・P14）、意地悪な台本の全 AI 経路への適用（`lab resilience`）、
実 UI にしか無いもの（`lab ux`）。

## 書くときの型

1. `lab up` で場を作る（シナリオ側から土台の関数を呼ぶ）
2. 手順を進める。各手順は `lab run` と同じ経路（IPC）を通す
3. 期待を書く。**判定は「純 sync で出た逸脱＝本物のバグ」「偽の訳文が絡む＝偽物の限界」で分ける**
4. 逸脱を見つけたら**単独の再現手順**に切り出してから報告する

## ハーネスの落とし穴（実測済み）

- **サンプルの `child2_1` / `child2_2` は title の接頭辞が `child_ja_new` と衝突する。**
  トレースの絞り込みは title の部分一致ではなく**ファイルパスの厳密一致**で行う。
- **`SelectionState` は初期状態が空。** sync の前に全ペアを選ばないと何も起きない
  （`selection.updateSelection(selection.getSelectableTargets().map(t => t.key))`）。土台が代行する。
- **`default` プロバイダはプレーンテキストを返すので trans の検証に落ちる。** 正常系は `--ai echo` を使う。
- **`--ws repo` を使うときだけ**、共有の `mdait.json` を退避して戻す必要がある。既定の `/tmp` では不要。
- **モックに無い vscode API に当たったら `scripts/lab/vscode-shim.js` を足す**（`withProgress` /
  `commands` / `findFiles` の要領）。
- **実 UI（code-server）では、見る操作に `innerText()` を使わない。** 無い要素を待ち続けて既定の
  30 秒ぶら下がり、その間**見張りが待ち行列を握ったまま**になるので、ほかの頼まれごとが全部止まる
  （実測: `dialog-policy` が 60 秒応答しなかった）。1回の `evaluateAll` で読み切る。
- **確認ダイアログの文言は `message` に入るとは限らない。** フォルダ翻訳の確認は `message` が空で、
  文言はすべて `detail` に入る（実測）。判定は `message || detail` で見る。
- **VS Code のリストは見えている行しか DOM に置かない。** 全部開くと下の枝が画面からはみ出し、
  はみ出した行は読むことも撮ることもできない。見たい枝だけ開き、要らない枝は畳む
  （`set-row-expanded`）。
- **revise のパッチは `echo` では作れない。** `echo` は `{"translation": ...}` の形しか返さないので、
  revise の trans 側は検証に失敗して全文再翻訳へ落ちる。これは**偽物の限界**であって退行ではない。
  パッチ適用そのものを確かめたいなら `--ai live` で手で返すか、`--ai agent` を使う。

## 見つけたバグの閉じ方

1. **単独の再現手順**で再現する（他の手順に依存しない最小の形）
2. 根本原因を、トレースを1点ずつ挿してデータで確定する（推測で直さない）
3. **根本修正 ＋ 単体回帰テスト**（`src/test/unit/...` に固定）
4. **シナリオにアサーションを足す**（同じ壊れ方をもう一度捕まえられるようにする）
5. `npm test` と `lab sweep` を両方緑にしてからコミットする

> 過去に見つけた frontmatter マーカー同期の非冪等2件（末尾改行の無限増加 / front マーカーの1回遅れ）は
> `src/test/unit/core/markdown/frontmatter-idempotency.test.ts` で単体固定している。これが型。
