/**
 * 合流で降ろされた行が、解決 → 同期で片付くことの通しのテスト（roadmap-v04 P03）。
 *
 * 2つの段をつないで確かめる。**解決**（競合マーカーを畳んで両方の行を残す）と、
 * **同期の突き合わせ**（原稿の本文と一致する側を席へ戻す）である。
 *
 * ここが持つ約束は「**どちらの行も失われないまま、原稿と一致する側が席に着く**」ことである。
 * 訳の良し悪しではなく事実の照合なので、人の判断は要らない。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyUnitStateResolution } from "../../../../commands/conflict/targets/state-target";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import type { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { alignEntriesToUnits } from "../../../../core/unit-state/unit-state-align";
import {
	UnitStateStore,
	isHeldBackEntry,
	isMergeHeldEntry,
} from "../../../../core/unit-state/unit-state-store";
import { resetUnitStateLock } from "../../../../infra/workspace/unit-state-lock";
import { seat } from "../../helpers/unit-state";

const OLD_BODY = "合流の前の本文";
const NEW_BODY = "相手が書き直した本文";

/** 同じ席に両陣営の行が来た `unit-state`（競合マーカー入り） */
function conflictedUnitState(): string {
	const title = calculateHash("章");
	return [
		"# mdait unit-state",
		"",
		"# aaaaaaaaaaaa en/a.md",
		"",
		"<<<<<<< HEAD",
		`aaaaaaaaaaaa\tunit\t${seat(0)}\t2\t${title}\t${calculateHash(OLD_BODY)}\tsrc-old\t`,
		"=======",
		`aaaaaaaaaaaa\tunit\t${seat(0)}\t2\t${title}\t${calculateHash(NEW_BODY)}\tsrc-new\trevise@src-new`,
		">>>>>>> theirs",
		"",
	].join("\n");
}

function unit(content: string): MdaitUnit {
	return { title: "章", content, level: 2 } as unknown as MdaitUnit;
}

suite("合流で降ろされた行が、解決と同期で片付く", () => {
	let mdaitDir: string;

	setup(() => {
		resetUnitStateLock();
		UnitStateStore.dispose();
		mdaitDir = fs.mkdtempSync(path.join(os.tmpdir(), "held-reconcile-"));
		fs.writeFileSync(path.join(mdaitDir, "unit-state"), conflictedUnitState(), "utf-8");
	});

	teardown(() => {
		UnitStateStore.dispose();
		resetUnitStateLock();
		fs.rmSync(mdaitDir, { recursive: true, force: true });
	});

	test("解決で競合マーカーが消え、どちらの行も残る", async () => {
		const outcome = await applyUnitStateResolution(mdaitDir);

		assert.equal(outcome.rows, 2, "どちらかの行が消えている");
		assert.equal(outcome.unseated, 1, "席を分けた回数が数えられていない");
		const after = fs.readFileSync(path.join(mdaitDir, "unit-state"), "utf-8");
		assert.doesNotMatch(after, /^<{7}|^={7}|^>{7}/m);
	});

	test("降ろされた行は、押し出された元の席を名乗る", async () => {
		await applyUnitStateResolution(mdaitDir);

		const rows = UnitStateStore.getInstance().getEntriesByPath("en/a.md");
		const held = rows.filter(isHeldBackEntry);
		assert.equal(held.length, 1);
		assert.equal(held[0].seat, `u${seat(0)}`);
		assert.equal(held.filter(isMergeHeldEntry).length, 1, "合流由来として数えられていない");
	});

	test("原稿が相手の版なら、降ろされた行が席へ戻る", async () => {
		await applyUnitStateResolution(mdaitDir);
		const rows = UnitStateStore.getInstance().getEntriesByPath("en/a.md");
		const heldIndexes = new Set(rows.map((row, i) => (isHeldBackEntry(row) ? i : -1)).filter((i) => i >= 0));

		// 同期の突き合わせ（本文の完全一致だけで拾う）
		const aligned = alignEntriesToUnits(rows, [unit(NEW_BODY)], heldIndexes);

		assert.equal(aligned[0]?.from, "src-new", "原稿と一致する側が席に着いていない");
		assert.equal(aligned[0]?.need, "revise@src-new");
	});

	test("原稿がこちらの版なら、席に残った行のまま", async () => {
		await applyUnitStateResolution(mdaitDir);
		const rows = UnitStateStore.getInstance().getEntriesByPath("en/a.md");
		const heldIndexes = new Set(rows.map((row, i) => (isHeldBackEntry(row) ? i : -1)).filter((i) => i >= 0));

		const aligned = alignEntriesToUnits(rows, [unit(OLD_BODY)], heldIndexes);

		assert.equal(aligned[0]?.from, "src-old");
	});

	test("2度解決しても、行は増えない（冪等）", async () => {
		await applyUnitStateResolution(mdaitDir);
		const first = fs.readFileSync(path.join(mdaitDir, "unit-state"), "utf-8");

		UnitStateStore.dispose();
		const second = await applyUnitStateResolution(mdaitDir);

		assert.equal(second.rows, 2);
		assert.equal(second.unseated, 0, "もう競合していないのに席を分けている");
		assert.equal(fs.readFileSync(path.join(mdaitDir, "unit-state"), "utf-8"), first);
	});
});
