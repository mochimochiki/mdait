// 2つの並びを突き合わせる汎用ロジックのテスト
// 「確実な鍵で錨を打つ → 区間に割る → 区間内を順序で埋める」の各段を検証する

import { strict as assert } from "node:assert";
import {
	type AlignAnchor,
	alignByAnchors,
	gapsBetweenAnchors,
	selectMonotonicAnchors,
} from "../../../../core/matching/interval-align";

/** 対応表を "a→b" の読みやすい形に落とす */
function format(pairs: Array<{ a: number | null; b: number | null }>): string[] {
	return pairs.map((p) => `${p.a ?? "-"}→${p.b ?? "-"}`);
}

suite("interval-align", () => {
	suite("selectMonotonicAnchors", () => {
		test("候補が無ければ空を返すこと", () => {
			assert.deepStrictEqual(selectMonotonicAnchors([]), []);
		});

		test("1対1の候補はすべて錨になること", () => {
			const candidates: AlignAnchor[] = [
				{ a: 0, b: 0 },
				{ a: 1, b: 1 },
				{ a: 2, b: 2 },
			];
			assert.deepStrictEqual(selectMonotonicAnchors(candidates), candidates);
		});

		test("順序が交差する候補は、両側とも単調になる最大の組だけが残ること", () => {
			// 2番目と3番目が入れ替わっている（並べ替えられた章に相当）
			const candidates: AlignAnchor[] = [
				{ a: 0, b: 0 },
				{ a: 1, b: 2 },
				{ a: 2, b: 1 },
				{ a: 3, b: 3 },
			];
			const anchors = selectMonotonicAnchors(candidates);
			// 交差する2つはどちらか一方しか採れないので、最大長は3
			assert.strictEqual(anchors.length, 3);
			for (let i = 1; i < anchors.length; i++) {
				assert.ok(anchors[i].a > anchors[i - 1].a, "a が単調増加であること");
				assert.ok(anchors[i].b > anchors[i - 1].b, "b が単調増加であること");
			}
		});

		test("同じ鍵が複数あるとき、前後の錨から正しい方が選ばれること", () => {
			// 前回 [A, B, C, B, D] から 1つ目の B を削除して [A, C, B, D] になった場合。
			// B の候補は (1,2) と (3,2) の2つで、単調性から (3,2) が選ばれるのが正しい。
			const candidates: AlignAnchor[] = [
				{ a: 0, b: 0 }, // A
				{ a: 1, b: 2 }, // 1つ目の B
				{ a: 3, b: 2 }, // 2つ目の B
				{ a: 2, b: 1 }, // C
				{ a: 4, b: 3 }, // D
			];
			const anchors = selectMonotonicAnchors(candidates);
			assert.deepStrictEqual(anchors, [
				{ a: 0, b: 0 },
				{ a: 2, b: 1 },
				{ a: 3, b: 2 },
				{ a: 4, b: 3 },
			]);
		});

		test("1つの要素に複数の相手候補があっても、片方ずつしか採らないこと", () => {
			const candidates: AlignAnchor[] = [
				{ a: 0, b: 0 },
				{ a: 0, b: 1 },
				{ a: 0, b: 2 },
			];
			const anchors = selectMonotonicAnchors(candidates);
			assert.strictEqual(anchors.length, 1);
			assert.strictEqual(anchors[0].a, 0);
		});
	});

	suite("gapsBetweenAnchors", () => {
		test("錨のあいだ・前・後ろの区間が列挙されること", () => {
			const gaps = gapsBetweenAnchors(4, 5, [{ a: 1, b: 2 }]);
			assert.deepStrictEqual(gaps, [
				{ aStart: 0, aEnd: 1, bStart: 0, bEnd: 2 },
				{ aStart: 2, aEnd: 4, bStart: 3, bEnd: 5 },
			]);
		});

		test("単調でない錨を渡しても、区間が重ならないこと", () => {
			// 区間が重なると fillGaps が同じ添字を二度使ってしまう。
			// 順序を巻き戻す錨は区切りに使わず読み飛ばす。
			const gaps = gapsBetweenAnchors(8, 8, [
				{ a: 5, b: 3 },
				{ a: 1, b: 5 },
			]);
			for (let i = 1; i < gaps.length; i++) {
				assert.ok(gaps[i].aStart >= gaps[i - 1].aEnd, "a の区間が重ならないこと");
				assert.ok(gaps[i].bStart >= gaps[i - 1].bEnd, "b の区間が重ならないこと");
			}
		});

		test("すき間が無ければ区間は生まれないこと", () => {
			const gaps = gapsBetweenAnchors(2, 2, [
				{ a: 0, b: 0 },
				{ a: 1, b: 1 },
			]);
			assert.deepStrictEqual(gaps, []);
		});
	});

	suite("alignByAnchors", () => {
		test("錨が無ければ全体が1区間として順序で埋められること", () => {
			assert.deepStrictEqual(format(alignByAnchors(2, 2, [])), ["0→0", "1→1"]);
		});

		test("右の並びが1つ増えていれば、増えた分だけ相手なしになること", () => {
			// 前回2件、いま3件。錨は先頭と末尾
			const pairs = alignByAnchors(2, 3, [
				{ a: 0, b: 0 },
				{ a: 1, b: 2 },
			]);
			assert.deepStrictEqual(format(pairs), ["0→0", "-→1", "1→2"]);
		});

		test("左の並びが1つ減っていれば、余った左が相手なしになること", () => {
			const pairs = alignByAnchors(3, 2, [
				{ a: 0, b: 0 },
				{ a: 2, b: 1 },
			]);
			assert.deepStrictEqual(format(pairs), ["0→0", "1→-", "2→1"]);
		});

		test("区間内に1対1で残ったものは対応づけられること（本文を書き換えた章に相当）", () => {
			const pairs = alignByAnchors(3, 3, [
				{ a: 0, b: 0 },
				{ a: 2, b: 2 },
			]);
			assert.deepStrictEqual(format(pairs), ["0→0", "1→1", "2→2"]);
		});

		test("単調でない錨を渡しても、同じ添字が二度現れないこと", () => {
			const pairs = alignByAnchors(2, 4, [
				{ a: 0, b: 3 },
				{ a: 1, b: 0 },
			]);
			const as = pairs.filter((p) => p.a !== null).map((p) => p.a);
			const bs = pairs.filter((p) => p.b !== null).map((p) => p.b);
			assert.strictEqual(new Set(as).size, as.length, "a が重複しないこと");
			assert.strictEqual(new Set(bs).size, bs.length, "b が重複しないこと");
		});
	});
});
