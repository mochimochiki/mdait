# シナリオのパターン集

機能を実装・修正した後に、**その変更に効くシナリオをその場で組み立てる**ための型。
毎回全部やるものではない。今回の変更に効くものを選んで組み合わせる。

命令はどのホストでも同じ書き方になる。

```bash
node scripts/lab/lab.mjs run mdait.sync
node scripts/lab/lab.mjs run mdait.translate.file "<訳文側の絶対パス>"
```

判定は `lab run` が出す要約（status / need フラグの増減 / 警告ログ）で行い、細かく見たいときだけ
run ディレクトリの `steps/NNN-*.json` を読む。

## 費用の原則

- **対象は最大2ファイル**。全ファイル翻訳は割に合わない（実測: 3ファイル9ユニットで12往復）。
- ファイル数より**流れの複雑さとパターンの網羅**を優先する。
- `--ai echo` なら費用はゼロ。**費用がかかるのは `--ai agent` だけ**。機構の確認は echo で足りる。

## 変更した場所 → 選ぶパターン

| 変更した場所 | パターン |
|---|---|
| sync（マーカー・ハッシュ・level・差分検出） | P1, P4 |
| trans（翻訳ロジック・指示文・出力処理） | P2, P4, P5 |
| patchMode（差分翻訳・パッチ適用） | P4, P5 |
| TM（commit・検索・参照・書式） | P3, P6 |
| term（検出・展開・用語集） | P7 |
| エラー処理・入力の検証 | P8 |
| 複数機能にまたがる変更・リファクタ | P9 |
| UI（通知・進捗・取り消し） | P10（code-server ホスト） |
| エージェント連携（adopt・独立ユニット・LM Tools・並列翻訳） | P11, P12 |

---

## P1: sync の基本動作

**いつ**: sync 処理、マーカー挿入、ハッシュ計算、ペア検出を変えたとき

```bash
lab up --ai none --reset      # AI を使わないので shim すら要らない
lab run mdait.sync
```

**確かめること**
- `status === "done"`
- `result.totalFileCount > 0` / `successCount > 0`
- 訳文側にマーカーが入っている（external モードなら `.mdait/unit-state` に行が増える）
- `structuredLogs` に `scope: "sync"` がある

---

## P2: trans の基本翻訳

**いつ**: 翻訳ロジック、指示文の組み立て、出力の後始末を変えたとき（**前提**: P1 の後）

```bash
lab up --ai echo --reset
lab run mdait.sync
lab run mdait.translate.file "<need:translate を持つ訳文の絶対パス>"
```

**確かめること**
- `status === "done"` / `result.translatedCount > 0`
- `need:translate` が消えている（`lab run` の要約が need の増減を出す）
- 訳文が書き込まれている

---

## P3: tm.commit

**いつ**: TM 登録、TMX の書式、TM エントリ生成を変えたとき（**前提**: P2 の後）

```bash
lab run mdait.tm.commit.file "<原文の絶対パス>"
```

**確かめること**: `result.committed > 0`、`.mdait/translations.tmx` にエントリが増えている

---

## P4: 改訂の流れ（原文を変える → re-sync → revise）

**いつ**: patchMode、差分検出、改訂判定、`need:revise` の扱いを変えたとき（**前提**: P3 の後）

1. 原文（ja 側）の本文を一部書き換える
2. `lab run mdait.sync`
3. `lab run mdait.translate.file "<訳文の絶対パス>"`

**確かめること**
- 手順2: `result.revisionsNeeded >= 1`、訳文側に `need:revise@{前のハッシュ}` が付く
- 手順3: `structuredLogs` に `patchMode: true` を含む行がある
- 手順3: 変えた場所だけが更新され、変えていない場所の訳文は元のまま

> sync の `totalModified` は**訳文の内容の変更**を数える。原文を変えて訳文側に `need:revise` が付くのは
> modified に数えられない。これは正常な振る舞いで、退行ではない。

---

## P5: 手直しの保全

**いつ**: patchMode の失敗時の退避、確認ダイアログ、既存訳の保護を変えたとき（**前提**: P2 の後）

1. 訳文の翻訳済みテキストに手直しを足す（例: `(HAND-EDITED)`）
2. 原文の対応する章を変える
3. `lab run mdait.sync` → `lab run mdait.translate.file ...`

**確かめること**: 手直しが sync 後も残る。patchMode が成った場合は翻訳後も残る。

---

## P6: TM を参照する効果

**いつ**: TM 検索、参照の書式、指示文への差し込みを変えたとき（**前提**: P3 の後）

TM に登録したのとは**別の**訳文ファイルを翻訳し、`structuredLogs` に `TM references found` が出るか、
`result.tmHits > 0` かを見る。

---

## P7: term の検出と展開

**いつ**: 用語検出・展開・用語集ファイルの操作を変えたとき（**前提**: P1 の後）

```bash
lab run mdait.term.detect "<原文のフォルダ>"
lab run mdait.term.expand "<原文のフォルダ>"    # ← expand はフォルダしか受け付けない
```

**確かめること**: 各ステップが `done`。用語集ファイル（既定 `terms.csv`）にエントリが増えている。

