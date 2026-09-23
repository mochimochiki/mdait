/**
 * `.mdait` の初期化（ensureMdaitDir）のテスト。
 *
 * `.gitignore` が持つ約束は「足りない行を書き足す」ことである。ファイルが無いときだけ
 * 作る作りだと、**既にある作業場には新しい指定が永久に届かない**。
 *
 * `.gitattributes` が持つ約束は逆で、「mdait が書いた `merge=union` を外す」ことである
 * （ADR-260911-01）。union は SVN に無く、効いた先では黙って片方を捨てていた。
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

	const mdaitPath = (name: string): string => path.join(tempDir, ".mdait", name);
	const read = (name: string): string => fs.readFileSync(mdaitPath(name), "utf-8");
	const write = (name: string, content: string): void => {
		fs.mkdirSync(path.dirname(mdaitPath(name)), { recursive: true });
		fs.writeFileSync(mdaitPath(name), content, "utf-8");
	};

	test("何も無いところに .gitignore を作る（コミットしないものは local/ の1行で足りる）", async () => {
		await ensureMdaitDir();

		assert.equal(read(".gitignore"), "local/\n");
	});

	test(".gitattributes は作らない", async () => {
		await ensureMdaitDir();

		assert.equal(fs.existsSync(mdaitPath(".gitattributes")), false);
	});

	test("既にある .gitignore にも、足りない行だけを書き足す（旧い行は消さない）", async () => {
		write(".gitignore", "logs/\nlocal/\n");

		await ensureMdaitDir();

		const ignore = read(".gitignore");
		assert.equal(ignore.match(/^local\/$/gm)?.length, 1, "既にある行が二重になっている");
		assert.match(ignore, /^logs\/$/m, "利用者のファイルの旧い行は残す");
	});

	test("末尾に改行が無いファイルでも、行が繋がってしまわない", async () => {
		write(".gitignore", "logs/");

		await ensureMdaitDir();

		assert.match(read(".gitignore"), /^logs\/$/m);
		assert.match(read(".gitignore"), /^local\/$/m);
	});

	test("CRLF のファイルには CRLF で書き足す（改行を混ぜない）", async () => {
		write(".gitignore", "logs/\r\n");

		await ensureMdaitDir();

		assert.ok(read(".gitignore").includes("local/"));
		assert.doesNotMatch(read(".gitignore"), /[^\r]\n/, "CRLF のファイルに LF が混ざっている");
	});

	test("旧い場所（.mdait 直下）のログ・レポート・避難先を local/ へ移す", async () => {
		write("logs/ai-stats.log", "stats");
		write("reports/sync.md", "report");
		write("unit-state.broken", "broken");

		await ensureMdaitDir();

		assert.equal(read("local/logs/ai-stats.log"), "stats");
		assert.equal(read("local/reports/sync.md"), "report");
		assert.equal(read("local/unit-state.broken"), "broken");
		assert.equal(fs.existsSync(mdaitPath("logs")), false);
		assert.equal(fs.existsSync(mdaitPath("unit-state.broken")), false);
	});

	test("移し先に既にあるものは上書きしない（避難先は最初の事故の姿を残す）", async () => {
		write("unit-state.broken", "second");
		write("local/unit-state.broken", "first");

		await ensureMdaitDir();

		assert.equal(read("local/unit-state.broken"), "first");
		assert.equal(read("unit-state.broken"), "second", "移せなかったものは元の場所に残す");
	});

	test("2度呼んでも中身は変わらない", async () => {
		await ensureMdaitDir();
		const first = read(".gitignore");
		await ensureMdaitDir();

		assert.equal(read(".gitignore"), first);
	});

	suite("既にある .gitattributes から merge=union を外す", () => {
		test("mdait が書いた4行だけの .gitattributes は、ファイルごと消える", async () => {
			write(
				".gitattributes",
				"unit-state merge=union\nunit-registry merge=union\ntranslations.tmx merge=union\nterms.csv merge=union\n",
			);

			await ensureMdaitDir();

			assert.equal(fs.existsSync(mdaitPath(".gitattributes")), false);
		});

		test("他人が書いた行は残る", async () => {
			write(".gitattributes", "unit-state merge=union\n*.md text eol=lf\nglossary.json binary\n");

			await ensureMdaitDir();

			const attributes = read(".gitattributes");
			assert.doesNotMatch(attributes, /merge=union/);
			assert.match(attributes, /^\*\.md text eol=lf$/m);
			assert.match(attributes, /^glossary\.json binary$/m);
		});

		test("同じ行に並んだ他の指定は残し、merge=union だけを外す", async () => {
			write(".gitattributes", "unit-state merge=union eol=lf\n");

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "unit-state eol=lf\n");
		});

		test("union 以外の指定（利用者が書き換えたもの）には触らない", async () => {
			write(".gitattributes", "unit-state merge=ours\n");

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "unit-state merge=ours\n");
		});

		test("対象外のパスの merge=union は外さない", async () => {
			write(".gitattributes", "CHANGELOG.md merge=union\n");

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "CHANGELOG.md merge=union\n");
		});

		test("用語集の名前を変えている作業場でも、その名前の行が外れる", async () => {
			write("mdait.json", JSON.stringify({ terms: { filename: "glossary.yaml" } }));
			write(".gitattributes", "glossary.yaml merge=union\nterms.csv merge=union\n");
			await Configuration.getInstance().initialize();

			await ensureMdaitDir();

			assert.equal(fs.existsSync(mdaitPath(".gitattributes")), false);
		});

		test("外すものが無ければ1バイトも書かない", async () => {
			write(".gitattributes", "*.md text\n");
			const before = fs.statSync(mdaitPath(".gitattributes")).mtimeMs;

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "*.md text\n");
			assert.equal(fs.statSync(mdaitPath(".gitattributes")).mtimeMs, before);
		});

		test("CRLF のファイルは CRLF のまま書き戻す", async () => {
			write(".gitattributes", "unit-state merge=union\r\n*.md text\r\n");

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "*.md text\r\n");
		});

		test("末尾に改行が無いファイルは、無いまま書き戻す", async () => {
			write(".gitattributes", "unit-state merge=union\n*.md text");

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "*.md text");
		});

		test("他人が書いた空行は動かさない", async () => {
			write(".gitattributes", "unit-state merge=union\n\n*.md text\n\n");

			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), "\n*.md text\n\n");
		});

		test("空行しか残らなければ、ファイルごと消える", async () => {
			write(".gitattributes", "\nunit-state merge=union\n\n");

			await ensureMdaitDir();

			assert.equal(fs.existsSync(mdaitPath(".gitattributes")), false);
		});

		test("2度呼んでも中身は変わらない", async () => {
			write(".gitattributes", "unit-state merge=union\n*.md text\n");

			await ensureMdaitDir();
			const first = read(".gitattributes");
			await ensureMdaitDir();

			assert.equal(read(".gitattributes"), first);
		});
	});
});
