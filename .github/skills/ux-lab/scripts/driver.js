// mdait UX Lab: Playwright 操作ヘルパ。使い方は ../SKILL.md 参照。
// 依存 (playwright-core) は $MDAIT_UXLAB_DIR/node_modules から解決するため、
// このファイル自体はリポジトリの node_modules に依存しない。
const path = require("node:path");

const WORKDIR = process.env.MDAIT_UXLAB_DIR || "/tmp/mdait-uxlab";
const PORT = process.env.MDAIT_UXLAB_PORT || "8099";
// biome-ignore lint/style/useNodejsImportProtocol: WORKDIR 配下の外部パッケージを動的に解決する
const { chromium } = require(path.join(WORKDIR, "node_modules", "playwright-core"));

/**
 * code-server に接続し、mdait のUI操作に必要な下準備を済ませたセッションを返す。
 * - ワークスペース信頼ダイアログを承認
 * - code-server 独自の Chat 補助バーを閉じてスクリーンショットのノイズを減らす
 */
async function connect(opts = {}) {
  const workspace =
    opts.workspace || path.resolve(__dirname, "../../../../src/test/unit/workspace");
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: opts.viewport || { width: 1440, height: 900 },
  });
  await page.goto(`http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(workspace)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });

  try {
    const trust = page.locator(".dialog-buttons a", { hasText: /^Yes/i });
    await trust.waitFor({ timeout: 8000 });
    await trust.click();
  } catch {
    // 信頼済みならダイアログは出ない
  }

  try {
    const aux = page.locator(".part.auxiliarybar");
    if (await aux.isVisible({ timeout: 2000 })) {
      await page.keyboard.press("Control+Alt+B");
      await page.waitForTimeout(500);
    }
  } catch {
    // 補助バーが無ければ何もしない
  }

  /** スクリーンショットを $MDAIT_UXLAB_DIR/shots/<name>.png へ保存 */
  const shot = (name) =>
    page.screenshot({ path: path.join(WORKDIR, "shots", `${name}.png`) });

  /** アクティビティバーから mdait ビューを開く（拡張の activation を待つ） */
  const openMdait = async () => {
    const icon = page.locator('.activitybar .action-item a[aria-label*="mdait" i]');
    await icon.first().waitFor({ timeout: 60000 });
    await icon.first().click();
    await page.waitForTimeout(2000);
  };

  /** コマンドパレット経由でコマンドを実行（表示名で検索して先頭を実行） */
  const runCommand = async (query) => {
    await page.keyboard.press("F1");
    await page.waitForTimeout(500);
    await page.keyboard.type(query, { delay: 15 });
    await page.waitForTimeout(800);
    await page.keyboard.press("Enter");
  };

  /** ステータスツリーの行（.monaco-list-row）をテキストで探す */
  const treeRow = (text) =>
    page.locator(".part.sidebar .monaco-list-row", { hasText: text });

  return { browser, page, shot, openMdait, runCommand, treeRow, WORKDIR };
}

module.exports = { connect, WORKDIR, PORT };
