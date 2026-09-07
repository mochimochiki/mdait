// need フラグ解決コマンド（mdait_resolve の中核）の検証。
// applyNeedResolution（純ロジック）と resolveNeedForFile（ファイルI/O・embedded/external 両モード）を
// 対象とし、hash/from/本文の不変・冪等性・フィルタ挙動を保証する。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyNeedResolution,
	needMatchesSelection,
	resolveNeedForFile,
	unitTargets,
} from "../../../../commands/markers/resolve-need";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { FileMutex } from "../../../../infra/workspace/file-mutex";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

function makeUnit(hash: string, from: string | null, need: string | null, title = `Section ${hash}`): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash, from, need), title, 2, `## ${title}\n\n本文 ${hash}。\n`);
}

suite("applyNeedResolution（needフラグ解決の純ロジック）", () => {
	test("既定ではreviewのみ解決され、verify-deletion/translate/reviseは残る", () => {
		// verify-deletion を既定で解決すると from が残ったまま need だけ消え、
		// 次の sync で確認待ちが復活する。Keep（恒久化）は keep-unit.ts の担当
		const units = [
			makeUnit("aaa", "s1", "review"),
			makeUnit("bbb", "s2", "verify-deletion"),
			makeUnit("ccc", "s3", "translate"),
			makeUnit("ddd", "s4", "revise@old1"),
			makeUnit("eee", "s5", null),
		];
		const result = applyNeedResolution(units);

		assert.deepStrictEqual(
			result.resolved.map((r) => ({ hash: r.hash, need: r.need })),
			[{ hash: "aaa", need: "review" }],
		);
		assert.strictEqual(result.changed, true);
		assert.strictEqual(units[0].marker?.need, null);
		assert.strictEqual(units[1].marker?.need, "verify-deletion");
		assert.strictEqual(units[2].marker?.need, "translate");
		assert.strictEqual(units[3].marker?.need, "revise@old1");
	});

	test("verify-deletionは明示指定すれば解決できる（一時的に伏せる操作として残す）", () => {
		const units = [makeUnit("bbb", "s2", "verify-deletion")];
		const result = applyNeedResolution(units, { needs: ["verify-deletion"] });
		assert.strictEqual(result.resolved.length, 1);
		assert.strictEqual(units[0].marker?.need, null);
		assert.strictEqual(units[0].marker?.from, "s2", "fromは残る（＝次のsyncで再び確認待ちになる）");
	});

	test("hashとfromは変更されない", () => {
		const units = [makeUnit("aaa", "s1", "review")];
		applyNeedResolution(units);
		assert.strictEqual(units[0].marker?.hash, "aaa");
		assert.strictEqual(units[0].marker?.from, "s1");
	});

	test("resolvedにはタイトルが含まれる", () => {
		const units = [makeUnit("aaa", "s1", "review", "はじめに")];
		const result = applyNeedResolution(units);
		assert.strictEqual(result.resolved[0].title, "はじめに");
	});

	test("unitHashes指定時は指定ユニットのみ解決される", () => {
		const units = [makeUnit("aaa", "s1", "review"), makeUnit("bbb", "s2", "review")];
		const result = applyNeedResolution(units, {
			targets: unitTargets(["bbb"]),
		});
		assert.deepStrictEqual(
			result.resolved.map((r) => r.hash),
			["bbb"],
		);
		assert.strictEqual(units[0].marker?.need, "review", "指定外のユニットは解決されない");
	});

	test("存在しないhashはskipped(not-found)になる", () => {
		const units = [makeUnit("aaa", "s1", "review")];
		const result = applyNeedResolution(units, {
			targets: unitTargets(["zzz"]),
		});
		assert.deepStrictEqual(result.skipped, [{ hash: "zzz", reason: "not-found" }]);
		assert.strictEqual(result.changed, false);
	});

	test("needが無いユニットのhash指定はskipped(already-resolved)になる（冪等性）", () => {
		const units = [makeUnit("aaa", "s1", "review")];
		const first = applyNeedResolution(units, { targets: unitTargets(["aaa"]) });
		assert.strictEqual(first.resolved.length, 1);

		const second = applyNeedResolution(units, {
			targets: unitTargets(["aaa"]),
		});
		assert.strictEqual(second.resolved.length, 0);
		assert.deepStrictEqual(second.skipped, [{ hash: "aaa", reason: "already-resolved" }]);
		assert.strictEqual(second.changed, false);
	});

	test("フィルタ外のneedを持つhash指定はskipped(need-not-selected)になる", () => {
		const units = [makeUnit("aaa", "s1", "translate")];
		const result = applyNeedResolution(units, {
			targets: unitTargets(["aaa"]),
		});
		assert.deepStrictEqual(result.skipped, [{ hash: "aaa", reason: "need-not-selected" }]);
		assert.strictEqual(units[0].marker?.need, "translate");
	});

	test("needsフィルタでtranslateを明示指定すれば解決できる", () => {
		const units = [makeUnit("aaa", "s1", "translate"), makeUnit("bbb", "s2", "review")];
		const result = applyNeedResolution(units, { needs: ["translate"] });
		assert.deepStrictEqual(
			result.resolved.map((r) => r.hash),
			["aaa"],
		);
		assert.strictEqual(units[1].marker?.need, "review", "フィルタ外のreviewは解決されない");
	});

	test("needsフィルタのreviseはrevise@{oldhash}形式にも一致する", () => {
		const units = [makeUnit("aaa", "s1", "revise@old1")];
		const result = applyNeedResolution(units, { needs: ["revise"] });
		assert.strictEqual(result.resolved.length, 1);
		assert.strictEqual(result.resolved[0].need, "revise@old1");
	});

	test("unitHashes省略・全ユニット解決の2回目は無変更（冪等性）", () => {
		const units = [makeUnit("aaa", "s1", "review"), makeUnit("bbb", "s2", "review")];
		const first = applyNeedResolution(units);
		assert.strictEqual(first.resolved.length, 2);

		const second = applyNeedResolution(units);
		assert.strictEqual(second.resolved.length, 0);
		assert.strictEqual(second.changed, false);
	});
});

