/*
 * 受けた要求を1行1件で書き残す（transcript.jsonl）。
 *
 * 目的は2つ。
 *  - mdait が実際に何を送ってくるかを、推測ではなく実物で確かめる
 *  - live で録ったやり取りを、そのまま replay の材料にする
 *
 * 秘密は残さない。Authorization などの値は伏せ、ヘッダは名前だけを意味のある情報として扱う。
 */
import fs from "node:fs";
import path from "node:path";

/** 値を伏せるヘッダ（小文字で比較する） */
const SECRET_HEADERS = new Set([
	"authorization",
	"api-key",
	"x-api-key",
	"openai-api-key",
	"cookie",
	"proxy-authorization",
]);

/**
 * ヘッダの値のうち秘密にあたるものを伏せる。
 * 「あった」ことは分かるようにしたいので、消さずに長さだけ残す。
 */
export function maskHeaders(headers) {
	const masked = {};
	for (const [name, value] of Object.entries(headers || {})) {
		const key = String(name).toLowerCase();
		if (SECRET_HEADERS.has(key)) {
			const length = Array.isArray(value) ? value.join("").length : String(value ?? "").length;
			masked[key] = `<masked:${length}chars>`;
		} else {
			masked[key] = value;
		}
	}
	return masked;
}

export class Transcript {
	/** @param {string|undefined} filePath 書き出し先。未指定なら何も書かない */
	constructor(filePath) {
		this.filePath = filePath;
		if (filePath) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, "");
		}
	}

	append(entry) {
		if (!this.filePath) return;
		fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
	}
}

/** transcript.jsonl / 台本ファイルを読む（空行は飛ばす） */
export function readJsonl(filePath) {
	const text = fs.readFileSync(filePath, "utf8");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("//"))
		.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				throw new Error(`${filePath} の ${index + 1} 行目が JSON として読めません: ${error.message}`);
			}
		});
}
