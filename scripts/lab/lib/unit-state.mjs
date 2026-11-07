/*
 * 外の台帳（.mdait/unit-state）を読む。lab の中で台帳を読む処理はここだけを通す。
 *
 * 台帳の1行は8列で、1列目はファイルのパスではなく**ファイルID**（12桁の16進）である。
 * パスとの対応は見出し行 `# <id> <path>` だけが持つ。席に着いていない行の区画は
 * `# <id> [unseated]` という見出しで、こちらはパスを持たない（同じ ID の本来の見出しが持つ）。
 *
 * 列: id / kind / seat / level / titleHash / hash / from / need
 * 形の正本は src/core/unit-state/unit-state-store.ts。
 */
import fs from "node:fs";
import path from "node:path";

/** 見出し行 `# <id> <path>` */
const FILE_ID_HEADER = /^# ([0-9a-f]{12}) (.+)$/;
/** 席に着いていない行の区画の見出しに付く印 */
const UNSEATED_SUFFIX = "[unseated]";
/** 1行の列の数 */
const COLUMNS = 8;

/**
 * 台帳の中身を行に分ける。
 *
 * @param {string} content 台帳の全文
 * @returns {Array<{id:string, path:string, pathKnown:boolean, kind:string, seat:string, level:number, titleHash:string, hash:string, from:string, need:string, line:string}>}
 *   `path` は見出しから引いたパス。見出しが見つからない行は ID をそのまま入れ、`pathKnown` を false にする
 */
export function parseUnitState(content) {
	const lines = content.split("\n");
	const byId = new Map();
	for (const line of lines) {
		const m = FILE_ID_HEADER.exec(line);
		if (m && m[2] !== UNSEATED_SUFFIX) byId.set(m[1], m[2]);
	}
	const rows = [];
	for (const line of lines) {
		if (line.trim() === "" || line.startsWith("#")) continue;
		const cols = line.split("\t");
		if (cols.length !== COLUMNS) continue;
		const known = byId.get(cols[0]);
		rows.push({
			id: cols[0],
			path: known ?? cols[0],
			pathKnown: known !== undefined,
			kind: cols[1],
			seat: cols[2],
			level: Number(cols[3]),
			titleHash: cols[4],
			hash: cols[5],
			from: cols[6],
			need: cols[7],
			line,
		});
	}
	return rows;
}

/** 作業場の台帳をそのまま読む。無ければ空文字 */
export function readUnitStateText(ws) {
	try {
		return fs.readFileSync(path.join(ws, ".mdait", "unit-state"), "utf8");
	} catch {
		return "";
	}
}
