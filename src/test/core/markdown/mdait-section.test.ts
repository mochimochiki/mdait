import { strict as assert } from "node:assert";
import { MdaitHeader } from "../../../core/markdown/mdait-header";
import { MdaitSection } from "../../../core/markdown/mdait-section";

suite("MdaitSection", () => {
	// 繰り返し使用する変数を準備
	const testHash = "abcd1234";
	const testSourceHash = "efgh5678";
	const testTitle = "テストタイトル";
	const testContent = "# テストタイトル\nテスト本文";

	test("コンストラクタでプロパティが正しく初期化される", () => {
		const header = new MdaitHeader(testHash, testSourceHash, "need");
		const section = new MdaitSection(header, testTitle, 1, testContent);

		assert.equal(section.mdaitHeader, header);
		assert.equal(section.title, testTitle);
		assert.equal(section.headingLevel, 1);
		assert.equal(section.content, testContent);
	});

	test("toString: mdaitヘッダーありの場合は正しい形式で出力される", () => {
		const header = new MdaitHeader(testHash, testSourceHash, "need");
		const section = new MdaitSection(header, testTitle, 1, testContent);

		// ヘッダー出力 + 改行 + コンテンツの形式になっていることを確認
		const expected = `${header.toString()}\n${testContent}`;
		assert.equal(section.toString(), expected);
	});

	test("toString: mdaitヘッダーがundefinedの場合はコンテンツのみ出力される", () => {
		// @ts-ignore - コードの実装に沿ってテストを書くため
		const section = new MdaitSection(undefined, testTitle, 1, testContent);

		assert.equal(section.toString(), testContent);
	});

	test("needsTranslation: ヘッダーがある場合はヘッダーの状態を反映する", () => {
		// need:translate のケース
		const headerNeedsTranslation = new MdaitHeader(
			testHash,
			testSourceHash,
			"translate",
		);
		const sectionNeedsTranslation = new MdaitSection(
			headerNeedsTranslation,
			testTitle,
			1,
			testContent,
		);
		assert.equal(sectionNeedsTranslation.needsTranslation(), true);

		// need:review のケース
		const headerNeedsReview = new MdaitHeader(
			testHash,
			testSourceHash,
			"review",
		);
		const sectionNeedsReview = new MdaitSection(
			headerNeedsReview,
			testTitle,
			1,
			testContent,
		);
		assert.equal(sectionNeedsReview.needsTranslation(), true);

		// need タグなしのケース
		const headerNoNeed = new MdaitHeader(testHash, testSourceHash, null);
		const sectionNoNeed = new MdaitSection(
			headerNoNeed,
			testTitle,
			1,
			testContent,
		);
		assert.equal(sectionNoNeed.needsTranslation(), false);
	});

	test("needsTranslation: ヘッダーがundefinedの場合は常にfalseを返す", () => {
		// @ts-ignore - コードの実装に沿ってテストを書くため
		const section = new MdaitSection(undefined, testTitle, 1, testContent);
		assert.equal(section.needsTranslation(), false);
	});

	test("getSourceHash: ヘッダーがある場合はsrcHashを返す", () => {
		const header = new MdaitHeader(testHash, testSourceHash, "need");
		const section = new MdaitSection(header, testTitle, 1, testContent);
		assert.equal(section.getSourceHash(), testSourceHash);
	});

	test("getSourceHash: ヘッダーがundefinedの場合はnullを返す", () => {
		// @ts-ignore - コードの実装に沿ってテストを書くため
		const section = new MdaitSection(undefined, testTitle, 1, testContent);
		assert.equal(section.getSourceHash(), null);
	});

	test("markAsTranslated: 正しくneedタグを削除する", () => {
		// 事前にneedタグが設定されたヘッダーを用意
		const header = new MdaitHeader(testHash, testSourceHash, "translate");
		const section = new MdaitSection(header, testTitle, 1, testContent);

		// 実行前の状態確認
		assert.equal(section.needsTranslation(), true);

		// 翻訳完了マークを設定
		section.markAsTranslated();

		// 実行後の状態確認
		assert.equal(section.needsTranslation(), false);
		assert.equal(header.needTag, null);
	});

	test("createEmptyTargetSection: 正しくターゲットセクションが作成される", () => {
		// ソースセクションを用意
		const header = new MdaitHeader(testHash);
		const source = new MdaitSection(header, testTitle, 2, testContent);

		// 新しいターゲットセクションを作成
		const target = MdaitSection.createEmptyTargetSection(
			source,
			testSourceHash,
		);

		// 生成されたセクションの検証
		assert.equal(target.title, source.title);
		assert.equal(target.headingLevel, source.headingLevel);
		assert.equal(target.content, source.content);
		assert.ok(target.mdaitHeader);
		assert.equal(target.mdaitHeader.srcHash, testSourceHash);
		assert.equal(target.mdaitHeader.needTag, "need");
	});
});
