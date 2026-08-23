/*
 * 実験に使うワークスペース（原稿と .mdait/mdait.json の置き場）の用意。
 *
 * 既定は使い捨ての /tmp 側（<LAB_DIR>/ws）。リポジトリの中を既定にはしない。
 * リポジトリ内（src/test/unit/workspace）を使いたいときだけ `--ws repo` を選ぶ。
 * その場合は設定ファイルを必ず退避し、`restoreConfig` で元へ戻す。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_DIR, ensureLabDir } from "./session.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** リポジトリのルート */
export const REPO = path.resolve(HERE, "..", "..", "..");
/** 原稿の見本の置き場 */
const SAMPLE_CONTENT = path.join(REPO, "src", "test", "unit", "sample-content");
/** 設定の雛形 */
const TEMPLATE_CONFIG = path.join(REPO, "src", "test", "unit", "workspace", ".mdait", "mdait.json");
/** リポジトリ内のワークスペース */
const REPO_WS = path.join(REPO, "src", "test", "unit", "workspace");
/** 使い捨てのワークスペース */
export const TMP_WS = path.join(LAB_DIR, "ws");

/**
 * 前回の実行が残す、持ち越すと結果が変わるもの。
 * `.mdait/debug` は消さない（ホストを落とさずに作り直せるようにするため。中の依頼・結果だけ捨てる）。
 */
const RESIDUE = [
	"unit-state",
	"unit-registry",
	"index.json",
	"logs",
	"reports",
	"ai-stats.log",
	"translations.tmx",
	"terms.csv",
];

/** ワークスペースの置き場を決める */
function resolveWs(mode) {
	if (!mode || mode === "tmp") return TMP_WS;
	if (mode === "repo") return REPO_WS;
	return path.resolve(mode);
}

/** 残骸を消す。消せなくても止まらない */
function clearResidue(ws) {
	for (const name of RESIDUE) {
		try {
			fs.rmSync(path.join(ws, ".mdait", name), { recursive: true, force: true });
		} catch {}
	}
	// やり取りの途中の紙だけ捨てる（ready と .ipc-enabled は残す）
	for (const name of ["command.json", "result.json", "command.json.tmp"]) {
		try {
			fs.rmSync(path.join(ws, ".mdait", "debug", name), { force: true });
		} catch {}
	}
}

/** 退避した設定の置き場（ワークスペースの外に置く。リポジトリを汚さないため） */
function backupPath(ws) {
	const key = ws.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return path.join(LAB_DIR, "config-backup", `${key}.json`);
}

/**
 * ワークスペースを用意して、その絶対パスを返す。
 *
 * @param {{mode?: string, reset?: boolean}} options
 *   mode: "tmp"（既定）| "repo" | 絶対パス、reset: 原稿を見本から作り直すか
 * @returns {Promise<string>} ワークスペースの絶対パス
 */
export async function prepareWorkspace(options = {}) {
	const mode = options.mode ?? "tmp";
	const reset = options.reset ?? false;
	const ws = resolveWs(mode);
	ensureLabDir();

	if (ws === REPO_WS) {
		// リポジトリ内。原稿の作り直しは npm run copy-test-files に任せ、設定は必ず退避する
		fs.mkdirSync(path.join(ws, ".mdait"), { recursive: true });
		backupConfig(ws);
		if (reset) {
			const { execFileSync } = await import("node:child_process");
			execFileSync("npm", ["run", "copy-test-files"], { cwd: REPO, stdio: "ignore" });
			clearResidue(ws);
		}
		return ws;
	}

	const isDisposable = ws === TMP_WS || ws.startsWith(`${LAB_DIR}${path.sep}`);
	const content = path.join(ws, "content");
	if (isDisposable) {
		// 使い捨て。無ければ作り、reset なら丸ごと入れ替える
		if (reset || !fs.existsSync(content)) {
			fs.rmSync(content, { recursive: true, force: true });
			fs.mkdirSync(ws, { recursive: true });
			fs.cpSync(SAMPLE_CONTENT, content, { recursive: true, force: true });
		}
		fs.mkdirSync(path.join(ws, ".mdait"), { recursive: true });
		const configFile = path.join(ws, ".mdait", "mdait.json");
		if (reset || !fs.existsSync(configFile)) {
			fs.copyFileSync(TEMPLATE_CONFIG, configFile);
		}
		if (reset) clearResidue(ws);
		return ws;
	}

	// 自分で場所を指定した場合。原稿には触らない（消してしまうと取り返しがつかない）
	const configFile = path.join(ws, ".mdait", "mdait.json");
	if (!fs.existsSync(configFile)) {
		throw new Error(`${configFile} がありません。mdait の設定がある場所を指してください`);
	}
	backupConfig(ws);
	if (reset) clearResidue(ws);
	return ws;
}

/** 設定を退避する（既に退避済みなら上書きしない。二重に走っても元が失われないように） */
function backupConfig(ws) {
	const configFile = path.join(ws, ".mdait", "mdait.json");
	if (!fs.existsSync(configFile)) return;
	const backup = backupPath(ws);
	if (fs.existsSync(backup)) return;
	fs.mkdirSync(path.dirname(backup), { recursive: true });
	fs.copyFileSync(configFile, backup);
}

/**
 * mdait.json の AI 設定を shim（手元の受け皿）へ向ける。
 *
 * @param {string} ws ワークスペース
 * @param {{mode?: string, baseURL?: string, model?: string, timeoutSec?: number}} ai
 *   mode が "none" のときは何もしない（実物のプロバイダをそのまま使う）
 */
export function configureAi(ws, ai = {}) {
	if (!ai.mode || ai.mode === "none") return;
	if (!ai.baseURL) throw new Error("configureAi には baseURL が要ります");
	const configFile = path.join(ws, ".mdait", "mdait.json");
	const json = JSON.parse(fs.readFileSync(configFile, "utf8"));
	json.ai = {
		...(json.ai ?? {}),
		provider: "openai",
		model: ai.model ?? "byok-shim",
		openai: {
			...(json.ai?.openai ?? {}),
			// shim は中身を見ないが、空だと mdait 側が落ちるので何か入れておく
			apiKey: "lab-dummy-key",
			baseURL: ai.baseURL,
			timeoutSec: ai.timeoutSec ?? 600,
		},
		debug: {
			enableStatsLogging: true,
			logPromptAndResponse: true,
		},
	};
	fs.writeFileSync(configFile, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

/** 退避しておいた設定を戻す。退避が無ければ何もしない */
export function restoreConfig(ws) {
	const backup = backupPath(ws);
	if (!fs.existsSync(backup)) return false;
	const configFile = path.join(ws, ".mdait", "mdait.json");
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.copyFileSync(backup, configFile);
	fs.rmSync(backup, { force: true });
	return true;
}
