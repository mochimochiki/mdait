import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFileSync } from "../../../../infra/workspace/atomic-write";

/** テスト用一時ディレクトリを作成 */
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "mdait-aw-"));
}

/** ディレクトリ内の .tmp- で始まるファイル一覧を取得 */
function listTmpFiles(dir: string): string[] {
	return fs.readdirSync(dir).filter((name) => name.startsWith(".tmp-"));
}

suite("atomicWriteFileSync", () => {
	let tempDir: string;

	setup(() => {
		tempDir = createTempDir();
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("新規ファイルを書き込めること", () => {
		const filePath = path.join(tempDir, "new.txt");
		atomicWriteFileSync(filePath, "hello", "utf-8");
		assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "hello");
	});

	test("既存ファイルを置換できること", () => {
		const filePath = path.join(tempDir, "exists.txt");
		fs.writeFileSync(filePath, "old", "utf-8");
		atomicWriteFileSync(filePath, "new content", "utf-8");
		assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "new content");
	});

	test("親ディレクトリが存在しない場合は作成されること", () => {
		const filePath = path.join(tempDir, "nested", "deep", "file.txt");
		atomicWriteFileSync(filePath, "nested", "utf-8");
		assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "nested");
	});

	test("成功後に一時ファイルが残らないこと", () => {
		const filePath = path.join(tempDir, "clean.txt");
		atomicWriteFileSync(filePath, "data", "utf-8");
		atomicWriteFileSync(filePath, "data2", "utf-8");
		assert.deepStrictEqual(listTmpFiles(tempDir), []);
	});

	test("BOM付きBufferを書き込めること", () => {
		const filePath = path.join(tempDir, "bom.csv");
		const bom = Buffer.from([0xef, 0xbb, 0xbf]);
		const content = Buffer.from("a,b,c", "utf8");
		atomicWriteFileSync(filePath, Buffer.concat([bom, content]));

		const written = fs.readFileSync(filePath);
		assert.deepStrictEqual(written.subarray(0, 3), bom);
		assert.strictEqual(written.subarray(3).toString("utf8"), "a,b,c");
	});

	test("rename失敗時に例外が伝播し一時ファイルが掃除されること", () => {
		// 宛先パスを空でないディレクトリにしてrenameを失敗させる
		const filePath = path.join(tempDir, "target");
		fs.mkdirSync(filePath);
		fs.writeFileSync(path.join(filePath, "blocker.txt"), "x", "utf-8");

		assert.throws(() => atomicWriteFileSync(filePath, "data", "utf-8"));
		assert.deepStrictEqual(listTmpFiles(tempDir), []);
	});

	test("既存ファイルのパーミッションが維持されること", function () {
		if (process.platform === "win32") {
			this.skip();
		}
		const filePath = path.join(tempDir, "perms.txt");
		fs.writeFileSync(filePath, "old", "utf-8");
		fs.chmodSync(filePath, 0o600);

		atomicWriteFileSync(filePath, "new", "utf-8");
		assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
	});

	test("EncodingオプションなしでもUTF-8文字列を書き込めること", () => {
		const filePath = path.join(tempDir, "default.txt");
		atomicWriteFileSync(filePath, "日本語テキスト");
		assert.strictEqual(fs.readFileSync(filePath, "utf-8"), "日本語テキスト");
	});
});
