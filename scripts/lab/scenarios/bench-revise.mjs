#!/usr/bin/env node
/*
 * 改訂（revise）の指示文ベンチ — どの出力形式なら改訂が成立するかを数える。
 *
 * なぜ mdait を丸ごと走らせないのか
 *   知りたいのは「AI が返した答えがパッチとして成立するか」だけで、ファイル層・排他・
 *   マーカー更新は関係ない。実物を走らせると1件28秒かかり、しかも失敗がファイル層の
 *   事情と混ざる。ここでは**本番の関数をそのまま呼ぶ**（偽物は1つも挟まない）:
 *     protectCodeBlocks / elideCodeBlocks … 送る本文の作り方（translator.ts）
 *     createUnifiedDiff                    … 原文差分の作り方（diff-generator.ts）
 *     buildUserMessage                     … user message の組み立て（prompt-provider.ts）
 *     extractJsonFromResponse / detectJsonInContent … 封筒の開け方（response-validator.ts）
 *     applySimplePatch                     … 当てはめ（diff-generator.ts）
 *   置き換えているのはファイルの読み書きと VS Code だけ。測った成功率はそのまま製品の成功率になる。
 *
 * 何を数えるか（段階。手前で落ちたら後ろは見ない）
 *   transport … HTTP が返ったか
 *   envelope  … 封筒からパッチ本文を取り出せたか（JSON が壊れていないか等）
 *   format    … パッチが要求した書式になっているか
 *   apply     … 前回訳文に当たったか
 *   health    … **当たった結果が壊れていないか**
 *
 *   health を分けているのが要点。当てはめ器はわざと寛容なので、出鱈目なパッチでも
 *   「当たって」しまうことがある。apply だけを数えると、原稿を壊す候補が満点になる。
 *
 *   このほかに intent（改訂の中身が入ったか）を目安として横に出すが、**合否には使わない**。
 *   訳文の正解は一意でないので、正規表現の当たり外れで勝者を決めてはいけない。
 *
 * 動かし方
 *   node scripts/lab/lab.mjs bench-revise --model haiku          （まとめ役が shim を立てる）
 *   node scripts/lab/scenarios/bench-revise.mjs --base-url http://127.0.0.1:8080/v1 --model qwen
 *   node scripts/lab/scenarios/bench-revise.mjs --self-test      （LLM を1回も呼ばない）
 *
 *     --base-url <URL>     OpenAI 互換の行き先。省略時は lab のセッションの shim
 *     --model <名前>       送るモデル名
 *     --api-key <値>       Authorization に載せる値（既定 lab-bench）
 *     --cases C1,C4        ケースを絞る
 *     --variants a,b       候補を絞る
 *     --repeat <回数>      同じ組を何回試すか（既定 1）
 *     --concurrency <数>   同時に投げる数（既定 4）
 *     --timeout <秒>       1件あたりの上限（既定 180）
 *     --out <パス>         結果の JSON の書き出し先
 *     --self-test          LLM を呼ばず、判定の筋道だけを確かめる
 *     --dry                何を送るつもりかだけを出して終わる
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asNumber, parseArgs } from "../lib/args.mjs";
import { readSession } from "../lib/session.mjs";
import { selectCases } from "./revise-cases.mjs";
import { USER_SECTION_MARKER, selectVariants } from "./revise-variants.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

require(path.join(REPO, "scripts", "lab", "vscode-shim.js"));
const { protectCodeBlocks, elideCodeBlocks } = require(path.join(REPO, "out", "commands", "trans", "translator.js"));
const { createUnifiedDiff } = require(path.join(REPO, "out", "core", "diff", "diff-generator.js"));
const { buildUserMessage } = require(path.join(REPO, "out", "prompts", "prompt-provider.js"));

const say = (text = "") => process.stdout.write(`${text}\n`);

// ===========================================================================
// 指示文を組み立てる
// ===========================================================================

/**
 * `{{変数}}` と `{{#変数}}…{{/変数}}` を展開する。
 *
 * **本番（PromptProvider.replaceVariables）と同じ規則**。写しなので離れうるが、
 * 離れたことは self-test の `guardTemplateFidelity` が気づく（`current` の
 * レンダリング結果を本番の PromptProvider と1バイトずつ突き合わせている）。
 */
