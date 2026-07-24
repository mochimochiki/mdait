import * as assert from "node:assert";
import * as path from "node:path";
import {
	type FileStatusItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";

declare let __vscodeMockWorkspaceRoot: string;

/** テスト用 FileStatusItem を生成 */
function makeFileItem(
	filePath: string,
	status: Status = Status.NeedsTranslation,
	children?: UnitStatusItem[],
): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		translatedUnits: 0,
		totalUnits: 1,
		status,
		...(children ? { children } : {}),
	};
}

/** テスト用 UnitStatusItem を生成 */
function makeUnitItem(
	filePath: string,
	unitHash: string,
	needFlag: string | undefined,
	status: Status = Status.Translated,
	extra?: Partial<UnitStatusItem>,
): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: unitHash,
		filePath,
		unitHash,
		needFlag,
		status,
		...extra,
	};
}

suite("StatusItemTree", () => {
	let tree: StatusItemTree;

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace"; // 他テストが変更した場合でも確実にリセット
		tree = new StatusItemTree();
	});

	teardown(() => {
		tree.dispose();
	});

	suite("buildTree / getRootDir（サブフォルダシナリオ）", () => {
		test("configBaseDir を渡すとサブフォルダ基準でルートが解決されること", () => {
			// サブフォルダ（/mock-workspace/sub）を configBaseDir として渡す
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const jaDir = path.resolve(configBaseDir, "ja");
			const fileItem = makeFileItem(path.join(jaDir, "file.md"));

			tree.buildTree([fileItem], ["ja"], configBaseDir);

			// サブフォルダ基準で ja ディレクトリが登録されていること
			const jaItem = tree.getDirectory(jaDir);
			assert.ok(
				jaItem,
				"configBaseDirのサブフォルダ基準でjaディレクトリが登録されていること",
			);
		});

		test("configBaseDir なしの場合でもワークスペースルート基準で動作すること", () => {
			// configBaseDir なし → mock の workspaceFolders[0] (/mock-workspace) を使用
			const jaDir = path.resolve("/mock-workspace/ja");
			const fileItem = makeFileItem(path.join(jaDir, "file.md"));

			assert.doesNotThrow(() => {
				tree.buildTree([fileItem], ["ja"]);
			});

			const jaItem = tree.getDirectory(jaDir);
			assert.ok(
				jaItem,
				"ワークスペースルート基準でjaディレクトリが登録されていること",
			);
		});

		test("buildTree後にclearすると全データがリセットされること", () => {
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const jaDir = path.resolve(configBaseDir, "ja");
			const fileItem = makeFileItem(path.join(jaDir, "file.md"));

			tree.buildTree([fileItem], ["ja"], configBaseDir);
			assert.ok(!tree.isEmpty(), "buildTree後はファイルが登録されていること");

			tree.clear();
			assert.ok(tree.isEmpty(), "clear後はファイルが空であること");
		});

		test("ワークスペースルートと異なるconfigBaseDirでもディレクトリが正しく登録されること", () => {
			// workspaceRoot = /mock-workspace, configBaseDir = /mock-workspace/sub
			// この2つが異なる場合でもパスが正しく解決される
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const enDir = path.resolve(configBaseDir, "en");
			const jaDir = path.resolve(configBaseDir, "ja");
			const sourceFile = makeFileItem(
				path.join(enDir, "doc.md"),
				Status.Source,
			);
			const targetFile = makeFileItem(
				path.join(jaDir, "doc.md"),
				Status.NeedsTranslation,
			);

			tree.buildTree([sourceFile, targetFile], ["en", "ja"], configBaseDir);

			assert.ok(tree.getDirectory(enDir), "enディレクトリが登録されていること");
			assert.ok(tree.getDirectory(jaDir), "jaディレクトリが登録されていること");
		});

		test("buildTree後に外部からaddOrUpdateFileを呼ぶとonTreeChangedイベントが発火すること", () => {
			// バグ2シナリオ: 翻訳後にrefreshFileStatus → addOrUpdateFile が呼ばれるケース
			// buildTreeでconfigBaseDirを設定した後、外部からaddOrUpdateFileを呼んでも
			// getRootDirがconfigBaseDirを使って正しくルートを解決し、イベントが発火することを確認する
			const configBaseDir = path.resolve("/mock-workspace/sub");
			const jaDir = path.resolve(configBaseDir, "ja");
			const initialFileItem = makeFileItem(path.join(jaDir, "file1.md"));

			tree.buildTree([initialFileItem], ["ja"], configBaseDir);

			// buildTree後にリスナーを登録して外部呼び出しのイベントを検知
			let firedCount = 0;
			tree.onTreeChanged(() => {
				firedCount++;
			});

			// 翻訳完了後にrefreshFileStatusから呼ばれるシナリオを再現
			const translatedFileItem = makeFileItem(
				path.join(jaDir, "file1.md"),
				Status.Translated,
			);
			tree.addOrUpdateFile(translatedFileItem);

			assert.strictEqual(
				firedCount,
				1,
				"addOrUpdateFile後にonTreeChangedイベントが1回発火すること",
			);
		});
	});

	suite("getNeedsAttentionUnits（Needs Attention仮想ノードの集約ロジック）", () => {
		test("review/verify-deletionのユニットのみを全ファイル横断で集める", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const fileA = makeFileItem(path.join(jaDir, "a.md"), Status.Translated, [
				makeUnitItem(path.join(jaDir, "a.md"), "reviewUnit", "review"),
				makeUnitItem(path.join(jaDir, "a.md"), "translateUnit", "translate"),
				makeUnitItem(path.join(jaDir, "a.md"), "cleanUnit", undefined),
			]);
			const fileB = makeFileItem(path.join(jaDir, "b.md"), Status.Translated, [
				makeUnitItem(path.join(jaDir, "b.md"), "deletionUnit", "verify-deletion"),
				makeUnitItem(path.join(jaDir, "b.md"), "isolateUnit", "isolate"),
			]);

			tree.buildTree([fileA, fileB], ["ja"]);

			const matches = tree.getNeedsAttentionUnits();
			assert.deepStrictEqual(
				matches.map((u) => u.unitHash).sort(),
				["deletionUnit", "reviewUnit"],
			);
		});

		test("該当ユニットが無ければ空配列を返す", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const fileA = makeFileItem(path.join(jaDir, "a.md"), Status.Translated, [
				makeUnitItem(path.join(jaDir, "a.md"), "cleanUnit", undefined),
			]);

			tree.buildTree([fileA], ["ja"]);

			assert.deepStrictEqual(tree.getNeedsAttentionUnits(), []);
		});

		test("scopeDirsを渡すと対象ディレクトリ配下のユニットだけが集約されること", () => {
			// ツリー本体は選択中の transPair だけを表示するため、要対応も同じ範囲に揃える
			const jaDir = path.resolve("/mock-workspace/ja");
			const frDir = path.resolve("/mock-workspace/fr");
			const jaFile = makeFileItem(path.join(jaDir, "a.md"), Status.Translated, [
				makeUnitItem(path.join(jaDir, "a.md"), "jaUnit", "review"),
			]);
			const frFile = makeFileItem(path.join(frDir, "a.md"), Status.Translated, [
				makeUnitItem(path.join(frDir, "a.md"), "frUnit", "review"),
			]);

			tree.buildTree([jaFile, frFile], ["ja", "fr"]);

			assert.deepStrictEqual(
				tree.getNeedsAttentionUnits([jaDir]).map((u) => u.unitHash),
				["jaUnit"],
				"選択外のディレクトリのユニットは集約されないこと",
			);
			assert.strictEqual(
				tree.getNeedsAttentionUnits().length,
				2,
				"scopeDirs未指定なら全ファイルが対象であること",
			);
		});

		test("scopeDirsの比較がパス境界で行われ、en と en-US が混ざらないこと", () => {
			const enDir = path.resolve("/mock-workspace/en");
			const enUsDir = path.resolve("/mock-workspace/en-US");
			const enFile = makeFileItem(path.join(enDir, "a.md"), Status.Translated, [
				makeUnitItem(path.join(enDir, "a.md"), "enUnit", "review"),
			]);
			const enUsFile = makeFileItem(
				path.join(enUsDir, "a.md"),
				Status.Translated,
				[makeUnitItem(path.join(enUsDir, "a.md"), "enUsUnit", "review")],
			);

			tree.buildTree([enFile, enUsFile], ["en", "en-US"]);

			assert.deepStrictEqual(
				tree.getNeedsAttentionUnits([enDir]).map((u) => u.unitHash),
				["enUnit"],
				"en-US 配下のユニットが en の集約に混入しないこと",
			);
		});

		test("投入順に依らずファイルパス昇順→開始行昇順で安定ソートされること", () => {
			// 並びが揺れると「項目が増えた・入れ替わった」という不安を生むため順序を固定する
			const jaDir = path.resolve("/mock-workspace/ja");
			const aPath = path.join(jaDir, "a.md");
			const bPath = path.join(jaDir, "b.md");
			const fileB = makeFileItem(bPath, Status.Translated, [
				makeUnitItem(bPath, "b20", "review", Status.NeedsTranslation, {
					startLine: 20,
				}),
				makeUnitItem(bPath, "b5", "review", Status.NeedsTranslation, {
					startLine: 5,
				}),
			]);
			const fileA = makeFileItem(aPath, Status.Translated, [
				makeUnitItem(aPath, "a10", "verify-deletion", Status.NeedsTranslation, {
					startLine: 10,
				}),
			]);

			// 投入順を変えた2本のツリーで同じ並びになることを確認する
			tree.buildTree([fileB, fileA], ["ja"]);
			const order1 = tree.getNeedsAttentionUnits().map((u) => u.unitHash);

			const other = new StatusItemTree();
			try {
				other.buildTree([fileA, fileB], ["ja"]);
				const order2 = other.getNeedsAttentionUnits().map((u) => u.unitHash);
				assert.deepStrictEqual(order1, ["a10", "b5", "b20"]);
				assert.deepStrictEqual(order2, order1, "投入順が変わっても並びが同じこと");
			} finally {
				other.dispose();
			}
		});
	});

	suite("ユニット索引の張り直し（ゴースト残留の防止）", () => {
		test("ハッシュが変わると旧ユニットが索引から消えること", () => {
			// 原文の見出し変更などでハッシュが変わったとき、旧ユニットが索引に残ると
			// getUnitByHash / getTargetUnitByFromHash が実在しないユニットを返してしまう
			const jaDir = path.resolve("/mock-workspace/ja");
			const filePath = path.join(jaDir, "a.md");
			tree.buildTree(
				[
					makeFileItem(filePath, Status.Translated, [
						makeUnitItem(filePath, "oldHash", undefined, Status.Translated, {
							fromHash: "oldFrom",
						}),
					]),
				],
				["ja"],
			);
			assert.ok(tree.getUnitByHash("oldHash"), "更新前は旧ハッシュで引けること");

			// 同じファイルをハッシュの変わったユニットで更新（refreshFileStatus 相当）
			tree.addOrUpdateFile(
				makeFileItem(filePath, Status.Translated, [
					makeUnitItem(filePath, "newHash", undefined, Status.Translated, {
						fromHash: "newFrom",
					}),
				]),
			);

			assert.strictEqual(
				tree.getUnitByHash("oldHash"),
				undefined,
				"旧ハッシュのユニットが索引に残っていないこと",
			);
			assert.strictEqual(
				tree.getTargetUnitByFromHash("oldFrom"),
				undefined,
				"旧fromのユニットが索引に残っていないこと",
			);
			assert.ok(tree.getUnitByHash("newHash"), "新ハッシュで引けること");
			assert.ok(tree.getTargetUnitByFromHash("newFrom"), "新fromで引けること");
		});

		test("索引とchildrenが同一インスタンスを指し、updateUnitの結果が両方に反映されること", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const filePath = path.join(jaDir, "a.md");
			tree.buildTree(
				[
					makeFileItem(filePath, Status.Translated, [
						makeUnitItem(filePath, "u1", "review", Status.NeedsTranslation),
					]),
				],
				["ja"],
			);

			tree.updateUnit(filePath, "u1", { needFlag: undefined });

			assert.strictEqual(tree.getUnit("u1", filePath)?.needFlag, undefined);
			assert.strictEqual(
				tree.getUnitsInFile(filePath)[0].needFlag,
				undefined,
				"children側にも同じ更新が反映されること",
			);
			assert.deepStrictEqual(
				tree.getNeedsAttentionUnits(),
				[],
				"need解決後は要対応から外れること",
			);
		});
	});

	suite("removeFile（削除・リネームの反映）", () => {
		test("削除したファイルがファイル・ユニット・要対応から消えること", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const aPath = path.join(jaDir, "a.md");
			const bPath = path.join(jaDir, "b.md");
			tree.buildTree(
				[
					makeFileItem(aPath, Status.Translated, [
						makeUnitItem(aPath, "aUnit", "review", Status.NeedsTranslation),
					]),
					makeFileItem(bPath, Status.Translated, [
						makeUnitItem(bPath, "bUnit", "review", Status.NeedsTranslation),
					]),
				],
				["ja"],
			);
			assert.strictEqual(tree.getNeedsAttentionUnits().length, 2);

			const removed = tree.removeFile(aPath);

			assert.strictEqual(removed, true);
			assert.strictEqual(tree.getFile(aPath), undefined, "ファイルが消えること");
			assert.strictEqual(
				tree.getUnitByHash("aUnit"),
				undefined,
				"ユニット索引からも消えること",
			);
			assert.deepStrictEqual(
				tree.getNeedsAttentionUnits().map((u) => u.unitHash),
				["bUnit"],
				"要対応からも消えること",
			);
			assert.deepStrictEqual(
				tree.getDirectoryChildren(jaDir).map((i) => i.label),
				["b.md"],
				"ディレクトリの子要素からも消えること",
			);
		});

		test("存在しないファイルのremoveFileはfalseを返し、何も壊さないこと（冪等）", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const aPath = path.join(jaDir, "a.md");
			tree.buildTree([makeFileItem(aPath, Status.Translated)], ["ja"]);

			assert.strictEqual(tree.removeFile(path.join(jaDir, "missing.md")), false);
			assert.strictEqual(tree.removeFile(aPath), true);
			assert.strictEqual(tree.removeFile(aPath), false, "2回目はfalseであること");
			assert.ok(tree.isEmpty());
		});

		test("配下が空になったサブディレクトリは取り除かれ、ルートは残ること", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const subDir = path.join(jaDir, "guide");
			const subPath = path.join(subDir, "a.md");
			tree.buildTree([makeFileItem(subPath, Status.Translated)], ["ja"]);
			assert.ok(tree.getDirectory(subDir), "削除前はサブディレクトリが存在すること");

			tree.removeFile(subPath);

			assert.strictEqual(
				tree.getDirectory(subDir),
				undefined,
				"空になったサブディレクトリが消えること",
			);
			assert.ok(
				tree.getDirectory(jaDir),
				"ルートディレクトリは空でも残ること（選択中の対象は常に表示する）",
			);
		});
	});

	suite("ディレクトリ集計のパス境界比較", () => {
		test("en の集計に en-US 配下のファイルが混入しないこと", () => {
			const enDir = path.resolve("/mock-workspace/en");
			const enUsDir = path.resolve("/mock-workspace/en-US");
			const enFile = makeFileItem(path.join(enDir, "a.md"));
			const enUsFile = makeFileItem(path.join(enUsDir, "a.md"));

			tree.buildTree([enFile, enUsFile], ["en", "en-US"], "/mock-workspace");

			assert.strictEqual(
				tree.getFilesInDirectoryRecursive(enDir).length,
				1,
				"en 配下のファイルは1件であること",
			);
			assert.strictEqual(
				tree.getDirectory(enDir)?.totalUnits,
				1,
				"en の集計に en-US のユニットが加算されないこと",
			);
			assert.deepStrictEqual(
				tree.getDirectoryChildren(enDir).map((i) => i.label),
				["a.md"],
				"en-US が en のサブディレクトリとして現れないこと",
			);
		});
	});

	suite("変更通知（宛先を判定せず1本のシグナルにまとめる）", () => {
		test("要対応を増やす更新でも通知が発行され、集約結果が即座に新しくなること", () => {
			// 本不具合の再現テスト: 以前は要対応を増やす更新でルート集計が再評価されず、
			// 件数だけが古いスナップショットのまま凍結していた
			const jaDir = path.resolve("/mock-workspace/ja");
			const filePath = path.join(jaDir, "a.md");
			tree.buildTree(
				[
					makeFileItem(filePath, Status.Translated, [
						makeUnitItem(filePath, "u1", undefined, Status.Translated),
					]),
				],
				["ja"],
			);
			assert.strictEqual(tree.getNeedsAttentionUnits().length, 0);

			let fired = 0;
			tree.onTreeChanged(() => {
				fired++;
			});

			// 翻訳の品質チェックで need:review が付いた状態を再現（refreshFileStatus 相当）
			tree.addOrUpdateFile(
				makeFileItem(filePath, Status.NeedsTranslation, [
					makeUnitItem(filePath, "u1", "review", Status.NeedsTranslation),
				]),
			);

			assert.strictEqual(fired, 1, "変更が1回通知されること");
			assert.strictEqual(
				tree.getNeedsAttentionUnits().length,
				1,
				"通知後の集約結果に新しい要対応が含まれること",
			);
		});

		test("removeFile でも通知が発行されること", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			const filePath = path.join(jaDir, "a.md");
			tree.buildTree([makeFileItem(filePath, Status.Translated)], ["ja"]);

			let fired = 0;
			tree.onTreeChanged(() => {
				fired++;
			});
			tree.removeFile(filePath);

			assert.strictEqual(fired, 1);
		});

		test("buildTree中はファイルごとに通知せず、完了後に1回だけ通知すること", () => {
			const jaDir = path.resolve("/mock-workspace/ja");
			let fired = 0;
			tree.onTreeChanged(() => {
				fired++;
			});

			tree.buildTree(
				[
					makeFileItem(path.join(jaDir, "a.md")),
					makeFileItem(path.join(jaDir, "b.md")),
					makeFileItem(path.join(jaDir, "c.md")),
				],
				["ja"],
			);

			assert.strictEqual(fired, 1);
		});
	});
});
