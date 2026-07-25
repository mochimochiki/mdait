// StatusManager の更新通知（ADR-260724-01）の検証。
// 「変更のたびに宛先を判定して部分通知する」のをやめ、変更シグナルをデバウンスで束ねて
// ツリー全体の再描画を1回だけ通知する方式に変えた。その3つの性質
//   (1) 複数の変更が1回にまとまること
//   (2) 最後の変更から必ず1回通知されること（取りこぼさないこと）
//   (3) 変更が途切れず続く場合も上限時間で必ず通知されること（一括処理中に凍らないこと）
// と、要対応を増やす更新でも通知が届くこと（本不具合の再現）を保証する。

import * as assert from "node:assert";
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

/** 実時間待ちのマージン倍率（CIのイベントループ遅延に対する余裕） */
const WAIT_FACTOR = 20;

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

/**
 * ファイルI/Oを伴わない StatusCollectorPort のスタブ。
 * 「どのファイルが実在するか」「collectFileStatus が何を返すか」をテストから制御する。
 */
class StubCollector implements StatusCollectorPort {
	public nextStatus = new Map<string, FileStatusItem>();
	public existingFiles = new Set<string>();

	constructor(
		private readonly rootDirs: string[],
		private readonly initialFiles: FileStatusItem[],
	) {
		for (const file of initialFiles) {
			this.existingFiles.add(file.filePath);
		}
	}

	public async buildStatusItemTree(): Promise<StatusItemTree> {
		const tree = new StatusItemTree();
		tree.buildTree(this.initialFiles, this.rootDirs);
		return tree;
	}

	public async collectFileStatus(filePath: string): Promise<FileStatusItem> {
		return this.nextStatus.get(filePath) ?? makeFileItem(filePath);
	}

	public fileExists(filePath: string): boolean {
		return this.existingFiles.has(filePath);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite("StatusManager（ツリー変更通知の一本化とデバウンス）", () => {
	const jaDir = path.resolve("/mock-workspace/ja");
	let manager: StatusManager;

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		manager = StatusManager.getInstance();
	});

	teardown(() => {
		manager.dispose();
	});

	test("待ち時間内の複数の変更が1回の通知にまとめられること", async () => {
		const debounce = 20;
		manager.setNotifyDebounceMs(debounce, 10_000);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		const tree = manager.getStatusItemTree();
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "a.md")));
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "b.md")));
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "c.md")));

		assert.strictEqual(fired, 0, "待ち時間内はまだ通知されないこと");

		await sleep(debounce * WAIT_FACTOR);
		assert.strictEqual(fired, 1, "3件の変更が1回の通知にまとまること");
	});

	test("最後の変更から必ず1回通知されること（取りこぼさないこと）", async () => {
		const debounce = 20;
		manager.setNotifyDebounceMs(debounce, 10_000);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		const tree = manager.getStatusItemTree();
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "a.md")));
		await sleep(debounce * WAIT_FACTOR);
		tree.addOrUpdateFile(makeFileItem(path.join(jaDir, "b.md")));
		await sleep(debounce * WAIT_FACTOR);

		assert.strictEqual(fired, 2, "変更のまとまりごとに通知されること");
	});

	test("変更が途切れず続いても上限時間で通知されること（一括処理中に凍らないこと）", async () => {
		// デバウンスだけだと、待ち時間より短い間隔で更新が続く一括処理（ディレクトリsync等）の
		// 最中は一度も通知されず、終わるまでツリーが凍って見える
		const debounce = 5_000; // 上限が効かなければ絶対に発火しない長さ
		const maxWait = 30;
		manager.setNotifyDebounceMs(debounce, maxWait);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		const tree = manager.getStatusItemTree();
		const deadline = Date.now() + maxWait * 8;
		let i = 0;
		while (Date.now() < deadline) {
			tree.addOrUpdateFile(makeFileItem(path.join(jaDir, `f${i++}.md`)));
			await sleep(2);
		}

		assert.ok(
			fired >= 1,
			`一括処理の途中でも通知されること（実際の通知回数: ${fired}）`,
		);
	});

	test("flushPendingNotificationで保留中の通知が即座に発行されること", () => {
		manager.setNotifyDebounceMs(5_000, 10_000);
		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		manager
			.getStatusItemTree()
			.addOrUpdateFile(makeFileItem(path.join(jaDir, "a.md")));
		assert.strictEqual(fired, 0);

		manager.flushPendingNotification();
		assert.strictEqual(fired, 1);

		manager.flushPendingNotification();
		assert.strictEqual(fired, 1, "保留がなければ何も起きないこと");
	});

	test("要対応を増やす更新の後、通知が届き集約結果も新しくなること", async () => {
		// 本不具合の再現テスト。翻訳の品質チェックで need:review が付いた状態を
		// refreshFileStatus 経由で再現し、通知と集約の両方が追随することを確認する。
		// 本番と同じデバウンス経路を通す（即時通知に切り替えると経路が変わってしまう）。
		const debounce = 20;
		const filePath = path.join(jaDir, "a.md");
		const collector = new StubCollector(
			[jaDir],
			[makeFileItem(filePath, [makeUnitItem(filePath, "u1", undefined)])],
		);
		manager.setCollector(collector);
		manager.setNotifyDebounceMs(debounce, 10_000);
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
		await sleep(debounce * WAIT_FACTOR);

		assert.strictEqual(fired, 1, "要対応を増やす更新でも通知が届くこと");
		assert.strictEqual(
			manager.getStatusItemTree().getNeedsAttentionUnits().length,
			1,
			"集約結果が新しい要対応を含むこと",
		);
	});

	test("ファイルが消えている場合はツリーから取り除かれること", async () => {
		const filePath = path.join(jaDir, "a.md");
		const collector = new StubCollector(
			[jaDir],
			[makeFileItem(filePath, [makeUnitItem(filePath, "u1", "review")])],
		);
		manager.setCollector(collector);
		manager.setNotifyDebounceMs(0);
		await manager.buildStatusItemTree();
		assert.ok(manager.getStatusItemTree().getFile(filePath));

		collector.existingFiles.delete(filePath);
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

	test("全体再構築は保留中の通知を破棄し、1回だけ通知すること", async () => {
		const debounce = 20;
		const filePath = path.join(jaDir, "a.md");
		const collector = new StubCollector([jaDir], [makeFileItem(filePath)]);
		manager.setCollector(collector);
		manager.setNotifyDebounceMs(debounce, 10_000);

		let fired = 0;
		manager.onStatusTreeChanged(() => {
			fired++;
		});

		// 保留中の通知がある状態で全体再構築する
		manager
			.getStatusItemTree()
			.addOrUpdateFile(makeFileItem(path.join(jaDir, "pending.md")));
		await manager.buildStatusItemTree();

		assert.strictEqual(fired, 1, "再構築直後に1回だけ通知されること");

		await sleep(debounce * WAIT_FACTOR);
		assert.strictEqual(fired, 1, "破棄された保留通知が後から届かないこと");
	});
});
