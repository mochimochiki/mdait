// マーカー書き換え操作（CodeLens・ツリーから走る4経路）が、本文の中身が
// 変わらないときにファイルを書かないことの検証。
//
// external を選ぶ理由は「原文を1バイトも書き換えない」（ADR-260802-04 / ADR-260814-01）。
// external ではマーカーが `.mdait/unit-state` にあるため、need 解除・Keep（独立化）・
// isolate 宣言では本文に1バイトの変化も無い。それでも書き戻していたため、
// パーサーを通った整形（ユニット間の空行の数・末尾の改行・改行コード）が
// 原文へそのまま焼き付いていた。
//
// 止め方は操作の種類（入口）で分ける。マーカーしか変えない3経路は external なら
// 書かない。deleteUnit は external でも本文から章そのものを消すので書き込みが要るため、
// 別の入口（`withMarkdownMutation`）を通る。「中身が変わったか」の比較は
// 無駄な書き込みを減らす守りとして残るが、それだけでは正規形でない原稿を守れない
// （下の2つ目の suite を参照）。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { declareIsolateForFile } from "../../../../commands/markers/declare-isolate";
import { deleteUnitFromFile } from "../../../../commands/markers/delete-unit";
import { keepUnitsAsIndependent } from "../../../../commands/markers/keep-unit";
import { resolveNeedForFile } from "../../../../commands/markers/resolve-need";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";

declare let __vscodeMockWorkspaceRoot: string;

/**
 * 原文（external なので本文にマーカーは無い）。
 *
 * ここは正規形の原稿（LF・章のあいだの空行は1つ・末尾に改行あり）。
 * 正規形でない原稿は「中身の比較」では止まらないため、2つ目の suite で別に固定する。
 */
const SOURCE_CONTENT = "# 手引き\n\n導入の本文。\n\n## 第1章\n\n第1章の本文。\n";

/** 訳文（external なので本文にマーカーは無い） */
const TARGET_CONTENT = "# Guide\n\nIntro.\n\n## Chapter 1\n\nChapter 1 body.\n";

