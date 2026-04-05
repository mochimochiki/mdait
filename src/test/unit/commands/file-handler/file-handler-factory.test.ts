import { strict as assert } from "node:assert";
import { getFileHandler } from "../../../../commands/file-handler/file-handler-factory";

suite("getFileHandler", () => {
	test(".md → MdFileHandler を返す", () => {
		const handler = getFileHandler("docs/readme.md");
		assert.equal(handler.fileType, "md");
	});

	test(".MD（大文字）→ MdFileHandler を返す", () => {
		const handler = getFileHandler("docs/README.MD");
		assert.equal(handler.fileType, "md");
	});

	test(".Md（大小文字混在）→ MdFileHandler を返す", () => {
		const handler = getFileHandler("docs/file.Md");
		assert.equal(handler.fileType, "md");
	});

	test(".txt → PlainFileHandler を返す", () => {
		const handler = getFileHandler("notes/file.txt");
		assert.equal(handler.fileType, "plain");
	});

	test(".csv → PlainFileHandler を返す", () => {
		const handler = getFileHandler("data/terms.csv");
		assert.equal(handler.fileType, "plain");
	});

	test(".tsv → PlainFileHandler を返す", () => {
		const handler = getFileHandler("data/terms.tsv");
		assert.equal(handler.fileType, "plain");
	});

	test("拡張子なし → PlainFileHandler を返す", () => {
		const handler = getFileHandler("Makefile");
		assert.equal(handler.fileType, "plain");
	});
});
