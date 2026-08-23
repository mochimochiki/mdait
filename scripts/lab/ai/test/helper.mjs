import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createShimServer } from "../lib/server.mjs";

/** 空きポートで shim を1つ立てる。テストが終わったら close() を呼ぶ */
export async function startShim({ backend, ...options } = {}) {
	const server = createShimServer({ backend, log: () => {}, ...options });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}/v1`;
	return {
		server,
		base,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** 使い捨てのディレクトリを作る */
export function tempDir(name) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `byok-${name}-`));
}

/** 非ストリーミングで1回聞く */
export async function ask(base, body, headers = {}) {
	const response = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "U" }], ...body }),
	});
	const text = await response.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.status, text, json };
}

/** ストリーミングで1回聞き、SSE の生テキストを返す */
export async function askStream(base, body) {
	const response = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "U" }], stream: true, ...body }),
	});
	return { status: response.status, text: await response.text() };
}

/** SSE の生テキストから data: 行の JSON だけを取り出す */
export function sseEvents(text) {
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice(6))
		.filter((payload) => payload !== "[DONE]")
		.map((payload) => JSON.parse(payload));
}

/** SSE の心拍（コメント行）の数 */
export function countPings(text) {
	return text.split("\n").filter((line) => line.startsWith(": ping")).length;
}

export function writeJsonl(dir, name, lines) {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}