function replaceVariables(template, variables) {
	let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, content) => {
		const value = variables[key];
		if (value !== undefined && value !== "") {
			return content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
		}
		return "";
	});
	for (const [key, value] of Object.entries(variables)) {
		if (value === undefined || value === null) continue;
		result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
	}
	// 埋まらなかった変数は消す（本番も同じ）
	return result.replace(/\{\{\w+\}\}/g, "");
}

/** テンプレートを system / user-section に割る（本番 getPromptParts と同じ切り方） */
function splitTemplate(template, variables) {
	const at = template.indexOf(USER_SECTION_MARKER);
	if (at === -1) {
		return { system: replaceVariables(template, variables), userContext: "", isLegacy: true };
	}
	return {
		system: replaceVariables(template.slice(0, at).trimEnd(), variables),
		userContext: replaceVariables(template.slice(at + USER_SECTION_MARKER.length), variables).trim(),
		isLegacy: false,
	};
}

/** 前回訳文に行番号を振る（linenum 候補用） */
export function numberLines(text) {
	return text
		.split("\n")
		.map((line, at) => `${at + 1}\t${line}`)
		.join("\n");
}

/**
 * 1件分の依頼（system と user message）を組み立てる。
 * 本番 `AITranslator.translateRevisionPatch` の段取りをそのまま踏む。
 */
export function buildRequest(testCase, variant) {
	const markdown = testCase.fileExtension === ".md";
	// 原文はコードブロックを目印に畳んでから送る（本番と同じ）
	const { text: sourceForModel } = protectCodeBlocks(testCase.sourceNew, { markdown });
	const sourceDiff = createUnifiedDiff(testCase.sourceOld, testCase.sourceNew, "source");

	const variables = {
		sourceLang: testCase.sourceLang,
		targetLang: testCase.targetLang,
		contextLang: testCase.sourceLang,
		surroundingText: elideCodeBlocks("", { markdown }),
		terms: "",
		tmReferences: "",
		fileExtension: testCase.fileExtension,
		// 前回訳文は畳まずに生のまま渡す。畳むと文脈行が実物と一致しなくなる（本番のコメント参照）
		previousTranslation: testCase.previousTranslation,
		numberedPreviousTranslation: numberLines(testCase.previousTranslation),
		sourceDiff,
	};

	const parts = splitTemplate(variant.template, variables);
	return {
		system: parts.system,
		user: buildUserMessage(parts, sourceForModel),
		sourceDiff,
	};
}

// ===========================================================================
// 健全性の判定（apply に通ったあとに見る）
// ===========================================================================

const CJK = /[぀-ヿ㐀-䶿一-鿿]/;

/** コードフェンスの外側の行だけを返す */
function outsideFences(text) {
	const out = [];
	let inside = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) {
			inside = !inside;
			continue;
		}
		if (!inside) out.push(line);
	}
	return out;
}

