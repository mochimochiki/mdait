#!/usr/bin/env node
/*
 * 実 UI でしか見えないものを撮って、文字にして残す。
 *
 * headless ホストは commands 層を直に叩くので、**画面を持たない**。
 * ツリーのアイコン・CodeLens・確認ダイアログは、実 Extension Host（code-server）でしか
 * 存在しない。ここはその穴を埋めるための段取りで、見るのは次の5つ。
 *
 *   U1-tree      同期のあと、ツリーに何がどんなアイコンで並ぶか／行アクションは何か
 *   U2-dialog    AI を使う前に立ちはだかる確認（初回利用の説明・フォルダ翻訳の確認）
 *   U3-progress  翻訳中にツリーがどう変わるか（回転アイコンが出て、終わると状態のアイコンへ戻る）
 *   U4-codelens  マーカーの上に出るボタン（訳文側と原文側で品揃えが違う）
 *   U5-notify    終わったときに何と言うか（通知の文言とボタン）
 *
 * 判定は sweep と同じ2段。**この分け方は勝手に変えない。**
 *   FAIL … 製品の側の不具合。1件でもあれば終了コード 1
 *   INFO … 確かめる道具の側の限界（見本が足りない、偽の AI では起こせない、など）
 *
 * 見えているものは全部 `ux.json` に文字で落とす。**画像だけ残しても差分が取れない**ので、
 * ツリーの行・CodeLens のボタン・ダイアログの文言は必ず機械可読で控える。
 *
 * 動かし方
 *   node scripts/lab/lab.mjs ux             （まとめ役が配線する呼び方）
 *   node scripts/lab/scenarios/ux.mjs       （単独。実験場が無ければ自分で起こす）
 *     --verbose   通った判定（OK）も1件ずつ出す
 *     --only U1,U4   見たい分だけ（U2〜U3 はひと続きなので、片方だけ選ぶと前提が揃わない）
 *     --keep      単独で動かしたとき、終わっても実験場を止めない
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "../lib/args.mjs";
import { awaitCommand, sendCommand, startCommand } from "../lib/ipc.mjs";
import { saveStep } from "../lib/runs.mjs";
import { LAB_DIR, readSession } from "../lib/session.mjs";
import { ask } from "../ui/driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const LAB = path.join(REPO, "scripts", "lab", "lab.mjs");

/** 翻訳中の画面を撮るために、echo にこれだけ待たせる（速すぎると回転を1枚も捉えられない） */
const ECHO_DELAY_MS = 4000;
/** フォルダ翻訳の対象。小さく保つ — 1ユニットごとに ECHO_DELAY_MS だけ待つため */
const TRANS_DIR = "content/en/child/child2";
/** CodeLens を見る訳文と原文。上のフォルダの外にあるものを選ぶ（翻訳されずに need が残る） */
const LENS_TARGET = "content/en/child/child_ja_new.md";
const LENS_SOURCE = "content/ja/child/child_ja_new.md";

// ===========================================================================
// 判定と観察の記録
// ===========================================================================

/** 判定（FAIL / INFO / OK） */
let findings = [];
/** 観察したもの。画像に写っているものを文字で残す控え */
let observed = {};
let verbose = false;

function say(text = "") {
	process.stdout.write(`${text}\n`);
}

function fail(phase, where, summary, detail) {
	findings.push({ sev: "FAIL", phase, file: where, summary, detail: detail ?? "" });
	say(`  [FAIL] (${phase}) ${where}: ${summary}`);
}

function info(phase, where, summary) {
	findings.push({ sev: "INFO", phase, file: where, summary, detail: "" });
	say(`  [INFO] (${phase}) ${where}: ${summary}`);
}

function ok(phase, summary) {
	findings.push({ sev: "OK", phase, file: "-", summary, detail: "" });
	if (verbose) say(`  [OK]   (${phase}) ${summary}`);
}

