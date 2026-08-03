// 外部ストアの行 ↔ いまのユニットの突き合わせのテスト
// 章の挿入・削除・並べ替え・本文編集など、実際に起きる編集で対応がずれないことを検証する

import { strict as assert } from "node:assert";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { alignEntriesToUnits } from "../../../../core/unit-state/unit-state-align";
import type { UnitStateEntry } from "../../../../core/unit-state/unit-state-store";

const PATH = "content/en/guide.md";

/** 見出しと本文からユニットを作る（パーサーを通した結果と同じ形にする） */
function unit(title: string, body: string, level = 2): MdaitUnit {
	const content = `${"#".repeat(level)} ${title}\n\n${body}\n`;
	return new MdaitUnit(new MdaitMarker(""), title, level, content);
}

/** そのユニットが「前回 sync された姿」であるとして行を作る */
function rowOf(u: MdaitUnit, order: number, from: string, need = ""): UnitStateEntry {
	return {
		path: PATH,
		order,
		level: u.headingLevel,
		titleHash: calculateHash(u.title),
		hash: calculateHash(u.content),
		from,
		need,
	};
}

/** 突き合わせ結果を「ユニットの見出し → 行の from」の読みやすい形に落とす */
function linkedFrom(entries: UnitStateEntry[], units: MdaitUnit[]): Array<string | null> {
	return alignEntriesToUnits(entries, units).map((e) => (e ? e.from : null));
}

