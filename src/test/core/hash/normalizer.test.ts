import { strict as assert } from "node:assert";
import { TextNormalizer, normalizeText } from "../../../core/hash/normalizer";

suite("TextNormalizer クラスのテスト", () => {
	test("デフォルトオプションで全ての正規化処理が適用される", () => {
		const normalizer = new TextNormalizer();
		const input = "  テスト\r\n  テキスト  ";
		const expected = "テスト\nテキスト";
		assert.equal(normalizer.normalize(input), expected);
	});

	test("trim オプションが false の場合は前後の空白が残る", () => {
		const normalizer = new TextNormalizer({ trim: false });
		const input = "  テスト  ";
		assert.equal(normalizer.normalize(input), " テスト ");
	});

	test("collapseSpaces オプションが false の場合は連続空白が統合されない", () => {
		const normalizer = new TextNormalizer({ collapseSpaces: false });
		const input = "テスト  テキスト";
		assert.equal(normalizer.normalize(input), "テスト  テキスト");
	});

	test("collapseSpaces オプションが false の場合はタブ文字が空白に変換されない", () => {
		const normalizer = new TextNormalizer({ collapseSpaces: false });
		const input = "テスト\tテキスト";
		assert.equal(normalizer.normalize(input), "テスト\tテキスト");
	});

	test("normalizeNewlines オプションが false の場合はCRLFがLFに変換されない", () => {
		const normalizer = new TextNormalizer({ normalizeNewlines: false });
		const input = "テスト\r\nテキスト";
		assert.equal(normalizer.normalize(input), "テスト\r\nテキスト");
	});

	test("複数のオプションを同時に無効化できる", () => {
		const normalizer = new TextNormalizer({
			trim: false,
			collapseSpaces: false,
			normalizeNewlines: false,
		});
		const input = "  テスト\r\n  テキスト  ";
		assert.equal(normalizer.normalize(input), "  テスト\r\n  テキスト  ");
	});

	test("空の文字列を正規化するとそのまま空文字列が返される", () => {
		const normalizer = new TextNormalizer();
		assert.equal(normalizer.normalize(""), "");
	});

	test("空白のみの文字列を正規化すると空文字列が返される", () => {
		const normalizer = new TextNormalizer();
		assert.equal(normalizer.normalize("   \t  \n  "), "");
	});

	test("normalizeText 関数は常にデフォルトオプションで正規化する", () => {
		const input = "  テスト\r\n  テキスト  ";
		const expected = "テスト\nテキスト";
		assert.equal(normalizeText(input), expected);
	});
});
