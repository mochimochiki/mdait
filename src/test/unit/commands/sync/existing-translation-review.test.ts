/**
 * マーカーの無い訳文を sync がどう受けるか（規則は `marker-sync.ts` の `needForFirstLink`）。
 *
 * 規則: **紐（from）なし・本文あり・丸写しでない訳文ユニットは `need:review`、丸写し
 * （訳文の hash が原文の hash と同じ＝まだ訳していない）は `need:translate`。**
 * 取り込み（adopt）の有無にも、マーカーの保管方式（embedded / external）にも依らない。
 *
 * 背景（2つの事故）:
 * 1. 既定の embedded で、人が手で訳した訳文にふつうの sync を掛けると全ユニットに
 *    `need:translate` が付き、次の trans が既訳を機械翻訳で上書きしていた
 *    （docs/design/agent-orchestration.md の G3）。review に倒すのは adopt のときだけだった。
 * 2. external で `.mdait/unit-state` を失って sync すると、旧 `isExternalRebuild` の安全網が
 *    訳文の全ユニットを review に倒していた。原文の丸写し（まだ訳していない）まで review に
 *    なり、人に確認を頼む理由の無いものが確認待ちの列に並んでいた。
 *
 * `syncMarkerPair` の単体テストでは呼び出し側の判定（本文の有無・丸写しの見分け）が
 * 通らないので、ここは sync_CoreProc を通してディスク上の姿を見る。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sync_CoreProc } from "../../../../commands/sync/sync-command";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

/** 原文。3章 */
const SOURCE = [
	"# 製品ガイド",
	"",
	"この製品の概要を説明します。",
	"",
	"## インストール",
	"",
	"インストール手順を説明します。",
	"",
	"## 使い方",
	"",
	"基本的な使い方を説明します。",
	"",
].join("\n");

/** 人が手で訳した既訳。マーカーは無い */
const TRANSLATED = [
	"# Product Guide",
	"",
	"This section describes the product overview.",
	"",
	"## Installation",
	"",
	"This section describes the installation steps.",
	"",
	"## Usage",
	"",
	"This section describes basic usage.",
	"",
].join("\n");

/** 訳し途中の訳文。真ん中の章だけ原文の丸写しのまま */
const MIXED = [
	"# Product Guide",
	"",
	"This section describes the product overview.",
	"",
	"## インストール",
	"",
	"インストール手順を説明します。",
	"",
	"## Usage",
	"",
	"This section describes basic usage.",
	"",
].join("\n");