suite("applyNeedResolution（同一テキスト検査。ADR-260802-01）", () => {
	/** hash→原文本文の対応表から SourceTextLookup を作る */
	const lookupFrom = (map: Record<string, string>) => (fromHash: string) => map[fromHash];

	test("訳文が原文とまったく同じなら翻訳済みにできない（same-as-source でスキップ）", () => {
		const unit = makeUnit("aaa", "s1", "translate");
		const result = applyNeedResolution(
			[unit],
			{ targets: unitTargets(["aaa"]), needs: ["translate"] },
			lookupFrom({ s1: unit.content }),
		);

		assert.strictEqual(result.resolved.length, 0);
		assert.deepStrictEqual(result.skipped, [{ hash: "aaa", reason: "same-as-source" }]);
		assert.strictEqual(result.changed, false);
		assert.strictEqual(unit.marker?.need, "translate", "need は残る");
	});

	test("要改訂も同じ検査にかかる", () => {
		const unit = makeUnit("aaa", "s1", "revise@old1");
		const result = applyNeedResolution(
			[unit],
			{ targets: unitTargets(["aaa"]), needs: ["revise"] },
			lookupFrom({ s1: unit.content }),
		);
		assert.deepStrictEqual(result.skipped, [{ hash: "aaa", reason: "same-as-source" }]);
	});

	test("前後の空白・改行コードの差は「同じ」とみなす", () => {
		const unit = makeUnit("aaa", "s1", "translate");
		const withCrLf = `${unit.content.replace(/\n/g, "\r\n")}\n\n`;
		const result = applyNeedResolution(
			[unit],
			{ targets: unitTargets(["aaa"]), needs: ["translate"] },
			lookupFrom({ s1: withCrLf }),
		);
		assert.deepStrictEqual(result.skipped, [{ hash: "aaa", reason: "same-as-source" }]);
	});

	test("訳してあれば通る", () => {
		const unit = makeUnit("aaa", "s1", "translate");
		const result = applyNeedResolution(
			[unit],
			{ targets: unitTargets(["aaa"]), needs: ["translate"] },
			lookupFrom({ s1: "## Section aaa\n\nDifferent source text.\n" }),
		);
		assert.strictEqual(result.resolved.length, 1);
		assert.strictEqual(unit.marker?.need, null);
	});

	test("allowSameAsSource を指定すれば同一でも通る（コードだけのユニット等）", () => {
		const unit = makeUnit("aaa", "s1", "translate");
		const result = applyNeedResolution(
			[unit],
			{ targets: unitTargets(["aaa"]), needs: ["translate"], allowSameAsSource: true },
			lookupFrom({ s1: unit.content }),
		);
		assert.strictEqual(result.resolved.length, 1);
	});

	test("review / verify-deletion / isolate は検査の対象外（訳したかを問う need ではない）", () => {
		const units = [makeUnit("aaa", "s1", "review"), makeUnit("bbb", "s2", "verify-deletion")];
		const result = applyNeedResolution(
			units,
			{ needs: ["review", "verify-deletion"] },
			lookupFrom({ s1: units[0].content, s2: units[1].content }),
		);
		assert.strictEqual(result.resolved.length, 2);
	});

	test("原文が引けないときは判定せず通す（検査できないことを理由に止めない）", () => {
		const unit = makeUnit("aaa", "s1", "translate");
		const result = applyNeedResolution([unit], { targets: unitTargets(["aaa"]), needs: ["translate"] }, lookupFrom({}));
		assert.strictEqual(result.resolved.length, 1);
	});

	test("対象未指定の一括解決でも検査される", () => {
		const units = [makeUnit("aaa", "s1", "translate"), makeUnit("bbb", "s2", "translate")];
		const result = applyNeedResolution(units, { needs: ["translate"] }, lookupFrom({ s1: units[0].content }));
		assert.strictEqual(result.resolved.length, 1, "訳してある bbb だけ解決される");
		assert.strictEqual(result.resolved[0].hash, "bbb");
		assert.deepStrictEqual(result.skipped, [{ hash: "aaa", reason: "same-as-source" }]);
	});
});