const countFences = (text) => text.split("\n").filter((l) => /^\s*```/.test(l)).length;
const countHeadings = (text) => outsideFences(text).filter((l) => /^#{1,6}\s/.test(l)).length;

/** 行単位の対称差。同じ行が何本入れ替わったかを数える */
export function countChangedLines(before, after) {
	const bag = new Map();
	for (const line of before.split("\n")) bag.set(line, (bag.get(line) ?? 0) + 1);
	let added = 0;
	for (const line of after.split("\n")) {
		const left = bag.get(line) ?? 0;
		if (left > 0) bag.set(line, left - 1);
		else added += 1;
	}
	let removed = 0;
	for (const left of bag.values()) removed += left;
	return Math.max(added, removed);
}

/**
 * 「当たった結果」が壊れていないかを見る。ゴールデン不要・決定的。
 * @returns {string[]} 見つかった問題（空なら健全）
 */
export function checkHealth(testCase, result) {
	const previous = testCase.previousTranslation;
	const problems = [];

	if (!result.trim()) {
		return ["empty-result"];
	}
	if (countFences(result) % 2 !== 0) problems.push("fence-unbalanced");
	if (countFences(result) !== countFences(previous)) problems.push("fence-count-changed");

	const hadPlaceholder = /__CODE_BLOCK_(PLACEHOLDER_\d+|OMITTED)__/.test(previous);
	if (!hadPlaceholder && /__CODE_BLOCK_(PLACEHOLDER_\d+|OMITTED)__/.test(result)) {
		problems.push("placeholder-residue");
	}
	if (countHeadings(result) !== countHeadings(previous)) problems.push("heading-count-changed");

	if (!testCase.allowCjk && outsideFences(result).some((line) => CJK.test(line))) {
		problems.push("source-language-leak");
	}
	// 行番号を振って渡した候補が、その番号をそのまま書き戻していないか
	if (outsideFences(result).some((line) => /^\d+\t/.test(line))) problems.push("line-number-residue");

	const changed = countChangedLines(previous, result);
	if (changed > testCase.maxChangedLines) problems.push(`over-edit(${changed}>${testCase.maxChangedLines})`);

	const previousLines = previous.split("\n").length;
	if (result.split("\n").length < previousLines * 0.6) problems.push("truncated");

	return problems;
}

/** 改訂の中身が入ったかの目安。合否には使わない */
export function checkIntent(testCase, result) {
	const expect = testCase.expect;
	if (!expect) return null;
	const misses = [];
	for (const pattern of expect.present ?? []) {
		if (!new RegExp(pattern, "i").test(result)) misses.push(`missing:${pattern}`);
	}
	for (const pattern of expect.absent ?? []) {
		if (new RegExp(pattern, "i").test(result)) misses.push(`stale:${pattern}`);
	}
	return { ok: misses.length === 0, misses };
}

// ===========================================================================
// 1件を判定する（HTTP を除いた部分。self-test はここだけを叩く）
// ===========================================================================

/**
 * モデルの生の答えを段階ごとに判定する。
 * @returns {{stage:string, ok:boolean, reason?:string, detail?:string, text?:string,
 *            health?:string[], intent?:object|null}}
 */
export function judge(testCase, variant, raw) {
	// **1件の悪い答えで 35 件の結果を道連れにしない。**
	// 封筒を開く側も当てる側も、外の道具（JSON.parse・diff の applyPatch）を呼ぶので、
	// 「読めない」を返り値ではなく例外で知らせてくることがある（実測: applyPatch は
	// 壊れたハンクで throw する）。**ベンチにとって壊れた答えは観測対象であって異常事態ではない**
	// ので、例外はその1マスの失敗として記録し、走行そのものは続ける
	let envelope;
	try {
		envelope = variant.parseEnvelope(raw);
	} catch (error) {
		return { stage: "envelope", ok: false, reason: "envelope-threw", detail: String(error?.message ?? error) };
	}
	if (!envelope.ok) {
		return { stage: "envelope", ok: false, reason: envelope.reason, detail: envelope.detail };
	}
	let applied;
	try {
		applied = variant.applyPatch(testCase.previousTranslation, envelope.patch);
	} catch (error) {
		return { stage: "format", ok: false, reason: "apply-threw", detail: String(error?.message ?? error) };
	}
	if (!applied.ok) {
		// 書式そのものが違うのか、当てる場所が見つからなかったのかを分ける
		const stage = ["unrecognized-format", "empty-patch", "no-changes", "unterminated-block", "bad-range"].includes(
			applied.reason,
		)
			? "format"
			: "apply";
		return { stage, ok: false, reason: applied.reason };
	}
	const health = checkHealth(testCase, applied.text);
	const intent = checkIntent(testCase, applied.text);
	if (health.length > 0) {
		return { stage: "health", ok: false, reason: health.join(","), text: applied.text, health, intent };
	}
	return { stage: "health", ok: true, text: applied.text, health, intent };
}

// ===========================================================================
// HTTP
// ===========================================================================

async function askModel({ baseURL, model, apiKey, system, user, timeoutSec }) {
	const url = `${baseURL.replace(/\/$/, "")}/chat/completions`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
	const startedAt = Date.now();
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				stream: false,
			}),
			signal: controller.signal,
		});
		const durationMs = Date.now() - startedAt;
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return { ok: false, reason: `http-${response.status}`, detail: body.slice(0, 300), durationMs };
		}
		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content ?? "";
		const finish = data?.choices?.[0]?.finish_reason;
		if (finish === "length") return { ok: false, reason: "truncated-by-length", durationMs, raw: content };
		return { ok: true, raw: content, durationMs };
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const aborted = error?.name === "AbortError";
		return {
			ok: false,
			reason: aborted ? "timeout" : "transport-error",
			detail: String(error?.message ?? error),
			durationMs,
		};
	} finally {
		clearTimeout(timer);
	}
}

// ===========================================================================
// 走らせる
// ===========================================================================

/** 決まった同時数で順に片付ける */
async function pool(items, limit, worker) {
	const results = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const at = next++;
			if (at >= items.length) return;
			results[at] = await worker(items[at], at);
		}
	});
	await Promise.all(runners);
	return results;
}

export async function run(options = {}) {
	const cases = selectCases(options.cases);
	const variants = selectVariants(options.variants);
	const repeat = Math.max(1, asNumber(options.repeat, 1));
	const concurrency = Math.max(1, asNumber(options.concurrency, 4));
	const timeoutSec = Math.max(5, asNumber(options.timeout, 180));

	const session = readSession();
	const baseURL = options.baseUrl ?? session?.ai?.baseURL;
	const model = options.model ?? "bench";
	const apiKey = options.apiKey ?? "lab-bench";

	if (options.dry) {
		say(`改訂ベンチ（送らずに中身だけ出します）`);
		say(`  行き先: ${baseURL ?? "（未設定）"}   モデル: ${model}`);
		say(`  ケース: ${cases.map((c) => c.id).join(" ")}`);
		say(`  候補  : ${variants.map((v) => v.id).join(" ")}`);
		say(
			`  往復数: ${cases.length * variants.length * repeat} 回（${cases.length}ケース × ${variants.length}候補 × ${repeat}回）`,
		);
		const sample = buildRequest(cases[0], variants[0]);
		say("");
		say(`  ${cases[0].id} × ${variants[0].id} に送るもの:`);
		say(`    system      ${sample.system.length} 文字`);
		say(`    user        ${sample.user.length} 文字`);
		say(`    原文差分    ${sample.sourceDiff.split("\n").length} 行`);
		return { failed: 0, dry: true };
	}

	if (!baseURL) {
		throw new Error("行き先が分かりません。--base-url を渡すか、先に `lab up --ai agent` で実験場を起こしてください");
	}

	/** @type {Array<{testCase:object, variant:object, attempt:number}>} */
	const jobs = [];
	for (const variant of variants) {
		for (const testCase of cases) {
			for (let attempt = 1; attempt <= repeat; attempt += 1) jobs.push({ testCase, variant, attempt });
		}
	}

	say(`========== 改訂ベンチ ==========`);
	say(`行き先 ${baseURL}   モデル ${model}`);
	say(`${cases.length}ケース × ${variants.length}候補 × ${repeat}回 = ${jobs.length} 往復（同時 ${concurrency}）`);
	say("");

	let done = 0;
	const records = await pool(jobs, concurrency, async ({ testCase, variant, attempt }) => {
		// 最後の砦。judge の中は個別に守ってあるが、依頼の組み立てや HTTP まわりで
		// 想定外が出ても**この1マスだけを失敗にして走り切る**（36往復ぶんの枠を
		// 1件の事故で捨てない）
		let answer = { ok: false, reason: "bench-error", durationMs: 0 };
		let verdict;
		try {
			const request = buildRequest(testCase, variant);
			answer = await askModel({ baseURL, model, apiKey, system: request.system, user: request.user, timeoutSec });
			verdict = answer.ok
				? judge(testCase, variant, answer.raw)
				: { stage: "transport", ok: false, reason: answer.reason, detail: answer.detail };
		} catch (error) {
			verdict = { stage: "transport", ok: false, reason: "bench-error", detail: String(error?.message ?? error) };
		}
		done += 1;
		process.stderr.write(`\r  ${done}/${jobs.length} 完了`);
		return {
			case: testCase.id,
			difficulty: testCase.difficulty,
			stress: testCase.stress,
			variant: variant.id,
			attempt,
			durationMs: answer.durationMs,
			stage: verdict.stage,
			ok: verdict.ok,
			reason: verdict.reason ?? null,
			detail: verdict.detail ?? null,
			health: verdict.health ?? null,
			intent: verdict.intent ?? null,
			raw: answer.raw ?? null,
			result: verdict.text ?? null,
		};
	});
	process.stderr.write("\r");

	report(records, variants, cases);

	const outPath = options.out ?? path.join(session?.runDir ?? "/tmp", "bench-revise.json");
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, `${JSON.stringify({ baseURL, model, repeat, records }, null, "\t")}\n`, "utf8");
	say("");
	say(`全文（送ったものと返ってきたもの）は ${outPath}`);

	return { failed: 0, records, outPath };
}

/** 表にして出す。成功率ではなく「どこで落ちたか」が読めることを優先する */
function report(records, variants, cases) {
	const STAGES = ["transport", "envelope", "format", "apply", "health"];
	const pad = (text, width) => String(text).padEnd(width, " ");

	say("候補ごとの成績（成立＝health まで通ったもの / 括弧内は落ちた段）");
	say("");
	say(`  ${pad("候補", 15)}${pad("成立", 10)}${STAGES.map((s) => pad(s, 11)).join("")}${pad("intent", 8)}`);
	for (const variant of variants) {
		const mine = records.filter((r) => r.variant === variant.id);
		const passed = mine.filter((r) => r.ok).length;
		const cells = STAGES.map((stage) => pad(mine.filter((r) => !r.ok && r.stage === stage).length || "·", 11));
		const intentOk = mine.filter((r) => r.ok && r.intent?.ok).length;
		const rate = mine.length > 0 ? Math.round((passed / mine.length) * 100) : 0;
		say(
			`  ${pad(variant.id, 15)}${pad(`${passed}/${mine.length} (${rate}%)`, 10)}${cells.join("")}${pad(`${intentOk}/${mine.length}`, 8)}`,
		);
	}

	say("");
	say("落ちた理由の内訳");
	const reasons = new Map();
	for (const record of records) {
		if (record.ok) continue;
		const key = `${record.variant} / ${record.stage} / ${record.reason}`;
		reasons.set(key, (reasons.get(key) ?? 0) + 1);
	}
	if (reasons.size === 0) say("  （なし）");
	for (const [key, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
		say(`  ${pad(count, 4)}${key}`);
	}

	say("");
	say("ケースごと（◯成立 ／ ×落ちた ／ △成立したが intent を外した）");
	const header = cases.map((c) => pad(c.id, 5)).join("");
	say(`  ${pad("候補", 15)}${header}`);
	for (const variant of variants) {
		const cells = cases.map((testCase) => {
			const mine = records.filter((r) => r.variant === variant.id && r.case === testCase.id);
			if (mine.length === 0) return pad("·", 5);
			const passed = mine.filter((r) => r.ok).length;
			if (passed === 0) return pad("×", 5);
			if (passed < mine.length) return pad(`${passed}/${mine.length}`, 5);
			return pad(mine.every((r) => r.intent?.ok !== false) ? "◯" : "△", 5);
		});
		say(`  ${pad(variant.id, 15)}${cells.join("")}`);
	}
}

// ===========================================================================
// 自前の点検（LLM を1回も呼ばない）
// ===========================================================================

/**
 * `current` 候補のレンダリング結果が、本番の PromptProvider と1バイトも違わないことを確かめる。
 * ここが離れると、ベンチは「本番とは違う指示文」を測ることになる。
 */
function guardTemplateFidelity() {
	const { PromptProvider } = require(path.join(REPO, "out", "prompts", "prompt-provider.js"));
	const { PromptIds } = require(path.join(REPO, "out", "prompts", "defaults.js"));
	const testCase = selectCases("C1")[0];
	const variant = selectVariants("current")[0];

	const markdown = testCase.fileExtension === ".md";
	const variables = {
		sourceLang: testCase.sourceLang,
		targetLang: testCase.targetLang,
		contextLang: testCase.sourceLang,
		surroundingText: elideCodeBlocks("", { markdown }),
		terms: "",
		tmReferences: "",
		fileExtension: testCase.fileExtension,
		previousTranslation: testCase.previousTranslation,
		sourceDiff: createUnifiedDiff(testCase.sourceOld, testCase.sourceNew, "source"),
	};

	const mine = splitTemplate(variant.template, variables);
	const theirs = PromptProvider.getInstance().getPromptParts(PromptIds.TRANS_REVISE_PATCH, variables);
	const same = mine.system === theirs.system && mine.userContext === theirs.userContext;
	return {
		name: "本番の PromptProvider と同じ指示文を組み立てている",
		ok: same,
		detail: same
			? ""
			: `system ${mine.system.length}/${theirs.system.length} 文字, userContext ${mine.userContext.length}/${theirs.userContext.length} 文字`,
	};
}

/** 判定の筋道が正しく動くことを、作り物の答えで確かめる */
function selfTestChecks() {
	const checks = [];
	const add = (name, ok, detail = "") => checks.push({ name, ok, detail });

	const c1 = selectCases("C1")[0];
	const [current, plain, udiff, searchreplace, linenum] = selectVariants("current,plain,udiff,searchreplace,linenum");
	const prev = c1.previousTranslation;
	const goodLine =
		"We target small and medium-sized enterprises and startups seeking global expansion. The domestic translation market is worth approximately 300 billion yen (of which business documents account for 40%), while the global market is projected at 62 billion dollars with an annual growth rate of about 9%.";
	const oldLine = prev.split("\n")[4];

	// --- 成立する答え（候補ごとに1つずつ） ---
	const okCurrent = judge(c1, current, JSON.stringify({ targetPatch: `=\n-${oldLine}\n+${goodLine}` }));
	add(`current: 正しいパッチが成立する`, okCurrent.ok, okCurrent.reason ?? "");

	const okPlain = judge(c1, plain, `=\n-${oldLine}\n+${goodLine}`);
	add(`plain: 正しいパッチが成立する`, okPlain.ok, okPlain.reason ?? "");

	const okUdiff = judge(c1, udiff, `@@ -3,3 +3,3 @@\n ### Target Market\n \n-${oldLine}\n+${goodLine}`);
	add(`udiff: 正しい unified diff が成立する`, okUdiff.ok, okUdiff.reason ?? "");

	const okSr = judge(c1, searchreplace, `<<<<<<< SEARCH\n${oldLine}\n=======\n${goodLine}\n>>>>>>> REPLACE`);
	add(`searchreplace: 正しいブロックが成立する`, okSr.ok, okSr.reason ?? "");

	const okLine = judge(c1, linenum, `REPLACE 5\n${goodLine}\nEND`);
	add(`linenum: 行番号の指示が成立する`, okLine.ok, okLine.reason ?? "");

	// --- 落ちるべき答え ---
	const brokenJson = judge(c1, current, '{"targetPatch": "=\n-broken');
	add(`current: 壊れた JSON は envelope で落ちる`, !brokenJson.ok && brokenJson.stage === "envelope", brokenJson.stage);

	const fenced = judge(
		c1,
		current,
		`\`\`\`json\n${JSON.stringify({ targetPatch: `=\n-${oldLine}\n+${goodLine}` })}\n\`\`\``,
	);
	add(`current: コードフェンスで包まれても開ける`, fenced.ok, fenced.reason ?? "");

	const wrongShape = judge(c1, udiff, `=\n-${oldLine}\n+${goodLine}`);
	add(`udiff: 別の書式で返したら format で落ちる`, !wrongShape.ok && wrongShape.stage === "format", wrongShape.stage);

	const noAnchor = judge(
		c1,
		searchreplace,
		`<<<<<<< SEARCH\nthis line does not exist anywhere\n=======\nsomething\n>>>>>>> REPLACE`,
	);
	add(`searchreplace: 目印が無ければ apply で落ちる`, !noAnchor.ok && noAnchor.stage === "apply", noAnchor.stage);

	// SEARCH の末尾に空白が紛れても、余分な文字を食わないこと。
	// 位置を「空白を落とした search」で探しながら長さを落とす前で数えていた時期があり、
	// 差の分だけ後ろを食って**次の行と繋がっていた**（health は over-edit に届かず素通りする）。
	// だから健全性ではなく、出来上がりの文字列そのものを突き合わせる
	const c2 = selectCases("C2")[0];
	const c2Lines = c2.previousTranslation.split("\n");
	const trailing = judge(
		c2,
		searchreplace,
		`<<<<<<< SEARCH\n${c2Lines[4]}  \n=======\n- Pd(PPh₃)₄ (1.0 mol%)\n>>>>>>> REPLACE`,
	);
	const trailingWant = [...c2Lines.slice(0, 4), "- Pd(PPh₃)₄ (1.0 mol%)", ...c2Lines.slice(5)].join("\n");
	add(
		`searchreplace: SEARCH の末尾に空白が紛れても、後ろの文字を食わない`,
		trailing.ok && trailing.text === trailingWant,
		trailing.ok ? `出来上がりが違う: ${JSON.stringify(trailing.text?.slice(100, 200))}` : String(trailing.reason),
	);

	// 壊れた unified diff は**例外ではなく判定**として返ること。
	// diff の applyPatch は「当たらない」を false で返す一方、「diff として読めない」は
	// throw で知らせる（実測: "Hunk at line 7 contained invalid line"）。捕まえ損ねると
	// 1件の悪い答えが走行ごと落とし、36往復ぶんの枠が消える（実際に一度そうなった）
	const brokenHunk = judge(
		c1,
		udiff,
		`@@ -1,5 +1,5 @@\n ## Market Analysis\n\nthis line has no prefix at all\n+${goodLine}`,
	);
	add(
		`udiff: ハンクが壊れていても例外にせず format で落とす`,
		!brokenHunk.ok && brokenHunk.stage === "format",
		`${brokenHunk.stage} / ${brokenHunk.reason}`,
	);

	// judge そのものが、道具の投げる例外を1マスの失敗に閉じ込めること
	const throwing = {
		id: "throwing",
		parseEnvelope: () => {
			throw new Error("boom");
		},
		applyPatch: () => ({ ok: true, text: "" }),
	};
	const contained = judge(c1, throwing, "anything");
	add(
		`封筒を開く側が投げても、走行を止めず1マスの失敗にする`,
		!contained.ok && contained.reason === "envelope-threw",
		String(contained.reason),
	);

	const outOfRange = judge(c1, linenum, `REPLACE 999\nnope\nEND`);
	add(
		`linenum: 存在しない行番号は format で落ちる`,
		!outOfRange.ok && outOfRange.reason === "bad-range",
		outOfRange.reason,
	);

	// --- ここが肝: 「当たったが壊れた」を満点にしない ---
	// 先頭1行だけを文脈として残し、あとは丸ごと入れ替える。当てはめ自体は通る形にしておく
	// （通らないと format で落ちてしまい、health の網が働いたことを確かめられない）
	const [firstLine, ...restLines] = prev.split("\n");
	const wholeRewrite = judge(
		c1,
		plain,
		`=${firstLine}\n${restLines.map((l) => `-${l}`).join("\n")}\n+Completely rewritten from scratch.\n+A second invented line.\n+A third invented line.`,
	);
	add(
		`当てはめには通っても、全文を書き直したら health で落ちる`,
		!wholeRewrite.ok && wholeRewrite.stage === "health",
		`${wholeRewrite.stage} / ${wholeRewrite.reason}`,
	);

	const leaked = judge(c1, plain, `=\n-${oldLine}\n+グローバル市場は620億ドル規模と予測されている。`);
	add(
		`原文の言語が漏れたら health で落ちる`,
		!leaked.ok && String(leaked.reason).includes("source-language-leak"),
		String(leaked.reason),
	);

	const c4 = selectCases("C4")[0];
	const fenceBreak = judge(
		c4,
		plain,
		`=## Error Responses\n=\n-On error, the API responds in the following format.\n+On error, the API responds like this:\n+\`\`\`\n`,
	);
	add(
		`コードフェンスの数が変わったら health で落ちる`,
		!fenceBreak.ok && String(fenceBreak.reason).includes("fence"),
		String(fenceBreak.reason),
	);

	const numberEcho = judge(c1, linenum, `REPLACE 5\n5\t${goodLine}\nEND`);
	add(
		`行番号を書き戻したら health で落ちる`,
		!numberEcho.ok && String(numberEcho.reason).includes("line-number-residue"),
		String(numberEcho.reason),
	);

	// --- 送るものが本番と同じか ---
	checks.push(guardTemplateFidelity());

	// --- コードブロックが目印に畳まれて送られているか ---
	const request = buildRequest(c4, current);
	add(
		`コードブロックは目印に畳んで送る（訳文側は実物のまま）`,
		request.user.includes("__CODE_BLOCK_PLACEHOLDER_0__") && request.user.includes('"RATE_LIMIT_EXCEEDED"'),
		"",
	);
	add(`原文差分が user message に載っている`, request.user.includes("Source Text Changes:"), "");
	add(`前回訳文が user message に載っている`, request.user.includes("Previous Translation"), "");

	return checks;
}

