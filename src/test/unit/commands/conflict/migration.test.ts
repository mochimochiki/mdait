/**
 * 既にある作業場からの移行のテスト（roadmap-v04 P04）。
 *
 * union を外したのだから、**union が書かれたままの作業場を開いた人**にも移行が届かなければ
 * ならない。ここが持つ約束は「開いただけで指定が外れること」と、「溜まっていた合流由来の
 * 行が、解決と同期で片付くこと」である。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyUnitStateResolution } from "../../../../commands/conflict/targets/state-target";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { UnitStateStore, isMergeHeldEntry } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";
import { ensureMdaitDir } from "../../../../infra/workspace/mdait-dir";
import { resetUnitStateLock } from "../../../../infra/workspace/unit-state-lock";
import { seat } from "../../helpers/unit-state";

declare let __vscodeMockWorkspaceRoot: string;

suite("既にある作業場からの移行", () => {
	let tempDir: string;
	let mdaitDir: string;

	setup(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		resetUnitStateLock();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-"));
		mdaitDir = path.join(tempDir, ".mdait");
		fs.mkdirSync(mdaitDir, { recursive: true });
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		UnitStateStore.dispose();
		resetUnitStateLock();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const attributes = () => path.join(mdaitDir, ".gitattributes");

	test("union が書かれた作業場を開くだけで、指定が外れる", async () => {
		// 前の版の mdait が書いた4行そのもの
		fs.writeFileSync(
			attributes(),
			"unit-state merge=union\nunit-registry merge=union\ntranslations.tmx merge=union\nterms.csv merge=union\n",
			"utf-8",
		);

		await ensureMdaitDir();

		assert.equal(fs.existsSync(attributes()), false, "移行が届いていない");
	});

	test("利用者が足した行は残る", async () => {
		fs.writeFileSync(attributes(), "unit-state merge=union\n*.md text eol=lf\nlogs/* binary\n", "utf-8");

		await ensureMdaitDir();

		const after = fs.readFileSync(attributes(), "utf-8");
		assert.doesNotMatch(after, /merge=union/);
		assert.match(after, /^\*\.md text eol=lf$/m);
		assert.match(after, /^logs\/\* binary$/m);
	});

	test("溜まっていた合流由来の行は、解決で片付く（行は1つも失われない）", async () => {
		// union を掛けたまま合流を重ねた作業場には、同じ席の行が2つ並んでいる
		const title = calculateHash("章");
		fs.writeFileSync(
			path.join(mdaitDir, "unit-state"),
			[
				"# mdait unit-state",
				"",
				"# aaaaaaaaaaaa en/a.md",
				"",
				`aaaaaaaaaaaa\tunit\t${seat(0)}\t2\t${title}\t${calculateHash("古い本文")}\tsrc-old\t`,
				`aaaaaaaaaaaa\tunit\t${seat(0)}\t2\t${title}\t${calculateHash("新しい本文")}\tsrc-new\trevise@src-new`,
				"",
			].join("\n"),
			"utf-8",
		);

		const outcome = await applyUnitStateResolution(mdaitDir);

		assert.equal(outcome.rows, 2, "行が失われている");
		assert.equal(outcome.unseated, 1);
		const merged = UnitStateStore.getInstance().getEntriesByPath("en/a.md").filter(isMergeHeldEntry);
		assert.equal(merged.length, 1, "合流由来として見分けられていない");
	});

	test("まだ mdait 化していない作業場では、何も作らない", async () => {
		// `.gitattributes` を作らないのはもちろん、勝手に作り直しもしない
		await ensureMdaitDir();

		assert.equal(fs.existsSync(attributes()), false);
	});
});
