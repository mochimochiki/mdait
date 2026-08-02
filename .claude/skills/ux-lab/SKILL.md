---
name: ux-lab
description: "ブラウザ版 VS Code (code-server) + Playwright + Chromium で mdait 拡張のUIを実際に操作し、スクリーンショットで見た目・導線を評価するための環境構築と操作方法。Use when: reviewing UX/UI of the extension, visually verifying tree/CodeLens/dialog behavior, taking screenshots of the running extension in a sandboxed cloud environment."
---

# UX Lab — ブラウザ版 VS Code で mdait のUIを実際に操作・目視評価する

## 背景（なぜ code-server か）

クラウド実行環境のネットワークポリシーでは npm レジストリ等しか許可されておらず、
デスクトップ版 VS Code のダウンロード（update.code.visualstudio.com / GitHub Releases）は
403 でブロックされる。そのため **npm 配布の code-server（ブラウザ版 VS Code）** を使う。
ブラウザはプリインストールの Chromium（`/opt/pw-browsers/chromium`）を Playwright で操作する。

## 構築

```bash
bash .claude/skills/ux-lab/scripts/setup.sh
```

- 作業ディレクトリは `MDAIT_UXLAB_DIR`（既定 `/tmp/mdait-uxlab`）。
- 初回は code-server の取得とネイティブモジュールのビルドで数分かかる。2回目以降はスキップされ、
  **vsix の再パッケージと再インストールだけ** 行うので、拡張のコードを直したら setup.sh を再実行すればよい。
- 内部でやっていること（ネットワーク制約の回避）:
  - `--ignore-scripts` で npm インストール（postinstall が GitHub から ripgrep を落とそうとして失敗するため）
  - `@vscode/ripgrep` に環境内蔵の `rg` をコピーし、postinstall を無効化
  - `npm rebuild` でネイティブモジュールをビルド（kerberos 用に `libkrb5-dev` を apt で導入）

## 起動

```bash
bash .claude/skills/ux-lab/scripts/start.sh [ワークスペースパス]
```

- 既定ワークスペースは `src/test/unit/workspace`（`npm run copy-test-files` でリセット可能）。
- `http://127.0.0.1:8099/?folder=<ワークスペース>` で待ち受ける（ポートは `MDAIT_UXLAB_PORT`）。
- サーバーログ: `$MDAIT_UXLAB_DIR/cs.log`
- **注意**: エージェントの Bash から起動する場合、フォアグラウンドのコマンド終了と共に
  デーモンが殺されることがある。`run_in_background` で起動するか、start.sh（nohup 使用）を
  サンドボックス無効で実行すると安定する。パイプ（`| head` 等）に繋ぐとサーバーごと死ぬので繋がない。

## 操作とスクリーンショット

`scripts/driver.js` に Playwright ヘルパがある。使用例:

```js
const { connect } = require('/path/to/repo/.claude/skills/ux-lab/scripts/driver');
(async () => {
  const s = await connect();          // 信頼ダイアログの承認・Chatパネルの退避まで自動
  await s.openMdait();                // アクティビティバーの mdait ビューを開く
  await s.shot('mdait-view');         // $MDAIT_UXLAB_DIR/shots/mdait-view.png に保存
  await s.runCommand('mdait: Diagnose');  // コマンドパレット経由の実行
  await s.page.waitForTimeout(3000);
  await s.shot('after-diagnose');
  await s.browser.close();
})();
```

- 撮ったスクリーンショットは Read ツールで画像として読み、目視評価する。
- ツリー行は `.part.sidebar .monaco-list-row` で取れる。行のホバーでインラインアクションが出る。
- 右クリック（コンテキストメニュー）は `row.click({ button: 'right' })`。
- 通知トーストは `.notifications-toasts .notification-toast`、ダイアログは `.monaco-dialog-box`。

## AI を使う機能を最後まで動かす（偽 Ollama）

code-server には `vscode.lm` のプロバイダが無く、外部 API もネットワークポリシーで塞がれている。
ただし mdait の Ollama プロバイダは接続先を設定で変えられるので、**ローカルに偽の Ollama を立てれば
翻訳・term・tm・aiReview を最後まで実行できる**。翻訳中のツリーの見え方（回転アイコンの粒度や
1件ずつ緑になる遷移）は、これが無いと目視できない。

```bash
# 応答をわざと遅らせる（既定 6 秒/リクエスト）。進行中の状態を撮る余裕を作るため
node .claude/skills/ux-lab/scripts/fake-ollama.js &
```

ワークスペースの `.mdait/mdait.json` を向ける（**リポジトリ管理下なので検証後に `git checkout` で戻す**）:

```json
"ai": { "provider": "ollama",
        "ollama": { "endpoint": "http://127.0.0.1:11434", "model": "fake:latest" } }
```

- 応答本文は `response-validator.ts` が期待する JSON（`{"translation": "..."}`）を返す。
- 遅延は `FAKE_OLLAMA_DELAY_MS`、ポートは `FAKE_OLLAMA_PORT` で変えられる。
- 翻訳待ちユニットは `mdait: Sync` で作る（sample-content には訳文の無い原文が多数ある）。
- 初回実行時に AI 利用の確認ダイアログ（`Proceed`）が出るので、Playwright 側で承認すること。

## 制約（できないこと）

- **`vscode.lm` 経由のプロバイダは使えない**（上記の偽 Ollama で代替する）。
- code-server は製品名やウェルカム画面など細部が公式版と異なるが、拡張が使うワークベンチUI
  （ツリー・CodeLens・QuickPick・通知・カスタムエディタ）は共通。

## リセット

- ワークスペースの内容: `npm run copy-test-files`
- 拡張・ユーザデータ: setup.sh 再実行（`cs-ext` / `cs-data` を作り直し、信頼状態もリセットされる）
- 全部やり直し: `rm -rf "$MDAIT_UXLAB_DIR"` → setup.sh
