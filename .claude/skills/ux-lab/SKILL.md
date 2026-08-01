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

## 制約（できないこと）

- **AI 実行は不可**: code-server（Code OSS）には `vscode.lm` API のプロバイダが無く、外部 API も
  ネットワークポリシーで塞がれている。翻訳・term・tm・aiReview・adopt は「確認UI → 実行 →
  エラー通知」までの UX 確認に使う（それはそれで価値がある）。決定的な機能（sync・validate・
  ツリー・CodeLens・設定エディタ・レポート表示）は最後まで動く。
- code-server は製品名やウェルカム画面など細部が公式版と異なるが、拡張が使うワークベンチUI
  （ツリー・CodeLens・QuickPick・通知・カスタムエディタ）は共通。

## リセット

- ワークスペースの内容: `npm run copy-test-files`
- 拡張・ユーザデータ: setup.sh 再実行（`cs-ext` / `cs-data` を作り直し、信頼状態もリセットされる）
- 全部やり直し: `rm -rf "$MDAIT_UXLAB_DIR"` → setup.sh
