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

	test("SVN の作業コピーでは、.mdait を再帰で解決済みにするコマンドを添えること", () => {
		fs.mkdirSync(path.join(root, ".svn"));
		const message = withSvnResolveHint("解決しました。", path.join(root, ".mdait", "unit-state"));
		assert.ok(message.startsWith("解決しました。"), message);
		// `-R .mdait` が無いと、--accept の既定の深さ empty で何も解決されない（svn 1.14 で実測）
		assert.ok(message.includes("svn resolve --accept working -R .mdait"), message);
	});

	test("SVN の作業コピーでなければ、文言をそのまま返すこと", () => {
		const message = withSvnResolveHint("解決しました。", path.join(root, ".mdait", "unit-state"));
		assert.strictEqual(message, "解決しました。");
	});
});