function tallyOf(phase, from) {
	const mine = findings.slice(from).filter((f) => f.phase === phase);
	return {
		ok: mine.filter((f) => f.sev === "OK").length,
		info: mine.filter((f) => f.sev === "INFO").length,
		fail: mine.filter((f) => f.sev === "FAIL").length,
	};
}

// ===========================================================================
// 実験場との行き来
// ===========================================================================

let ws = "";
let runDir = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** コマンドを1つ叩いて、全文を run ディレクトリへ残す */
async function step(command, args = [], options = {}) {
	const result = await sendCommand(ws, command, args, options);
	if (runDir) saveStep(runDir, command, result, { args, ws });
	return result;
}

/** 画面を撮る。撮れなくても段取りは止めない（撮れなかったことは控える） */
async function shoot(name) {
	try {
		const file = await ask("shot", { name, dir: runDir ? path.join(runDir, "shots") : undefined });
		(observed.shots ??= []).push(file);
		return file;
	} catch (error) {
		info("U0", "shot", `画面を撮れませんでした（${name}）: ${String(error?.message ?? error)}`);
		return null;
	}
}

/** ツリーの行を読む。ラベル・アイコン・回転しているかを文字で返す */
async function readTree() {
	return await ask("tree-items", {}, { timeoutSec: 30 });
}

/** ツリーの行を「ラベル → アイコン」の1行で書く（差分を目で追うため） */
function renderTree(rows) {
	return rows.map(
		(r) => `${"  ".repeat(Math.max(0, r.depth - 1))}${r.label}${r.description ? ` ${r.description}` : ""} [${r.icon}]`,
	);
}

// ===========================================================================
// U1: 同期のあとのツリー
// ===========================================================================

async function phaseTree() {
	// 前の実験で開いたままのエディタが写り込まないように、まず片付ける
	await ask("close-editors", {}, { timeoutSec: 30 }).catch(() => {});
	await step("mdait.sync");
	// ツリーは同期の結果を受けて描き直される。描き終わるのを少し待つ
	await sleep(2000);
	// 開かないと根の2行（原文の言語・訳文の言語）しか見えない
	const opened = await ask("expand-tree", { rounds: 6 }, { timeoutSec: 120 });
	say(`  折り畳みを ${opened} 箇所ひらいた`);
	const rows = await readTree();
	observed.tree = { afterSync: rows };
	say(`  ツリーの行: ${rows.length}`);
	for (const line of renderTree(rows).slice(0, 12)) say(`    ${line}`);
	if (rows.length > 12) say(`    …ほか ${rows.length - 12} 行`);
	await shoot("U1-ツリーの初期状態");

	if (rows.length === 0) {
		fail("U1", "tree", "同期のあともツリーが空。実 UI で状態が何も見えない");
		return;
	}
	ok("U1", `ツリーに ${rows.length} 行が並んだ`);

	// アイコンが1つも付かないなら、状態は色でも形でも伝わっていない
	const withIcon = rows.filter((r) => r.icon);
	if (withIcon.length === 0) {
		fail("U1", "tree", "どの行にもアイコンが無い（状態が見た目に出ていない）");
	} else {
		ok("U1", `${withIcon.length} 行にアイコンが付いた`);
	}

	// 読み上げラベル（aria-label）。ADR で「名前 — 状態」の形にすると決めてある
	const missingAria = rows.filter((r) => !r.aria);
	if (missingAria.length > 0) {
		fail(
			"U1",
			"tree",
			`読み上げラベルの無い行が ${missingAria.length} 件（スクリーンリーダーに状態が伝わらない）`,
			missingAria
				.slice(0, 5)
				.map((r) => r.label)
				.join(" / "),
		);
	} else {
		ok("U1", "すべての行に読み上げラベルが付いている");
	}
}

