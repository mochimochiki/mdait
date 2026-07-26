// need を外したあとステータス更新が必ず走ることの回帰テスト。
//
// 背景: CodeLens がサーフェスごとにマーカーを直接書き換えていたため、
// frontmatter と非Markdownファイルの「完了マーク」ではステータス更新が呼ばれず、
// 本文マーカーの更新も sync.autoSyncOnSave が有効なときにだけ偶然直っていた。
// ユーザーには「押すと直る／放っておくとズレる」として現れる。
//
// 現在はすべての書き換えが getFileHandler → withFileMutation を通るため、
// どの経路でも更新が走る。ここはその不変条件を守る番人である。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFileHandler } from "../../../../commands/file-handler/file-handler-factory";
import type { StatusCollectorPort } from "../../../../core/status/status-collector-port";
import type { FileStatusItem } from "../../../../core/status/status-item";
import { Status, StatusItemType } from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";
import { StatusManager } from "../../../../core/status/status-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

/** 再収集を要求されたファイルを記録するだけのスタブ */
class RecordingCollector implements StatusCollectorPort {
	readonly refreshed: string[] = [];

	async collectFileStatus(filePath: string): Promise<FileStatusItem> {
		this.refreshed.push(filePath);
		return {
			type: StatusItemType.File,
			label: path.basename(filePath),
			status: Status.Translated,
			filePath,
			fileName: path.basename(filePath),
			translatedUnits: 0,
			totalUnits: 0,
			children: [],
		};
	}

	async buildStatusItemTree(): Promise<StatusItemTree> {
		return new StatusItemTree();
	}

	fileExists(filePath: string): boolean {
		return fs.existsSync(filePath);
	}
}

suite("need 解決後のステータス更新（どのファイル種別でも走ること）", () => {
	let tempDir: string;
	let collector: RecordingCollector;

	async function initConfig(): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				trans: { extensions: [".txt"] },
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-refresh-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		collector = new RecordingCollector();
		StatusManager.getInstance().setCollector(collector);
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("本文ユニットのneed解決でステータス更新が走る", async () => {
		await initConfig();
		const file = path.join(tempDir, "en", "doc.md");
		fs.writeFileSync(file, "<!-- mdait tgtA from:srcA need:review -->\n## A\n\nBody.\n", "utf-8");

		const result = await getFileHandler(file).resolveNeed(file, {
			targets: [{ kind: "unit", hash: "tgtA" }],
			needs: ["review"],
		});

		assert.strictEqual(result.resolved.length, 1);
		assert.ok(collector.refreshed.includes(file), "ステータス更新が呼ばれること");
	});

	test("frontmatterのneed解決でステータス更新が走る", async () => {
		await initConfig();
		const file = path.join(tempDir, "en", "fm.md");
		fs.writeFileSync(file, "---\ntitle: T\nmdait:\n  front: fmA from:fmS need:review\n---\n\nBody.\n", "utf-8");

		const result = await getFileHandler(file).resolveNeed(file, {
			targets: [{ kind: "frontmatter" }],
			needs: ["review"],
		});

		assert.strictEqual(result.resolved.length, 1, "frontmatter の need が解決されること");
		assert.ok(collector.refreshed.includes(file), "ステータス更新が呼ばれること");
		assert.ok(!fs.readFileSync(file, "utf-8").includes("need:review"), "frontmatter マーカーから need が消えること");
	});

	test("非Markdownファイルのneed解決でステータス更新が走る", async () => {
		const config = await initConfig();
		const file = path.join(tempDir, "en", "doc.txt");
		fs.writeFileSync(file, "hello\n", "utf-8");

		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: "en/doc.txt",
			order: 0,
			level: 0,
			titleHash: "",
			hash: "tgtA",
			from: "srcA",
			need: "translate",
		});

		const result = await getFileHandler(file).resolveNeed(file, {
			targets: [{ kind: "file" }],
			needs: ["translate"],
		});

		assert.strictEqual(result.resolved.length, 1);
		assert.ok(collector.refreshed.includes(file), "ステータス更新が呼ばれること");
		assert.strictEqual(
			UnitStateStore.getInstance().getEntry("en/doc.txt", 0)?.need,
			"",
			"unit-state の need が空になること",
		);
		assert.strictEqual(fs.readFileSync(file, "utf-8"), "hello\n", "本文は不変であること");
		assert.ok(config.trans.extensions?.includes(".txt"));

		// 非Markdownファイルの need はマーカーモードに関わらず unit-state に載るため、
		// embedded でもディスクへ保存されていなければ再読み込みで need が復活する
		const persisted = fs.readFileSync(path.join(tempDir, ".mdait", "unit-state"), "utf-8");
		const row = persisted.split("\n").find((l) => l.startsWith("en/doc.txt\t"));
		assert.ok(row, "unit-state に行が書き出されていること");
		assert.ok(!row.endsWith("translate"), `need が残っている: ${row}`);
	});

	test("解決対象がないときはステータス更新を走らせない（冪等）", async () => {
		await initConfig();
		const file = path.join(tempDir, "en", "done.md");
		fs.writeFileSync(file, "<!-- mdait tgtA from:srcA -->\n## A\n\nBody.\n", "utf-8");

		const result = await getFileHandler(file).resolveNeed(file, {
			targets: [{ kind: "unit", hash: "tgtA" }],
			needs: ["review"],
		});

		assert.strictEqual(result.changed, false);
		assert.ok(!collector.refreshed.includes(file), "無変更ならステータス更新は呼ばない");
	});
});
