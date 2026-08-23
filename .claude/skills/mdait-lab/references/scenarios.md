# シナリオを足す・広げる

`lab sweep` と `lab probe` は、どちらも `scripts/lab/scenarios/` に置いた**手順の列**である。
駆動（ホストの起こし方）・記録（run ディレクトリ）・判定の出し方は土台が持つので、
新しいシナリオを足すときに書くのは**手順とアサーションだけ**でよい。

## 2つの性格の違い

| | `sweep`（`scenarios/sweep.mjs`） | `probe`（`scenarios/probe.mjs`） |
|---|---|---|
| 目的 | 決まった期待に対する**判定** | 何が起きるかの**観察** |
| 出口 | FAIL があれば exit 1 | 常に 0。前回の run との差分を出す |
| 中身 | P1〜P8（sync 冪等・マーカー整合・translate・revise・非MD・external・モード切替・無言削除の禁止・本文喪失の禁止） | S0〜S14（編集・章の挿入/削除/並べ替え・リネーム・フォルダ移動・削除・外部変更） |
| 特徴 | AI は `echo`（決定的） | **embedded と external の両方を同じ手順で流して並べる** |
| 入口 | `npm run test:explore` | `lab probe [--only S3,S13]` |

`probe` が判定しないのは意図的である。両モードの性質は正反対で（embedded は文書の中の変化に強く、
external は文書の外の処理に強い）、「どちらが正しい」と決められない差が出るため。差の意味は
`docs/design/unit-state.md` を見る。

## 優先して広げたいところ

いま叩けていない経路。上から順に価値が高い。

- `term.detect` / `term.expand` / `tm.commit` / `ai-review` / `adopt` の各経路
- external マーカーモード（`markers.mode: "external"`）での sync / trans
- 非 Markdown（csv / txt）の `PlainFileHandler` 分岐
- エッジな原稿（`structure_mismatch` / 空マーカー / マーカー無し / frontmatter だけ / 見出しレベルの境界）
- 多言語ペア・深い階層・大きめの入力での冪等性
- 意地悪な台本（`--ai script`）を trans 以外の AI 経路にも当てる

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
