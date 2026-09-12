/**
 * 用語集の競合を解く係のテスト（roadmap-v04 P02）。
 *
 * 用語集は、合流で**跡を1つも残さずに片方を捨てていた**対象である（CSV の畳み込み）。
 * ここが持つ約束は「言語ごとに触った先が別なら両方採ること」と、「決まらない件が
 * 残っていれば1バイトも書かないこと」である。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyTermsResolution, planTermsResolution } from "../../../../commands/conflict/targets/terms-target";
import { TermEntry } from "../../../../commands/term/term-entry";
import { TermsRepository } from "../../../../commands/term/terms-repository";

const PAIRS = [{ sourceLang: "en", targetLang: "ja", sourceDir: "content/en", targetDir: "content/ja" }];

/** CSV の1行（primary は en） */
const row = (en: string, ja: string, context = "") => `${en},${ja},${context},`;
const HEADER = "en,ja,context,variants_en";

function csv(...rows: string[]): string {
	return `${[HEADER, ...rows].join("\n")}\n`;
}

/** 両側で中身が違う CSV を、競合マーカー入りの1ファイルにする */
function conflicted(ours: string[], theirs: string[], base?: string[]): string {
	const middle = base
		? ["<<<<<<< HEAD", ...ours, "||||||| base", ...base, "=======", ...theirs, ">>>>>>> theirs"]
		: ["<<<<<<< HEAD", ...ours, "=======", ...theirs, ">>>>>>> theirs"];
	return `${[HEADER, ...middle].join("\n")}\n`;
}

suite("用語集の競合を解く", () => {
	let tempDir: string;
	let termsPath: string;

	setup(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "terms-conflict-"));
		termsPath = path.join(tempDir, "terms.csv");
	});

	teardown(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const write = (content: string) => fs.writeFileSync(termsPath, content, "utf-8");
	/** 解決の経路が使うのと同じ、空のリポジトリ（競合中のファイルは通常の load では読めない） */
	const repo = () => TermsRepository.create(termsPath, PAIRS);
	const readBack = async () => [...(await (await TermsRepository.load(termsPath)).getAllEntries())];

	test("競合していなければ計画を作らない", async () => {
		write(csv(row("Hello", "こんにちは")));

		assert.equal(await planTermsResolution(termsPath, await repo(), "en"), undefined);
	});

	test("2人が別々の語を足しただけなら、人の前に出さない", async () => {
		write(conflicted([row("Hello", "こんにちは")], [row("Goodbye", "さようなら")]));

		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 0, "人の判断を求めてはいけない形");
		assert.equal(planned.plan.autoResolvedCount, 2);
	});

	test("同じ語に別の訳語なら、人の判断を待つ", async () => {
		write(conflicted([row("Hello", "こんにちは")], [row("Hello", "やあ")]));

		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 1);
		assert.equal(planned.plan.pending[0].label, "Hello");
		assert.match(planned.plan.pending[0].oursText, /こんにちは/);
		assert.match(planned.plan.pending[0].theirsText, /やあ/);
	});

	test("祖先があり、片方だけが訳語を直したなら、決定的に決まる", async () => {
		write(
			conflicted([row("Hello", "もとの訳")], [row("Hello", "相手が直した")], [row("Hello", "もとの訳")]),
		);

		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 0);
		assert.equal(planned.plan.hasBase, true);

		await applyTermsResolution(planned.plan, planned.resolution, await repo(), new Map());
		const back = await readBack();
		assert.equal(TermEntry.getTerm(back[0], "ja"), "相手が直した");
	});

	test("判定が決まれば、その訳語を書き戻す", async () => {
		write(conflicted([row("Hello", "こんにちは")], [row("Hello", "やあ")]));
		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);

		const key = planned.plan.pending[0].key;
		const outcome = await applyTermsResolution(
			planned.plan,
			planned.resolution,
			await repo(),
			new Map([[key, "theirs" as const]]),
		);

		assert.equal(outcome.decidedCount, 1);
		const back = await readBack();
		assert.equal(TermEntry.getTerm(back[0], "ja"), "やあ");
	});

	test("決まらない件が残っていれば、1バイトも書かない", async () => {
		const content = conflicted([row("Hello", "こんにちは")], [row("Hello", "やあ")]);
		write(content);
		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);

		const outcome = await applyTermsResolution(planned.plan, planned.resolution, await repo(), new Map());

		assert.equal(outcome.remainingCount, 1);
		assert.equal(fs.readFileSync(termsPath, "utf-8"), content, "競合マーカーごと残っていない");
	});

	test("BOM 付きの用語集でも、主言語の語が読める", async () => {
		// BOM を外し忘れると先頭の列名が `\ufeffen` になり、主言語の列が言語として
		// 認識されない（実測: 語の見出しが空になり、主言語の列が素通りしていた）
		write(`\ufeff${conflicted([row("Hello", "こんにちは")], [row("Hello", "やあ")])}`);

		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 1);
		assert.equal(planned.plan.pending[0].label, "Hello", "主言語の語が読めていない");
	});

	test("解き終えた用語集には、どちらの語も残っている", async () => {
		write(conflicted([row("Hello", "こんにちは")], [row("Goodbye", "さようなら")]));
		const planned = await planTermsResolution(termsPath, await repo(), "en");
		assert.ok(planned);

		await applyTermsResolution(planned.plan, planned.resolution, await repo(), new Map());

		const after = fs.readFileSync(termsPath, "utf-8");
		assert.doesNotMatch(after, /^<{7}|^={7}|^>{7}/m);
		const back = await readBack();
		assert.equal(back.length, 2, "どちらかの語が消えている");
	});

	suite("YAML の用語集でも同じように解ける", () => {
		test("2人が別々の語を足しただけなら、両方残る", async () => {
			const yamlPath = path.join(tempDir, "glossary.yaml");
			const head = "metadata:\n  languages:\n    - en\n    - ja\nterms:";
			const term = (en: string, ja: string) =>
				`  - context: ""\n    languages:\n      en:\n        term: ${en}\n        variants: []\n      ja:\n        term: ${ja}\n        variants: []`;
			fs.writeFileSync(
				yamlPath,
				`${[head, "<<<<<<< HEAD", term("Hello", "こんにちは"), "=======", term("Goodbye", "さようなら"), ">>>>>>> theirs"].join("\n")}\n`,
				"utf-8",
			);

			const planned = await planTermsResolution(yamlPath, await TermsRepository.create(yamlPath, PAIRS), "en");
			assert.ok(planned);
			assert.equal(planned.plan.pending.length, 0);

			await applyTermsResolution(
				planned.plan,
				planned.resolution,
				await TermsRepository.create(yamlPath, PAIRS),
				new Map(),
			);
			const back = [...(await (await TermsRepository.load(yamlPath)).getAllEntries())];
			assert.equal(back.length, 2);
		});

		test("合流の途中の YAML は、通常の読み込みでは読まずに失敗する", async () => {
			// CSV には前からあった番人。YAML だけ抜けていた（ADR-260908-02 と同じ線）
			const yamlPath = path.join(tempDir, "glossary.yaml");
			fs.writeFileSync(yamlPath, "terms:\n<<<<<<< HEAD\n  - context: a\n=======\n  - context: b\n>>>>>>> x\n", "utf-8");

			await assert.rejects(() => TermsRepository.load(yamlPath), /middle of a merge/);
		});
	});
});
