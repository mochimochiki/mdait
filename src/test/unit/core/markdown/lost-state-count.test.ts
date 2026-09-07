// 「翻訳の状態を失った」の数え方（countLostStateEntries）のテスト。
//
// 訳文の hash は訳し直せば必ず変わる。hash だけで見ると、翻訳が成功するたびに
// 「失った」と数えてしまい、既定テンプレート（external）の利用者は初回の翻訳で
// 必ずこの警告を見ていた（実測）。狼少年をやめないと、本当に状態を落としたとき
// （マージの取りこぼしなど）に読まれない。

import { strict as assert } from "node:assert";
import { countLostStateEntries } from "../../../../core/markdown/marker-provider";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import type { UnitStateEntry } from "../../../../core/unit-state/unit-state-store";
import { seat } from "../../helpers/unit-state";

function entry(overrides: Partial<UnitStateEntry> = {}): UnitStateEntry {
	return {
		path: "en/guide.md",
		kind: "unit" as const, seat: seat(0),
		level: 1,
		titleHash: "t0",
		hash: "old00001",
		from: "src00001",
		need: "",
		...overrides,
	};
}

function unit(hash: string, from?: string, need?: string): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash, from ?? null, need ?? null), "Section", 1, "## Section\n\nbody\n", 0, 0);
}

/** これから書き出す席（既定は「行 0 の席をユニットが取る」） */
const taken = (...keys: string[]) => new Set(keys.length > 0 ? keys : [seat(0)]);

suite("失った翻訳の状態を数える", () => {
	test("訳し直して hash が変わっただけなら、失ったと数えない", () => {
		const previous = [entry({ hash: "old00001", from: "src00001", need: "translate" })];
		const units = [unit("new00001", "src00001")];

		assert.strictEqual(countLostStateEntries(previous, units, taken()), 0, "章はまだそこに在る（from が同じ）");
	});

	test("章そのものが消えたら、失ったと数える", () => {
		const previous = [entry({ hash: "old00001", from: "src00001", need: "translate" })];
		const units = [unit("new00002", "src99999")];

		assert.strictEqual(countLostStateEntries(previous, units, taken()), 1);
	});

	test("位置が変わっただけ（hash が生きている）なら数えない", () => {
		const previous = [entry({ kind: "unit" as const, seat: seat(0), hash: "h1", from: "s1" })];
		const units = [unit("h9", "s9"), unit("h1", "s1")];

		assert.strictEqual(countLostStateEntries(previous, units, taken()), 0);
	});

	test("守るべき状態が無い行（from も need も空）は数えない", () => {
		const previous = [entry({ hash: "h1", from: "", need: "" })];
		assert.strictEqual(countLostStateEntries(previous, [unit("h2", "s2")], taken()), 0);
	});

	test("保留席の行は上書きされないので数えない", () => {
		const previous = [entry({ kind: "held" as const, seat: "", hash: "h1", from: "s1", need: "translate" })];
		assert.strictEqual(countLostStateEntries(previous, [unit("h2", "s2")], taken()), 0);
	});

	test("どのユニットにも席を譲らなかった行は、刈り取り／保留の判断が別にあるので数えない", () => {
		const previous = [entry({ kind: "unit" as const, seat: seat(5), hash: "h1", from: "s1", need: "translate" })];
		assert.strictEqual(countLostStateEntries(previous, [unit("h2", "s2")], taken(seat(9))), 0);
	});

	test("from を持たない独立ユニットは、これまでどおり hash で見る", () => {
		const previous = [entry({ hash: "h1", from: "", need: "isolate" })];

		assert.strictEqual(countLostStateEntries(previous, [unit("h1")], taken()), 0, "同じ hash が居れば残っている");
		assert.strictEqual(countLostStateEntries(previous, [unit("h2", "s2")], taken()), 1, "居なければ失われている");
	});
});
