import { strict as assert } from "node:assert";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";

suite("MdaitMarker", () => {
	// 繰り返し使用する値を定義
	const testHash = "abcd1234";
	const testFrom = "efgh5678";

	test("コンストラクタでプロパティが正しく初期化される", () => {
		// 全てのパラメータを指定した場合
		const header1 = new MdaitMarker(testHash, testFrom, "translate");
		assert.equal(header1.hash, testHash);
		assert.equal(header1.from, testFrom);
		assert.equal(header1.need, "translate");

		// オプショナルパラメータを省略した場合
		const header2 = new MdaitMarker(testHash);
		assert.equal(header2.hash, testHash);
		assert.equal(header2.from, null);
		assert.equal(header2.need, null);

		// fromのみ指定した場合
		const header3 = new MdaitMarker(testHash, testFrom);
		assert.equal(header3.hash, testHash);
		assert.equal(header3.from, testFrom);
		assert.equal(header3.need, null);
	});
	test("toString: 正しいフォーマットの文字列が生成される", () => {
		const header1 = new MdaitMarker(testHash, testFrom, "translate");
		assert.equal(header1.toString(), `<!-- mdait ${testHash} from:${testFrom} need:translate -->`);

		// fromだけがある場合
		const header2 = new MdaitMarker(testHash, testFrom);
		assert.equal(header2.toString(), `<!-- mdait ${testHash} from:${testFrom} -->`);

		// 基本的なhashだけの場合
		const header3 = new MdaitMarker(testHash);
		assert.equal(header3.toString(), `<!-- mdait ${testHash} -->`);

		// needTagだけがある場合
		const header4 = new MdaitMarker(testHash, null, "review");
		assert.equal(header4.toString(), `<!-- mdait ${testHash} need:review -->`);

		// ハッシュが空文字列の場合
		const header5 = new MdaitMarker("");
		assert.equal(header5.toString(), "<!-- mdait -->");
	});
	test("parse: 正常なコメント文字列からオブジェクトが生成される", () => {
		// 全要素を含むコメント
		const comment1 = `<!-- mdait ${testHash} from:${testFrom} need:translate -->`;
		const header1 = MdaitMarker.parse(comment1);
		assert.ok(header1);
		assert.equal(header1.hash, testHash);
		assert.equal(header1.from, testFrom);
		assert.equal(header1.need, "translate");

		// fromだけのコメント
		const comment2 = `<!-- mdait ${testHash} from:${testFrom} -->`;
		const header2 = MdaitMarker.parse(comment2);
		assert.ok(header2);
		assert.equal(header2.hash, testHash);
		assert.equal(header2.from, testFrom);
		assert.equal(header2.need, null);

		// 基本的なhashだけのコメント
		const comment3 = `<!-- mdait ${testHash} -->`;
		const header3 = MdaitMarker.parse(comment3);
		assert.ok(header3);
		assert.equal(header3.hash, testHash);
		assert.equal(header3.from, null);
		assert.equal(header3.need, null);

		// needTagだけのコメント
		const comment4 = `<!-- mdait ${testHash} need:review -->`;
		const header4 = MdaitMarker.parse(comment4);
		assert.ok(header4);
		assert.equal(header4.hash, testHash);
		assert.equal(header4.from, null);
		assert.equal(header4.need, "review");
	});

	test("parse: ハッシュが省略されたマーカーは空文字列のハッシュを持つ", () => {
		// ハッシュが省略された場合
		const comment = "<!-- mdait -->";
		const header = MdaitMarker.parse(comment);
		assert.ok(header);
		assert.equal(header.hash, "");
		assert.equal(header.from, null);
		assert.equal(header.need, null);
	});

	test("parse: 不正なフォーマットの文字列からはnullが返される", () => {
		// 完全に異なるコメント
		assert.equal(MdaitMarker.parse("<!-- 通常のコメント -->"), null);

		// 空文字列
		assert.equal(MdaitMarker.parse(""), null);

		// mdait以外の単語
		assert.equal(MdaitMarker.parse("<!-- other -->"), null);
	});

	test("updateHash: ハッシュ値が正しく更新される", () => {
		const header = new MdaitMarker(testHash);
		const newHash = "newh1234";
		header.updateHash(newHash);
		assert.equal(header.hash, newHash);
	});
	test("removeNeedTag: needTagが適切に削除される", () => {
		const header = new MdaitMarker(testHash, testFrom, "translate");
		assert.equal(header.need, "translate");
		header.removeNeedTag();
		assert.equal(header.need, null);
	});

	test("needsTranslation: 翻訳が必要かどうかが正しく判定される", () => {
		// translate タグがある場合
		const header1 = new MdaitMarker(testHash, testFrom, "translate");
		assert.equal(header1.needsTranslation(), true);

		// タグがない場合
		const header3 = new MdaitMarker(testHash, testFrom);
		assert.equal(header3.needsTranslation(), false);

		// 別のタグがある場合
		const header4 = new MdaitMarker(testHash, testFrom, "other");
		assert.equal(header4.needsTranslation(), false);

		// revise@{hash}形式の場合もtrueを返す
		const header5 = new MdaitMarker(testHash, testFrom, "revise@abc12345");
		assert.equal(header5.needsTranslation(), true);
	});

	test("needsRevision: revise@{hash}形式を正しく判定する", () => {
		// revise形式
		const header1 = new MdaitMarker(testHash, testFrom, "revise@abc12345");
		assert.equal(header1.needsRevision(), true);

		// translate形式
		const header2 = new MdaitMarker(testHash, testFrom, "translate");
		assert.equal(header2.needsRevision(), false);

		// needなし
		const header3 = new MdaitMarker(testHash, testFrom);
		assert.equal(header3.needsRevision(), false);
	});

	test("getOldHashFromNeed: revise@{hash}からoldhashを抽出する", () => {
		// revise形式
		const header1 = new MdaitMarker(testHash, testFrom, "revise@abc12345");
		assert.equal(header1.getOldHashFromNeed(), "abc12345");

		// translate形式
		const header2 = new MdaitMarker(testHash, testFrom, "translate");
		assert.equal(header2.getOldHashFromNeed(), null);

		// needなし
		const header3 = new MdaitMarker(testHash, testFrom);
		assert.equal(header3.getOldHashFromNeed(), null);
	});

	test("setReviseNeed: need:revise@{oldhash}形式を設定する", () => {
		const header = new MdaitMarker(testHash, testFrom, "translate");
		header.setReviseNeed("abc12345");
		assert.equal(header.need, "revise@abc12345");
		assert.equal(header.needsRevision(), true);
		assert.equal(header.getOldHashFromNeed(), "abc12345");
	});

	test("parse: revise@{hash}形式を正しくパースする", () => {
		const comment = `<!-- mdait ${testHash} from:${testFrom} need:revise@abc12345 -->`;
		const header = MdaitMarker.parse(comment);
		assert.ok(header);
		assert.equal(header.hash, testHash);
		assert.equal(header.from, testFrom);
		assert.equal(header.need, "revise@abc12345");
		assert.equal(header.needsRevision(), true);
		assert.equal(header.getOldHashFromNeed(), "abc12345");
	});

	test("toString: revise@{hash}形式を正しく文字列化する", () => {
		const header = new MdaitMarker(testHash, testFrom, "revise@abc12345");
		assert.equal(header.toString(), `<!-- mdait ${testHash} from:${testFrom} need:revise@abc12345 -->`);
	});
	suite("hasUnconfirmedEdit（手で訳したが未確定か）", () => {
		test("sync直後の訳文（hash === from）は編集されていない", () => {
			assert.equal(new MdaitMarker("aaaa1111", "aaaa1111", "translate").hasUnconfirmedEdit(), false);
		});

		test("翻訳待ちのまま本文が書き換わっていれば編集済み", () => {
			assert.equal(new MdaitMarker("bbbb2222", "aaaa1111", "translate").hasUnconfirmedEdit(), true);
		});

		test("要改訂は判定対象外（ADR-260802-03）", () => {
			// need:revise@X の X は「旧原文のハッシュ」であって訳文ハッシュではない
			// （marker-sync.ts の setReviseNeed(oldSourceHash)）。別の名前空間の値なので比較しても
			// 意味がなく、訳文に一度も触れていないユニットまで「編集済み」になっていた。
			// 原文が変わったことは needsRevise() が表す
			assert.equal(new MdaitMarker("cccc3333", "dddd4444", "revise@cccc3333").hasUnconfirmedEdit(), false);
			assert.equal(new MdaitMarker("eeee5555", "dddd4444", "revise@cccc3333").hasUnconfirmedEdit(), false);
		});

		test("翻訳済み・裁定待ち・原文ユニットは対象外", () => {
			assert.equal(new MdaitMarker("bbbb2222", "aaaa1111", null).hasUnconfirmedEdit(), false);
			assert.equal(new MdaitMarker("bbbb2222", "aaaa1111", "review").hasUnconfirmedEdit(), false);
			assert.equal(new MdaitMarker("bbbb2222", "aaaa1111", "verify-deletion").hasUnconfirmedEdit(), false);
			assert.equal(new MdaitMarker("bbbb2222", "aaaa1111", "isolate").hasUnconfirmedEdit(), false);
			assert.equal(new MdaitMarker("aaaa1111", null, "translate").hasUnconfirmedEdit(), false);
		});

		test("hash が空なら判定しない", () => {
			assert.equal(new MdaitMarker("", "aaaa1111", "translate").hasUnconfirmedEdit(), false);
		});
	});
});
