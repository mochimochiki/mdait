/*
 * 人（＝郵便受けを覗くエージェント）に見せる要約を作る。
 *
 * 1回の要求には system prompt と会話履歴が丸ごと乗る。全文を毎回読むと
 * 数往復で読み手の作業記憶が尽きるので、「前回から変わったところ」だけを見せる。
 * 全文はいつでも req-NNN.json にあるので、必要になったときだけ開けばよい。
 */

/** 長い文字列を頭から切って、切ったことが分かるようにする */
function clip(text, limit) {
	const value = text ?? "";
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}\n…（ここで切りました。全文は ${value.length} 文字）`;
}

/** メッセージの本文を文字列にする。中身が無いとき（道具を呼ぶだけの発言）は空文字 */
function messageText(message) {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return message.content.map((part) => part?.text ?? JSON.stringify(part)).join("");
	if (message.content == null) return "";
	return JSON.stringify(message.content);
}

/**
 * メッセージ1件を「役割＋中身」の1ブロックにする。
 *
 * 道具を呼ぶ相手では、assistant の発言が「本文が空で tool_calls だけ」という形になる。
 * 本文しか見ないと、相手が何を実行しようとしたのかが要約から消えてしまうので、
 * 呼び出しの中身も並べる。
 */
function renderMessage(message, limit) {
	const blocks = [];
	const text = messageText(message);
	if (text.length > 0) blocks.push(`\`\`\`\n${clip(text, limit)}\n\`\`\``);

	for (const call of message.tool_calls ?? []) {
		const fn = call.function ?? {};
		const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
		blocks.push(`道具を呼ぶ: \`${fn.name ?? "(名前なし)"}\`\n\n\`\`\`json\n${clip(args, limit)}\n\`\`\``);
	}

	if (blocks.length === 0) blocks.push("（中身なし）");

	// どの呼び出しに対する結果なのかが分からないと、往復の対応が追えない
	const label =
		message.role === "tool" && message.tool_call_id ? `tool（${message.tool_call_id} の結果）` : message.role;
	return `### ${label}\n\n${blocks.join("\n\n")}\n`;
}

/**
 * 今回の要求のダイジェストを作る。
 *
 * @param {object} params
 * @param {number} params.seq 何往復目か
 * @param {object} params.body 要求本文（OpenAI形式）
 * @param {object|undefined} params.previousBody 前回の要求本文
 * @param {string} params.requestFile 全文の置き場所
 * @param {string} params.replyFile 応答を書くべき場所
 * @param {number} params.clipChars 1メッセージあたりの表示上限
 */
export function buildDigest({ seq, body, previousBody, requestFile, replyFile, clipChars = 1200 }) {
	const lines = [];
	const messages = body.messages || [];
	const previousMessages = previousBody?.messages || [];

	lines.push(`# 要求 ${seq}`);
	lines.push("");
	lines.push(`- モデル: \`${body.model ?? "(未指定)"}\``);
	lines.push(`- ストリーミング: ${body.stream ? "する" : "しない"}`);
	lines.push(`- メッセージ数: ${messages.length}（前回 ${previousMessages.length}）`);
	if (body.max_completion_tokens || body.max_tokens) {
		lines.push(`- 出力上限トークン: ${body.max_completion_tokens ?? body.max_tokens}`);
	}
	if (body.prompt_cache_key) lines.push(`- prompt_cache_key: \`${body.prompt_cache_key}\``);
	lines.push(`- 全文: \`${requestFile}\``);
	lines.push("");
	lines.push(`**答えるには**: \`${replyFile}\` に \`{"text": "..."}\` を書く。`);
	lines.push("");

	// ツール定義は初回だけ中身を見せ、以降は「同じ」の1行で済ませる
	const tools = body.tools || [];
	if (tools.length > 0) {
		const previousTools = JSON.stringify(previousBody?.tools ?? null);
		if (previousTools === JSON.stringify(tools)) {
			lines.push(`## ツール定義\n\n前回と同じ（${tools.length} 件）。\n`);
		} else {
			lines.push("## ツール定義\n");
			for (const tool of tools) {
				const fn = tool.function ?? tool;
				lines.push(`- \`${fn.name}\`: ${clip(fn.description ?? "", 160)}`);
			}
			lines.push("");
		}
	}

	// 会話は「前回の要求に無かった分」だけを見せる。
	// 先頭から一致している間は同じ履歴とみなす（LLM への要求は履歴を積み上げる形なので、これで足りる）
	let sameUntil = 0;
	while (
		sameUntil < messages.length &&
		sameUntil < previousMessages.length &&
		JSON.stringify(messages[sameUntil]) === JSON.stringify(previousMessages[sameUntil])
	) {
		sameUntil += 1;
	}

	if (sameUntil > 0) {
		lines.push(`## 会話\n\n先頭 ${sameUntil} 件は前回と同じなので省略。\n`);
	} else {
		lines.push("## 会話\n");
	}

	const fresh = messages.slice(sameUntil);
	if (fresh.length === 0) {
		lines.push("（前回から増えたメッセージはありません）\n");
	} else {
		for (const message of fresh) lines.push(renderMessage(message, clipChars));
	}

	return lines.join("\n");
}