suite("unit-state-align", () => {
	// 前回の姿: 導入 / 第1章 / 第2章 / 第3章（それぞれ原文 s0〜s3 から訳したもの）
	const intro = unit("ドキュメント", "導入の文章。", 1);
	const ch1 = unit("第1章", "第1章の本文。");
	const ch2 = unit("第2章", "第2章の本文。");
	const ch3 = unit("第3章", "第3章の本文。");
	const previous = [rowOf(intro, 0, "s0"), rowOf(ch1, 1, "s1"), rowOf(ch2, 2, "s2"), rowOf(ch3, 3, "s3")];

	test("何も変わっていなければ、そのままの対応になること", () => {
		assert.deepStrictEqual(linkedFrom(previous, [intro, ch1, ch2, ch3]), ["s0", "s1", "s2", "s3"]);
	});

	test("途中に章を挿入しても、後ろの章の対応がずれないこと", () => {
		const inserted = unit("第1.5章", "第1.5章の本文。");
		assert.deepStrictEqual(linkedFrom(previous, [intro, ch1, inserted, ch2, ch3]), [
			"s0",
			"s1",
			null, // 新しい章は対応する行を持たない（sync が新規と判定する）
			"s2",
			"s3",
		]);
	});

	test("先頭に章を挿入しても、以降の章の対応がずれないこと", () => {
		const head = unit("まえがき", "まえがきの本文。", 1);
		assert.deepStrictEqual(linkedFrom(previous, [head, intro, ch1, ch2, ch3]), [null, "s0", "s1", "s2", "s3"]);
	});

	test("途中の章を削除しても、残った章の対応がずれないこと", () => {
		assert.deepStrictEqual(linkedFrom(previous, [intro, ch1, ch3]), ["s0", "s1", "s3"]);
	});

	test("先頭の章を削除しても、残った章の対応がずれないこと", () => {
		assert.deepStrictEqual(linkedFrom(previous, [ch1, ch2, ch3]), ["s1", "s2", "s3"]);
	});

	test("章を並べ替えても、対応が入れ替わらないこと", () => {
		assert.deepStrictEqual(linkedFrom(previous, [intro, ch1, ch3, ch2]), ["s0", "s1", "s3", "s2"]);
	});

	test("本文だけ書き換えた章は、見出しの一致で対応が保たれること", () => {
		const edited = unit("第2章", "第2章の本文（改訂）。");
		assert.deepStrictEqual(linkedFrom(previous, [intro, ch1, edited, ch3]), ["s0", "s1", "s2", "s3"]);
	});

	test("見出しごと書き換えた章も、前後の章に挟まれていれば対応が保たれること", () => {
		const renamed = unit("第二章", "まるごと書き換えた本文。");
		assert.deepStrictEqual(linkedFrom(previous, [intro, ch1, renamed, ch3]), ["s0", "s1", "s2", "s3"]);
	});

	test("章を書き換えつつ別の章を挿入しても、確定した章の対応は保たれること", () => {
		const inserted = unit("第1.5章", "第1.5章の本文。");
		const edited = unit("第3章", "第3章の本文（改訂）。");
		const linked = linkedFrom(previous, [intro, ch1, inserted, ch2, edited]);
		assert.deepStrictEqual(linked.slice(0, 2), ["s0", "s1"]);
		assert.strictEqual(linked[3], "s2", "書き換えていない第2章は対応が保たれること");
		assert.strictEqual(linked[4], "s3", "書き換えた第3章は見出しの一致で拾えること");
	});

	test("同じ本文の章が2つある文書で、先頭側を削除しても正しい方が残ること", () => {
		// 前回: 導入 / 注意事項 / 第2章 / 注意事項 / 第3章
		const notice = unit("注意事項", "安全に配慮してください。");
		const rows = [
			rowOf(intro, 0, "s0"),
			rowOf(notice, 1, "s1"),
			rowOf(ch2, 2, "s2"),
			rowOf(notice, 3, "s3"),
			rowOf(ch3, 4, "s4"),
		];
		// 1つ目の注意事項を削除 → 導入 / 第2章 / 注意事項 / 第3章
		assert.deepStrictEqual(linkedFrom(rows, [intro, ch2, notice, ch3]), ["s0", "s2", "s3", "s4"]);
	});

	// 章を移動したうえで編集すると確定した対応が交差し、区間の枠が崩れる。
	// 余った行と余ったユニットが別々の区間に取り残されて対応なしになると、
	// その訳文は from を失って新規扱いになり、次の翻訳で人の訳が上書きされる。
	// 行が余っている限りユニットを対応なしにしないことを固定する。
	suite("章の移動と編集が重なっても、行が余っている限り対応なしを作らない", () => {
		const movedEdited = unit("第3章", "第3章の本文（改訂）。");
		const editedElsewhere = unit("第1章", "第1章の本文（改訂）。");
		const rows = [rowOf(ch1, 0, "s1"), rowOf(ch2, 1, "s2"), rowOf(ch3, 2, "s3")];

		test("末尾の章を先頭へ移動し、その章を編集した場合", () => {
			assert.deepStrictEqual(linkedFrom(rows, [movedEdited, ch1, ch2]), ["s3", "s1", "s2"]);
		});

		test("末尾の章を先頭へ移動し、別の章を編集した場合", () => {
			assert.deepStrictEqual(linkedFrom(rows, [ch3, editedElsewhere, ch2]), ["s3", "s1", "s2"]);
		});

		// 章を移動したうえで、別の章を見出しごと丸ごと書き換えた場合、書き換えた章には
		// 手がかりが1つも残らない（本文も見出しもレベルも一致しない）。これは「消して
		// 新しく足した」と区別がつかないため、対応が付かないのが正しい。
		// ここで無理に余り同士を結ぶと、別の場所で消えた章の訳文が新しく増えた章に
		// 割り当てられる（実測 S54）。移動していない側の対応が保たれることだけを固定する。
		test("章を移動したうえで別の章を見出しごと書き換えても、動かした章の対応は保たれること", () => {
			const rows4 = [rowOf(intro, 0, "s0"), rowOf(ch1, 1, "s1"), rowOf(ch2, 2, "s2"), rowOf(ch3, 3, "s3")];
			const renamedA = unit("まったく別の章", "まったく別の本文。");
			const renamedB = unit("さらに別の章", "さらに別の本文。");
			const linked = linkedFrom(rows4, [ch3, intro, renamedA, renamedB]);
			assert.deepStrictEqual(linked.slice(0, 2), ["s3", "s0"]);
			assert.strictEqual(new Set(linked.filter((x) => x !== null)).size, linked.filter((x) => x !== null).length);
		});

		test("移動だけで編集していなければ、当然そのままの対応になること", () => {
			assert.deepStrictEqual(linkedFrom(rows, [ch3, ch1, ch2]), ["s3", "s1", "s2"]);
		});
	});

	test("同じ本文の章が3つある文書を並べ替えても、どれも対応を失わないこと", () => {
		const notice = unit("注意事項", "安全に配慮してください。");
		const other = unit("M章", "Mの本文。");
		const last = unit("Z章", "Zの本文。");
		const rows = [
			rowOf(ch1, 0, "s0"),
			rowOf(notice, 1, "s1"),
			rowOf(other, 2, "s2"),
			rowOf(notice, 3, "s3"),
			rowOf(last, 4, "s4"),
			rowOf(notice, 5, "s5"),
		];
		// 先頭と末尾から2番目を入れ替える
		const linked = linkedFrom(rows, [last, notice, other, notice, ch1, notice]);
		assert.strictEqual(
			linked.filter((x) => x === null).length,
			0,
			`対応なしが出ないこと（実際: ${JSON.stringify(linked)}）`,
		);
		assert.strictEqual(new Set(linked).size, linked.length, "同じ行が二度使われないこと");
	});

	test("同一本文が多い大きな文書でも現実的な時間で終わること", () => {
		const many = 1600;
		const built = [];
		for (let i = 0; i < many; i++) {
			built.push(i % 2 === 0 ? unit("共通", "同じ本文。") : unit(`章${i}`, `本文${i}`));
		}
		const rows = built.map((u, i) => rowOf(u, i, `s${i}`));
		const edited = built.map((u, i) => (i % 7 === 0 ? unit(u.title, `書き換え${i}`) : u));
		const started = Date.now();
		alignEntriesToUnits(rows, edited);
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 1000, `1秒未満で終わること（実際: ${elapsed}ms）`);
	});

	test("行が1件も無ければ、すべて対応なしになること", () => {
		assert.deepStrictEqual(linkedFrom([], [intro, ch1]), [null, null]);
	});

	test("ユニットが1件も無ければ、空の結果を返すこと", () => {
		assert.deepStrictEqual(alignEntriesToUnits(previous, []), []);
	});

	test("行の方が多ければ、余った行は使われないこと（章がまとめて減った場合）", () => {
		assert.deepStrictEqual(linkedFrom(previous, [intro]), ["s0"]);
	});
});