> **注意（実装と食い違っていた点）**: 旧 `debug-ipc` スキルは `mdait.term.detect.file` /
> `.directory` / `mdait.term.expand.file` / `.directory` という ID を載せていたが、**どれも登録されていない**。
> 実在するのは `mdait.term.detect` と `mdait.term.expand` の2つだけ（`src/extension.ts`）。
> lab はこの2つを正とし、対象がファイルかフォルダかは引数の形で伝える。

---

## P8: エラーからの復帰

**いつ**: エラー処理、入力の検証、メッセージを変えたとき

```bash
lab run mdait.trans "/存在しない/場所/file.md"
```

**確かめること**: `status === "error"`、`error` にファイル関連の説明が入る

---

## P9: 全体の一気通貫

**いつ**: 複数機能にまたがるリファクタ、依存関係の変更、大きな構造変更のとき

P1 → P2 → P3 → P4 → P6 を**2ファイルで**続けて流す。最後にもう一度 sync して、
added / modified / deleted / revisionsNeeded がすべて 0 になること（＝落ち着いた状態）を確かめる。

---

## P10: 進捗と取り消し（code-server ホスト）

**いつ**: 進捗表示、取り消し、中断時のファイル保全を変えたとき

```bash
lab up --host code-server --ai echo --delay 6000    # 遅らせて「翻訳中」を作る
lab run mdait.translate.directory "<ディレクトリの絶対パス>"   # 別の端末で
lab shot during-translation
```

`--delay` が無いと翻訳が一瞬で終わり、回転アイコンや1件ずつ緑になる遷移を撮れない。
取り消しは IPC からは起こせないので、Playwright で通知トーストの取り消しボタンを押す。

---

## P11: 新規翻訳のオーケストレーション（ひとこと依頼 → 完成状態）

**いつ**: エージェント連携（LM Tools のデータ形式、need フラグの経路、並列翻訳）を変えたとき。
判定条件は `docs/design/agent-orchestration.md` の「完成状態の定義」をそのまま使う。

```bash
lab up --ai echo --reset
lab run mdait.sync
lab run mdait.translate.directory "<ws>/content/en"
lab run mdait.term.detect "<ws>/content/ja"
lab run mdait.term.expand "<ws>/content/en"
lab run mdait.tm.commit.directory "<ws>/content/en"
lab run mdait.sync                       # 落ち着いた状態の確認
```

**確かめること**
- 最後の sync が added / modified / deleted / revisionsNeeded すべて 0（条件5: 冪等な定常状態）
- en 側の全ファイルに `need:` が残っていない（条件1。`need:isolate` は除く）
- term と tm をもう一度流して新規0件（条件3・4）
- ディレクトリ翻訳のログで複数ファイルの開始が交互に出ている（並列の確認。`trans.concurrency >= 2` のとき）

---

## P12: 既存対訳の取り込み（adopt → 知識づくり → 翻訳）

**いつ**: adopt、孤立ユニットの扱い（独立ユニット・`need:isolate`・一次受け）、取り込みの流れを変えたとき

**準備**: `40_structure_mismatch.md`（ja/en 両方にあり・マーカー無し・構造がずれている）があること。
en 側の既訳本文のスナップショットを先に取る。

```bash
lab up --ai echo --reset
lab run mdait.sync '{"adopt":true}'
# en 側 40_structure_mismatch.md を確認 → need:review を外して素ハッシュ化（独立ユニット宣言）
lab run mdait.sync
lab run mdait.tm.commit.directory "<ws>/content/en"
lab run mdait.translate.directory "<ws>/content/en"
lab run mdait.sync
```

**確かめること**
- adopt 後: 既訳の本文が**1文字も変わっていない**（スナップショット比較）。対応ペアに `from` ＋ `need:review` が付く。`totalAdopted > 0`
- adopt 後: 日本語だけの章に対応する en 側ユニットに `need:translate` が付く
- adopt 後: 訳文側だけにある章（マーカー無し）が**削除されず**一次受けされる
  > **注意（実測）**: 対応付けは**位置で並べるだけ**で、内容は見ない。原文にだけ章が1つあると
  > 以降が玉突きでずれ、`totalOrphanReviewed` は 0 のまま**意味の違う組**が確定する。
  > これを直すのが `align`（AI による並べ直し）で、`mdait.sync '{"adopt":true}'` だけでは走らない
  > （`adopt` と `align` の両方が要る）。偽の AI では align が成立しないので、
  > この期待を確かめるには**本物の LLM** が要る。
- 素ハッシュ化した独立ユニットは以後の sync で不変（対応付けにも使われない）
- `tm.commit`: `newEntries > 0`。独立ユニット化より前に流すと `need:review` スキップ・`noFrom` スキップになることも確認できる
- 最後の sync: added / modified / deleted / revisionsNeeded / adopted すべて 0

**isolate の確認**: ja 側の任意ユニットに `need:isolate` を付けて再 sync → en 側に対応する訳文が作られない
（既存ペアがある場合は ja 本文を変えても `need:revise` が付かず、hash と from だけが更新される＝凍結）。

---

## 組み合わせの例

| 変更 | 流れ |
|---|---|
| sync の改修 | P1 → P4 |
| patchMode の改修 | P1 → P2 → P4 → P5 |
| TM の改修 | P1 → P2 → P3 → P6 |
| 全面リファクタ | P9 |
| エージェント連携の改修 | P11 → P12 |