suite("マーカー書き換え4経路: 中身が変わらないならファイルを書かない", () => {
	let tempDir: string;
	let mdaitDir: string;
	let sourceFile: string;
	let targetFile: string;
	/** vscode.workspace.fs.writeFile の呼び出し先（絶対パス）の記録 */
	let writtenPaths: string[];
	let originalWriteFile: typeof vscode.workspace.fs.writeFile;

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-no-write-"));
		__vscodeMockWorkspaceRoot = tempDir;
		mdaitDir = path.join(tempDir, ".mdait");
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });

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

	/** external のストアに行を用意する（本文にはマーカーを書かない） */
	function setEntries(relPath: string, entries: { hash: string; from?: string; need?: string }[]): void {
		const store = UnitStateStore.getInstance();
		store.load(mdaitDir);
		entries.forEach((entry, order) => {
			store.setEntry({
				path: relPath,
				order,
				level: order === 0 ? 1 : 2,
				titleHash: "",
				hash: entry.hash,
				from: entry.from ?? "",
				need: entry.need ?? "",
			});
		});
	}

	/** そのファイルへ書き込みが走った回数 */
	function writeCountFor(absPath: string): number {
		return writtenPaths.filter((p) => p === absPath).length;
	}

	/**
	 * バイト列が変わっていないことを確かめる。
	 * 文字列に直してから比べると、改行コードや BOM の違いを見逃す。
	 */
	function assertBytesUnchanged(before: Buffer, absPath: string, message: string): void {
		const after = fs.readFileSync(absPath);
		if (after.equals(before)) {
			return;
		}
		assert.strictEqual(after.toString("utf-8"), before.toString("utf-8"), message);
		assert.fail(`${message}（文字としては同じだが、バイト列が違う）`);
	}

	test("externalでneedを解除しても原文ファイルへは1回も書き込まれない", async () => {
		const config = await initConfig("external");
		fs.writeFileSync(sourceFile, SOURCE_CONTENT, "utf-8");
		setEntries("ja/doc.md", [{ hash: "srcA", need: "isolate" }, { hash: "srcB" }]);
		const before = fs.readFileSync(sourceFile);

		const result = await resolveNeedForFile(sourceFile, config, {
			targets: [{ kind: "unit", hash: "srcA" }],
			needs: ["isolate"],
		});

		assert.strictEqual(result.resolved.length, 1, "needは解除されること");
		assert.strictEqual(
			UnitStateStore.getInstance().getEntriesByPath("ja/doc.md")[0]?.need,
			"",
			"ストアの行からneedが外れること",
		);
		assert.strictEqual(writeCountFor(sourceFile), 0, "原文ファイルへ書き込みが走った");
		assertBytesUnchanged(before, sourceFile, "need解除で原文が書き換わった");
	});

	test("externalでisolateを宣言しても原文ファイルへは1回も書き込まれない", async () => {
		const config = await initConfig("external");
		fs.writeFileSync(sourceFile, SOURCE_CONTENT, "utf-8");
		setEntries("ja/doc.md", [{ hash: "srcA" }, { hash: "srcB" }]);
		const before = fs.readFileSync(sourceFile);

		const result = await declareIsolateForFile(sourceFile, "srcB", config);

		assert.strictEqual(result.declared, true, "isolateが宣言されること");
		assert.strictEqual(
			UnitStateStore.getInstance().getEntriesByPath("ja/doc.md")[1]?.need,
			"isolate",
			"ストアの行にneed:isolateが入ること",
		);
		assert.strictEqual(writeCountFor(sourceFile), 0, "原文ファイルへ書き込みが走った");
		assertBytesUnchanged(before, sourceFile, "isolate宣言で原文が書き換わった");
	});

	test("externalでKeep（独立化）しても訳文ファイルへは1回も書き込まれない", async () => {
		const config = await initConfig("external");
		fs.writeFileSync(targetFile, TARGET_CONTENT, "utf-8");
		setEntries("en/doc.md", [
			{ hash: "tgtA", from: "srcA" },
			{ hash: "tgtB", from: "srcB", need: "verify-deletion" },
		]);
		const before = fs.readFileSync(targetFile);

		const result = await keepUnitsAsIndependent(targetFile, config, ["tgtB"]);

		assert.strictEqual(result.kept.length, 1, "独立化されること");
		const kept = UnitStateStore.getInstance().getEntriesByPath("en/doc.md")[1];
		assert.strictEqual(kept?.need, "", "ストアの行からneedが外れること");
		assert.strictEqual(kept?.from, "", "ストアの行からfromが外れること");
		assert.strictEqual(writeCountFor(targetFile), 0, "訳文ファイルへ書き込みが走った");
		assertBytesUnchanged(before, targetFile, "Keepで訳文の本文が書き換わった");
	});

	test("externalでもユニット削除は本文が変わるのでファイルへ書き込まれる", async () => {
		const config = await initConfig("external");
		fs.writeFileSync(targetFile, TARGET_CONTENT, "utf-8");
		setEntries("en/doc.md", [
			{ hash: "tgtA", from: "srcA" },
			{ hash: "tgtB", from: "srcB", need: "verify-deletion" },
		]);

		const result = await deleteUnitFromFile(targetFile, "tgtB", config);

		assert.strictEqual(result.deleted, true, "ユニットが削除されること");
		assert.strictEqual(writeCountFor(targetFile), 1, "削除では書き込みが1回走ること");
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("Chapter 1"), "本文から章が消えること");
		assert.ok(written.includes("Intro."), "残る章はそのままであること");
	});

	test("embeddedではneedを解除すると本文のマーカーが書き換えられる", async () => {
		const config = await initConfig("embedded");
		const embedded = [
			"<!-- mdait tgtA from:srcA need:review -->",
			"# Guide",
			"",
			"Intro.",
			"",
			"<!-- mdait tgtB from:srcB -->",
			"## Chapter 1",
			"",
			"Chapter 1 body.",
			"",
		].join("\n");
		fs.writeFileSync(targetFile, embedded, "utf-8");

		const result = await resolveNeedForFile(targetFile, config, { targets: [{ kind: "unit", hash: "tgtA" }] });

		assert.strictEqual(result.resolved.length, 1, "needは解除されること");
		assert.strictEqual(writeCountFor(targetFile), 1, "embeddedでは書き込みが1回走ること");
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(!written.includes("need:review"), "本文からneedフラグが消えること");
		assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"), "マーカー自体は残ること");
	});

	test("embeddedでもマーカーに変化が無ければファイルは書き換えられない", async () => {
		const config = await initConfig("embedded");
		const embedded = ["<!-- mdait tgtA from:srcA -->", "# Guide", "", "Intro.", ""].join("\n");
		fs.writeFileSync(targetFile, embedded, "utf-8");
		const before = fs.readFileSync(targetFile);

		// 解除できる need が無いので changed:false。書き込みは元から走らない
		const result = await resolveNeedForFile(targetFile, config, { targets: [{ kind: "unit", hash: "tgtA" }] });

		assert.strictEqual(result.resolved.length, 0, "解除対象が無いこと");
		assert.strictEqual(writeCountFor(targetFile), 0, "書き込みが走った");
		assertBytesUnchanged(before, targetFile, "無変更なのに本文が書き換わった");
	});
});

