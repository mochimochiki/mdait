import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withSvnResolveHint } from "../../../../commands/conflict/svn-hint";
import { isSubversionWorkingCopy } from "../../../../core/conflict/subversion";

suite("isSubversionWorkingCopy（作業場が Subversion の作業コピーか）", () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-svn-"));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("作業コピーの根にある .svn を、深い階層からたどって見つけること", () => {
		fs.mkdirSync(path.join(root, ".svn"));
		const deep = path.join(root, "docs", ".mdait");
		fs.mkdirSync(deep, { recursive: true });
		assert.strictEqual(isSubversionWorkingCopy(deep), true);
	});

	test(".svn が無ければ作業コピーとみなさないこと", () => {
		const deep = path.join(root, "docs", ".mdait");
		fs.mkdirSync(deep, { recursive: true });
		assert.strictEqual(isSubversionWorkingCopy(deep), false);
	});

	test(".svn という名前のファイルは作業コピーの印とみなさないこと", () => {
		fs.writeFileSync(path.join(root, ".svn"), "");
		assert.strictEqual(isSubversionWorkingCopy(root), false);
	});
});

suite("withSvnResolveHint（競合を解き終えた文言に SVN の一手を添える）", () => {
	let root: string;

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-svn-hint-"));
		fs.mkdirSync(path.join(root, ".mdait"));
	});

	teardown(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("一括の解決では、その .mdait を絶対パスで再帰に解決済みにするコマンドを添えること", () => {
		// `.mdait` は作業コピーの根にあるとは限らない（ここでは docs の下）
		fs.mkdirSync(path.join(root, ".svn"));
		const mdaitDir = path.join(root, "docs", ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		const message = withSvnResolveHint("解決しました。", path.join(mdaitDir, "unit-state"), "mdait-dir");
		assert.ok(message.startsWith("解決しました。"), message);
		// `-R` が無いと、--accept の既定の深さ empty で何も解決されない（svn 1.14 で実測）
		assert.ok(message.includes(`svn resolve --accept working -R "${mdaitDir}"`), message);
	});

	test("手動の解決では、解いたファイルだけを解決済みにするコマンドを添えること", () => {
		// ほかのファイルに競合が残っていることがあるので、.mdait 丸ごとは案内しない
		fs.mkdirSync(path.join(root, ".svn"));
		const file = path.join(root, ".mdait", "translations.tmx");
		const message = withSvnResolveHint("解決しました。", file, "file");
		assert.ok(message.includes(`svn resolve --accept working "${file}"`), message);
		assert.ok(!message.includes("-R"), message);
	});

	test("SVN の作業コピーでなければ、文言をそのまま返すこと", () => {
		const message = withSvnResolveHint("解決しました。", path.join(root, ".mdait", "unit-state"), "mdait-dir");
		assert.strictEqual(message, "解決しました。");
	});
});
