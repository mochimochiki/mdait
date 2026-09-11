/**
 * 「競合の解決」をサーフェスに出す部分のテスト（roadmap-v04 P01）。
 *
 * ここが持つ約束は `docs/ux.md` §3.3 の表そのものである。**気づき**はステータスバーの
 * 1行、**状態**はツリーの1件1行、**解説**は Hover（ツリー行のツールチップ）。
 * 0件のときは何も出さない（UX-P7: デッドエンドを置かない）。
 */

import { strict as assert } from "node:assert";
import type { MdaitConflicts } from "../../../../core/conflict/mdait-conflicts";
import { Status, StatusItemType } from "../../../../core/status/status-item";
import {
	CONFLICTS_ID,
	buildConflictRows,
	buildConflictsItem,
	isConflictRowId,
} from "../../../../ui/status/conflict-branch";
import { buildConflictTooltip, buildStatusBarText } from "../../../../ui/status/status-bar-summary";

const empty: MdaitConflicts = { files: [], heldRows: [], total: 0 };

const withFiles = (...kinds: Array<"unit-state" | "unit-registry" | "tm" | "terms">): MdaitConflicts => ({
	files: kinds.map((kind) => ({ kind, filePath: `/ws/.mdait/${kind}` })),
	heldRows: [],
	total: kinds.length,
});

const withHeld = (count: number): MdaitConflicts => ({
	files: [],
	heldRows: Array.from({ length: count }, (_, i) => ({
		path: `en/a${i}.md`,
		seat: "u50000000",
		hash: "HASH",
		from: "src",
		need: "revise@old",
	})),
	total: count,
});

suite("競合の解決（StatusTree の枝）", () => {
	test("0件なら枝を出さない（空のノードを置かない）", () => {
		assert.equal(buildConflictsItem(empty), undefined);
	});

	test("件数をラベルに出す", () => {
		const item = buildConflictsItem(withFiles("tm", "terms"));

		assert.ok(item);
		assert.match(item.label, /2/);
		assert.equal(item.directoryPath, CONFLICTS_ID);
		assert.equal(item.status, Status.Error);
	});

	test("枝そのものにも解説を置く（Hover）", () => {
		const item = buildConflictsItem(withFiles("tm"));

		assert.ok(item?.tooltip);
		assert.ok(item.tooltip.length > 0);
	});

	test("ファイルは1つ1行で、種別とパスが読める", () => {
		const rows = buildConflictRows(withFiles("tm", "terms"), "/ws");

		assert.equal(rows.length, 2);
		assert.deepEqual(
			rows.map((r) => r.description),
			[".mdait/tm", ".mdait/terms"],
		);
		assert.ok(rows.every((r) => r.type === StatusItemType.Directory));
	});

	test("合流で降ろされた行は1つ1行で、原稿と預かっている状態が読める", () => {
		const rows = buildConflictRows(withHeld(2), "/ws");

		assert.equal(rows.length, 2);
		assert.equal(rows[0].label, "a0.md");
		assert.match(rows[0].description ?? "", /revise@old/);
		assert.match(rows[0].tooltip ?? "", /en\/a0\.md/);
	});

	test("ファイルと行が混ざっても、行の識別子がぶつからない", () => {
		const mixed: MdaitConflicts = {
			files: withFiles("tm", "terms").files,
			heldRows: withHeld(3).heldRows,
			total: 5,
		};
		const rows = buildConflictRows(mixed, "/ws");

		const ids = rows.map((r) => r.directoryPath);
		assert.equal(new Set(ids).size, ids.length, "識別子が重なっている");
		assert.ok(ids.every(isConflictRowId));
	});

	test("ワークスペースが分からなくても絶対パスで出す", () => {
		const rows = buildConflictRows(withFiles("unit-state"), undefined);

		assert.equal(rows[0].description, "/ws/.mdait/unit-state");
	});
});

suite("競合の解決（ステータスバーの1行）", () => {
	const counts = (
		overrides: Partial<Parameters<typeof buildStatusBarText>[0]> = {},
	): Parameters<typeof buildStatusBarText>[0] => ({
		pendingTranslation: 0,
		needsAttention: 0,
		orphanTargets: 0,
		conflicts: 0,
		conflictKinds: [],
		...overrides,
	});

	test("何も無ければ何も出さない", () => {
		assert.equal(buildStatusBarText(counts()), "");
	});

	test("競合だけでも出る（他の件数が 0 でも隠れない）", () => {
		const text = buildStatusBarText(counts({ conflicts: 3 }));

		assert.match(text, /3/);
		assert.ok(text.startsWith("$(git-merge)"), text);
	});

	test("競合は他の件数より前に出る", () => {
		const text = buildStatusBarText(counts({ conflicts: 1, pendingTranslation: 5 }));

		assert.ok(text.indexOf("1") < text.indexOf("5"), text);
	});

	test("競合が無ければ、これまでどおりの見た目のまま", () => {
		const text = buildStatusBarText(counts({ pendingTranslation: 2 }));

		assert.ok(text.startsWith("$(globe)"), text);
	});

	suite("ツールチップは、実際に使えなくなっている対象だけを挙げる", () => {
		test("unit-state だけの競合では、TM も用語集も使えないとは言わない", () => {
			const tip = buildConflictTooltip(counts({ conflicts: 1, conflictKinds: ["unit-state"] }));

			assert.doesNotMatch(tip, /memory|glossary/i, tip);
		});

		test("台帳だけの競合でも同じ", () => {
			const tip = buildConflictTooltip(counts({ conflicts: 1, conflictKinds: ["unit-registry"] }));

			assert.doesNotMatch(tip, /memory|glossary/i, tip);
		});

		test("TM が競合していれば、翻訳メモリが使えないと言う", () => {
			const tip = buildConflictTooltip(counts({ conflicts: 1, conflictKinds: ["tm"] }));

			assert.match(tip, /translation memory/i, tip);
			assert.doesNotMatch(tip, /glossary/i, tip);
		});

		test("両方が競合していれば両方を挙げる", () => {
			const tip = buildConflictTooltip(counts({ conflicts: 2, conflictKinds: ["tm", "terms"] }));

			assert.match(tip, /translation memory/i, tip);
			assert.match(tip, /glossary/i, tip);
		});

		test("合流で降ろされた行だけのときも、対象を名指ししない", () => {
			const tip = buildConflictTooltip(counts({ conflicts: 3, conflictKinds: [] }));

			assert.match(tip, /3/, tip);
			assert.doesNotMatch(tip, /memory|glossary/i, tip);
		});
	});
});