// 「中身が変わったか」の比較だけでは守れない原稿がある。パーサーを通した書き出しは
// 改行コードを LF に揃え、ユニット間の空行を1つに詰め、末尾に改行を足す。
// つまり整形そのものが差分になるので、比較は必ず「変わった」と答えてしまう。
//
// external の約束は「原文を1バイトも書き換えない」なので、原稿の書かれ方に関わらず
// 守られていなければならない。マーカーしか変えない操作は、モードで書き込みを止める
// （sync の persistSourceDocument と同じ強さ）。
suite("マーカーしか変えない操作: externalでは原稿の書かれ方に関わらず書き込まない", () => {
	let tempDir: string;
	let mdaitDir: string;
	let sourceFile: string;
	let targetFile: string;
	let writtenPaths: string[];
	let originalWriteFile: typeof vscode.workspace.fs.writeFile;

	/** CRLF 改行の原稿（書き出すと全行が LF に変わる） */
	const CRLF_CONTENT = "# 手引き\r\n\r\n導入の本文。\r\n\r\n## 第1章\r\n\r\n第1章の本文。\r\n";
	/** 手書きの原稿（章のあいだに空行2つ・末尾に改行なし） */
	const HANDWRITTEN_CONTENT = "# 手引き\n\n導入の本文。\n\n\n## 第1章\n\n第1章の本文。";
	/** 末尾に空行が3つある原稿（書き出すと刈られる） */
	const TRAILING_BLANKS_CONTENT = "# 手引き\n\n導入の本文。\n\n## 第1章\n\n第1章の本文。\n\n\n\n";

	/** 検査に使う「正規形でない原稿」の一覧 */
	const IRREGULAR_CONTENTS: { label: string; content: string }[] = [
		{ label: "CRLF改行", content: CRLF_CONTENT },
		{ label: "章のあいだに空行2つ・末尾に改行なし", content: HANDWRITTEN_CONTENT },
		{ label: "末尾に空行3つ", content: TRAILING_BLANKS_CONTENT },
	];

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-irregular-"));
		__vscodeMockWorkspaceRoot = tempDir;
		mdaitDir = path.join(tempDir, ".mdait");
		sourceFile = path.join(tempDir, "ja", "doc.md");
		targetFile = path.join(tempDir, "en", "doc.md");
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });

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

	async function initExternalConfig(): Promise<Configuration> {
		fs.mkdirSync(mdaitDir, { recursive: true });
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
		return await Configuration.getInstance().initialize(configPath);
	}

	function setEntries(relPath: string, entries: { hash: string; from?: string; need?: string }[]): void {
		const store = UnitStateStore.getInstance();
		store.load(mdaitDir);
		entries.forEach((entry, order) => {
			store.setEntry({
				path: relPath,
				order,
				level: order === 0 ? 1 : 2,
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

	/** バイト列が1バイトも変わっていないことを確かめる */
	function assertBytesUnchanged(before: Buffer, absPath: string, message: string): void {
		const after = fs.readFileSync(absPath);
		if (after.equals(before)) {
			return;
		}
		assert.strictEqual(after.toString("utf-8"), before.toString("utf-8"), message);
		assert.fail(`${message}（文字としては同じだが、バイト列が違う）`);
	}

	for (const { label, content } of IRREGULAR_CONTENTS) {
		test(`externalでは${label}の原文でもneed解除は1バイトも書き換えない`, async () => {
			const config = await initExternalConfig();
			fs.writeFileSync(sourceFile, content, "utf-8");
			setEntries("ja/doc.md", [{ hash: "srcA", need: "isolate" }, { hash: "srcB" }]);
			const before = fs.readFileSync(sourceFile);

			const result = await resolveNeedForFile(sourceFile, config, {
				targets: [{ kind: "unit", hash: "srcA" }],
				needs: ["isolate"],
			});

			assert.strictEqual(result.resolved.length, 1, "needは解除されること");
			assert.strictEqual(writeCountFor(sourceFile), 0, "原文ファイルへ書き込みが走った");
			assertBytesUnchanged(before, sourceFile, `${label}の原文がneed解除で書き換わった`);
		});

		test(`externalでは${label}の訳文でもneed解除は1バイトも書き換えない`, async () => {
			const config = await initExternalConfig();
			fs.writeFileSync(targetFile, content, "utf-8");
			setEntries("en/doc.md", [
				{ hash: "tgtA", from: "srcA", need: "review" },
				{ hash: "tgtB", from: "srcB" },
			]);
			const before = fs.readFileSync(targetFile);

			const result = await resolveNeedForFile(targetFile, config, {
				targets: [{ kind: "unit", hash: "tgtA" }],
			});

			assert.strictEqual(result.resolved.length, 1, "needは解除されること");
			assert.strictEqual(writeCountFor(targetFile), 0, "訳文ファイルへ書き込みが走った");
			assertBytesUnchanged(before, targetFile, `${label}の訳文がneed解除で書き換わった`);
		});

		test(`externalでは${label}の訳文でもKeep（独立化）は1バイトも書き換えない`, async () => {
			const config = await initExternalConfig();
			fs.writeFileSync(targetFile, content, "utf-8");
			setEntries("en/doc.md", [
				{ hash: "tgtA", from: "srcA" },
				{ hash: "tgtB", from: "srcB", need: "verify-deletion" },
			]);
			const before = fs.readFileSync(targetFile);

			const result = await keepUnitsAsIndependent(targetFile, config, ["tgtB"]);

			assert.strictEqual(result.kept.length, 1, "独立化されること");
			assert.strictEqual(writeCountFor(targetFile), 0, "訳文ファイルへ書き込みが走った");
			assertBytesUnchanged(before, targetFile, `${label}の訳文がKeepで書き換わった`);
		});

		test(`externalでは${label}の原文でもisolate宣言は1バイトも書き換えない`, async () => {
			const config = await initExternalConfig();
			fs.writeFileSync(sourceFile, content, "utf-8");
			setEntries("ja/doc.md", [{ hash: "srcA" }, { hash: "srcB" }]);
			const before = fs.readFileSync(sourceFile);

			const result = await declareIsolateForFile(sourceFile, "srcB", config);

			assert.strictEqual(result.declared, true, "isolateが宣言されること");
			assert.strictEqual(writeCountFor(sourceFile), 0, "原文ファイルへ書き込みが走った");
			assertBytesUnchanged(before, sourceFile, `${label}の原文がisolate宣言で書き換わった`);
		});

		test(`externalでは${label}の訳文でもユニット削除は本文が変わるので書き込まれる`, async () => {
			const config = await initExternalConfig();
			fs.writeFileSync(targetFile, content, "utf-8");
			setEntries("en/doc.md", [
				{ hash: "tgtA", from: "srcA" },
				{ hash: "tgtB", from: "srcB", need: "verify-deletion" },
			]);

			const result = await deleteUnitFromFile(targetFile, "tgtB", config);

			assert.strictEqual(result.deleted, true, "ユニットが削除されること");
			assert.strictEqual(writeCountFor(targetFile), 1, "削除では書き込みが1回走ること");
			const written = fs.readFileSync(targetFile, "utf-8");
			assert.ok(!written.includes("第1章の本文。"), "本文から章が消えること");
			assert.ok(written.includes("導入の本文。"), "残る章はそのままであること");
		});
	}

	test("externalでneed解除したあとunit-stateファイルに結果が保存されている", async () => {
		const config = await initExternalConfig();
		fs.writeFileSync(sourceFile, CRLF_CONTENT, "utf-8");
		setEntries("ja/doc.md", [{ hash: "srcA", need: "isolate" }, { hash: "srcB" }]);

		const result = await resolveNeedForFile(sourceFile, config, {
			targets: [{ kind: "unit", hash: "srcA" }],
			needs: ["isolate"],
		});
		assert.strictEqual(result.resolved.length, 1, "needは解除されること");

		// ディスクの unit-state から読み直す。stringify を呼び続けていなければ、
		// 書き込みは止まっても状態が残らないという別の壊れ方になる
		UnitStateStore.dispose();
		const reloaded = UnitStateStore.getInstance();
		reloaded.load(mdaitDir);
		const entries = reloaded.getEntriesByPath("ja/doc.md");
		assert.strictEqual(entries[0]?.hash, "srcA", "1行目のhashが保たれること");
		assert.strictEqual(entries[0]?.need, "", "unit-stateの行からneedが外れて保存されること");
		assert.strictEqual(entries.length, 2, "行が失われないこと");
	});

	test("externalでisolate宣言したあとunit-stateファイルに結果が保存されている", async () => {
		const config = await initExternalConfig();
		fs.writeFileSync(sourceFile, HANDWRITTEN_CONTENT, "utf-8");
		setEntries("ja/doc.md", [{ hash: "srcA" }, { hash: "srcB" }]);

		const result = await declareIsolateForFile(sourceFile, "srcB", config);
		assert.strictEqual(result.declared, true, "isolateが宣言されること");

		UnitStateStore.dispose();
		const reloaded = UnitStateStore.getInstance();
		reloaded.load(mdaitDir);
		assert.strictEqual(
			reloaded.getEntriesByPath("ja/doc.md")[1]?.need,
			"isolate",
			"unit-stateの行にneed:isolateが保存されること",
		);
	});

	test("externalでKeep（独立化）したあとunit-stateファイルに結果が保存されている", async () => {
		const config = await initExternalConfig();
		fs.writeFileSync(targetFile, TRAILING_BLANKS_CONTENT, "utf-8");
		setEntries("en/doc.md", [
			{ hash: "tgtA", from: "srcA" },
			{ hash: "tgtB", from: "srcB", need: "verify-deletion" },
		]);

		const result = await keepUnitsAsIndependent(targetFile, config, ["tgtB"]);
		assert.strictEqual(result.kept.length, 1, "独立化されること");

		UnitStateStore.dispose();
		const reloaded = UnitStateStore.getInstance();
		reloaded.load(mdaitDir);
		const kept = reloaded.getEntriesByPath("en/doc.md")[1];
		assert.strictEqual(kept?.need, "", "unit-stateの行からneedが外れて保存されること");
		assert.strictEqual(kept?.from, "", "unit-stateの行からfromが外れて保存されること");
	});
});