for (const mode of ["embedded", "external"] as const) {
	suite(`sync: マーカーの無い既訳は review、丸写しは translate で受ける（${mode}）`, () => {
		let tempDir: string;
		let mdaitDir: string;
		let sourceFile: string;
		let targetFile: string;

		setup(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-existing-translation-"));
			__vscodeMockWorkspaceRoot = tempDir;
			fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
			fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
			mdaitDir = path.join(tempDir, ".mdait");
			sourceFile = path.join(tempDir, "ja", "doc.md");
			targetFile = path.join(tempDir, "en", "doc.md");
		});

		teardown(() => {
			Configuration.dispose();
			UnitRegistryManager.resetInstance();
			UnitStateStore.dispose();
			FileMutex.dispose();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		/** 設定を書いて原文と訳文を置く（sync はまだ掛けない） */
		async function bootstrap(target: string): Promise<Configuration> {
			fs.mkdirSync(mdaitDir, { recursive: true });
			const configPath = path.join(mdaitDir, "mdait.json");
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
					primaryLang: "ja",
					markers: { mode },
					sync: { level: 3, autoDelete: true },
				}),
				"utf-8",
			);
			const config = Configuration.getInstance();
			await config.initialize(configPath);
			UnitStateStore.getInstance().load(mdaitDir);
			fs.writeFileSync(sourceFile, SOURCE, "utf-8");
			fs.writeFileSync(targetFile, target, "utf-8");
			return config;
		}

		/** 訳文ユニットの (hash, from, need) の並び。embedded は本文から、external は外の台帳から読む */
		function targetMarkers(): Array<{ hash: string; from: string; need: string }> {
			if (mode === "embedded") {
				const text = fs.readFileSync(targetFile, "utf-8");
				return [...text.matchAll(/<!-- mdait ([0-9a-f]+)(?: from:([0-9a-f]+))?(?: need:([\w@-]+))? -->/g)].map(
					(matched) => ({ hash: matched[1], from: matched[2] ?? "", need: matched[3] ?? "" }),
				);
			}
			return UnitStateStore.getInstance()
				.getEntriesByPath("en/doc.md")
				.filter((entry) => entry.kind === "unit")
				.map((entry) => ({ hash: entry.hash, from: entry.from, need: entry.need }));
		}

		function targetNeeds(): string[] {
			return targetMarkers().map((marker) => marker.need);
		}

		/** 訳文の本文（マーカーの行を除く） */
		function targetBody(): string {
			return fs
				.readFileSync(targetFile, "utf-8")
				.split("\n")
				.filter((line) => !line.trimStart().startsWith("<!-- mdait"))
				.join("\n");
		}

		test("(a) 訳済みの訳文にふつうの sync を掛けると、全ユニットが確認待ちになり本文は変わらない", async () => {
			const config = await bootstrap(TRANSLATED);

			const result = await sync_CoreProc(sourceFile, targetFile, config);

			assert.deepStrictEqual(targetNeeds(), ["review", "review", "review"], "取り込みを頼まなくても既訳は守る");
			assert.strictEqual(targetBody(), TRANSLATED, "既訳の本文は1文字も変えない");
			assert.strictEqual(result.adopted, 3, "既訳として受けた件数を数えること（取り込みレポートと LM ツールが使う）");
			for (const marker of targetMarkers()) {
				assert.ok(marker.from, "紐（from）は結ばれていること");
				assert.notStrictEqual(marker.hash, marker.from, "既訳は丸写しではない");
			}
		});

		test("(b) 訳文が原文の丸写し（マーカーなし）なら翻訳待ちのまま", async () => {
			const config = await bootstrap(SOURCE);

			const result = await sync_CoreProc(sourceFile, targetFile, config);

			assert.deepStrictEqual(
				targetNeeds(),
				["translate", "translate", "translate"],
				"まだ訳していないものを人に確認させない",
			);
			assert.strictEqual(result.adopted, 0, "丸写しは既訳ではない");
			for (const marker of targetMarkers()) {
				assert.strictEqual(marker.hash, marker.from, "未訳の訳文は原文の丸写しなので hash と from が一致する");
			}
		});

		test("(c) 訳済みの章と丸写しの章が混ざっていれば、それぞれ review / translate になる", async () => {
			const config = await bootstrap(MIXED);

			const result = await sync_CoreProc(sourceFile, targetFile, config);

			assert.deepStrictEqual(targetNeeds(), ["review", "translate", "review"]);
			assert.strictEqual(targetBody(), MIXED, "どの章の本文も変えない");
			assert.strictEqual(result.adopted, 2);
		});

		test("(e) 2回目の sync では何も変わらない（冪等）", async () => {
			const config = await bootstrap(MIXED);
			await sync_CoreProc(sourceFile, targetFile, config);
			const firstText = fs.readFileSync(targetFile, "utf-8");
			const firstMarkers = targetMarkers();

			const second = await sync_CoreProc(sourceFile, targetFile, config);

			assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), firstText);
			assert.deepStrictEqual(targetMarkers(), firstMarkers);
			assert.strictEqual(second.added + second.modified + second.deleted, 0, "変更 0");
			assert.strictEqual(second.adopted, 0, "二度目に受けるものはもう無い");
		});

		test("取り込み（adopt）を頼んでも着地は同じ（規則は adopt に依らない）", async () => {
			const config = await bootstrap(MIXED);

			const result = await sync_CoreProc(sourceFile, targetFile, config, { adopt: true });

			assert.deepStrictEqual(targetNeeds(), ["review", "translate", "review"]);
			assert.strictEqual(result.adopted, 2);
		});

		test("受けたあと原文が変わると、丸写しは写し直され、既訳は改訂待ちへ移る（refreshUntranslatedCopy との相互作用）", async () => {
			const config = await bootstrap(MIXED);
			await sync_CoreProc(sourceFile, targetFile, config);

			// 丸写しの章（インストール）と既訳の章（使い方）の原文を両方変える
			fs.writeFileSync(
				sourceFile,
				fs
					.readFileSync(sourceFile, "utf-8")
					.replace("インストール手順を説明します。", "インストール手順を説明します。前提条件も確認してください。")
					.replace("基本的な使い方を説明します。", "基本的な使い方と応用を説明します。"),
				"utf-8",
			);
			const result = await sync_CoreProc(sourceFile, targetFile, config);

			const needs = targetNeeds();
			assert.strictEqual(needs[0], "review", "触っていない章の確認待ちはそのまま");
			assert.strictEqual(needs[1], "translate", "丸写しは翻訳待ちのまま");
			assert.ok(needs[2].startsWith("revise@"), `既訳は改訂待ちへ移る（実際: ${needs[2]}）`);
			assert.ok(targetBody().includes("前提条件も確認してください。"), "丸写しは新しい原文へ写し直される");
			assert.ok(targetBody().includes("This section describes basic usage."), "既訳の本文には触らない");
			assert.strictEqual(result.reviewsSuperseded, 1);
		});
	});
}

