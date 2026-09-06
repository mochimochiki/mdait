/**
 * `.mdait` の初期化（ensureMdaitDir）のテスト。
 *
 * ここが持つ約束は「足りない行を書き足す」ことである。ファイルが無いときだけ作る作りだと、
 * **既にある作業場には新しい指定が永久に届かない**。`unit-registry merge=union` は
 * それではまるで意味が無い — 控えを一度でも取り込んだ作業場にこそ要る指定だからである。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Configuration } from "../../../../infra/config/configuration";
import { ensureMdaitDir } from "../../../../infra/workspace/mdait-dir";

declare let __vscodeMockWorkspaceRoot: string;

suite(".mdait の初期化", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-dir-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const read = (name: string): string => fs.readFileSync(path.join(tempDir, ".mdait", name), "utf-8");

	test("何も無いところに .gitignore と .gitattributes を作る", async () => {
		await ensureMdaitDir();

		assert.match(read(".gitignore"), /^logs\/$/m);
		assert.match(read(".gitignore"), /^unit-registry\.broken$/m);
		assert.match(read(".gitattributes"), /^unit-state merge=union$/m);
		assert.match(read(".gitattributes"), /^unit-registry merge=union$/m);
	});

	test("既にあるファイルにも、足りない行だけを書き足す", async () => {
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".mdait", ".gitattributes"), "unit-state merge=union\n", "utf-8");

		await ensureMdaitDir();

		const attributes = read(".gitattributes");
		assert.match(attributes, /^unit-registry merge=union$/m);
		assert.equal(attributes.match(/^unit-state merge=union$/gm)?.length, 1, "既にある行が二重になっている");
	});

	test("末尾に改行が無いファイルでも、行が繋がってしまわない", async () => {
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".mdait", ".gitignore"), "logs/", "utf-8");

		await ensureMdaitDir();

		assert.match(read(".gitignore"), /^logs\/$/m);
		assert.match(read(".gitignore"), /^unit-registry\.broken$/m);
	});

	test("CRLF のファイルには CRLF で書き足す（改行を混ぜない）", async () => {
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".mdait", ".gitattributes"), "unit-state merge=union\r\n", "utf-8");

		await ensureMdaitDir();

		const attributes = read(".gitattributes");
		assert.ok(attributes.includes("unit-registry merge=union"));
		assert.doesNotMatch(attributes, /[^\r]\n/, "CRLF のファイルに LF が混ざっている");
	});

	test("利用者が書き換えた指定は上書きしない", async () => {
		fs.mkdirSync(path.join(tempDir, ".mdait"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, ".mdait", ".gitattributes"), "unit-state merge=ours\n", "utf-8");

		await ensureMdaitDir();

		const attributes = read(".gitattributes");
		assert.match(attributes, /^unit-state merge=ours$/m);
		assert.doesNotMatch(attributes, /^unit-state merge=union$/m);
	});

	test("2度呼んでも中身は変わらない", async () => {
		await ensureMdaitDir();
		const first = read(".gitattributes");
		await ensureMdaitDir();

		assert.equal(read(".gitattributes"), first);
	});
});
