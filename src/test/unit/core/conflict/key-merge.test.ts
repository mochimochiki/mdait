/**
 * 鍵で突き合わせる決定的マージのテスト（roadmap-v04 P02）。
 *
 * ここが持つ約束は2つ。**片方にしか無い鍵は必ず両方採ること**（union をやめた代償で
 * 「別々の追加」が1つの競合ブロックに入るため）と、**誰がどの順で合流させても同じ答えに
 * なること**である。
 */

import { strict as assert } from "node:assert";
import { type KeyedEntry, mergeByKey } from "../../../../core/conflict/key-merge";

/** 訳語と note を持つ、用語集の1件を模した値 */
interface Term {
	word: string;
	note: string;
}

const e = (key: string, word: string, note = ""): KeyedEntry<Term> => ({ key, value: { word, note } });

const sameValue = (a: Term, b: Term) => a.word === b.word && a.note === b.note;

/** 触った項目が重なっていなければ両方残す */
const mergeFields = (ours: Term, theirs: Term, base: Term | undefined): Term | undefined => {
	if (!base) {
		return undefined;
	}
	const wordTouched = ours.word !== base.word && theirs.word !== base.word && ours.word !== theirs.word;
	const noteTouched = ours.note !== base.note && theirs.note !== base.note && ours.note !== theirs.note;
	if (wordTouched || noteTouched) {
		return undefined; // 同じ項目を2人が別々に直した。人が決める
	}
	return {
		word: ours.word !== base.word ? ours.word : theirs.word,
		note: ours.note !== base.note ? ours.note : theirs.note,
	};
};

const opts = { sameValue };
const optsWithFields = { sameValue, mergeFields };

suite("鍵で突き合わせる決定的マージ", () => {
	test("片方にしか無い鍵は、両方とも採る", () => {
		const found = mergeByKey([e("a", "A")], [e("b", "B")], undefined, opts);

		assert.deepEqual(
			found.resolved.map((r) => r.key),
			["a", "b"],
		);
		assert.equal(found.undecided.length, 0);
	});

	test("同じ鍵に同じ値なら、1つに畳む", () => {
		const found = mergeByKey([e("a", "A")], [e("a", "A")], undefined, opts);

		assert.equal(found.resolved.length, 1);
		assert.equal(found.undecided.length, 0);
	});

	test("同じ鍵に別の値なら、決まらない", () => {
		const found = mergeByKey([e("a", "私の訳")], [e("a", "相手の訳")], undefined, opts);

		assert.equal(found.resolved.length, 0);
		assert.equal(found.undecided.length, 1);
		assert.equal(found.undecided[0].ours.word, "私の訳");
		assert.equal(found.undecided[0].theirs.word, "相手の訳");
	});

	test("祖先があり、片方だけが変えたなら、変えたほうを採る", () => {
		const base = [e("a", "もと")];

		const theirsChanged = mergeByKey([e("a", "もと")], [e("a", "相手が直した")], base, opts);
		assert.equal(theirsChanged.resolved[0].value.word, "相手が直した");
		assert.equal(theirsChanged.undecided.length, 0);

		const oursChanged = mergeByKey([e("a", "私が直した")], [e("a", "もと")], base, opts);
		assert.equal(oursChanged.resolved[0].value.word, "私が直した");
	});

	test("祖先があり、両方が別々に変えたなら、決まらない", () => {
		const found = mergeByKey([e("a", "私")], [e("a", "相手")], [e("a", "もと")], opts);

		assert.equal(found.undecided.length, 1);
		assert.equal(found.undecided[0].base?.word, "もと");
	});

	test("触った項目が別なら、項目単位で両方採る", () => {
		const found = mergeByKey(
			[e("a", "私が直した訳語", "もとの note")],
			[e("a", "もとの訳語", "相手が直した note")],
			[e("a", "もとの訳語", "もとの note")],
			optsWithFields,
		);

		assert.equal(found.undecided.length, 0);
		assert.deepEqual(found.resolved[0].value, { word: "私が直した訳語", note: "相手が直した note" });
	});

	test("同じ項目を2人が直していたら、項目単位でも決まらない", () => {
		const found = mergeByKey(
			[e("a", "私の訳語", "note")],
			[e("a", "相手の訳語", "note")],
			[e("a", "もとの訳語", "note")],
			optsWithFields,
		);

		assert.equal(found.undecided.length, 1);
	});

	suite("消えたかどうか", () => {
		test("祖先が無ければ、片方に無くても必ず採る（消えたのか足したのか分からない）", () => {
			const found = mergeByKey([e("a", "A")], [], undefined, opts);

			assert.equal(found.resolved.length, 1);
			assert.equal(found.deleted.length, 0);
		});

		test("祖先に在り、残ったほうが変えていないなら、消したことに従う", () => {
			const found = mergeByKey([e("a", "もと")], [], [e("a", "もと")], opts);

			assert.equal(found.resolved.length, 0);
			assert.deepEqual(found.deleted, ["a"]);
		});

		test("片方が消し、片方が直していたら、決まらない", () => {
			const found = mergeByKey([e("a", "私が直した")], [], [e("a", "もと")], opts);

			assert.equal(found.deleted.length, 0);
			assert.equal(found.undecided.length, 1);
			assert.equal(found.undecided[0].ours.word, "私が直した");
			assert.equal(found.undecided[0].theirs.word, "もと");
		});
	});

	suite("順に依らないこと", () => {
		test("どちらを ours にしても、決まる件数は変わらない", () => {
			const a = [e("x", "X"), e("shared", "私")];
			const b = [e("y", "Y"), e("shared", "相手")];

			const forward = mergeByKey(a, b, undefined, opts);
			const backward = mergeByKey(b, a, undefined, opts);

			assert.equal(forward.resolved.length, backward.resolved.length);
			assert.equal(forward.undecided.length, backward.undecided.length);
		});

		test("結果は鍵の符号位置の順に並ぶ", () => {
			const found = mergeByKey([e("B", "b"), e("a", "a")], [e("C", "c")], undefined, opts);

			assert.deepEqual(
				found.resolved.map((r) => r.key),
				["B", "C", "a"],
			);
		});

		test("読む順で答えが変わらない（同じ鍵が2度来ても先を採る）", () => {
			const found = mergeByKey([e("a", "先"), e("a", "後")], [e("a", "先")], undefined, opts);

			assert.equal(found.resolved.length, 1);
			assert.equal(found.resolved[0].value.word, "先");
		});
	});

	test("別々の追加が1つのブロックに入っても、どちらも失われない", () => {
		// union をやめた代償として、この形が必ず出る。ここが本番
		const ours = [e("base1", "B1"), e("base2", "B2"), e("mine", "私が足した")];
		const theirs = [e("base1", "B1"), e("base2", "B2"), e("yours", "相手が足した")];

		const found = mergeByKey(ours, theirs, undefined, opts);

		assert.equal(found.undecided.length, 0, "人の前に出てはいけない形");
		assert.deepEqual(
			found.resolved.map((r) => r.key),
			["base1", "base2", "mine", "yours"],
		);
	});
});