// ===========================================================================
// U2・U3: 確認ダイアログと、翻訳中のツリー
//
// ひと続きにする。フォルダ翻訳は「確認 → AI 初回利用の説明 → 実行」と進むので、
// 同じ1回の実行から、立ちはだかるものと走っている最中の見え方の両方が撮れる。
// ===========================================================================

async function phaseDialogAndProgress() {
	// 見張りに「答えるな」と言っておく。答えられてしまうと撮る前に消える。
	// この段の間は**自分で答える**。**必ず元へ戻すこと**（戻さないと以後のコマンドが
	// 誰にも答えてもらえず返らない）
	await ask("dialog-policy", { policy: "decline" });
	// 訳文側の枝だけを開き、原文側は畳む。開きすぎると行が画面からはみ出し、
	// はみ出した行は DOM に無いので**回転していても読めない**。
	// 開け閉てが空振りしたら黙って進まない — 枝が畳まれたままだと、回転を1つも捉えられずに
	// 「回転しなかった」という誤った判定になる
	const missed = [];
	for (const [label, expanded] of [
		["ja", false],
		["en", true],
		["child", true],
		["child2", true],
	]) {
		const found = await ask("set-row-expanded", { label, expanded }, { timeoutSec: 60 }).catch(() => false);
		if (!found) missed.push(label);
	}
	if (missed.length > 0) {
		info("U3", "tree", `ツリーに見つからず開け閉てできなかった行: ${missed.join(" / ")}`);
	}
	const dialogs = [];
	const frames = [];
	let result = null;
	try {
		const id = startCommand(ws, "mdait.translate.directory", [TRANS_DIR]);

		// ダイアログ待ちとツリー観察を**1つの輪**にする。
		// 別々にすると、ダイアログを待っている20秒のあいだに翻訳が終わってしまい、
		// 走っている最中のツリーを1枚も撮れない（実測: 2枚しか撮れず、しかも終わりぎわだった）。
		await watchWhileRunning(id, dialogs, frames);

		result = await awaitCommand(ws, id, { timeoutSec: 600, label: "mdait.translate.directory" });
		if (runDir) saveStep(runDir, "mdait.translate.directory", result, { args: [TRANS_DIR], ws });
		// 通知は放っておくと自然に消えるので、**返ってきたその場で**拾う（U5 で判定する）
		observed.notifications = await ask("notifications", {}, { timeoutSec: 30 }).catch(() => []);
		if (observed.notifications.length > 0) await shoot("U5-終わったときの通知");
	} finally {
		// 途中で転んでも見張りは必ず戻す
		await ask("dialog-policy", { policy: "answer" }).catch(() => {});
	}

	observed.dialogs = dialogs;
	observed.progress = {
		frames: frames.map((f) => ({ at: f.at, rows: f.rows.length, spinning: f.spinning })),
	};
	observed.tree = { ...(observed.tree ?? {}), afterTrans: await readTree() };

	// --- U2 の判定 ---
	if (dialogs.length === 0) {
		fail("U2", "dialog", "AI を使うフォルダ翻訳が、確認を1つも出さずに走った（ADR-260705-01 に反する）");
	} else {
		ok("U2", `確認が ${dialogs.length} 件立ちはだかった`);
		// 文言は message と detail のどちらに入ることもある（実測: フォルダ翻訳の確認は
		// message が空で detail だけに入る）。どちらも空なら、人は何を承諾するのか分からない
		const wordless = dialogs.filter((d) => !d.message && !d.detail);
		if (wordless.length > 0) {
			fail("U2", "dialog", `文言の無い確認が ${wordless.length} 件（何に答えるのか分からない）`);
		} else {
			ok("U2", "どの確認にも文言がある");
		}
	}

	// --- U3 の判定 ---
	const spun = frames.filter((f) => f.spinning.length > 0);
	say(`  翻訳中に読んだツリー: ${frames.length} 回 / 回転していた回: ${spun.length}`);
	if (frames.length === 0) {
		info("U3", "tree", "翻訳が速すぎて途中のツリーを1回も読めなかった（--delay を増やす）");
	} else if (spun.length === 0) {
		fail(
			"U3",
			"tree",
			"翻訳中にツリーが1度も回転アイコンを出さなかった（進行中だと見て分からない）",
			`読んだ回数 ${frames.length}・delay ${ECHO_DELAY_MS}ms`,
		);
	} else {
		ok("U3", `翻訳中に ${spun.length} 回、回転アイコンの出たツリーを捉えた`);
		const labels = [...new Set(spun.flatMap((f) => f.spinning))];
		observed.progress.spinningLabels = labels;
		say(`  回転した行: ${labels.join(" / ")}`);
		// ファイルの行まで回るか、まとめの行（言語やフォルダ）だけかを控える。
		// まとめの行しか回らないなら「どのファイルを訳しているか」は画面から分からない
		const fileLevel = labels.filter((l) => /\.[A-Za-z0-9]+$/.test(l));
		observed.progress.spinningFiles = fileLevel;
		if (fileLevel.length === 0) {
			info("U3", "tree", "回転したのはまとめの行だけで、ファイルの行は回らなかった");
		} else {
			ok("U3", `ファイルの行まで回転した（${fileLevel.join(" / ")}）`);
		}
	}

	// 終わったあとも回り続けていないか（ADR-260803-01 の「下ろし忘れ」）
	const after = observed.tree.afterTrans.filter((r) => r.spinning);
	if (after.length > 0) {
		fail(
			"U3",
			"tree",
			`翻訳が終わってもまだ回転している行が ${after.length} 件ある`,
			after.map((r) => r.label).join(" / "),
		);
	} else {
		ok("U3", "翻訳が終わると回転が止まっている");
	}

	await shoot("U3-翻訳のあとのツリー");
	observed.transResult = result?.result ?? null;
	return result;
}

