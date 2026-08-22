/*
 * OpenAI 互換の受付サーバー。
 *
 * mdait の `ai.provider: "openai"` は `${baseURL}/chat/completions` を素の fetch で叩く。
 * ここはその相手役で、127.0.0.1 にだけ耳を貸す。
 *
 * 「何を返すか」は backends.mjs が決め、「どう返すか」（JSON か SSE か）はここが決める。
 */
import http from "node:http";
import { ReplayMismatchError, ShimUsageError } from "./backends.mjs";
import { Transcript, maskHeaders } from "./transcript.mjs";
import { buildCompletion, buildModelList, buildStreamChunks, newCompletionId } from "./wire.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 要求の本文を最後まで読む。壊れた JSON はそのまま文字列で返す */
function readBody(request) {
	return new Promise((resolve, reject) => {
		const parts = [];
		request.on("data", (chunk) => parts.push(chunk));
		request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
		request.on("error", reject);
	});
}

function sendJson(response, status, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	response.end(body);
}

function errorPayload(message, type = "shim_error") {
	return { error: { message, type, param: null, code: null } };
}

/**
 * 受付サーバーを作る。
 *
 * @param {object} options
 * @param {object} options.backend 応答を決める人（respond(body, ctx) を持つ）
 * @param {string} options.model /v1/models で名乗るモデル名
 * @param {string|undefined} options.recordFile 録音の書き出し先
 * @param {number} options.heartbeatSec ストリーミング中に心拍を打つ間隔（秒）
 * @param {(message: string) => void} options.log 進行の書き出し先
 */
export function createShimServer({ backend, model = "byok-shim", recordFile, heartbeatSec = 10, log = () => {} }) {
	const transcript = new Transcript(recordFile);
	let seq = 0;
	/** 実測用の記録 */
	const stats = { requests: 0, inFlight: 0, peakInFlight: 0, errors: 0 };

	const server = http.createServer(async (request, response) => {
		const raw = await readBody(request).catch(() => "");
		const headers = maskHeaders(request.headers);
		const url = new URL(request.url, "http://127.0.0.1");

		if (request.method === "GET" && url.pathname === "/__shim/stats") {
			// 実測用の覗き窓。何本が同時に来たかを外から確かめられるようにしてある
			sendJson(response, 200, { ...stats, backend: backend.stats?.() ?? null, mode: backend.name });
			return;
		}

		if (request.method === "GET" && url.pathname.endsWith("/models")) {
			transcript.append({ kind: "other", method: request.method, path: url.pathname, headers });
			sendJson(response, 200, buildModelList([model]));
			return;
		}

		if (!(request.method === "POST" && url.pathname.endsWith("/chat/completions"))) {
			// 知らない入口も黙って捨てない。何を叩きに来たかを知ることが、この道具の目的の一つ
			transcript.append({
				kind: "other",
				method: request.method,
				path: url.pathname,
				headers,
				body: raw.slice(0, 4000),
			});
			log(`知らない入口に要求が来ました: ${request.method} ${url.pathname}`);
			sendJson(response, 404, errorPayload(`このshimは ${request.method} ${url.pathname} を扱いません`, "not_found"));
			return;
		}

		let body;
		try {
			body = JSON.parse(raw);
		} catch (error) {
			transcript.append({
				kind: "other",
				method: request.method,
				path: url.pathname,
				headers,
				body: raw.slice(0, 4000),
			});
			sendJson(
				response,
				400,
				errorPayload(`要求本文を JSON として読めません: ${error.message}`, "invalid_request_error"),
			);
			return;
		}

		seq += 1;
		stats.requests += 1;
		stats.inFlight += 1;
		stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
		const current = seq;
		const started = Date.now();
		log(`要求 ${current}: メッセージ ${body.messages?.length ?? 0} 件 / stream=${Boolean(body.stream)}`);

		const promptChars = (body.messages || []).reduce((sum, message) => {
			const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
			return sum + content.length;
		}, 0);

		const finishRecord = (reply) => {
			transcript.append({
				kind: "chat",
				seq: current,
				method: request.method,
				path: url.pathname,
				headers,
				request: body,
				reply,
				durationMs: Date.now() - started,
			});
			stats.inFlight -= 1;
		};

		if (body.stream) {
			await respondStreaming({
				request,
				response,
				body,
				current,
				promptChars,
				backend,
				model,
				heartbeatSec,
				log,
				stats,
				finishRecord,
			});
		} else {
			await respondOnce({ response, body, current, promptChars, backend, model, log, stats, finishRecord });
		}
	});

	server.stats = () => ({ ...stats, backend: backend.stats?.() });
	return server;
}

