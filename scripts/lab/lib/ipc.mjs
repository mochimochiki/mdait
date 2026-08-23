/*
 * ホストへの命令はすべてファイル経由でやり取りする。
 *
 *   <ws>/.mdait/debug/command.json  … こちらが書く依頼
 *   <ws>/.mdait/debug/result.json   … 向こうが書く結果
 *
 * 3つのホスト（headless / code-server / desktop）で同じ経路を使う。形の正は
 * src/infra/debug/debug-command-handler.ts。
 */
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** やり取りに使うファイルの場所をまとめて返す */
export function ipcPaths(ws) {
	const dir = path.join(ws, ".mdait", "debug");
	return {
		dir,
		commandFile: path.join(dir, "command.json"),
		resultFile: path.join(dir, "result.json"),
		readyFile: path.join(dir, "ready"),
		// 同じ版の VS Code が既に走っているときは環境変数が届かないため、この空ファイルで IPC を有効にする
		enableFile: path.join(dir, ".ipc-enabled"),
	};
}

/** 受け入れ準備ができたことを示す `ready` ができるまで待つ */
export async function waitReady(ws, timeoutSec = 120) {
	const { readyFile } = ipcPaths(ws);
	const limit = Date.now() + timeoutSec * 1000;
	while (Date.now() < limit) {
		if (fs.existsSync(readyFile)) return true;
		await sleep(200);
	}
	throw new Error(`ホストが ${timeoutSec} 秒たっても受け入れ準備を終えませんでした（${readyFile} ができない）`);
}

/** 依頼につける番号。前の結果を読み違えないための目印 */
function newId() {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 途中まで書かれたファイルを掴むことがあるので、読めなければ黙って諦める */
function readJsonOrNull(file) {
	try {
		const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** 途中の状態を相手に見せないよう、別名で書いてから置き換える */
function writeJsonAtomic(file, value) {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	fs.renameSync(tmp, file);
}

/**
 * 依頼を1つ出して、その結果が返るまで待つ。
 *
 * 待つ相手は「同じ番号（id）で、かつ実行中（running）でない結果」に限る。
 * 前回の結果がそのまま残っていても取り違えない。
 *
 * @param {string} ws ワークスペース
 * @param {string} command `mdait.` で始まるコマンド名
 * @param {unknown[]} args 引数
 * @param {{timeoutSec?: number}} options 待つ上限（既定 600 秒）
 * @returns {Promise<object>} result.json の中身
 */
export async function sendCommand(ws, command, args = [], options = {}) {
	const timeoutSec = options.timeoutSec ?? 600;
	const { dir, commandFile, resultFile } = ipcPaths(ws);
	fs.mkdirSync(dir, { recursive: true });

	const id = newId();
	// 前回の結果は消しておく（取り違えの二重の防ぎ）
	try {
		fs.unlinkSync(resultFile);
	} catch {}
	writeJsonAtomic(commandFile, { id, command, args });

	const limit = Date.now() + timeoutSec * 1000;
	let sawRunning = false;
	while (Date.now() < limit) {
		const result = readJsonOrNull(resultFile);
		if (result && result.id === id) {
			if (result.status === "running") {
				sawRunning = true;
			} else {
				return result;
			}
		}
		await sleep(sawRunning ? 200 : 100);
	}
	throw new Error(`${command} の結果が ${timeoutSec} 秒たっても返りませんでした（${resultFile}）`);
}
