import { strict as assert } from "node:assert";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../core/markdown/mdait-unit";

suite("MdaitSection", () => {
	// 繰り返し使用する変数を準備
	const testHash = "abcd1234";
	const testSourceHash = "efgh5678";
	const testTitle = "テストタイトル";
	const testContent = "# テストタイトル\nテスト本文";

	test("コンストラクタでプロパティが正しく初期化される", () => {
		const marker = new MdaitMarker(testHash, testSourceHash, "need");
		const section = new MdaitUnit(marker, testTitle, 1, testContent);

		assert.equal(section.marker, marker);
		assert.equal(section.title, testTitle);
		assert.equal(section.headingLevel, 1);
		assert.equal(section.content, testContent);
	});

	test("toString: mdaitヘッダーありの場合は正しい形式で出力される", () => {
		const marker = new MdaitMarker(testHash, testSourceHash, "need");
		const section = new MdaitUnit(marker, testTitle, 1, testContent);

		// ヘッダー出力 + 改行 + コンテンツの形式になっていることを確認
		const expected = `${marker.toString()}\n${testContent}\n`;
		assert.equal(section.toString(), expected);
	});

	test("toString: mdaitヘッダーがundefinedの場合はコンテンツのみ出力される", () => {
		// @ts-ignore - コードの実装に沿ってテストを書くため
		const section = new MdaitUnit(undefined, testTitle, 1, testContent);

		assert.equal(section.toString(), `${testContent}\n`);
	});

	test("needsTranslation: ヘッダーがある場合はヘッダーの状態を反映する", () => {
		// need:translate のケース
		const markerNeedsTranslation = new MdaitMarker(testHash, testSourceHash, "translate");
		const sectionNeedsTranslation = new MdaitUnit(markerNeedsTranslation, testTitle, 1, testContent);
		assert.equal(sectionNeedsTranslation.needsTranslation(), true);

		// need タグなしのケース
		const markerNoNeed = new MdaitMarker(testHash, testSourceHash, null);
		const sectionNoNeed = new MdaitUnit(markerNoNeed, testTitle, 1, testContent);
		assert.equal(sectionNoNeed.needsTranslation(), false);
	});

	test("needsTranslation: ヘッダーがundefinedの場合は常にfalseを返す", () => {
		// @ts-ignore - コードの実装に沿ってテストを書くため
		const section = new MdaitUnit(undefined, testTitle, 1, testContent);
		assert.equal(section.needsTranslation(), false);
	});
	test("getSourceHash: ヘッダーがある場合はfromを返す", () => {
		const marker = new MdaitMarker(testHash, testSourceHash, "need");
		const section = new MdaitUnit(marker, testTitle, 1, testContent);
		assert.equal(section.getSourceHash(), testSourceHash);
	});

	test("getSourceHash: ヘッダーがundefinedの場合はnullを返す", () => {
		// @ts-ignore - コードの実装に沿ってテストを書くため
		const section = new MdaitUnit(undefined, testTitle, 1, testContent);
		assert.equal(section.getSourceHash(), null);
	});

	test("markAsTranslated: 正しくneedタグを削除する", () => {
		// 事前にneedタグが設定されたヘッダーを用意
		const header = new MdaitMarker(testHash, testSourceHash, "translate");
		const section = new MdaitUnit(header, testTitle, 1, testContent);

		// 実行前の状態確認
		assert.equal(section.needsTranslation(), true);

		// 翻訳完了マークを設定
		section.markAsTranslated();

		// 実行後の状態確認
		assert.equal(section.needsTranslation(), false);
		assert.equal(header.need, null);
	});

	test("createEmptyTargetSection: 正しくターゲットユニットが作成される", () => {
		// ソースユニットを用意
		const header = new MdaitMarker(testHash);
		const source = new MdaitUnit(header, testTitle, 2, testContent);

		// 新しいターゲットユニットを作成
		const target = MdaitUnit.createEmptyTargetUnit(source, testSourceHash);

		// 生成されたユニットの検証
		assert.equal(target.title, source.title);
		assert.equal(target.headingLevel, source.headingLevel);
		assert.equal(target.content, source.content);
		assert.ok(target.marker);
		assert.equal(target.marker.from, testSourceHash);
		assert.equal(target.marker.need, "translate");
	});
});
