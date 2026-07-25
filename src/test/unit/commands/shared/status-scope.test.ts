// 表示範囲の算出（getSelectedScopeDirs）の検証。
// ステータスツリー本体・要対応キュー・「次の要対応へ」が同じ範囲を見るための唯一の算出点であり、
// ここがズレると「ツリーに出ていないファイルの項目が要対応にだけ並ぶ」不整合が起きる。

import * as assert from "node:assert";
import * as path from "node:path";
import { getSelectedScopeDirs } from "../../../../commands/shared/status-scope";
import { SelectionState } from "../../../../core/status/selection-state";
import {
	type FileStatusItem,
	Status,
	StatusItemType,
} from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";
import type { TransPair } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

const BASE_DIR = path.resolve("/mock-workspace");

const jaPair: TransPair = {
	sourceDir: "en",
	targetDir: "ja",
	sourceLang: "en",
	targetLang: "ja",
};
const koPair: TransPair = {
	sourceDir: "en",
	targetDir: "ko",
	sourceLang: "en",
	targetLang: "ko",
};

function makeConfig(pairs: TransPair[]) {
	return {
		getConfigBaseDir: () => BASE_DIR,
		transPairs: pairs,
	};
}

suite("getSelectedScopeDirs（表示範囲の算出）", () => {
	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
	});

	test("選択中ペアの source/target が絶対パスで返ること", () => {
		SelectionState.getInstance().reconcileWith([jaPair]);

		assert.deepStrictEqual(getSelectedScopeDirs(makeConfig([jaPair])), [
			path.join(BASE_DIR, "en"),
			path.join(BASE_DIR, "ja"),
		]);
	});

	test("選択外のペアのディレクトリは含まれないこと", () => {
		// 先頭ペア（ja）だけが選択された状態に補正される
		SelectionState.getInstance().reconcileWith([jaPair, koPair]);

		const dirs = getSelectedScopeDirs(makeConfig([jaPair, koPair]));

		assert.ok(dirs.includes(path.join(BASE_DIR, "ja")));
		assert.ok(
			!dirs.includes(path.join(BASE_DIR, "ko")),
			"選択外の ko が含まれないこと",
		);
	});

	test("複数ペアで共有される source ディレクトリが重複しないこと", () => {
		SelectionState.getInstance().reconcileWith([jaPair, koPair]);
		SelectionState.getInstance().updateSelection(["ja", "ko"]);

		const dirs = getSelectedScopeDirs(makeConfig([jaPair, koPair]));

		assert.deepStrictEqual(dirs, [
			path.join(BASE_DIR, "en"),
			path.join(BASE_DIR, "ja"),
			path.join(BASE_DIR, "ko"),
		]);
	});
});

suite("StatusItemTree.getFilesInScope（集計範囲の絞り込み）", () => {
	let tree: StatusItemTree;

	function makeFile(filePath: string): FileStatusItem {
		return {
			type: StatusItemType.File,
			label: path.basename(filePath),
			filePath,
			fileName: path.basename(filePath),
			translatedUnits: 0,
			totalUnits: 1,
			status: Status.NeedsTranslation,
		};
	}

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		tree = new StatusItemTree();
		tree.buildTree(
			[
				makeFile(path.join(BASE_DIR, "en", "a.md")),
				makeFile(path.join(BASE_DIR, "ja", "a.md")),
				makeFile(path.join(BASE_DIR, "ko", "a.md")),
			],
			["en", "ja", "ko"],
			BASE_DIR,
		);
	});

	teardown(() => {
		tree.dispose();
	});

	test("対象ディレクトリ配下のファイルだけが返ること", () => {
		// LM Tools の全体集計を人間のツリーと同じ範囲に揃えるための絞り込み。
		// 範囲が食い違うと、エージェントだけが「誰も処理しない件数」を報告する
		const files = tree.getFilesInScope([
			path.join(BASE_DIR, "en"),
			path.join(BASE_DIR, "ja"),
		]);

		assert.deepStrictEqual(
			files.map((f) => path.basename(path.dirname(f.filePath))).sort(),
			["en", "ja"],
		);
	});

	test("未指定なら全ファイルが返ること", () => {
		assert.strictEqual(tree.getFilesInScope().length, 3);
	});
});