suite("needMatchesSelection（needフィルタ一致判定）", () => {
	test("完全一致とrevise@プレフィックス一致を判定する", () => {
		assert.strictEqual(needMatchesSelection("review", ["review"]), true);
		assert.strictEqual(needMatchesSelection("revise@abc", ["revise"]), true);
		assert.strictEqual(needMatchesSelection("review", ["translate"]), false);
		assert.strictEqual(needMatchesSelection("revise@abc", ["review"]), false);
	});
});

suite("resolveNeedForFile（ファイル単位のneedフラグ解決）", () => {
	let tempDir: string;
	let targetFile: string;

	const TARGET_CONTENT = `<!-- mdait tgtA from:srcA need:review -->
## Section A

Content A.

<!-- mdait tgtB from:srcB need:verify-deletion -->
## Section B

Content B.

<!-- mdait tgtC from:srcC need:translate -->
## Section C

Content C.
`;

	async function initConfig(markers: Record<string, unknown> = {}): Promise<Configuration> {
		const mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		fs.writeFileSync(
			path.join(mdaitDir, "mdait.json"),
			JSON.stringify({
				transPairs: [
					{
						sourceDir: "ja",
						targetDir: "en",
						sourceLang: "ja",
						targetLang: "en",
					},
				],
				primaryLang: "ja",
				...(Object.keys(markers).length > 0 ? { markers } : {}),
			}),
			"utf-8",
		);
		return await Configuration.getInstance().initialize(path.join(mdaitDir, "mdait.json"));
	}

	function writeTarget(content = TARGET_CONTENT): void {
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		fs.writeFileSync(targetFile, content, "utf-8");
	}

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-resolve-"));
		__vscodeMockWorkspaceRoot = tempDir;
		targetFile = path.join(tempDir, "en", "doc.md");
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		FileMutex.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("既定ではreviewのneedだけが除去されhash/from/本文は不変（verify-deletionは残る）", async () => {
		const config = await initConfig();
		writeTarget();

		const result = await resolveNeedForFile(targetFile, config);

		assert.strictEqual(result.resolved.length, 1);
		assert.strictEqual(result.changed, true);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(written.includes("<!-- mdait tgtA from:srcA -->"));
		assert.ok(written.includes("<!-- mdait tgtB from:srcB need:verify-deletion -->"), "verify-deletionは残ること");
		assert.ok(written.includes("<!-- mdait tgtC from:srcC need:translate -->"), "translateは残ること");
		assert.ok(written.includes("Content A."));
		assert.ok(written.includes("Content B."));
		assert.deepStrictEqual(result.remainingNeedFlags.sort(), ["translate", "verify-deletion"]);
	});

	test("原文と同一の訳文は翻訳済みにできない（ファイル経由でも原文を引いて検査する）", async () => {
		const config = await initConfig();
		// sync 直後の状態: 訳文は原文のコピーで hash === from
		const sourceContent = `<!-- mdait srcA -->
## セクション A

本文 A。
`;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "ja", "doc.md"), sourceContent, "utf-8");
		writeTarget(`<!-- mdait srcA from:srcA need:translate -->
## セクション A

本文 A。
`);

		const result = await resolveNeedForFile(targetFile, config, {
			targets: unitTargets(["srcA"]),
			needs: ["translate"],
		});

		assert.strictEqual(result.resolved.length, 0);
		assert.deepStrictEqual(result.skipped, [{ hash: "srcA", reason: "same-as-source" }]);
		assert.ok(
			fs.readFileSync(targetFile, "utf-8").includes("need:translate"),
			"need は残る",
		);
	});

	test("訳してあれば通る（同一テキスト検査は訳文を止めない）", async () => {
		const config = await initConfig();
		const sourceContent = `<!-- mdait srcA -->
## セクション A

本文 A。
`;
		fs.mkdirSync(path.join(tempDir, "ja"), { recursive: true });
		fs.writeFileSync(path.join(tempDir, "ja", "doc.md"), sourceContent, "utf-8");
		writeTarget(`<!-- mdait tgtA from:srcA need:translate -->
## Section A

Body A.
`);

		const result = await resolveNeedForFile(targetFile, config, {
			targets: unitTargets(["tgtA"]),
			needs: ["translate"],
		});

		assert.strictEqual(result.resolved.length, 1);
	});

	test("2回目の実行は無変更でresolved 0件（冪等性）", async () => {
		const config = await initConfig();
		writeTarget();
		await resolveNeedForFile(targetFile, config);
		const contentAfterFirst = fs.readFileSync(targetFile, "utf-8");

		const second = await resolveNeedForFile(targetFile, config);

		assert.strictEqual(second.resolved.length, 0);
		assert.strictEqual(second.changed, false);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), contentAfterFirst);
	});

	test("unitHashes指定の2回目はskipped(already-resolved)になる（冪等性）", async () => {
		const config = await initConfig();
		writeTarget();
		const first = await resolveNeedForFile(targetFile, config, {
			targets: unitTargets(["tgtA"]),
		});
		assert.strictEqual(first.resolved.length, 1);

		const second = await resolveNeedForFile(targetFile, config, {
			targets: unitTargets(["tgtA"]),
		});
		assert.strictEqual(second.resolved.length, 0);
		assert.deepStrictEqual(second.skipped, [{ hash: "tgtA", reason: "already-resolved" }]);
	});

	test("コードブロック内のサンプルマーカーには誤マッチしない", async () => {
		const config = await initConfig();
		const contentWithCodeBlock = `<!-- mdait tgtA from:srcA need:review -->
## Section A

\`\`\`markdown
<!-- mdait fakeHash from:fakeSrc need:review -->
\`\`\`
`;
		writeTarget(contentWithCodeBlock);

		const result = await resolveNeedForFile(targetFile, config);

		assert.deepStrictEqual(
			result.resolved.map((r) => r.hash),
			["tgtA"],
		);
		const written = fs.readFileSync(targetFile, "utf-8");
		assert.ok(
			written.includes("<!-- mdait fakeHash from:fakeSrc need:review -->"),
			"コードブロック内のサンプルマーカーは書き換えないこと",
		);
	});

	test("externalマーカーモードではunit-stateストアのneedが除去され本文は不変", async () => {
		const config = await initConfig({ mode: "external" });
		const externalContent = "## Section A\n\nContent A.\n\n## Section B\n\nContent B.\n";
		writeTarget(externalContent);

		// unit-state ストアへ external マーカーを登録する
		const store = UnitStateStore.getInstance();
		store.load(path.join(tempDir, ".mdait"));
		store.setEntry({
			path: "en/doc.md",
			kind: "unit" as const, seat: seat(0),
			level: 2,
			titleHash: "",
			hash: "tgtA",
			from: "srcA",
			need: "review",
		});
		store.setEntry({
			path: "en/doc.md",
			kind: "unit" as const, seat: seat(1),
			level: 2,
			titleHash: "",
			hash: "tgtB",
			from: "srcB",
			need: "",
		});

		const result = await resolveNeedForFile(targetFile, config);

		assert.deepStrictEqual(
			result.resolved.map((r) => r.hash),
			["tgtA"],
		);
		assert.strictEqual(fs.readFileSync(targetFile, "utf-8"), externalContent, "本文にマーカーは埋め込まれないこと");
		const entries = UnitStateStore.getInstance().getEntriesByPath("en/doc.md");
		assert.strictEqual(entries[0].need, "", "ストアのneedが除去されること");
		assert.strictEqual(entries[0].hash, "tgtA");
		assert.strictEqual(entries[0].from, "srcA");
	});
});
