/**
 * UX 検証用の偽 Ollama サーバー。
 * /api/chat に対して「遅く」応答することで、翻訳の進行中の見え方を目視できるようにする。
 * 応答本文は mdait の response-validator が期待する JSON（{"translation": "..."}）。
 */
const http = require("node:http");

const PORT = Number(process.env.FAKE_OLLAMA_PORT || 11434);
// 1リクエストあたりの遅延（ms）。回転アイコンを撮る余裕を作る
const DELAY_MS = Number(process.env.FAKE_OLLAMA_DELAY_MS || 6000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
	}
	const url = req.url || "";
	console.log(new Date().toISOString(), req.method, url);

	if (url.startsWith("/api/tags")) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ models: [{ name: "fake:latest", model: "fake:latest" }] }));
		return;
	}

	if (url.startsWith("/api/chat")) {
		// 原文を取り出して「訳した風」の本文を作る（差分が見えるよう接頭辞を付ける）
		let source = "";
		try {
			const parsed = JSON.parse(body);
			const last = (parsed.messages || []).filter((m) => m.role === "user").pop();
			source = typeof last?.content === "string" ? last.content : "";
		} catch {
			// 解析できなくても応答は返す
		}
		const heading = source.match(/^#{1,6} .*$/m)?.[0] ?? "";
		const translation = `${heading ? `${heading} (translated)\n\n` : ""}Translated by the fake provider at ${new Date().toISOString()}.`;
		const payload = JSON.stringify({ translation });

		res.setHeader("content-type", "application/x-ndjson");
		// ストリーミング応答。最初のチャンクを遅らせることで「翻訳中」の時間を作る
		await sleep(DELAY_MS);
		res.write(
			`${JSON.stringify({
				model: "fake:latest",
				created_at: new Date().toISOString(),
				message: { role: "assistant", content: payload },
				done: false,
			})}\n`,
		);
		res.write(
			`${JSON.stringify({
				model: "fake:latest",
				created_at: new Date().toISOString(),
				message: { role: "assistant", content: "" },
				done: true,
				done_reason: "stop",
				prompt_eval_count: 10,
				eval_count: 20,
			})}\n`,
		);
		res.end();
		return;
	}

	res.statusCode = 404;
	res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`fake ollama listening on 127.0.0.1:${PORT} (delay ${DELAY_MS}ms)`);
});
