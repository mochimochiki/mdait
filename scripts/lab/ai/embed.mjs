/*
 * shim を「別プロセスを起こさずに」立てるための入口。
 *
 * shim.mjs はコマンド行から使う道具だが、中身（backend を組み立てて受付サーバーを立てる）は
 * そのまま関数として呼べる。lab の headless ホストは外にプロセスを増やしたくないので、
 * ここを import して同じプロセスの中に立てる。
 *
 *   import { startShim } from "../ai/embed.mjs";
 *   const ai = await startShim({ mode: "echo", delay: 300 });
 *   // ai.baseURL を mdait.json の ai.openai.baseURL に書く
 *   await ai.close();
 *
 * ポートは既定で 0（空きポートを自動で取る）。同じ機械で何本立てても衝突しない。
 */
import { createShimServer } from "./lib/server.mjs";
import { buildBackend, defaultOptions } from "./shim.mjs";

/**
 * shim を1つ立てて、繋ぎ先を返す。
 *
 * 受け取る名前はコマンド行のオプションと同じ（`--answer-timeout` は `answerTimeout`）。
 * 指定しなかったものは shim.mjs の既定に従う。
 *
 * @param {object} [options]
 * @param {"echo"|"live"|"script"|"replay"|"agent"} [options.mode] 誰が答えるか（既定: echo）
 * @param {number} [options.delay] echo が答えるまで黙っている時間（ミリ秒）
 * @param {number} [options.port] 待ち受けポート（既定: 0＝空きポートを自動で取る）
 * @param {string} [options.model] /v1/models で名乗る名前
 * @param {string} [options.record] やり取りの録音先ファイル
 * @param {string} [options.script] --mode script で読む台本
 * @param {string} [options.replay] --mode replay で読む録音
 * @param {string} [options.mailbox] --mode live の郵便受け
 * @param {(message: string) => void} [options.log] 進行の書き出し先（既定: 何もしない）
 * @returns {Promise<{baseURL: string, port: number, mode: string, server: object, backend: object,
 *                    stats: () => object, close: () => Promise<void>}>}
 */
export async function startShim(options = {}) {
	const settings = { ...defaultOptions(), mode: "echo", port: 0, ...options };
	const backend = buildBackend(settings);
	const log = settings.log ?? (() => {});

	const server = createShimServer({
		backend,
		model: settings.model,
		recordFile: settings.record,
		heartbeatSec: settings.heartbeat,
		log,
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(settings.port, "127.0.0.1", resolve);
	});

	const port = server.address().port;
	return {
		baseURL: `http://127.0.0.1:${port}/v1`,
		port,
		mode: settings.mode,
		server,
		backend,
		stats: () => server.stats(),
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				// 開いたままの接続に付き合って、いつまでも終わらないのを防ぐ
				server.closeAllConnections?.();
			}),
	};
}
