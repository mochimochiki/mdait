/**
 * @file status-item-tree.test.ts
 * @description StatusItemTreeのテスト（ユニットカウントに焦点を当てたテスト）
 */

import { strict as assert } from "node:assert";
import { StatusItemTree } from "../../../core/status/status-item-tree";
import { Status, StatusItemType, type FileStatusItem, type UnitStatusItem } from "../../../core/status/status-item";

suite("StatusItemTree - Unit Counting", () => {
	test("aggregateProgress: ターゲットユニットのみをカウントする（ソースユニットは除外）", () => {
		const tree = new StatusItemTree();

		// ソースファイル（全ユニットがStatus.Source）
		const sourceFile: FileStatusItem = {
			type: StatusItemType.File,
			label: "source.md",
			status: Status.Source,
			filePath: "/test/source.md",
			fileName: "source.md",
			translatedUnits: 0,
			totalUnits: 3,
			hasParseError: false,
			contextValue: "mdaitFileSource",
			children: [
				{
					type: StatusItemType.Unit,
					label: "Unit 1",
					status: Status.Source,
					unitHash: "hash1",
					filePath: "/test/source.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 2",
					status: Status.Source,
					unitHash: "hash2",
					filePath: "/test/source.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 3",
					status: Status.Source,
					unitHash: "hash3",
					filePath: "/test/source.md",
					contextValue: "mdaitUnitSource",
				},
			],
		};

		// ターゲットファイル（Status.Translatedが2つ、Status.NeedsTranslationが1つ）
		const targetFile: FileStatusItem = {
			type: StatusItemType.File,
			label: "target.md",
			status: Status.NeedsTranslation,
			filePath: "/test/target.md",
			fileName: "target.md",
			translatedUnits: 2,
			totalUnits: 3,
			hasParseError: false,
			contextValue: "mdaitFileTarget",
			children: [
				{
					type: StatusItemType.Unit,
					label: "Unit 1",
					status: Status.Translated,
					unitHash: "thash1",
					fromHash: "hash1",
					filePath: "/test/target.md",
					contextValue: "mdaitUnitTarget",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 2",
					status: Status.Translated,
					unitHash: "thash2",
					fromHash: "hash2",
					filePath: "/test/target.md",
					contextValue: "mdaitUnitTarget",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 3",
					status: Status.NeedsTranslation,
					unitHash: "thash3",
					fromHash: "hash3",
					needFlag: "translate",
					filePath: "/test/target.md",
					contextValue: "mdaitUnitTarget",
				},
			],
		};

		// ツリーを構築
		tree.buildTree([sourceFile, targetFile], ["/test"]);

		// 進捗を集計
		const progress = tree.aggregateProgress();

		// ソースユニット（3つ）は除外され、ターゲットユニット（3つ）のみがカウントされる
		assert.strictEqual(progress.totalUnits, 3, "totalUnitsはターゲットユニットのみをカウントする");
		assert.strictEqual(progress.translatedUnits, 2, "translatedUnitsは翻訳済みユニットをカウントする");
		assert.strictEqual(progress.errorUnits, 0, "errorUnitsはエラーユニットをカウントする");
	});

	test("aggregateDirectoryProgress: ターゲットユニットのみをカウントする（ソースユニットは除外）", () => {
		const tree = new StatusItemTree();

		// ソースファイル
		const sourceFile: FileStatusItem = {
			type: StatusItemType.File,
			label: "source.md",
			status: Status.Source,
			filePath: "/test/docs/source.md",
			fileName: "source.md",
			translatedUnits: 0,
			totalUnits: 2,
			hasParseError: false,
			contextValue: "mdaitFileSource",
			children: [
				{
					type: StatusItemType.Unit,
					label: "Source Unit 1",
					status: Status.Source,
					unitHash: "shash1",
					filePath: "/test/docs/source.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Source Unit 2",
					status: Status.Source,
					unitHash: "shash2",
					filePath: "/test/docs/source.md",
					contextValue: "mdaitUnitSource",
				},
			],
		};

		// ターゲットファイル
		const targetFile: FileStatusItem = {
			type: StatusItemType.File,
			label: "target.md",
			status: Status.Translated,
			filePath: "/test/docs/target.md",
			fileName: "target.md",
			translatedUnits: 2,
			totalUnits: 2,
			hasParseError: false,
			contextValue: "mdaitFileTarget",
			children: [
				{
					type: StatusItemType.Unit,
					label: "Target Unit 1",
					status: Status.Translated,
					unitHash: "thash1",
					fromHash: "shash1",
					filePath: "/test/docs/target.md",
					contextValue: "mdaitUnitTarget",
				},
				{
					type: StatusItemType.Unit,
					label: "Target Unit 2",
					status: Status.Translated,
					unitHash: "thash2",
					fromHash: "shash2",
					filePath: "/test/docs/target.md",
					contextValue: "mdaitUnitTarget",
				},
			],
		};

		// ツリーを構築
		tree.buildTree([sourceFile, targetFile], ["/test/docs"]);

		// ディレクトリの進捗を集計
		const progress = tree.aggregateDirectoryProgress("/test/docs");

		// ソースユニット（2つ）は除外され、ターゲットユニット（2つ）のみがカウントされる
		assert.strictEqual(progress.totalUnits, 2, "totalUnitsはターゲットユニットのみをカウントする");
		assert.strictEqual(progress.translatedUnits, 2, "translatedUnitsは翻訳済みユニットをカウントする");
		assert.strictEqual(progress.errorUnits, 0, "errorUnitsはエラーユニットをカウントする");
	});

	test("aggregateProgress: エラーユニットを正しくカウントする", () => {
		const tree = new StatusItemTree();

		const fileWithError: FileStatusItem = {
			type: StatusItemType.File,
			label: "file.md",
			status: Status.Error,
			filePath: "/test/file.md",
			fileName: "file.md",
			translatedUnits: 1,
			totalUnits: 3,
			hasParseError: false,
			contextValue: "mdaitFileTarget",
			children: [
				{
					type: StatusItemType.Unit,
					label: "Unit 1",
					status: Status.Translated,
					unitHash: "hash1",
					fromHash: "shash1",
					filePath: "/test/file.md",
					contextValue: "mdaitUnitTarget",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 2",
					status: Status.Error,
					unitHash: "hash2",
					fromHash: "shash2",
					filePath: "/test/file.md",
					errorMessage: "Translation failed",
					contextValue: "mdaitUnitTarget",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 3",
					status: Status.NeedsTranslation,
					unitHash: "hash3",
					fromHash: "shash3",
					needFlag: "translate",
					filePath: "/test/file.md",
					contextValue: "mdaitUnitTarget",
				},
			],
		};

		tree.buildTree([fileWithError], ["/test"]);

		const progress = tree.aggregateProgress();

		assert.strictEqual(progress.totalUnits, 3, "totalUnitsは全ターゲットユニットをカウントする");
		assert.strictEqual(progress.translatedUnits, 1, "translatedUnitsは翻訳済みユニットをカウントする");
		assert.strictEqual(progress.errorUnits, 1, "errorUnitsはエラーユニットを正しくカウントする");
	});

	test("aggregateProgress: ソースユニットのみの場合、totalUnitsは0になる", () => {
		const tree = new StatusItemTree();

		const sourceOnlyFile: FileStatusItem = {
			type: StatusItemType.File,
			label: "source-only.md",
			status: Status.Source,
			filePath: "/test/source-only.md",
			fileName: "source-only.md",
			translatedUnits: 0,
			totalUnits: 5,
			hasParseError: false,
			contextValue: "mdaitFileSource",
			children: [
				{
					type: StatusItemType.Unit,
					label: "Unit 1",
					status: Status.Source,
					unitHash: "hash1",
					filePath: "/test/source-only.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 2",
					status: Status.Source,
					unitHash: "hash2",
					filePath: "/test/source-only.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 3",
					status: Status.Source,
					unitHash: "hash3",
					filePath: "/test/source-only.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 4",
					status: Status.Source,
					unitHash: "hash4",
					filePath: "/test/source-only.md",
					contextValue: "mdaitUnitSource",
				},
				{
					type: StatusItemType.Unit,
					label: "Unit 5",
					status: Status.Source,
					unitHash: "hash5",
					filePath: "/test/source-only.md",
					contextValue: "mdaitUnitSource",
				},
			],
		};

		tree.buildTree([sourceOnlyFile], ["/test"]);

		const progress = tree.aggregateProgress();

		// ソースユニットのみなので、totalUnitsは0であるべき
		assert.strictEqual(progress.totalUnits, 0, "ソースユニットのみの場合、totalUnitsは0");
		assert.strictEqual(progress.translatedUnits, 0, "translatedUnitsは0");
		assert.strictEqual(progress.errorUnits, 0, "errorUnitsは0");
	});
});
