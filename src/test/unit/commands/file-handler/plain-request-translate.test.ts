// 非Markdown（ファイル＝1ユニット）の「翻訳待ちに戻す」（need:review → need:translate）の検証。
// need はストアにしか無く本文は変えない。resolveNeed と同じ経路（withFileMutation）を通るので、
// 保存・ステータス更新も同じように走る。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getFileHandler } from "../../../../commands/file-handler/file-handler-factory";
import { PlainFileHandler } from "../../../../commands/file-handler/plain-file-handler";
import type { StatusCollectorPort } from "../../../../core/status/status-collector-port";
import type { FileStatusItem } from "../../../../core/status/status-item";
import { Status, StatusItemType } from "../../../../core/status/status-item";
import { StatusItemTree } from "../../../../core/status/status-item-tree";
import { StatusManager } from "../../../../core/status/status-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { seat } from "../../helpers/unit-state";

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

suite("PlainFileHandler.requestTranslate（need:review → need:translate）", () => {
	let tempDir: string;
	let mdaitDir: string;
	let targetFile: string;
	let collector: RecordingCollector;

	const TARGET_CONTENT = "Adopted translation\r\n";

	async function initConfig(): Promise<Configuration> {
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

	/** 訳文ファイルと、その need 付きの行を用意する */
	function seedTarget(need: string, hash = "tgtA"): void {
		fs.writeFileSync(targetFile, TARGET_CONTENT, "utf-8");
		const store = UnitStateStore.getInstance();
		store.load(mdaitDir);
		store.setEntry({
			path: "en/doc.txt",
			kind: "unit" as const,
			seat: seat(0),
			level: 0,
			titleHash: "",
			hash,
			from: "srcA",
			need,
		});
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-plain-request-translate-"));
		__vscodeMockWorkspaceRoot = tempDir;
		mdaitDir = path.join(tempDir, ".mdait");
		targetFile = path.join(tempDir, "en", "doc.txt");
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

	test("need:review の行が need:translate になり、本文は1バイトも変わらない", async () => {
		await initConfig();
		seedTarget("review");
		const before = fs.readFileSync(targetFile);

		const result = await new PlainFileHandler().requestTranslate(targetFile, { kind: "file" });

		assert.strictEqual(result.requested, true);
		assert.strictEqual(result.changed, true);
		assert.strictEqual(result.hash, "tgtA");
		const entry = UnitStateStore.getInstance().getSoleEntry("en/doc.txt");
		assert.strictEqual(entry?.need, "translate");
		assert.strictEqual(entry?.from, "srcA", "from は変わらないこと");
		assert.ok(fs.readFileSync(targetFile).equals(before), "本文（CRLF）がそのまま残ること");
	});

	test("付け替えた結果は unit-state ファイルに保存され、ステータス更新が走る", async () => {
		await initConfig();
		seedTarget("review");

		await getFileHandler(targetFile).requestTranslate(targetFile, { kind: "file" });

		assert.ok(collector.refreshed.includes(targetFile), "ステータス更新が呼ばれること");
		UnitStateStore.dispose();
		const reloaded = UnitStateStore.getInstance();
		reloaded.load(mdaitDir);
		assert.strictEqual(
			reloaded.getSoleEntry("en/doc.txt")?.need,
			"translate",
			"再読み込みしても translate のままであること",
		);
	});

	test("hash 指定は照合する（一致すれば付け替え、違えば not-found）", async () => {
		await initConfig();
		seedTarget("review");

		const mismatch = await new PlainFileHandler().requestTranslate(targetFile, { kind: "unit", hash: "other" });
		assert.strictEqual(mismatch.requested, false);
		assert.strictEqual(mismatch.reason, "not-found");
		assert.strictEqual(
			UnitStateStore.getInstance().getSoleEntry("en/doc.txt")?.need,
			"review",
			"違う hash では触らないこと",
		);

		const match = await new PlainFileHandler().requestTranslate(targetFile, { kind: "unit", hash: "tgtA" });
		assert.strictEqual(match.requested, true);
		assert.strictEqual(UnitStateStore.getInstance().getSoleEntry("en/doc.txt")?.need, "translate");
	});

	for (const need of ["", "translate", "revise@oldhash", "verify-deletion", "isolate"]) {
		test(`need が「${need || "なし"}」の行は not-review でスキップし、変えない`, async () => {
			await initConfig();
			seedTarget(need);

			const result = await new PlainFileHandler().requestTranslate(targetFile, { kind: "file" });

			assert.strictEqual(result.requested, false);
			assert.strictEqual(result.changed, false);
			assert.strictEqual(result.reason, "not-review");
			assert.strictEqual(UnitStateStore.getInstance().getSoleEntry("en/doc.txt")?.need, need);
			assert.ok(!collector.refreshed.includes(targetFile), "無変更ならステータス更新は呼ばない");
		});
	}

	test("ストアに行が無いファイルは not-found", async () => {
		await initConfig();
		fs.writeFileSync(targetFile, TARGET_CONTENT, "utf-8");
		UnitStateStore.getInstance().load(mdaitDir);

		const result = await new PlainFileHandler().requestTranslate(targetFile, { kind: "file" });

		assert.strictEqual(result.requested, false);
		assert.strictEqual(result.reason, "not-found");
	});
});
