# ホスト3つの事情

「mdait をどこで走らせるか」の選択肢。**命令の書き方（`lab run`）はどれでも同じ**で、違うのは
何が本物で何が偽物か、設営にどれだけかかるか、である。

## headless（既定）

`out/` のコンパイル済みコマンド層を、vscode モック（`scripts/lab/vscode-shim.js`）越しに Node から直接叩く。
Extension Host は起動しない。

- **速い**（起動1秒未満）。クラウドでも動く。費用ゼロ。
- 常駐する。`lab up` が detached で起こし、`ready` ファイルができたら戻る。
- **UI が要るコマンドは動かない**（QuickPick を出すもの、CodeLens から呼ばれるもの）。
  `lab run` が実行前に知らせる。
- `fireTimeline` / `stateDiff` / `syncAnalysis` は入らない（ツリーの provider が構築されないため）。
- モックに無い vscode API に当たったら `scripts/lab/vscode-shim.js` を足す（`withProgress` /
  `commands` / `findFiles` の要領）。

**AI の初回利用ダイアログ**は `MDAIT_DEBUG_IPC=1` で回避している（GUI が無いので答えられない）。

## code-server（ブラウザ版 VS Code）

実 Extension Host が動く。**命令は IPC、画面は Playwright で撮る**という分担にする。

- 初回の設営に数分かかる。2回目以降は**vsix の再パッケージと再インストールだけ**なので、
  拡張のコードを直したら `lab up --host code-server` をやり直せば反映される。
- なぜブラウザ版か: クラウドのネットワークではデスクトップ版 VS Code の取得が 403 で塞がれている
  （`update.code.visualstudio.com` と GitHub Releases）。npm で配られる code-server なら通る。
  ブラウザはプリインストールの Chromium（`/opt/pw-browsers/chromium`）を使う。
- 設営で効かせている回避策（**消さないこと**）:
  - `npm install --ignore-scripts` — postinstall が GitHub から ripgrep を落とそうとして必ず失敗する
  - `@vscode/ripgrep` に環境内蔵の `rg` をコピーし、postinstall を無効化する
  - `npm rebuild` の前に `libkrb5-dev` を入れる（`apt-get update` を先に通さないと 404 になる）
- **IPC の有効化はファイルで行う**。ブラウザ版には環境変数を渡せないので、ワークスペースに
  `.mdait/debug/.ipc-enabled` を置く。`src/extension.ts` がこれを見て `DebugCommandHandler` を起こす。
- **拡張は mdait ビューを開くまで activate しない**。`lab up` はページを開いてビューを開き、
  `ready` ができるまで待ってから戻る。
- `vscode.lm` のプロバイダは無い。AI は shim（`--ai echo` など）を使う。
- 制約: 製品名やウェルカム画面など細部は公式版と違う。ただし拡張が使うワークベンチ UI
  （ツリー・CodeLens・QuickPick・通知・カスタムエディタ）は共通。

**落とし穴**（どれも実測で踏んだもの）:

- 起動をパイプ（`| head` など）に繋ぐとサーバーごと死ぬ。`pkill -f` で広く殺さない（自分のシェルまで巻き込む）。`lab down` を使う。
- **ブラウザのページを閉じると Extension Host ごと畳まれる。** IPC に返事が来なくなる。
  そのため `lab up` は「開いたままの常駐ページ」を裏で起こす。これがある限り、別のプロセスから
  `lab run` を投げても 0.4〜1.1 秒で返る。
- **画面を2つ開くと拡張も2つ動く。** 同じ `command.json` を奪い合ううえ、**片方を閉じると
  `ready` ファイルが消える**（拡張が終了時に自分で消すため）。画面は1つに保つ。見る操作は
  常駐ページに頼む形にしてある。
- **ボタン付きの通知や確認ダイアログは、誰かが答えるまでコマンドが終わらない。**
  実測: 対の無いファイルに `mdait.trans` を投げると `No translation pair found` の通知が出たまま
  17.5 秒止まり、通知を閉じた瞬間に `done`（`outcome: "no-trans-pair"`）になった。
  lab は headless と同じ約束で自動的に答える（下記）。

### 画面を撮る・触る

```bash
lab shot <名前>          # run ディレクトリの shots/<名前>.png に保存
```

撮った画像は Read ツールで開いて目視評価する。細かい操作は `scripts/lab/ui/driver.mjs` を使う。

- ツリーの行: `.part.sidebar .monaco-list-row`。ホバーでインラインアクションが出る
- 右クリック: `row.click({ button: "right" })`
- 通知トースト: `.notifications-toasts .notification-toast`／ダイアログ: `.monaco-dialog-box`
- **コマンドの実行に `runCommand`（コマンドパレットに文字を打つ）を使わない**。IPC のほうが確実で、
  結果 JSON と全ログまで取れる。QuickPick やマウス操作でしか起きないことを起こす時だけ使う。

