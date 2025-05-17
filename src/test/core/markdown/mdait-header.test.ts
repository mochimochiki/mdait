import { strict as assert } from "node:assert";
import { MdaitHeader } from "../../../core/markdown/mdait-header";

suite("MdaitHeader", () => {
	// 繰り返し使用する値を定義
	const testHash = "abcd1234";
	const testSrcHash = "efgh5678";

	test("コンストラクタでプロパティが正しく初期化される", () => {
		// 全てのパラメータを指定した場合
		const header1 = new MdaitHeader(testHash, testSrcHash, "translate");
		assert.equal(header1.hash, testHash);
		assert.equal(header1.srcHash, testSrcHash);
		assert.equal(header1.needTag, "translate");

		// オプショナルパラメータを省略した場合
		const header2 = new MdaitHeader(testHash);
		assert.equal(header2.hash, testHash);
		assert.equal(header2.srcHash, null);
		assert.equal(header2.needTag, null);

		// srcHashのみ指定した場合
		const header3 = new MdaitHeader(testHash, testSrcHash);
		assert.equal(header3.hash, testHash);
		assert.equal(header3.srcHash, testSrcHash);
		assert.equal(header3.needTag, null);
	});

	test("toString: 正しいフォーマットの文字列が生成される", () => {
		// 全てのパラメータがある場合
		const header1 = new MdaitHeader(testHash, testSrcHash, "translate");
		assert.equal(
			header1.toString(),
			`<!-- mdait ${testHash} src:${testSrcHash} need:translate -->`,
		);

		// srcHashだけがある場合
		const header2 = new MdaitHeader(testHash, testSrcHash);
		assert.equal(
			header2.toString(),
			`<!-- mdait ${testHash} src:${testSrcHash} -->`,
		);

		// 基本的なhashだけの場合
		const header3 = new MdaitHeader(testHash);
		assert.equal(header3.toString(), `<!-- mdait ${testHash} -->`);

		// needTagだけがある場合
		const header4 = new MdaitHeader(testHash, null, "review");
		assert.equal(header4.toString(), `<!-- mdait ${testHash} need:review -->`);
	});

	test("parse: 正常なコメント文字列からオブジェクトが生成される", () => {
		// 全要素を含むコメント
		const comment1 = `<!-- mdait ${testHash} src:${testSrcHash} need:translate -->`;
		const header1 = MdaitHeader.parse(comment1);
		assert.ok(header1);
		assert.equal(header1.hash, testHash);
		assert.equal(header1.srcHash, testSrcHash);
		assert.equal(header1.needTag, "translate");

		// srcHashだけのコメント
		const comment2 = `<!-- mdait ${testHash} src:${testSrcHash} -->`;
		const header2 = MdaitHeader.parse(comment2);
		assert.ok(header2);
		assert.equal(header2.hash, testHash);
		assert.equal(header2.srcHash, testSrcHash);
		assert.equal(header2.needTag, null);

		// 基本的なhashだけのコメント
		const comment3 = `<!-- mdait ${testHash} -->`;
		const header3 = MdaitHeader.parse(comment3);
		assert.ok(header3);
		assert.equal(header3.hash, testHash);
		assert.equal(header3.srcHash, null);
		assert.equal(header3.needTag, null);

		// needTagだけのコメント
		const comment4 = `<!-- mdait ${testHash} need:review -->`;
		const header4 = MdaitHeader.parse(comment4);
		assert.ok(header4);
		assert.equal(header4.hash, testHash);
		assert.equal(header4.srcHash, null);
		assert.equal(header4.needTag, "review");
	});

	test("parse: 不正なフォーマットの文字列からはnullが返される", () => {
		// 完全に異なるコメント
		assert.equal(MdaitHeader.parse("<!-- 通常のコメント -->"), null);

		// 一部だけmdaitに似ているがフォーマットが異なる
		assert.equal(MdaitHeader.parse("<!-- mdait invalid -->"), null);

		// 空文字列
		assert.equal(MdaitHeader.parse(""), null);

		// mdaitの後に正しいハッシュ形式がない
		assert.equal(MdaitHeader.parse("<!-- mdait -->"), null);
	});

	test("createWithTranslateTag: 適切なオブジェクトが生成される", () => {
		const header = MdaitHeader.createWithTranslateTag(testHash, testSrcHash);
		assert.equal(header.hash, testHash);
		assert.equal(header.srcHash, testSrcHash);
		assert.equal(header.needTag, "translate");
	});

	test("updateHash: ハッシュ値が正しく更新される", () => {
		const header = new MdaitHeader(testHash);
		const newHash = "newh1234";
		header.updateHash(newHash);
		assert.equal(header.hash, newHash);
	});

	test("removeNeedTag: needTagが適切に削除される", () => {
		const header = new MdaitHeader(testHash, testSrcHash, "translate");
		assert.equal(header.needTag, "translate");
		header.removeNeedTag();
		assert.equal(header.needTag, null);
	});

	test("needsTranslation: 翻訳が必要かどうかが正しく判定される", () => {
		// translate タグがある場合
		const header1 = new MdaitHeader(testHash, testSrcHash, "translate");
		assert.equal(header1.needsTranslation(), true);

		// review タグがある場合
		const header2 = new MdaitHeader(testHash, testSrcHash, "review");
		assert.equal(header2.needsTranslation(), true);

		// タグがない場合
		const header3 = new MdaitHeader(testHash, testSrcHash);
		assert.equal(header3.needsTranslation(), false);

		// 別のタグがある場合
		const header4 = new MdaitHeader(testHash, testSrcHash, "other");
		assert.equal(header4.needsTranslation(), false);
	});
});
