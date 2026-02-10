import { strict as assert } from "node:assert";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";

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
		// 全てのパラメータがある場合
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

	test("コンストラクタ: fixedパラメータが正しく初期化される", () => {
		// fixedをtrueで初期化
		const header1 = new MdaitMarker(testHash, testFrom, null, true);
		assert.equal(header1.fixed, true);

		// fixedを明示的にfalseで初期化
		const header2 = new MdaitMarker(testHash, testFrom, null, false);
		assert.equal(header2.fixed, false);

		// fixedを省略（デフォルトfalse）
		const header3 = new MdaitMarker(testHash);
		assert.equal(header3.fixed, false);
	});

	test("toString: fixedフラグありの文字列が正しく生成される", () => {
		// fixedのみ
		const header1 = new MdaitMarker(testHash, null, null, true);
		assert.equal(header1.toString(), `<!-- mdait ${testHash} fixed -->`);

		// from + fixed
		const header2 = new MdaitMarker(testHash, testFrom, null, true);
		assert.equal(header2.toString(), `<!-- mdait ${testHash} from:${testFrom} fixed -->`);

		// need + fixed
		const header3 = new MdaitMarker(testHash, null, "translate", true);
		assert.equal(header3.toString(), `<!-- mdait ${testHash} need:translate fixed -->`);

		// from + need + fixed
		const header4 = new MdaitMarker(testHash, testFrom, "translate", true);
		assert.equal(header4.toString(), `<!-- mdait ${testHash} from:${testFrom} need:translate fixed -->`);
	});

	test("parse: fixedフラグありのマーカーを正しくパースする", () => {
		// fixedのみ
		const comment1 = `<!-- mdait ${testHash} fixed -->`;
		const header1 = MdaitMarker.parse(comment1);
		assert.ok(header1);
		assert.equal(header1.hash, testHash);
		assert.equal(header1.from, null);
		assert.equal(header1.need, null);
		assert.equal(header1.fixed, true);

		// from + fixed
		const comment2 = `<!-- mdait ${testHash} from:${testFrom} fixed -->`;
		const header2 = MdaitMarker.parse(comment2);
		assert.ok(header2);
		assert.equal(header2.hash, testHash);
		assert.equal(header2.from, testFrom);
		assert.equal(header2.need, null);
		assert.equal(header2.fixed, true);

		// need + fixed
		const comment3 = `<!-- mdait ${testHash} need:translate fixed -->`;
		const header3 = MdaitMarker.parse(comment3);
		assert.ok(header3);
		assert.equal(header3.hash, testHash);
		assert.equal(header3.from, null);
		assert.equal(header3.need, "translate");
		assert.equal(header3.fixed, true);
	});

	test("parse: fixedフラグなしのマーカーを正しくパースする（後方互換性）", () => {
		// fixedなし
		const comment = `<!-- mdait ${testHash} from:${testFrom} need:translate -->`;
		const header = MdaitMarker.parse(comment);
		assert.ok(header);
		assert.equal(header.hash, testHash);
		assert.equal(header.from, testFrom);
		assert.equal(header.need, "translate");
		assert.equal(header.fixed, false);
	});

	test("isFixed/setFixed: メソッドが正しく動作する", () => {
		const header = new MdaitMarker(testHash);
		
		// 初期状態はfalse
		assert.equal(header.isFixed(), false);
		
		// trueに設定
		header.setFixed(true);
		assert.equal(header.isFixed(), true);
		assert.equal(header.fixed, true);
		
		// falseに戻す
		header.setFixed(false);
		assert.equal(header.isFixed(), false);
		assert.equal(header.fixed, false);
	});

	test("パース→文字列化の往復テスト: fixedありのマーカー", () => {
		const original = `<!-- mdait ${testHash} from:${testFrom} need:translate fixed -->`;
		const parsed = MdaitMarker.parse(original);
		assert.ok(parsed);
		const stringified = parsed.toString();
		assert.equal(stringified, original);
	});

	test("全属性付きテスト: hash + from + need + fixed", () => {
		// すべての属性を持つマーカーを作成
		const header = new MdaitMarker(testHash, testFrom, "revise@abc12345", true);
		
		// プロパティ確認
		assert.equal(header.hash, testHash);
		assert.equal(header.from, testFrom);
		assert.equal(header.need, "revise@abc12345");
		assert.equal(header.fixed, true);
		
		// 文字列化
		const str = header.toString();
		assert.equal(str, `<!-- mdait ${testHash} from:${testFrom} need:revise@abc12345 fixed -->`);
		
		// パース
		const parsed = MdaitMarker.parse(str);
		assert.ok(parsed);
		assert.equal(parsed.hash, testHash);
		assert.equal(parsed.from, testFrom);
		assert.equal(parsed.need, "revise@abc12345");
		assert.equal(parsed.fixed, true);
		
		// メソッド動作確認
		assert.equal(parsed.needsRevision(), true);
		assert.equal(parsed.getOldHashFromNeed(), "abc12345");
		assert.equal(parsed.isFixed(), true);
	});
});
