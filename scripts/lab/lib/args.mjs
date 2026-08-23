/*
 * コマンドラインの読み取り。
 *
 * `--名前 値` と `--名前`（真偽の旗）の2種類だけを扱う。旗として扱う名前は呼び出し側が渡す。
 * 値を取る指定に値が無ければ、その場で分かるように例外を投げる。
 */

/** 使い方の間違いを表す。lab.mjs はこれを捕まえて短く出す（スタックは出さない） */
export class UsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
}

/**
 * argv を読み分ける。
 *
 * @param {string[]} argv 読み取る配列（`process.argv.slice(2)` など）
 * @param {{ booleans?: string[] }} spec 真偽の旗として扱う名前
 * @returns {{ _: string[], [key: string]: unknown }} `_` が名前の付いていない引数
 */
export function parseArgs(argv, spec = {}) {
	const booleans = new Set(spec.booleans ?? []);
	const out = { _: [] };
	for (let at = 0; at < argv.length; at += 1) {
		const token = argv[at];
		if (!token.startsWith("--")) {
			out._.push(token);
			continue;
		}
		// `--名前=値` の書き方も受ける
		const eq = token.indexOf("=");
		const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
		if (eq >= 0) {
			out[name] = token.slice(eq + 1);
			continue;
		}
		if (booleans.has(name)) {
			out[name] = true;
			continue;
		}
		const value = argv[at + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new UsageError(`--${name} には値が要ります`);
		}
		out[name] = value;
		at += 1;
	}
	return out;
}

/** 数として読む。読めなければ既定値を返す */
export function asNumber(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/** 選択肢のどれかであることを確かめる */
export function oneOf(value, allowed, label) {
	if (value === undefined) return undefined;
	if (!allowed.includes(value)) {
		throw new UsageError(`${label} に使えるのは ${allowed.join(" / ")} です（渡された値: ${value}）`);
	}
	return value;
}
