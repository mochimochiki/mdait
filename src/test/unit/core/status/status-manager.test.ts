// StatusManager の更新通知（ADR-260724-01）の検証。
// 「変更のたびに宛先を判定して部分通知する」のをやめ、変更シグナルをデバウンスで束ねて
// ツリー全体の再描画を1回だけ通知する方式に変えた。その2つの性質
//   (1) 複数の変更が1回にまとまること
//   (2) 最後の変更から必ず1回通知されること（取りこぼさないこと）
// と、要対応を増やす更新でも通知が届くこと（本不具合の再現）を保証する。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StatusCollectorPort } from "../../../../core/status/status-collector-port";
import {
	type FileStatusItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";
import { StatusManager } from "../../../../core/status/status-manager";

declare let __vscodeMockWorkspaceRoot: string;

function makeUnitItem(
	filePath: string,
	unitHash: string,
	needFlag: string | undefined,
): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: unitHash,
		filePath,
		unitHash,
		needFlag,
		status: needFlag ? Status.NeedsTranslation : Status.Translated,
	};
}

function makeFileItem(
	filePath: string,
	children: UnitStatusItem[] = [],
): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		translatedUnits: 0,
		totalUnits: children.length,
		status: Status.NeedsTranslation,
		children,
	};
}

/** collectFileStatus が返す内容をテストから差し替えられるスタブ */
class StubCollector implements StatusCollectorPort {
	public nextStatus = new Map<string, FileStatusItem>();

	constructor(
		private readonly rootDirs: string[],
		private readonly initialFiles: FileStatusItem[],
	) {}

	public async buildStatusItemTree(): Promise<StatusItemTree> {
		const tree = new StatusItemTree();
		tree.buildTree(this.initialFiles, this.rootDirs);
		return tree;
	}

	public async collectFileStatus(filePath: string): Promise<FileStatusItem> {
		const prepared = this.nextStatus.get(filePath);
		return prepared ?? makeFileItem(filePath);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite("StatusManager（ツリー変更通知の一本化とデバウンス）", () => {
	let tmpDir: string;
	let jaDir: string;
	let manager: StatusManager;

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-status-manager-"));
		jaDir = path.join(tmpDir, "ja");
		fs.mkdirSync(jaDir, { recursive: true });
		manager = StatusManager.getInstance();
	});

	teardown(() => {
		manager.dispose();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("待ち時間内の複数の変更が1回の通知にまとめられること", async () => {
		manager.setNotifyDebounceMs(20);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		const tree = manager.getStatusItemTree();
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "a.md")));
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "b.md")));
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "c.md")));

		assert.strictEqual(fired, 0, "待ち時間内はまだ通知されないこと");

		await sleep(60);
		assert.strictEqual(fired, 1, "3件の変更が1回の通知にまとまること");
	});

	test("最後の変更から必ず1回通知されること（取りこぼさないこと）", async () => {
		manager.setNotifyDebounceMs(20);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		const tree = manager.getStatusItemTree();
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "a.md")));
		await sleep(60);
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "b.md")));
		await sleep(60);

		assert.strictEqual(fired, 2, "変更のまとまりごとに通知されること");
	});

	test("flushPendingNotificationで保留中の通知が即座に発行されること", () => {
		manager.setNotifyDebounceMs(1000);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		manager.getStatusItemTree().addOrUpdateFile(makeFileItem(path.join(jaDir, "a.md")));
		assert.strictEqual(fired, 0);

		manager.flushPendingNotification();
		assert.strictEqual(fired, 1);

		manager.flushPendingNotification();
		assert.strictEqual(fired, 1, "保留がなければ何も起きないこと");
	});

	test("要対応を増やす更新の後、通知が届き集約結果も新しくなること", async () => {
		// 本不具合の再現テスト。翻訳の品質チェックで need:review が付いた状態を
		// refreshFileStatus 経由で再現し、通知と集約の両方が追随することを確認する。
		const filePath = path.join(jaDir, "a.md");
		fs.writeFileSync(filePath, "# doc\n", "utf-8");

		const collector = new StubCollector(
			[jaDir],
			[makeFileItem(filePath, [makeUnitItem(filePath, "u1", undefined)])],
		);
		manager.setCollector(collector);
		manager.setNotifyDebounceMs(0);
		await manager.buildStatusItemTree();

		assert.strictEqual(
			manager.getStatusItemTree().getNeedsAttentionUnits().length,
			0,
			"翻訳前は要対応が0件であること",
		);

		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		collector.nextStatus.set(
			filePath,
			makeFileItem(filePath, [makeUnitItem(filePath, "u1", "review")]),
		);
		await manager.refreshFileStatus(filePath);

		assert.strictEqual(fired, 1, "要対応を増やす更新でも通知が届くこと");
		assert.strictEqual(
			manager.getStatusItemTree().getNeedsAttentionUnits().length,
			1,
			"集約結果が新しい要対応を含むこと",
		);
	});

	test("ファイルが消えている場合はツリーから取り除かれること", async () => {
		const filePath = path.join(jaDir, "a.md");
		fs.writeFileSync(filePath, "# doc\n", "utf-8");

		const collector = new StubCollector(
			[jaDir],
			[makeFileItem(filePath, [makeUnitItem(filePath, "u1", "review")])],
		);
		manager.setCollector(collector);
		manager.setNotifyDebounceMs(0);
		await manager.buildStatusItemTree();
		assert.ok(manager.getStatusItemTree().getFile(filePath));

		fs.rmSync(filePath);
		await manager.refreshFileStatus(filePath);

		assert.strictEqual(
			manager.getStatusItemTree().getFile(filePath),
			undefined,
			"削除されたファイルがツリーから消えること",
		);
		assert.deepStrictEqual(
			manager.getStatusItemTree().getNeedsAttentionUnits(),
			[],
			"削除されたファイルの要対応も消えること",
		);
	});
});