/** 自己点検。落ちた件数を返す（0 なら全通し） */
export function selfTest() {
	say("========== ベンチ自身の点検（LLM は呼びません） ==========");
	const checks = selfTestChecks();
	let failed = 0;
	for (const check of checks) {
		if (check.ok) {
			say(`  OK   ${check.name}`);
		} else {
			failed += 1;
			say(`  NG   ${check.name}${check.detail ? `  — ${check.detail}` : ""}`);
		}
	}
	say("");
	say(
		failed === 0 ? `${checks.length} 件すべて通りました。` : `${checks.length} 件中 ${failed} 件が通りませんでした。`,
	);
	return failed;
}

/** まとめ役（lab.mjs の preset）から呼ぶ入口。終了コードを返す */
export function selfTestCommand() {
	return selfTest() > 0 ? 1 : 0;
}

// ===========================================================================

async function main() {
	const opts = parseArgs(process.argv.slice(2), { booleans: ["self-test", "dry", "help"] });
	if (opts.help) {
		say(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
		return 0;
	}
	if (opts["self-test"]) return selfTestCommand();
	const result = await run({
		cases: opts.cases,
		variants: opts.variants,
		repeat: opts.repeat,
		concurrency: opts.concurrency,
		timeout: opts.timeout,
		baseUrl: opts["base-url"],
		model: opts.model,
		apiKey: opts["api-key"],
		out: opts.out,
		dry: opts.dry,
	});
	return result.failed > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main()
		.then((code) => process.exit(code ?? 0))
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? String(error)}\n`);
			process.exit(1);
		});
}
