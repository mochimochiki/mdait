# IPC の規約とコマンド一覧

命令の経路は3ホストとも同じ。ワークスペースの `.mdait/debug/` にファイルを置いてやり取りする。
`lab run` がこの手順を代行するので、**通常は自分でファイルを書く必要はない**。

## ファイル

| ファイル | 役割 |
|---|---|
| `.mdait/debug/.ipc-enabled` | 置いてあると Extension Host が IPC を有効にする（環境変数を渡せないブラウザ版のための道） |
| `.mdait/debug/ready` | Extension Host（または headless ホスト）の準備完了の合図 |
| `.mdait/debug/command.json` | 命令（lab → ホスト） |
| `.mdait/debug/result.json` | 結果（ホスト → lab） |

```json
// command.json
{ "id": "一意の文字列", "command": "mdait.sync", "args": [] }
```

```json
// result.json
{
  "id": "command.json と同じ id",
  "command": "mdait.sync",
  "status": "running | done | done-with-errors | error",
  "result": null,
  "error": null,
  "logs": ["[時刻][レベル][範囲] 本文 | {文脈}"],
  "structuredLogs": [{ "level": "info", "scope": "sync", "message": "...", "context": {}, "timestamp": "..." }],
  "startedAt": "ISO8601",
  "completedAt": "ISO8601",
  "fireTimeline": [],
  "stateDiff": [],
  "syncAnalysis": {}
}
```

- `done-with-errors` は「完走したが `errorCount > 0`」。成功と失敗の間を潰さないための状態。
- `fireTimeline` / `stateDiff` / `syncAnalysis` は**実 Extension Host のときだけ**入る。
  ツリーの更新イベントと状態の差分を突き合わせ、「コマンドは成功したのに画面が追随しない」を機械検出するためのもの。
- **`id` が一致する結果だけを読むこと**。前回の `result.json` を読んでしまう事故が起きる（`lab run` は対処済み）。
- 実装の正は `src/infra/debug/debug-command-handler.ts`。

## 引数の渡し方

`lab run <コマンド> <パス>` と書くと、コマンドに応じて lab が形を整える。

| 変換 | 渡る形 | 対象コマンド |
|---|---|---|
| Uri | `vscode.Uri.file(パス)` | `mdait.trans`、`mdait.translate.frontmatter` |
| ファイルの StatusItem | `{ type: "file", filePath, fileName }` | `mdait.translate.file`、`mdait.tm.commit.file`、`mdait.aiReview.file` |
| フォルダの StatusItem | `{ type: "directory", directoryPath, label }` | `mdait.translate.directory`、`mdait.tm.commit.directory`、`mdait.aiReview.directory` |
| そのまま | 文字列・JSON | 上記以外 |

`{...}` や `[...]` の形で書いた引数は JSON として読まれる（例: `lab run mdait.sync '{"adopt":true}'` で
取り込みが走り、`totalAdopted` が増える）。読めない形はそのまま文字列として渡るので、パスや普通の語は壊れない。

## よく使うコマンド

| コマンド | すること | 引数 |
|---|---|---|
| `mdait.sync` | 状態の同期 | なし（`{"adopt":true}` で取り込み） |
| `mdait.trans` | 単体翻訳 | **訳文の側**のファイルのパス |
| `mdait.translate.file` | ファイル翻訳 | **訳文の側**のファイルのパス |
| `mdait.translate.directory` | フォルダ翻訳 | **訳文の側**のフォルダのパス |
| `mdait.translate.frontmatter` | フロントマターの翻訳 | **訳文の側**のファイルのパス |
| `mdait.tm.commit.file` / `.directory` | TM 登録 | パス |
| `mdait.aiReview.file` / `.directory` | AI による訳文レビュー | パス |
| `mdait.term.expand` | 用語の展開 | **フォルダのパス**（ファイルを渡すと何もせず `done` で戻る。下記） |
| `mdait.adopt.run` | 既存訳の取り込み | なし |
| `mdait.markers.externalize` / `mdait.markers.embed` | マーカーの保管方式の切り替え | なし |
| `mdait.setup.createConfig` | 設定の作成 | なし |
| `mdait.setup.diagnose` | 診断 | なし |

> **翻訳系は必ず「訳文の側」を渡す。** 原文のパスを渡すと `no-trans-pair` で何もせずに終わる
> （エラーにもならないので、渡し間違いは「なぜか翻訳されない」としか見えない）。

## 気をつけること（実装と食い違っていた点）

- **`mdait.term.detect.file` / `.directory` / `mdait.term.expand.file` / `.directory` は存在しない。**
  旧 `debug-ipc` スキルと `debug-command-handler.ts` の表に載っているが、どこにも登録されていない。
  実在するのは `mdait.term.detect` と `mdait.term.expand` の2つ。
- **`mdait.term.detect` は引数が `(units, transPair)`** で、パスや StatusItem を受け取らない。
  つまり IPC からは素直に叩けない。lab は headless のときだけ `detectTerm_CoreProc` を直接呼ぶ
  アダプタで代行する（手本は `src/lm-tools/term-tool.ts`）。実 Extension Host では使えない。
- **`mdait.term.expand` はフォルダしか受け付けない。** ファイルを渡すとエラートーストを出して即戻るが、
  IPC の結果は `status: done`・返り値なし・ログ0行なので、**効かない渡し方をしたことが呼び手に伝わらない**。
  用語集がバイト単位で変わっていないことで見分ける。
- CodeLens から呼ばれるコマンドは headless では動かない。`lab run` が実行前に知らせる。
  選択肢の一覧（QuickPick）を出すコマンドは、lab が先頭を選んで答えるので走る（答えたことは要約に出る）。

## 困ったとき

| 症状 | 原因 | 対処 |
|---|---|---|
| `ready` ができない | ホストが起動していない／拡張が activate していない | `lab status` で確認。code-server は mdait ビューを開くまで activate しない |
| `status` が `running` のまま | AI 利用の確認ダイアログ待ち | headless は自動で回避（`MDAIT_DEBUG_IPC`）。実ホストは画面で許可を押す |
| `status` が `running` のまま（長時間） | LLM の応答待ち | `lab ai stats` で受け皿に要求が届いているか見る |
| コマンドが見つからない | ID の綴り違い、または上記の「存在しないID」 | この一覧で確かめる |