/**
 * 命令が終わるまで、ダイアログとツリーを交互に見る。
 *
 * 立ちはだかるものは**その場で撮ってから自分で押す**（見張りには「答えるな」と言ってある）。
 * 押さないと先へ進まないので、待つのと観るのを別々の輪にしてはいけない。
 *
 * @param {string} id 出した依頼の番号
 * @param {Array} dialogs 見つけたダイアログの控え（この配列に足す）
 * @param {Array} frames 読んだツリーの控え（この配列に足す）
 */
async function watchWhileRunning(id, dialogs, frames) {
	const resultFile = path.join(ws, ".mdait", "debug", "result.json");
	const started = Date.now();
	let shotTaken = false;
	let sawRunning = false;
	while (Date.now() - started < 300000) {
		let status = null;
		try {
			const current = JSON.parse(fs.readFileSync(resultFile, "utf8"));
			if (current.id === id) status = current.status;
		} catch {
			// 書きかけは掴めない。次の周回で見直す
		}
		if (status === "running") sawRunning = true;
		if (status && status !== "running") break;

		const box = await ask("dialog", {}, { timeoutSec: 30 }).catch(() => null);
		if (box?.buttons?.length) {
			dialogs.push(box);
			const text = [box.message, box.detail].filter(Boolean).join(" / ");
			say(`  ダイアログ${dialogs.length}: ${text.split("\n")[0].slice(0, 60)} [${box.buttons.join(" / ")}]`);
			await shoot(`U2-ダイアログ${dialogs.length}`);
			if (!box.primary) {
				fail("U2", "dialog", "ボタンの無いダイアログが出た（人が先へ進めない）", text);
				break;
			}
			await ask("click-dialog", { text: box.primary });
			await sleep(800);
			continue;
		}

		// ダイアログが出ていない間だけツリーを読む（撮るのは回転を捉えた最初の1回）
		if (sawRunning) {
			const rows = await readTree().catch(() => []);
			const spinning = rows.filter((r) => r.spinning).map((r) => r.label);
			frames.push({ at: Date.now() - started, rows, spinning });
			if (spinning.length > 0 && !shotTaken) {
				shotTaken = true;
				await shoot("U3-翻訳中のツリー");
			}
		}
		await sleep(300);
	}
}