/** backend を呼び、投げられた例外を「返せる形」に変える */
async function askBackend(backend, body, current) {
	try {
		const reply = await backend.respond(body, { seq: current });
		return reply ?? { text: "" };
	} catch (error) {
		if (error instanceof ReplayMismatchError) {
			return { http_status: 409, error: { message: error.message, type: "replay_mismatch" } };
		}
		if (error instanceof ShimUsageError) {
			return { http_status: 409, error: { message: error.message, type: "shim_usage_error" } };
		}
		return { http_status: 500, error: { message: `shim の中で失敗しました: ${error.message}`, type: "shim_error" } };
	}
}

async function respondOnce({ response, body, current, promptChars, backend, model, log, stats, finishRecord }) {
	const reply = await askBackend(backend, body, current);
	if (reply.delay) await sleep(reply.delay * 1000);

	if (reply.http_status && reply.http_status >= 400) {
		stats.errors += 1;
		log(`要求 ${current}: ${reply.http_status} を返します`);
		finishRecord(reply);
		sendJson(
			response,
			reply.http_status,
			reply.error ? { error: reply.error } : errorPayload("shim が意図的に返した失敗です"),
		);
		return;
	}

	const payload = buildCompletion({
		id: newCompletionId(),
		created: Math.floor(Date.now() / 1000),
		model: body.model || model,
		reply,
		promptChars,
	});
	finishRecord(reply);
	log(`要求 ${current}: ${(reply.text || "").length} 文字を返しました`);
	sendJson(response, 200, payload);
}

async function respondStreaming({
	request,
	response,
	body,
	current,
	promptChars,
	backend,
	model,
	heartbeatSec,
	log,
	stats,
	finishRecord,
}) {
	// 考えている間、相手に接続を切らせない。
	// 先に頭を返し、答えが決まるまで心拍を打ち続ける
	response.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const id = newCompletionId();
	const created = Math.floor(Date.now() / 1000);
	const usedModel = body.model || model;
	let closed = false;
	request.on("close", () => {
		closed = true;
	});

	const write = (payload) => {
		if (!closed) response.write(`data: ${JSON.stringify(payload)}\n\n`);
	};

	write({
		id,
		object: "chat.completion.chunk",
		created,
		model: usedModel,
		choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, logprobs: null }],
	});

	const heartbeat = setInterval(() => {
		// SSE のコメント行。受け手からは無視されるが、経路上の機器には「生きている」と伝わる
		if (!closed) response.write(": ping\n\n");
	}, Math.max(0.05, heartbeatSec) * 1000);

	let reply;
	try {
		reply = await askBackend(backend, body, current);
		if (reply.delay) await sleep(reply.delay * 1000);
	} finally {
		clearInterval(heartbeat);
	}

	if (reply.http_status && reply.http_status >= 400) {
		// ヘッダは返し終えているので、状態コードでは伝えられない。SSE の中でエラーを伝える
		stats.errors += 1;
		write({ error: reply.error ?? { message: "shim が意図的に返した失敗です" } });
		finishRecord(reply);
		if (!closed) response.end();
		return;
	}

	if (reply.raw_chunks) {
		// わざと壊れた断片を送り込むための逃げ道。中身は一切検査しない
		for (const chunk of reply.raw_chunks) {
			if (!closed) response.write(`data: ${chunk}\n\n`);
		}
		finishRecord(reply);
		if (!closed) response.write("data: [DONE]\n\n");
		if (!closed) response.end();
		return;
	}

	for (const chunk of buildStreamChunks({ id, created, model: usedModel, reply, promptChars })) {
		write(chunk);
	}
	finishRecord(reply);
	log(`要求 ${current}: ${(reply.text || "").length} 文字をストリームで返しました`);
	if (!closed) response.write("data: [DONE]\n\n");
	if (!closed) response.end();
}
