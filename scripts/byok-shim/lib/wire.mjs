/*
 * OpenAI Chat Completions API の「線の上を流れる形」を組み立てる。
 *
 * shim の他の部分は「返す中身」（本文・ツール呼び出し・終了理由）だけを扱い、
 * JSON や SSE の枠組みはすべてここで作る。OpenAI 互換であることの責任を
 * 1ファイルに閉じ込めるため。
 */

/** ざっくりのトークン見積り。実測ではないので目安として使う */
export function estimateTokens(text) {
	return Math.max(1, Math.ceil((text || "").length / 4));
}

let idCounter = 0;

/** chatcmpl-xxxx 形式の応答IDを作る（同一プロセス内で重複しない） */
export function newCompletionId() {
	idCounter += 1;
	return `chatcmpl-shim${String(idCounter).padStart(6, "0")}`;
}

/** reply の tool_calls（{name, arguments}）を OpenAI の形へ広げる */
function expandToolCalls(toolCalls) {
	return (toolCalls || []).map((call, index) => ({
		id: call.id || `call_shim${String(index + 1).padStart(4, "0")}`,
		type: "function",
		function: {
			name: call.name,
			// OpenAI は arguments を「JSON文字列」で渡す。オブジェクトで書かれていたら文字列にする
			arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
		},
	}));
}

/** 終了理由を決める。明示指定がなければ tool_calls の有無で決まる */
function resolveFinishReason(reply) {
	if (reply.finish_reason) return reply.finish_reason;
	return reply.tool_calls && reply.tool_calls.length > 0 ? "tool_calls" : "stop";
}

/** usage を組み立てる。reply 側で上書きできる */
function buildUsage(reply, promptChars) {
	const promptTokens = reply.usage?.prompt_tokens ?? Math.max(1, Math.ceil(promptChars / 4));
	const completionTokens = reply.usage?.completion_tokens ?? estimateTokens(reply.text || "");
	const cachedTokens = reply.usage?.cached_tokens ?? 0;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens,
		prompt_tokens_details: { cached_tokens: cachedTokens },
	};
}

/** 非ストリーミングの応答ボディ（1個の JSON） */
export function buildCompletion({ id, created, model, reply, promptChars }) {
	const message = { role: "assistant", content: reply.text ?? "" };
	if (reply.tool_calls && reply.tool_calls.length > 0) {
		message.tool_calls = expandToolCalls(reply.tool_calls);
	}
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [{ index: 0, message, finish_reason: resolveFinishReason(reply), logprobs: null }],
		usage: buildUsage(reply, promptChars),
	};
}

/** SSE の 1 断片（data: 行に載せる JSON） */
function chunk({ id, created, model, delta, finishReason }) {
	return {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null, logprobs: null }],
	};
}

/**
 * ストリーミングで流す断片を順に返す。
 * 最初の role だけの断片は「接続が生きている」ことを相手に伝える役目も持つ。
 */
export function buildStreamChunks({ id, created, model, reply, promptChars }) {
	const chunks = [];
	chunks.push(chunk({ id, created, model, delta: { role: "assistant", content: "" } }));

	const text = reply.text ?? "";
	if (text.length > 0) {
		// 1本の文字列で送らず、実物のAPIらしく刻む（受け手の結合処理を試すため）
		const size = 40;
		for (let at = 0; at < text.length; at += size) {
			chunks.push(chunk({ id, created, model, delta: { content: text.slice(at, at + size) } }));
		}
	}

	if (reply.tool_calls && reply.tool_calls.length > 0) {
		expandToolCalls(reply.tool_calls).forEach((call, index) => {
			chunks.push(
				chunk({
					id,
					created,
					model,
					delta: {
						tool_calls: [
							{
								index,
								id: call.id,
								type: "function",
								function: { name: call.function.name, arguments: call.function.arguments },
							},
						],
					},
				}),
			);
		});
	}

	const last = chunk({ id, created, model, delta: {}, finishReason: resolveFinishReason(reply) });
	last.usage = buildUsage(reply, promptChars);
	chunks.push(last);
	return chunks;
}

/** /v1/models の応答 */
export function buildModelList(models) {
	return {
		object: "list",
		data: models.map((id) => ({
			id,
			object: "model",
			created: 0,
			owned_by: "mdait-byok-shim",
		})),
	};
}