// ===========================================================================
// U4: CodeLens
// ===========================================================================

async function phaseCodeLens() {
	const seen = {};
	for (const [role, rel] of [
		["target", LENS_TARGET],
		["source", LENS_SOURCE],
	]) {
		if (!fs.existsSync(path.join(ws, rel))) {
			info("U4", rel, "見本が無いので見送る");
			continue;
		}
		await ask("open-file", { path: rel }, { timeoutSec: 60 });
		const lenses = await ask("codelens", {}, { timeoutSec: 30 });
		seen[role] = { file: rel, lenses };
		const buttons = [...new Set(lenses.flatMap((l) => l.buttons))];
		say(`  ${rel}: CodeLens ${lenses.length} 行 / ボタン ${buttons.join(" / ") || "（無し）"}`);
		await shoot(`U4-CodeLens-${role}`);

		if (lenses.length === 0) {
			fail("U4", rel, "マーカーがあるのに CodeLens が1つも出ない");
			continue;
		}
		ok("U4", `${rel} に CodeLens が ${lenses.length} 行出た`);

		// 訳文側は訳文側の、原文側は原文側のボタンが出ているか
		// （出るボタンの一覧は src/ui/codelens/codelens-provider.ts が正）
		const wanted = role === "target" ? "Source" : "Target";
		if (!buttons.some((b) => b.includes(wanted))) {
			fail("U4", rel, `${role} 側なのに「${wanted}」へ飛ぶボタンが無い`, buttons.join(" / "));
		} else {
			ok("U4", `${rel} に「${wanted}」ボタンがある`);
		}
	}
	observed.codeLens = seen;
	await ask("close-editors", {}, { timeoutSec: 30 }).catch(() => {});
}

// ===========================================================================
// U5: 通知
// ===========================================================================

async function phaseNotify() {
	// 通知は数十秒で自然に消えるので、**U2 で命令が返ったその場**で拾ってある。
	// ここは拾えたものを判定するだけ（U5 だけを単独で選ぶと材料が無い）。
	const toasts = observed.notifications;
	if (!toasts) {
		info("U5", "notification", "U2 を通っていないので通知の材料が無い（U5 だけを選ぶと拾えない）");
		return;
	}
	say(`  終わったときに出ていた通知: ${toasts.length}`);
	for (const toast of toasts) {
		say(
			`    [${toast.level}] ${toast.text.split("\n")[0].slice(0, 70)}${toast.buttons.length ? ` [${toast.buttons.join(" / ")}]` : ""}`,
		);
	}
	if (toasts.length === 0) {
		fail("U5", "notification", "翻訳が終わっても通知が1つも出ない（終わったことが画面から分からない）");
		return;
	}
	ok("U5", `${toasts.length} 件の通知を文言ごと拾えた`);
	// 失敗が無かったのに赤い通知が出ていたら、報告と実態が食い違っている
	const failedCount = observed.transResult?.failed ?? 0;
	const errors = toasts.filter((t) => t.level === "error");
	if (failedCount === 0 && errors.length > 0) {
		fail(
			"U5",
			"notification",
			"1件も失敗していないのにエラーの通知が出ている",
			errors.map((t) => t.text.split("\n")[0]).join(" / "),
		);
	} else {
		ok("U5", "通知の重さが結果と食い違っていない");
	}
	await ask("dismiss-notifications", {}, { timeoutSec: 30 }).catch(() => {});
}

// ===========================================================================
// まとめ役
// ===========================================================================

const PHASES = [
	["U1", phaseTree],
	["U2", phaseDialogAndProgress],
	["U4", phaseCodeLens],
	["U5", phaseNotify],
];
/** U2 と U3 はひと続きの1回の実行から採るので、段としては U2 に相乗りしている */
const PHASE_ALIAS = { U3: "U2" };

