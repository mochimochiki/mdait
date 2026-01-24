// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../core/markdown/front-matter";
import {
	FRONTMATTER_MARKER_KEY,
	calculateFrontmatterHash,
	getFrontmatterTranslationValues,
	parseFrontmatterMarker,
	serializeFrontmatterMarker,
	setFrontmatterMarker,
} from "../../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";

suite("FrontMatter翻訳ユーティリティ", () => {
	suite("getFrontmatterTranslationValues", () => {
		test("文字列キーのみを翻訳対象として抽出できること", () => {
			const frontMatter = FrontMatter.fromData({
				title: "Hello",
				description: "World",
				count: 3,
				flag: true,
			});

			const values = getFrontmatterTranslationValues(frontMatter, ["title", "description", "count", "flag"]);
			assert.deepStrictEqual(values, {
				title: "Hello",
				description: "World",
			});
		});

		test("undefinedのfrontmatterでは空オブジェクトを返すこと", () => {
			const values = getFrontmatterTranslationValues(undefined, ["title"]);
			assert.deepStrictEqual(values, {});
		});

		test("存在しないキーを指定しても結果に含まれないこと", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			const values = getFrontmatterTranslationValues(frontMatter, ["title", "notExist"]);
			assert.deepStrictEqual(values, { title: "Hello" });
		});
	});

	suite("calculateFrontmatterHash", () => {
		test("文字列キーでハッシュ計算し、非文字列のみの場合はnullになること", () => {
			const frontMatter = FrontMatter.fromData({
				title: "Hello",
				description: "World",
				tags: ["a", "b"],
			});

			const hash = calculateFrontmatterHash(frontMatter, ["title", "description"]);
			assert.ok(hash);

			const emptyHash = calculateFrontmatterHash(frontMatter, ["tags"]);
			assert.strictEqual(emptyHash, null);
		});

		test("undefinedのfrontmatterではnullを返すこと", () => {
			const hash = calculateFrontmatterHash(undefined, ["title"]);
			assert.strictEqual(hash, null);
		});

		test("空のkeysではnullを返すこと", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			const hash = calculateFrontmatterHash(frontMatter, []);
			assert.strictEqual(hash, null);
		});

		test("allowEmpty: trueなら空値でもハッシュを計算すること", () => {
			const frontMatter = FrontMatter.fromData({ title: "" });
			const hashWithoutOption = calculateFrontmatterHash(frontMatter, ["title"]);
			assert.strictEqual(hashWithoutOption, null);

			const hashWithOption = calculateFrontmatterHash(frontMatter, ["title"], { allowEmpty: true });
			assert.ok(hashWithOption);
		});

		test("同一コンテンツは同じハッシュになること", () => {
			const fm1 = FrontMatter.fromData({ title: "Hello", description: "World" });
			const fm2 = FrontMatter.fromData({ title: "Hello", description: "World" });
			const hash1 = calculateFrontmatterHash(fm1, ["title", "description"]);
			const hash2 = calculateFrontmatterHash(fm2, ["title", "description"]);
			assert.strictEqual(hash1, hash2);
		});
	});

	suite("parseFrontmatterMarker / serializeFrontmatterMarker", () => {
		test("frontmatterマーカーのparse/serializeが一致すること", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			frontMatter.set("mdait.front", "abc12345 from:def67890 need:translate");

			const marker = parseFrontmatterMarker(frontMatter);
			assert.ok(marker);
			assert.strictEqual(marker?.hash, "abc12345");
			assert.strictEqual(marker?.from, "def67890");
			assert.strictEqual(marker?.need, "translate");

			const serialized = serializeFrontmatterMarker(marker);
			assert.strictEqual(serialized, "abc12345 from:def67890 need:translate");
		});

		test("undefinedのfrontmatterではnullを返すこと", () => {
			const marker = parseFrontmatterMarker(undefined);
			assert.strictEqual(marker, null);
		});

		test("マーカーキーが空文字の場合はnullを返すこと", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			frontMatter.set(FRONTMATTER_MARKER_KEY, "   ");
			const marker = parseFrontmatterMarker(frontMatter);
			assert.strictEqual(marker, null);
		});

		test("hashのみのマーカーもパースできること", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			frontMatter.set(FRONTMATTER_MARKER_KEY, "abc12345");
			const marker = parseFrontmatterMarker(frontMatter);
			assert.ok(marker);
			assert.strictEqual(marker?.hash, "abc12345");
			assert.strictEqual(marker?.from, null);
			assert.strictEqual(marker?.need, null);
		});

		test("revise形式のneedもパースできること", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			frontMatter.set(FRONTMATTER_MARKER_KEY, "abc12345 from:def67890 need:revise@old12345");
			const marker = parseFrontmatterMarker(frontMatter);
			assert.ok(marker);
			assert.strictEqual(marker?.need, "revise@old12345");
		});
	});

	suite("setFrontmatterMarker", () => {
		test("マーカーを設定できること", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			const marker = new MdaitMarker("abc12345", "def67890", "translate");
			setFrontmatterMarker(frontMatter, marker);

			assert.strictEqual(frontMatter.get(FRONTMATTER_MARKER_KEY), "abc12345 from:def67890 need:translate");
		});

		test("nullを設定すると既存マーカーが削除されること", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			frontMatter.set(FRONTMATTER_MARKER_KEY, "abc12345");
			setFrontmatterMarker(frontMatter, null);

			assert.strictEqual(frontMatter.has(FRONTMATTER_MARKER_KEY), false);
		});

		test("hashがないマーカーを設定すると既存マーカーが削除されること", () => {
			const frontMatter = FrontMatter.fromData({ title: "Hello" });
			frontMatter.set(FRONTMATTER_MARKER_KEY, "abc12345");
			const emptyMarker = new MdaitMarker("");
			setFrontmatterMarker(frontMatter, emptyMarker);

			assert.strictEqual(frontMatter.has(FRONTMATTER_MARKER_KEY), false);
		});
	});
});
