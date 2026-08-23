/*
 * 結果の要約づくり。
 *
 * result.json は数百行になる。画面に出すのは「何が起きたか」と「気になる行」だけにして、
 * 全文はディスクに残す。加えて、前の手順からワークスペースがどう動いたかを並べる。
 * どのファイルの need（翻訳待ち・見直し待ち）が増えたか減ったかが、いちばん効く手掛かりになる。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** マーカーの厳密な形。need はここの3つ目に入る */
const MARKER_STRICT = /<!-- mdait(?:\s+([a-zA-Z0-9]+))?(?:\s+from:([a-zA-Z0-9]+))?(?:\s+need:([\w@-]+))?\s*-->/;
const MARKER_LOOSE = /<!--\s*mdait\b[^>]*-->/g;

/**
 * コードブロックの行番号の集合を返す。
 * 本体（out/core/markdown/code-block-lines.js）があればそれを使う。まだ compile していない
 * ときのために、素朴な囲い（``` と ~~~）の追跡へ落ちる。
 */
function codeBlockLines(content) {
	try {
		const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
		const { getCodeBlockLineSet } = require(path.join(REPO, "out/core/markdown/code-block-lines.js"));
		return getCodeBlockLineSet(content);
	} catch {
		const set = new Set();
		let fence = null;
		content.split("\n").forEach((line, i) => {
			const m = line.match(/^\s*(```+|~~~+)/);
			if (m) {
				if (fence === null) {
					fence = m[1][0];
					set.add(i);
					return;
				}
				if (m[1][0] === fence) {
					fence = null;
					set.add(i);
					return;
				}
			}
			if (fence !== null) set.add(i);
		});
		return set;
	}
}

/** 本文にあるマーカーを並べる。コードブロックの中の見本は本文なので数えない */
function markersIn(content) {
	const skip = codeBlockLines(content);
	const out = [];
	content.split("\n").forEach((line, i) => {
		if (skip.has(i)) return;
		const found = line.match(MARKER_LOOSE);
		if (found) out.push(...found);
	});
	return out;
}

/** マーカー1つから need の種類を取り出す。付いていなければ "(なし)" */
function needOf(marker) {
	const m = MARKER_STRICT.exec(marker);
	const need = m?.[3];
	if (!need) return "(なし)";
	// need:revise@1a2b3c4d のような形は種類だけにまとめる
	return need.split("@")[0];
}

function walk(dir, out = []) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name === ".git" || e.name === "node_modules" || e.name === ".mdait") continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) walk(full, out);
		else if (e.isFile()) out.push(full);
	}
	return out;
}

/** unit-state（外部マーカーの置き場）の need を数える。7列のうち最後が need */
function countUnitState(ws) {
	const file = path.join(ws, ".mdait", "unit-state");
	const result = { lines: 0, need: {} };
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return result;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		const columns = line.split("\t");
		if (columns.length !== 7) continue;
		result.lines += 1;
		const need = columns[6] ? columns[6].split("@")[0] : "(なし)";
		result.need[need] = (result.need[need] ?? 0) + 1;
	}
	return result;
}

/**
 * ワークスペースの今の姿を数える。
 * @returns {{files: number, mdFiles: number, markers: number, need: Record<string, number>, unitState: object}}
 */
export function census(ws) {
	const files = walk(ws);
	const need = {};
	let markers = 0;
	let mdFiles = 0;
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		mdFiles += 1;
		let content;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const marker of markersIn(content)) {
			markers += 1;
			const key = needOf(marker);
			need[key] = (need[key] ?? 0) + 1;
		}
	}
	return { files: files.length, mdFiles, markers, need, unitState: countUnitState(ws) };
}

/** 増減を `+3` `-1` の形にする */
function sign(n) {
	return n > 0 ? `+${n}` : String(n);
}

function diffNeedMap(before, after) {
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	const rows = [];
	for (const key of [...keys].sort()) {
		const b = before?.[key] ?? 0;
		const a = after?.[key] ?? 0;
		if (b !== a) rows.push(`${key}: ${b} → ${a} (${sign(a - b)})`);
	}
	return rows;
}

/**
 * 前の手順からの差を文にする。変わっていなければ「変化なし」の1行。
 * @returns {string[]}
 */
export function diffCensus(before, after) {
	if (!before) return ["（比べる相手がないので差は出せません）"];
	const lines = [];
	if (before.files !== after.files) lines.push(`ファイル数: ${before.files} → ${after.files} (${sign(after.files - before.files)})`);
	if (before.markers !== after.markers)
		lines.push(`本文のマーカー: ${before.markers} → ${after.markers} (${sign(after.markers - before.markers)})`);
	lines.push(...diffNeedMap(before.need, after.need).map((r) => `本文の need ${r}`));
	if (before.unitState.lines !== after.unitState.lines)
		lines.push(
			`unit-state の行: ${before.unitState.lines} → ${after.unitState.lines} (${sign(after.unitState.lines - before.unitState.lines)})`,
		);
	lines.push(...diffNeedMap(before.unitState.need, after.unitState.need).map((r) => `unit-state の need ${r}`));
	return lines.length > 0 ? lines : ["変化なし"];
}

/** 長い文字列を切る */
function clip(text, limit) {
	const s = typeof text === "string" ? text : JSON.stringify(text);
	if (s === undefined) return "";
	return s.length > limit ? `${s.slice(0, limit)}…（以下省略）` : s;
}

/** 所要時間を秒で */
function durationSec(result) {
	if (!result?.startedAt || !result?.completedAt) return null;
	const ms = Date.parse(result.completedAt) - Date.parse(result.startedAt);
	return Number.isFinite(ms) ? (ms / 1000).toFixed(1) : null;
}

/**
 * result.json から画面に出す分だけ抜く。
 * @returns {{status: string, durationSec: string|null, resultLine: string, notable: string[], logCount: number}}
 */
export function summarizeResult(result) {
	const notable = [];
	const structured = Array.isArray(result?.structuredLogs) ? result.structuredLogs : [];
	for (const entry of structured) {
		const level = String(entry?.level ?? "").toUpperCase();
		if (level !== "WARN" && level !== "ERROR") continue;
		const context = entry.context ? ` | ${clip(entry.context, 200)}` : "";
		notable.push(`[${level}][${entry.scope}] ${entry.message}${context}`);
	}
	// 構造化ログが無いホストのために、素のログ行からも拾う
	if (structured.length === 0 && Array.isArray(result?.logs)) {
		for (const line of result.logs) {
			if (/\[(WARN|ERROR)\]/.test(line)) notable.push(line);
		}
	}
	const logCount = structured.length || (Array.isArray(result?.logs) ? result.logs.length : 0);
	return {
		status: result?.status ?? "(不明)",
		durationSec: durationSec(result),
		resultLine: result?.result == null ? "(返り値なし)" : clip(result.result, 600),
		error: result?.error ?? null,
		notable,
		logCount,
	};
}

/**
 * 1手順ぶんの要約を組み立てる（画面にもファイルにも同じものを出す）。
 * @returns {string}
 */
export function renderDigest({ seq, command, args, result, diff, jsonPath }) {
	const s = summarizeResult(result);
	const lines = [];
	const label = String(seq).padStart(3, "0");
	lines.push(`## ${label} ${command}${args?.length ? ` ${args.join(" ")}` : ""}`);
	lines.push("");
	lines.push(`- 結果: **${s.status}**${s.durationSec ? `（${s.durationSec} 秒）` : ""}`);
	if (s.error) lines.push(`- エラー: ${s.error}`);
	lines.push(`- 返り値: ${s.resultLine}`);
	lines.push(`- ログ: ${s.logCount} 行（うち気になるもの ${s.notable.length} 行）`);
	if (jsonPath) lines.push(`- 全文: ${jsonPath}`);
	lines.push("");
	lines.push("### ワークスペースの変化（前の手順から）");
	for (const row of diff ?? []) lines.push(`- ${row}`);
	const dialogs = Array.isArray(result?.dialogs) ? result.dialogs : [];
	if (dialogs.length > 0) {
		lines.push("");
		lines.push("### 出た確認ダイアログ（画面が無いので lab が代わりに答えた）");
		for (const dialog of dialogs.slice(0, 20)) {
			const answer = dialog.answered ? `「${dialog.answered}」と答えた` : "答えなかった";
			const choices = dialog.buttons?.length ? `［${dialog.buttons.join(" / ")}］` : "";
			lines.push(`- ${answer}${choices}: ${dialog.message.replace(/\s+/g, " ").slice(0, 120)}`);
		}
		if (dialogs.length > 20) lines.push(`- …ほか ${dialogs.length - 20} 件`);
	}
	if (s.notable.length > 0) {
		lines.push("");
		lines.push("### 気になるログ（警告・エラーのみ）");
		for (const row of s.notable.slice(0, 40)) lines.push(`- ${row}`);
		if (s.notable.length > 40) lines.push(`- …ほか ${s.notable.length - 40} 行（全文を見てください）`);
	}
	lines.push("");
	return lines.join("\n");
}