export async function run({ session, verbose: v = false, only } = {}) {
	findings = [];
	observed = {};
	verbose = v;
	const current = session ?? readSession();
	ws = current?.ws;
	runDir = current?.runDir ?? null;
	if (!ws) throw new Error("実験場が立っていません（lab up --host code-server を先に実行）");
	if (current?.host !== "code-server") {
		throw new Error(
			`この段取りは実 UI がある code-server ホストでしか意味がありません（いまのホスト: ${current?.host}）`,
		);
	}

	const wanted = only
		? new Set(
				String(only)
					.split(",")
					.map((s) => s.trim().toUpperCase())
					.map((s) => PHASE_ALIAS[s] ?? s),
			)
		: null;

	for (const [name, phase] of PHASES) {
		if (wanted && !wanted.has(name)) continue;
		const from = findings.length;
		say("");
		say(`===== ${name} =====`);
		try {
			await phase();
		} catch (error) {
			fail(name, "-", "段の途中で止まった", String(error?.stack ?? error));
		}
		const tally = tallyOf(name, from);
		say(`${name}: OK ${tally.ok} / INFO ${tally.info} / FAIL ${tally.fail}`);
	}

	if (runDir) {
		fs.writeFileSync(path.join(runDir, "ux.json"), `${JSON.stringify({ findings, observed }, null, 2)}\n`, "utf8");
	}

	const failed = findings.filter((f) => f.sev === "FAIL");
	const infos = findings.filter((f) => f.sev === "INFO");
	say("");
	say("========== まとめ ==========");
	say(`FAIL=${failed.length} INFO=${infos.length} OK=${findings.filter((f) => f.sev === "OK").length}`);
	for (const finding of infos) say(`  INFO (${finding.phase}) ${finding.file}: ${finding.summary}`);
	for (const finding of failed) {
		say(`  FAIL (${finding.phase}) ${finding.file}: ${finding.summary}`);
		if (finding.detail) say(`         ${String(finding.detail).split("\n").join("\n         ")}`);
	}
	if (runDir) {
		say(`観察したもの（文字）: ${runDir}/ux.json`);
		say(`画面の写し: ${runDir}/shots`);
	}
	return { findings, observed, failed: failed.length };
}

// ===========================================================================
// 単独で動かすとき
// ===========================================================================

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function runLab(argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [LAB, ...argv], {
			stdio: "inherit",
			env: { ...process.env, MDAIT_LAB_DIR: LAB_DIR },
		});
		child.on("exit", (code) =>
			code === 0 || code === null
				? resolve(0)
				: reject(new Error(`lab ${argv[0]} が失敗しました（終了コード ${code}）`)),
		);
	});
}

/** この段取りが要る立ち上げ方（実 UI ＋ 遅い echo） */
export const UP_ARGS = [
	"up",
	"--host",
	"code-server",
	"--ai",
	"echo",
	"--delay",
	String(ECHO_DELAY_MS),
	"--ws",
	"tmp",
	"--reset",
	"--name",
	"ux",
];

async function main() {
	const opts = parseArgs(process.argv.slice(2), { booleans: ["verbose", "keep", "help"] });
	if (opts.help) {
		say("使い方: node scripts/lab/scenarios/ux.mjs [--verbose] [--only U1,U4] [--keep]");
		return 0;
	}
	let session = readSession();
	let startedHere = false;
	if (!session?.hostPid || !alive(session.hostPid) || session.host !== "code-server") {
		say("実 UI のホストが立っていないので、code-server を起こします（初回は設営に数分かかります）。");
		await runLab(UP_ARGS);
		session = readSession();
		startedHere = true;
	}
	const { failed } = await run({ session, verbose: Boolean(opts.verbose), only: opts.only });
	if (startedHere && !opts.keep) await runLab(["down"]);
	return failed > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exit(1);
		});
}
