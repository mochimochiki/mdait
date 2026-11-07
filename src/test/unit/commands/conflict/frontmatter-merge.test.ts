/**
 * frontmatter の状態が合流でぶつかったときの通しのテスト（external）。
 *
 * frontmatter の状態は対象キー全部をまとめた1行（`unit-state` の `front` 行）で持つ。
 * `title` を直した人と `description` を直した人を合流させると、この1行が両側で書き換わって
 * 競合する。キーごとに行を分ける案（merge-resilience.md「残っている対策案」1）は採らず、
 * **競合の解決と次の同期で片付く**ことをここで固定する。
 *
 * 約束は3つ。
 * - 解決 → 同期のあと、競合として人の前に残る件が無い
 * - 原稿（原文・訳文の frontmatter）を1文字も書き換えない
 * - 原稿がどちらの版とも違う（両方の直しが入った）なら、訳文の frontmatter を改訂待ちにする。
 *   片方の直しの訳しか確かめていない状態を「訳し終えた」と言わないため
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyUnitStateResolution } from "../../../../commands/conflict/targets/state-target";
import { sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore, isHeldBackEntry, isMergeHeldEntry } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { resetUnitStateLock } from "../../../../infra/workspace/unit-state-lock";

declare let __vscodeMockWorkspaceRoot: string;

const body = (lines: string[]) => lines.join("\n");
const source = (title: string, description: string) =>
	body(["---", `title: ${title}`, `description: ${description}`, "---", "", "# 概要", "", "本文。", ""]);
const target = (title: string, description: string) =>
	body(["---", `title: ${title}`, `description: ${description}`, "---", "", "# Overview", "", "Body.", ""]);

suite("frontmatter の状態の競合は、解決と同期で片付く（external）", () => {
	let tempDir: string;
	let mdaitDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		resetUnitStateLock();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-fm-merge-"));
		__vscodeMockWorkspaceRoot = tempDir;
		mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.mkdirSync(mdaitDir, { recursive: true });
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		resetUnitStateLock();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function initConfig(): Promise<Configuration> {
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode: "external" },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);
		return config;
	}

	/** ある版の原稿で同期し、frontmatter を「訳し終えた」状態にして、その版の front 行を返す */
	async function frontRowFor(config: Configuration, src: string, tgt: string): Promise<string> {
		fs.writeFileSync(sourceFile, src, "utf-8");
		fs.writeFileSync(targetFile, tgt, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		const store = UnitStateStore.getInstance();
		const front = store.getFrontMatterEntry("en/doc.md");
		assert.ok(front, "前提: frontmatter の行ができる");
		store.setFrontMatterEntry("en/doc.md", { hash: front.hash, from: front.from, need: "" });
		store.save(mdaitDir);
		const line = fs
			.readFileSync(path.join(mdaitDir, "unit-state"), "utf-8")
			.split("\n")
			.find((l) => l.split("\t")[1] === "front");
		assert.ok(line, "前提: front 行が書かれている");
		return line;
	}

	test("title と description を別々に直した2人を合流させても、競合が残らず原稿も変わらない", async () => {
		const config = await initConfig();
		// 共通の祖先で一度同期して、行の並び（ファイルの見出し・本文の行）を作っておく
		await frontRowFor(config, source("題", "説明"), target("Title", "Description"));
		const base = fs.readFileSync(path.join(mdaitDir, "unit-state"), "utf-8");
		// あなた: title を直して訳した / 相手: description を直して訳した
		const ours = await frontRowFor(config, source("新しい題", "説明"), target("New title", "Description"));
		const theirs = await frontRowFor(config, source("題", "新しい説明"), target("Title", "New description"));

		// 合流: 原稿は両方の直しが入って綺麗に混ざり、unit-state の front 行だけがぶつかる
		const frontLine = base.split("\n").find((l) => l.split("\t")[1] === "front") as string;
		fs.writeFileSync(
			path.join(mdaitDir, "unit-state"),
			base.replace(frontLine, ["<<<<<<< HEAD", ours, "=======", theirs, ">>>>>>> theirs"].join("\n")),
			"utf-8",
		);
		const mergedSource = source("新しい題", "新しい説明");
		const mergedTarget = target("New title", "New description");
		fs.writeFileSync(sourceFile, mergedSource, "utf-8");
		fs.writeFileSync(targetFile, mergedTarget, "utf-8");
		UnitStateStore.dispose();

		await applyUnitStateResolution(mdaitDir);
		await sync_CoreProc(sourceFile, targetFile, config);

		const store = UnitStateStore.getInstance();
		assert.equal(
			store.getAllEntries().filter(isMergeHeldEntry).length,
			0,
			"同期のあとも frontmatter の競合が人の前に残る",
		);
		assert.equal(
			store.getEntriesByPath("en/doc.md").filter(isHeldBackEntry).length,
			0,
			"frontmatter の行が、拾い戻す道の無い預かりとして残った",
		);
		assert.equal(fs.readFileSync(sourceFile, "utf-8"), mergedSource, "原文が書き換わった");
		assert.equal(fs.readFileSync(targetFile, "utf-8"), mergedTarget, "訳文が書き換わった");
		const front = store.getFrontMatterEntry("en/doc.md");
		assert.ok(
			front?.need.startsWith("revise@"),
			`両方の直しが入った frontmatter が改訂待ちにならない（need: ${front?.need}）`,
		);
	});
});
