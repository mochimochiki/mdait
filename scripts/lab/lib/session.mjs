/*
 * 走っているホスト・AI 役・作業場の記録。
 *
 * `lab up` がここへ書き、以後の動詞（run / shot / status / down …）はここを読む。
 * 置き場は既定で /tmp/mdait-lab。環境変数 MDAIT_LAB_DIR で変えられる。
 */
import fs from "node:fs";
import path from "node:path";

/** lab の作業用ディレクトリ（run の記録・使い捨てワークスペース・セッション情報の置き場） */
export const LAB_DIR = path.resolve(process.env.MDAIT_LAB_DIR || "/tmp/mdait-lab");

/** セッション情報のファイル */
export const SESSION_FILE = path.join(LAB_DIR, "session.json");

/** LAB_DIR を作る（既にあれば何もしない） */
export function ensureLabDir() {
	fs.mkdirSync(LAB_DIR, { recursive: true });
	return LAB_DIR;
}

/**
 * セッション情報を読む。
 * @returns {object|null} 無ければ null（壊れていても null）
 */
export function readSession() {
	try {
		return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
	} catch {
		return null;
	}
}

/**
 * セッション情報を書く。既存があれば**浅く**混ぜる（1段目のキーだけ差し替える）。
 * @param {object} patch 差し替える内容
 * @returns {object} 書いたあとの全体
 */
export function writeSession(patch) {
	ensureLabDir();
	const merged = { ...(readSession() ?? {}), ...patch };
	fs.writeFileSync(SESSION_FILE, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	return merged;
}

/** セッション情報を消す */
export function clearSession() {
	try {
		fs.unlinkSync(SESSION_FILE);
	} catch {}
}
