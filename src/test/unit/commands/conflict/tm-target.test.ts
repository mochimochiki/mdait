/**
 * 翻訳メモリの競合を解く係のテスト（roadmap-v04 P02）。
 *
 * ここが持つ約束は3つ。**別々の登録は人の前に出さないこと**（いちばん多い形で、二択で
 * 解かせると必ず片方が消える）、**決まらない件があれば1バイトも書かないこと**、そして
 * **書き出しは `TmxStore` の中の入口を通ること**である。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { TmxStore } from "../../../../core/tm/tmx-store";
import { applyTmResolution, planTmResolution } from "../../../../commands/conflict/targets/tm-target";

/** tuid は原文から決まる（製品と同じ計算。作り話の tuid は読み込みに弾かれる） */
const tuidOf = (primary: string) => calculateHash(primary, true);

/** TU 1つを1行の TMX として書く（製品の書き出しと同じ形） */
function tu(primary: string, variants: Record<string, string>): string {
	const tuvs = [
		`<tuv xml:lang="en"><seg>${primary}</seg></tuv>`,
		...Object.entries(variants).map(([lang, text]) => `<tuv xml:lang="${lang}"><seg>${text}</seg></tuv>`),
	].join("");
	return `<tu tuid="${tuidOf(primary)}">${tuvs}</tu>`;
}

