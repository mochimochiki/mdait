/**
 * ステータスバーの常駐表示のテスト。
 */

import { strict as assert } from "node:assert";
import type { StatusManager } from "../../../../core/status/status-manager";
import { type UnitStateEntry, UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import type { Configuration } from "../../../../infra/config/configuration";
import { StatusBarSummary } from "../../../../ui/status/status-bar-summary";
import { invalidateWorkspaceConflicts } from "../../../../ui/status/conflict-source";

suite("ステータスバーの常駐表示", () => {
	const store = UnitStateStore.getInstance() as unknown as { getAllEntries: () => UnitStateEntry[] };
	let originalGetAllEntries: () => UnitStateEntry[];

	setup(() => {
		originalGetAllEntries = store.getAllEntries;
		invalidateWorkspaceConflicts();
	});

	teardown(() => {
		store.getAllEntries = originalGetAllEntries;
		invalidateWorkspaceConflicts();
	});

	test("マージで降ろされた行だけが残っているとき、描き直しが止まる", async () => {
		// 競合したファイルが無いと人が決める件の計画は作られない。作れないのに描き直すと、
		// 次の描画がまた計画を取りに行き、拡張機能ごと固まる
		store.getAllEntries = () => [
			{
				path: "en/a.md",
				kind: "held",
				seat: "u50000000",
				level: 2,
				titleHash: "",
				hash: "aaaaaaaa",
				from: "bbbbbbbb",
				need: "",
			},
		];
		const configuration = {
			isConfigured: () => true,
			getUnitStateFilePath: () => "/nonexistent/unit-state",
			getUnitRegistryFilePath: () => "/nonexistent/unit-registry",
			getTmFilePath: () => "/nonexistent/translations.tmx",
			getTermsFilePath: () => "/nonexistent/terms.csv",
			getConfigBaseDir: () => "/nonexistent",
			transPairs: [],
		} as unknown as Configuration;
		const tree = {
			countPendingTranslationUnits: () => 0,
			getNeedsAttentionItems: () => [],
			countOrphanTargetFiles: () => 0,
		};
		const statusManager = {
			getStatusItemTree: () => tree,
			onStatusTreeChanged: () => ({ dispose() {} }),
		} as unknown as StatusManager;

		const summary = new StatusBarSummary(statusManager, configuration);
		let refreshes = 0;
		const refresh = summary.refresh.bind(summary);
		summary.refresh = () => {
			refreshes++;
			if (refreshes > 20) {
				throw new Error("描き直しが止まらない");
			}
			refresh();
		};
		summary.refresh();
		// 後続の描き直しが走りきるまで待つ
		await new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(refreshes, 1);
		summary.dispose();
	});
});
