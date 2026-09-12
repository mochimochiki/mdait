// 「翻訳待ちに戻す」（need:review → need:translate）の検証。
// 確認待ちの既訳を採用しない側の答えで、印を付け替えるだけで AI は呼ばない。
// review 以外の need は触らない（訳し終えた本文や判断待ちを黙って翻訳待ちに戻さない）。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { getFileHandler } from "../../../../commands/file-handler/file-handler-factory";
import { requestTranslateForFile } from "../../../../commands/markers/request-translate";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

suite("requestTranslateForFile（need:review → need:translate）", () => {
	let tempDir: string;
	let mdaitDir: string;
	let targetFile: string;
	/** vscode.workspace.fs.writeFile の呼び出し先（絶対パス）の記録 */
	let writtenPaths: string[];
	let originalWriteFile: typeof vscode.workspace.fs.writeFile;

	/** embedded の訳文。review・need なし・translate・verify-deletion・isolate を1つずつ持つ */
	const EMBEDDED_CONTENT = `<!-- mdait tgtA from:srcA need:review -->
## Section A

Adopted translation A.

<!-- mdait tgtB from:srcB -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:translate -->
## Section C

Content C.

<!-- mdait tgtD from:srcD need:verify-deletion -->
## Section D

Content D.

<!-- mdait tgtE from:srcE need:isolate -->
## Section E

Content E.
`;

	/** external の訳文（本文にマーカーは無い）。CRLF・末尾に改行なし＝正規形でない原稿 */
	const EXTERNAL_CONTENT = "## Section A\r\n\r\nAdopted translation A.\r\n\r\n## Section B\r\n\r\nContent B.";

	async function initConfig(mode: "embedded" | "external"): Promise<Configuration> {
		fs.mkdirSync(mdaitDir, { recursive: true });
		const configPath = path.join(mdaitDir, "mdait.json");
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				transPairs: [{ sourceDir: "ja", targetDir: "en", sourceLang: "ja", targetLang: "en" }],
				primaryLang: "ja",
				markers: { mode },
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(configPath);
	}

	function writeTarget(content: string): void {
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(targetFile, content, "utf-8");
	}

	/** external のストアに行を用意する（本文にはマーカーを書かない） */
	function setEntries(relPath: string, entries: { hash: string; from?: string; need?: string }[]): void {
		const store = UnitStateStore.getInstance();
		store.load(mdaitDir);
		entries.forEach((entry, at) => {
			store.setEntry({
				path: relPath,
				kind: "unit",
				seat: seat(at),
				level: 2,
				titleHash: "",
				hash: entry.hash,
				from: entry.from ?? "",
				need: entry.need ?? "",
			});
		});
	}

	function writeCountFor(absPath: string): number {
		return writtenPaths.filter((p) => p === absPath).length;
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-request-translate-"));
		__vscodeMockWorkspaceRoot = tempDir;
		mdaitDir = path.join(tempDir, ".mdait");
		targetFile = path.join(tempDir, "en", "doc.md");

		writtenPaths = [];
		originalWriteFile = vscode.workspace.fs.writeFile;
		vscode.workspace.fs.writeFile = async (uri, content) => {
			writtenPaths.push(uri.fsPath);
			return originalWriteFile(uri, content);
		};
	});

	teardown(() => {
		vscode.workspace.fs.writeFile = originalWriteFile;
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	suite("embedded", () => {
		test("need:review のユニットが need:translate になり、hash/from/本文は変わらない", async () => {
			const config = await initConfig("embedded");
			writeTarget(EMBEDDED_CONTENT);

			const result = await requestTranslateForFile(targetFile, "tgtA", config);

			assert.strictEqual(result.requested, true);
			assert.strictEqual(result.changed, true);
			assert.strictEqual(result.hash, "tgtA");
			assert.strictEqual(result.title, "Section A");
			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(written.includes("<!-- mdait tgtA from:srcA need:translate -->"), "need が translate に変わること");
			assert.ok(!written.includes("need:review"), "review が残らないこと");
			assert.ok(written.includes("Adopted translation A."), "採用しなかった訳文の本文はまだ消さないこと");
		});

		test("存在しない hash は requested false で reason not-found", async () => {
			const config = await initConfig("embedded");
			writeTarget(EMBEDDED_CONTENT);

			const result = await requestTranslateForFile(targetFile, "zzz", config);

			assert.strictEqual(result.requested, false);
			assert.strictEqual(result.changed, false);
			assert.strictEqual(result.reason, "not-found");
			assert.strictEqual(writeCountFor(targetFile), 0, "何も変わらないので書き込まないこと");
		});

		for (const [hash, label, markerLine] of [
			["tgtB", "need なし", "<!-- mdait tgtB from:srcB -->"],
			["tgtC", "need:translate", "<!-- mdait tgtC from:srcC need:translate -->"],
			["tgtD", "need:verify-deletion", "<!-- mdait tgtD from:srcD need:verify-deletion -->"],
			["tgtE", "need:isolate", "<!-- mdait tgtE from:srcE need:isolate -->"],
		] as const) {
			test(`${label} のユニットは reason not-review でスキップし、マーカーを変えない`, async () => {
				const config = await initConfig("embedded");
				writeTarget(EMBEDDED_CONTENT);

				const result = await requestTranslateForFile(targetFile, hash, config);

				assert.strictEqual(result.requested, false);
				assert.strictEqual(result.changed, false);
				assert.strictEqual(result.reason, "not-review");
				const written = fs.readFileSync(targetFile, "utf-8");
				assert.ok(written.includes(markerLine), "既存のマーカーがそのまま残ること");
				assert.strictEqual(writeCountFor(targetFile), 0, "何も変わらないので書き込まないこと");
			});
		}

		test("2回目は not-review になる（1回目で translate に変わっているため）", async () => {
			const config = await initConfig("embedded");
			writeTarget(EMBEDDED_CONTENT);
			const first = await requestTranslateForFile(targetFile, "tgtA", config);
			assert.strictEqual(first.requested, true);

			const second = await requestTranslateForFile(targetFile, "tgtA", config);

			assert.strictEqual(second.requested, false);
			assert.strictEqual(second.reason, "not-review");
		});
	});

	suite("MdFileHandler 経由", () => {
		const FRONTMATTER_CONTENT = `---
title: Adopted title
mdait:
  front: fmA from:fmS need:review
---

<!-- mdait tgtA from:srcA need:review -->
## Section A

Adopted translation A.
`;

		test("unit 指定は本文ユニットを付け替える", async () => {
			await initConfig("embedded");
			writeTarget(FRONTMATTER_CONTENT);

			const result = await getFileHandler(targetFile).requestTranslate(targetFile, { kind: "unit", hash: "tgtA" });

			assert.strictEqual(result.requested, true);
			assert.ok(fs.readFileSync(targetFile, "utf-8").includes("<!-- mdait tgtA from:srcA need:translate -->"));
		});

		test("frontmatter は対象外（not-found）で、frontmatter の review はそのまま残る", async () => {
			await initConfig("embedded");
			writeTarget(FRONTMATTER_CONTENT);

			const result = await getFileHandler(targetFile).requestTranslate(targetFile, { kind: "frontmatter" });

			assert.strictEqual(result.requested, false);
			assert.strictEqual(result.reason, "not-found");
			assert.ok(fs.readFileSync(targetFile, "utf-8").includes("front: fmA from:fmS need:review"));
			assert.strictEqual(writeCountFor(targetFile), 0);
		});
	});

	suite("external", () => {
		test("ストアの行が need:translate になり、訳文ファイルへは1バイトも書かない", async () => {
			const config = await initConfig("external");
			writeTarget(EXTERNAL_CONTENT);
			setEntries("en/doc.md", [
				{ hash: "tgtA", from: "srcA", need: "review" },
				{ hash: "tgtB", from: "srcB" },
			]);
			const before = fs.readFileSync(targetFile);

			const result = await requestTranslateForFile(targetFile, "tgtA", config);

			assert.strictEqual(result.requested, true);
			const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
			assert.strictEqual(entries[0]?.need, "translate", "ストアの行の need が translate になること");
			assert.strictEqual(entries[0]?.hash, "tgtA", "hash は変わらないこと");
			assert.strictEqual(entries[0]?.from, "srcA", "from は変わらないこと");
			assert.strictEqual(entries[1]?.need, "", "隣の行は触らないこと");
			assert.strictEqual(writeCountFor(targetFile), 0, "訳文ファイルへ書き込みが走った");
			assert.ok(fs.readFileSync(targetFile).equals(before), "CRLF・末尾改行なしの原稿がそのまま残ること");
		});

		test("付け替えた結果が unit-state ファイルに保存されている", async () => {
			const config = await initConfig("external");
			writeTarget(EXTERNAL_CONTENT);
			setEntries("en/doc.md", [{ hash: "tgtA", from: "srcA", need: "review" }]);

			await requestTranslateForFile(targetFile, "tgtA", config);

			// ディスクから読み直す。stringify を呼ばなければ、書き込みは止まっても状態が残らない
			UnitStateStore.dispose();
			const reloaded = UnitStateStore.getInstance();
			reloaded.load(mdaitDir);
			assert.strictEqual(reloaded.getEntriesByPath("en/doc.md")[0]?.need, "translate");
		});

		test("review 以外の行は not-review でスキップし、ストアも本文も変えない", async () => {
			const config = await initConfig("external");
			writeTarget(EXTERNAL_CONTENT);
			setEntries("en/doc.md", [
				{ hash: "tgtA", from: "srcA", need: "verify-deletion" },
				{ hash: "tgtB", from: "srcB" },
			]);
			const before = fs.readFileSync(targetFile);

			const result = await requestTranslateForFile(targetFile, "tgtA", config);

			assert.strictEqual(result.requested, false);
			assert.strictEqual(result.reason, "not-review");
			assert.strictEqual(UnitStateStore.getInstance().getEntriesByPath("en/doc.md")[0]?.need, "verify-deletion");
			assert.strictEqual(writeCountFor(targetFile), 0);
			assert.ok(fs.readFileSync(targetFile).equals(before));
		});
	});
});
