/**
 * 合流で席から降ろされた行が、原稿との突き合わせで席へ戻ることのテスト（roadmap-v04 P03）。
 *
 * 降ろされた行をどちらに決めるかは、**訳の良し悪しではなく事実の照合**である。
 * 原稿の本文のハッシュと一致する側が正しい版なので、機械が決定的に決められる。
 *
 * 拾い戻しは**本文の完全一致だけ**に絞ってある（ADR-260809-01）。弱い手がかりで拾うと、
 * 見出しだけ同じ別物の章に古い `from` が付く。
 */

import { strict as assert } from "node:assert";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import type { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { alignEntriesToUnits } from "../../../../core/unit-state/unit-state-align";
import type { UnitStateEntry } from "../../../../core/unit-state/unit-state-store";
import { seat } from "../../helpers/unit-state";

/** 本文だけを持つユニット（突き合わせに要るのは本文と見出し） */
function unit(title: string, content: string): MdaitUnit {
	return { title, content, level: 2 } as unknown as MdaitUnit;
}

const seated = (body: string, from: string, need = ""): UnitStateEntry => ({
	path: "en/a.md",
	kind: "unit",
	seat: seat(0),
	level: 2,
	titleHash: calculateHash("章"),
	hash: calculateHash(body),
	from,
	need,
});

const unseated = (body: string, from: string, need = ""): UnitStateEntry => ({
	...seated(body, from, need),
	kind: "held",
	// 合流で降ろされた行は、押し出された元の席を名乗る（ADR-260911-03）
	seat: `u${seat(0)}`,
});

suite("合流で降ろされた行の、原稿との照合", () => {
	test("原稿と一致する側が席へ戻る（降ろされた行のほうが正しい版だったとき）", () => {
		const entries = [seated("古い本文", "src-old"), unseated("いまの本文", "src-new", "revise@src-new")];
		const units = [unit("章", "いまの本文")];

		const aligned = alignEntriesToUnits(entries, units, new Set([1]));

		assert.equal(aligned[0]?.from, "src-new", "降ろされた行が席へ戻っていない");
		assert.equal(aligned[0]?.need, "revise@src-new");
	});

	test("席に残った側が原稿と一致するなら、そちらのまま", () => {
		const entries = [seated("いまの本文", "src-new"), unseated("古い本文", "src-old")];
		const units = [unit("章", "いまの本文")];

		const aligned = alignEntriesToUnits(entries, units, new Set([1]));

		assert.equal(aligned[0]?.from, "src-new");
	});

	test("どちらも原稿と一致しなければ、降ろされた行は拾われない", () => {
		// 本文が両方の版から動いている。ここは機械では決められないので人へ回る
		const entries = [seated("古い本文A", "src-a"), unseated("古い本文B", "src-b")];
		const units = [unit("章", "まったく別の本文")];

		const aligned = alignEntriesToUnits(entries, units, new Set([1]));

		assert.notEqual(aligned[0]?.from, "src-b", "弱い手がかりで降ろされた行を拾っている");
	});

	test("見出しが同じでも、本文が違えば降ろされた行は拾われない", () => {
		// 完全一致だけに絞る理由（ADR-260809-01）。見出しで拾うと別物の章に古い from が付く
		const entries = [unseated("消えた章の本文", "src-gone", "revise@src-gone")];
		const units = [unit("章", "別物の本文")];

		const aligned = alignEntriesToUnits(entries, units, new Set([0]));

		assert.equal(aligned[0], undefined);
	});
});