function tmx(...tus: string[]): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n<body>\n${tus.join("\n")}\n</body>\n</tmx>\n`;
}

/** 両側で本文が違う TMX を、競合マーカー入りの1ファイルにする */
function conflicted(oursBody: string[], theirsBody: string[], baseBody?: string[]): string {
	const head = '<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n<body>';
	const tail = "</body>\n</tmx>";
	const middle = baseBody
		? ["<<<<<<< HEAD", ...oursBody, "||||||| base", ...baseBody, "=======", ...theirsBody, ">>>>>>> theirs"]
		: ["<<<<<<< HEAD", ...oursBody, "=======", ...theirsBody, ">>>>>>> theirs"];
	return `${[head, ...middle, tail].join("\n")}\n`;
}

suite("翻訳メモリの競合を解く", () => {
	let tempDir: string;
	let tmPath: string;

	setup(() => {
		TmxStore.resetInstance();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-conflict-"));
		tmPath = path.join(tempDir, "translations.tmx");
	});

	teardown(() => {
		TmxStore.resetInstance();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const write = (content: string) => fs.writeFileSync(tmPath, content, "utf-8");
	const readBack = () => TmxStore.parseSide(fs.readFileSync(tmPath, "utf-8"));

	test("競合していなければ計画を作らない", () => {
		write(tmx(tu("Hello", { ja: "こんにちは" })));

		assert.equal(planTmResolution(tmPath), undefined);
	});

	test("2人が別々の文を登録しただけなら、人の前に出さない", () => {
		// union をやめた代償で出るいちばん多い形。二択で解かせると必ず片方が消える
		write(
			conflicted(
				[tu("Hello", { ja: "こんにちは" })],
				[tu("Goodbye", { ja: "さようなら" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 0, "人の判断を求めてはいけない形");
		assert.equal(planned.plan.autoResolvedCount, 2);
	});

	test("同じ原文に別々の言語の訳を足しただけなら、両方採る", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こんにちは" })],
				[tu("Hello", { fr: "Bonjour" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 0);

		applyTmResolution(tmPath, planned.plan, planned.resolution, new Map());
		const back = readBack().get(tuidOf("Hello"));
		assert.equal(back?.variants.get("ja")?.text, "こんにちは");
		assert.equal(back?.variants.get("fr")?.text, "Bonjour");
	});

	test("同じ原文の同じ言語に別の訳なら、人の判断を待つ", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こんにちは" })],
				[tu("Hello", { ja: "やあ" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 1);
		assert.match(planned.plan.pending[0].oursText, /こんにちは/);
		assert.match(planned.plan.pending[0].theirsText, /やあ/);
	});

	test("祖先があり、片方だけが訳を直したなら、決定的に決まる", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "もとの訳" })],
				[tu("Hello", { ja: "相手が直した" })],
				[tu("Hello", { ja: "もとの訳" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 0);
		assert.equal(planned.plan.hasBase, true);

		applyTmResolution(tmPath, planned.plan, planned.resolution, new Map());
		assert.equal(readBack().get(tuidOf("Hello"))?.variants.get("ja")?.text, "相手が直した");
	});

	test("判定が決まれば、その訳を書き戻す", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こんにちは" })],
				[tu("Hello", { ja: "やあ" })],
			),
		);
		const planned = planTmResolution(tmPath);
		assert.ok(planned);

		const outcome = applyTmResolution(
			tmPath,
			planned.plan,
			planned.resolution,
			new Map([[tuidOf("Hello"), "theirs" as const]]),
		);

		assert.equal(outcome.decidedCount, 1);
		assert.equal(outcome.remainingCount, 0);
		assert.equal(readBack().get(tuidOf("Hello"))?.variants.get("ja")?.text, "やあ");
	});

	test("決まらない件が残っていれば、1バイトも書かない", () => {
		// 半端に書き戻すと、残った件の両側がディスクから消える
		const content = conflicted(
			[tu("Hello", { ja: "こんにちは" })],
			[tu("Hello", { ja: "やあ" })],
		);
		write(content);
		const planned = planTmResolution(tmPath);
		assert.ok(planned);

		const outcome = applyTmResolution(tmPath, planned.plan, planned.resolution, new Map());

		assert.equal(outcome.remainingCount, 1);
		assert.equal(outcome.decidedCount, 0);
		assert.equal(fs.readFileSync(tmPath, "utf-8"), content, "競合マーカーごと残っていない");
	});

	test("祖先があり、片方だけが訳を消したなら、消えたままにする", () => {
		// 消したのに祖先の訳が戻ってくると、消す操作がいつまでも効かない
		write(
			conflicted(
				[tu("Hello", { ja: "もとの訳", fr: "bonjour" })],
				[tu("Hello", { fr: "bonjour" })],
				[tu("Hello", { ja: "もとの訳", fr: "bonjour" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 0);

		applyTmResolution(tmPath, planned.plan, planned.resolution, new Map());
		const back = readBack().get(tuidOf("Hello"));
		assert.equal(back?.variants.get("ja"), undefined, "消した訳が戻っている");
		assert.equal(back?.variants.get("fr")?.text, "bonjour");
	});

	test("片方が消し、片方が直した訳は、人の判断を待つ", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こちらが直した", fr: "bonjour" })],
				[tu("Hello", { fr: "bonjour" })],
				[tu("Hello", { ja: "もとの訳", fr: "bonjour" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		assert.equal(planned.plan.pending.length, 1);
	});

	test("片方が TU ごと消し、片方が直したなら、消した側には値を持たせない", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こちらが直した" }), tu("Goodbye", { ja: "さようなら" })],
				[tu("Goodbye", { ja: "さようなら" })],
				[tu("Hello", { ja: "もとの訳" }), tu("Goodbye", { ja: "さようなら" })],
			),
		);

		const planned = planTmResolution(tmPath);
		assert.ok(planned);
		const item = planned.plan.pending.find((candidate) => candidate.key === tuidOf("Hello"));
		assert.ok(item, "消された TU が人へ回っていない");
		assert.equal(item.theirsDeleted, true);
		// 祖先の値を置くと、その側を採れば訳が戻ると読めてしまう。**空のまま**渡し、
		// 「削除」と書くかどうかは表示する側が決める
		assert.equal(item.theirsText, "", "祖先の訳を相手の値として見せている");
	});

	test("消した側を採れば、その TU は消えたままになる", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こちらが直した" }), tu("Goodbye", { ja: "さようなら" })],
				[tu("Goodbye", { ja: "さようなら" })],
				[tu("Hello", { ja: "もとの訳" }), tu("Goodbye", { ja: "さようなら" })],
			),
		);
		const planned = planTmResolution(tmPath);
		assert.ok(planned);

		const outcome = applyTmResolution(
			tmPath,
			planned.plan,
			planned.resolution,
			new Map([[tuidOf("Hello"), "theirs" as const]]),
		);

		assert.equal(outcome.decidedCount, 1);
		assert.equal(readBack().get(tuidOf("Hello")), undefined, "祖先の値が書き戻っている");
		assert.equal(readBack().get(tuidOf("Goodbye"))?.variants.get("ja")?.text, "さようなら");
	});

	test("解き終えたファイルには競合マーカーが残らない", () => {
		write(
			conflicted(
				[tu("Hello", { ja: "こんにちは" })],
				[tu("Goodbye", { ja: "さようなら" })],
			),
		);
		const planned = planTmResolution(tmPath);
		assert.ok(planned);

		applyTmResolution(tmPath, planned.plan, planned.resolution, new Map());

		const after = fs.readFileSync(tmPath, "utf-8");
		assert.doesNotMatch(after, /^<{7}|^={7}|^>{7}/m);
		assert.equal(readBack().size, 2, "どちらかの登録が消えている");
	});
});