suite("sync: external で unit-state を失っても、既訳は review・丸写しは translate で受け直す", () => {
	let tempDir: string;
	let mdaitDir: string;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-external-rebuild-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		mdaitDir = path.join(tempDir, ".mdait");
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitRegistryManager.resetInstance();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	/** external の設定で原文と訳文を置き、一度 sync して台帳を作る */
	async function bootstrapAndSync(target: string): Promise<Configuration> {
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode: "external" },
				sync: { level: 3, autoDelete: true },
			}),
			"utf-8",
		);
		const config = Configuration.getInstance();
		await config.initialize(configPath);
		UnitStateStore.getInstance().load(mdaitDir);
		fs.writeFileSync(sourceFile, SOURCE, "utf-8");
		fs.writeFileSync(targetFile, target, "utf-8");
		await sync_CoreProc(sourceFile, targetFile, config);
		UnitStateStore.getInstance().save(mdaitDir);
		return config;
	}

	/** `.mdait/unit-state` を消して読み直す（台帳を失った状態を作る） */
	function loseUnitState(): void {
		UnitStateStore.dispose();
		fs.rmSync(path.join(mdaitDir, "unit-state"), { force: true });
		UnitStateStore.getInstance().load(mdaitDir);
		assert.strictEqual(UnitStateStore.getInstance().getEntriesByPath("en/doc.md").length, 0, "台帳は空である（前提）");
	}

	function targetNeeds(): string[] {
		return UnitStateStore.getInstance()
			.getEntriesByPath("en/doc.md")
			.filter((entry) => entry.kind === "unit")
			.map((entry) => entry.need);
	}

	test("(d) 台帳を失って再 sync すると、訳済みは review・丸写しは translate になる", async () => {
		const config = await bootstrapAndSync(MIXED);
		// 一度目の受け方を確かめてから台帳を失わせる（行が無くなれば、受け方は最初からやり直しになる）
		assert.deepStrictEqual(targetNeeds(), ["review", "translate", "review"], "前提: 一度目の受け方");
		loseUnitState();

		const result = await sync_CoreProc(sourceFile, targetFile, config);

		assert.deepStrictEqual(
			targetNeeds(),
			["review", "translate", "review"],
			"旧 isExternalRebuild は丸写しまで review に倒していた。丸写しは trans に任せる",
		);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), MIXED, "訳文の本文には触らない");
		assert.strictEqual(result.adopted, 2);
	});

	test("台帳を失っても全部が訳済みなら全ユニット review（旧安全網と同じ着地）", async () => {
		const config = await bootstrapAndSync(TRANSLATED);
		loseUnitState();

		await sync_CoreProc(sourceFile, targetFile, config);

		assert.deepStrictEqual(targetNeeds(), ["review", "review", "review"]);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), TRANSLATED);
	});

	test("台帳を失ったあとの再 sync も 2 回目は変更 0（冪等）", async () => {
		const config = await bootstrapAndSync(MIXED);
		loseUnitState();
		await sync_CoreProc(sourceFile, targetFile, config);
		const first = targetNeeds();

		const second = await sync_CoreProc(sourceFile, targetFile, config);

		assert.deepStrictEqual(targetNeeds(), first);
		assert.strictEqual(second.added + second.modified + second.deleted, 0);
	});
});