翻訳中の見え方（回転アイコン、1件ずつ緑になる遷移）を撮りたいときは `--ai echo --delay 6000` のように
遅らせる。遅延が無いと一瞬で終わって撮れない。

## 確認ダイアログと通知への答え方（3ホスト共通）

画面が無い、あるいは誰も見ていないので、答えないと**コマンドが無言で中断する**（実測:
`mdait.translate.directory` は「このフォルダの全ファイルを翻訳しますか」で止まり、ログ0行・
返り値なしで終わっていた）。lab はこう振る舞う。

- **確認ダイアログ**: 主たる操作のボタンを押す。headless は API に渡された最初の項目、
  code-server は**画面上で `secondary` の印が付いていない方**を選ぶ。
  **並び順で選んではいけない** — 実測で `[No / Cancel / Yes]` と並ぶダイアログがあり、
  並び順だと "No" を押してしまう
- **選択肢の一覧（QuickPick）**: 先頭の選択肢を選ぶ。答えないと、選ばせてから始まる処理が丸ごと走らない
  （実測: `mdait.aiReview.file` は「未確認だけ / 全部」の一覧で止まり、**ログ0行・返り値なしで done** になっていた。
  呼び手からは成功と区別が付かない）
- **ボタン付きの通知**: 押さずに閉じる（`✨Translate now` のようなボタンを押すと別の仕事が始まる）
- **エラー通知のボタン**（「ログを開く」等）: 別の操作なので押さない
- **答えたことは必ず要約に出す**。`lab run` の出力に
  「### 出た確認ダイアログ（画面が無いので lab が代わりに答えた）」として並ぶ。黙って押さない
- 取り消し側を試したいときは `MDAIT_LAB_DIALOG=no`（どれにも答えない。**放置したことも控える**ので、
  何が立ちはだかったのかは後から分かる）
- **desktop だけは自動で答えられない**。本物の画面なので、そこに居る人が押す（押すまで `lab run` は
  返らない）。画面を見ていない場では headless か code-server を使う
- code-server の見張りは**命令が動いている最中だけ**手を出す。ふだんの目視評価で通知が勝手に
  消えないようにするため

## desktop（本物の VS Code）

手元の PC でのみ使える。`lab up --host desktop` が自分で起こす（人が F5 を押す必要はない）。

- やること: テストコンテンツの同期 → `npm run compile` → `npm run bundle:dev`
  （Extension Host は `dist/extension.js` を使うので必須）→ VS Code バイナリの解決 → 起動 → `ready` 待ち。
- バイナリは `@vscode/test-electron` のキャッシュを優先し、無ければシステムインストールを使う。
- **システムインストールと同じバージョンを避ける**。同バージョンだと mutex 競合で既存インスタンスへ
  要求が転送され、`MDAIT_DEBUG_IPC` が伝わらず ready にならない。保険として `.ipc-enabled` も置く。
- プロファイルは `mdait-debug`（AI 同意ダイアログが記憶される）。
- ここだけの価値: 実 `vscode.lm`（Copilot 経由の本物のモデル）、ネイティブ UI、ブレークポイント。

## 困ったとき

| 症状 | 原因 | 対処 |
|---|---|---|
| `ready` ができない | ホストが起動していない／拡張が activate していない | `lab status`。code-server はビューを開くまで activate しない |
| `status` が `running` のまま | AI 利用の確認ダイアログ待ち | 実ホストは画面で許可を押す（プロファイルが覚えるので初回だけ） |
| code-server がすぐ死ぬ | 出力をパイプに繋いだ／フォアグラウンドで起こした | `lab up` を使う（切り離して起こす） |
| desktop が ready にならない | システム版と同バージョンを起こした | 別バージョンを使う。`.ipc-enabled` が置かれているか確かめる |
| モックに無い API で落ちる（headless） | vscode モックの穴 | `scripts/lab/vscode-shim.js` に足す |

## 環境変数

| 名前 | 何を決めるか | 既定 |
|---|---|---|
| `MDAIT_LAB_DIR` | lab の作業場（セッション・run・ワークスペース・code-server 一式） | `/tmp/mdait-lab` |
| `MDAIT_LAB_PORT` | code-server の待ち受けポート | `8099` |
| `MDAIT_LAB_CHROMIUM` | Chromium の場所 | `/opt/pw-browsers/chromium` |
| `MDAIT_LAB_VSCODE` | desktop で使う VS Code のバイナリを指定する | 自動で探す |
| `MDAIT_LAB_DIALOG` | `no` にすると確認ダイアログに答えない（取り消し側を試す） | 答える |

**`MDAIT_LAB_DIR` を分ければ同時に使える。** セッションの記録は1つなので、分けずに2つ起こすと
奪い合う（実測で、片方のセッションがもう片方に上書きされた）。
