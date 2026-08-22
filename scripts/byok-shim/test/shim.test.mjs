/*
 * BYOK shim の単体テスト。
 * 外につながないこと（127.0.0.1 だけ・claude は偽物）を前提にしているので、CI でそのまま走る。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBackend, LiveBackend, ReplayBackend, ScriptBackend, validateReply } from "../lib/backends.mjs";
import { buildDigest } from "../lib/digest.mjs";
import { readJsonl } from "../lib/transcript.mjs";
import { ask, askStream, countPings, sseEvents, startShim, tempDir, writeJsonl } from "./helper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, "fixtures", "fake-claude.mjs");

const translationReply = (text) => ({ text: JSON.stringify({ translation: text, termSuggestions: [] }) });

suite("BYOK shim: OpenAI 互換の形", () => {
	let shim;
	let dir;

	setup(async () => {
		dir = tempDir("wire");
		const file = writeJsonl(dir, "script.jsonl", [translationReply("訳文1"), translationReply("訳文2")]);
		shim = await startShim({ backend: new ScriptBackend({ file, loop: true }), model: "shim-test-model" });
	});

	teardown(async () => {
		await shim.close();
	});

	test("/v1/models がモデル一覧の形で返る", async () => {
		const response = await fetch(`${shim.base}/models`);
		const body = await response.json();
		assert.equal(response.status, 200);
		assert.equal(body.object, "list");
		assert.equal(body.data[0].id, "shim-test-model");
		assert.equal(body.data[0].object, "model");
	});

	test("stream:false のとき chat.completion の形で返る", async () => {
		const { status, json } = await ask(shim.base, {});
		assert.equal(status, 200);
		assert.equal(json.object, "chat.completion");
		assert.equal(json.choices[0].message.role, "assistant");
		assert.equal(JSON.parse(json.choices[0].message.content).translation, "訳文1");
		assert.equal(json.choices[0].finish_reason, "stop");
		// mdait は usage を読んでキャッシュのヒット率を記録するので、欠かさない
		assert.ok(json.usage.prompt_tokens > 0);
		assert.equal(typeof json.usage.prompt_tokens_details.cached_tokens, "number");
	});

	test("stream:true のとき SSE の断片が順番どおりに流れる", async () => {
		const { status, text } = await askStream(shim.base, {});
		assert.equal(status, 200);
		const events = sseEvents(text);
		assert.equal(events[0].object, "chat.completion.chunk");
		assert.equal(events[0].choices[0].delta.role, "assistant");
		const joined = events.map((event) => event.choices[0].delta.content ?? "").join("");
		assert.equal(JSON.parse(joined).translation, "訳文1");
		assert.equal(events.at(-1).choices[0].finish_reason, "stop");
		assert.ok(text.trimEnd().endsWith("data: [DONE]"));
	});

	test("role だけの断片は1つしか流れない", async () => {
		const { text } = await askStream(shim.base, {});
		const roleChunks = sseEvents(text).filter((event) => event.choices[0].delta.role !== undefined);
		assert.equal(roleChunks.length, 1, `role の断片が ${roleChunks.length} 個あります`);
	});

	test("知らない入口は 404 だが、記録は残る", async () => {
		const response = await fetch(`${shim.base}/responses`, { method: "POST", body: "{}" });
		assert.equal(response.status, 404);
	});
});

suite("BYOK shim: ツール呼び出しと心拍", () => {
	test("tool_calls が SSE の断片として正しい形で流れる", async () => {
		const dir = tempDir("tools");
		const file = writeJsonl(dir, "script.jsonl", [
			{ tool_calls: [{ name: "read_file", arguments: { path: "README.md" } }] },
		]);
		const shim = await startShim({ backend: new ScriptBackend({ file }) });
		try {
			const { text } = await askStream(shim.base, {});
			const events = sseEvents(text);
			const withTool = events.find((event) => event.choices[0].delta.tool_calls);
			assert.ok(withTool, "tool_calls を含む断片がありません");
			const call = withTool.choices[0].delta.tool_calls[0];
			assert.equal(call.index, 0);
			assert.equal(call.type, "function");
			assert.equal(call.function.name, "read_file");
			// arguments は JSON 文字列でなければならない（オブジェクトのまま流すと本物と形が違う）
			assert.equal(typeof call.function.arguments, "string");
			assert.equal(JSON.parse(call.function.arguments).path, "README.md");
			assert.equal(events.at(-1).choices[0].finish_reason, "tool_calls");
		} finally {
			await shim.close();
		}
	});

	test("答えを待っている間、心拍が流れ続ける", async () => {
		const dir = tempDir("ping");
		const file = writeJsonl(dir, "script.jsonl", [{ ...translationReply("遅い訳文"), delay: 0.6 }]);
		const shim = await startShim({ backend: new ScriptBackend({ file }), heartbeatSec: 0.1 });
		try {
			const { text } = await askStream(shim.base, {});
			assert.ok(countPings(text) >= 3, `心拍が足りません: ${countPings(text)} 回`);
			assert.ok(text.includes("遅い訳文"));
		} finally {
			await shim.close();
		}
	});
});

suite("BYOK shim: わざと壊すつまみ", () => {
	test("http_status を指定すると、その状態コードがそのまま返る", async () => {
		const dir = tempDir("nasty");
		const file = writeJsonl(dir, "script.jsonl", [
			{ http_status: 429, error: { message: "わざとレート制限", type: "rate_limit_error" } },
		]);
		const shim = await startShim({ backend: new ScriptBackend({ file }) });
		try {
			const { status, json } = await ask(shim.base, {});
			assert.equal(status, 429);
			assert.equal(json.error.type, "rate_limit_error");
		} finally {
			await shim.close();
		}
	});

	test("raw_chunks は検査せずそのまま流す（壊れた JSON を送り込める）", async () => {
		const dir = tempDir("raw");
		const file = writeJsonl(dir, "script.jsonl", [{ raw_chunks: ['{"broken":', "not json at all"] }]);
		const shim = await startShim({ backend: new ScriptBackend({ file }) });
		try {
			const { text } = await askStream(shim.base, {});
			assert.ok(text.includes('data: {"broken":'));
			assert.ok(text.includes("data: not json at all"));
			assert.ok(text.includes("data: [DONE]"));
		} finally {
			await shim.close();
		}
	});

	test("台本を使い切ったら 409 で止まる（黙って繰り返さない）", async () => {
		const dir = tempDir("exhaust");
		const file = writeJsonl(dir, "script.jsonl", [translationReply("1回だけ")]);
		const shim = await startShim({ backend: new ScriptBackend({ file }) });
		try {
			assert.equal((await ask(shim.base, {})).status, 200);
			const second = await ask(shim.base, {});
			assert.equal(second.status, 409);
			assert.match(second.json.error.message, /台本を使い切りました/);
		} finally {
			await shim.close();
		}
	});

	test("答えの形が違えば、その場で理由が分かる", () => {
		assert.match(validateReply({ nope: 1 }), /知らない鍵/);
		assert.match(validateReply({}), /どれか1つは要ります/);
		assert.match(validateReply({ text: 1 }), /文字列/);
		assert.match(validateReply({ text: "a", finish_reason: "???" }), /finish_reason/);
		assert.equal(validateReply({ text: "a" }), null);
	});
});

suite("BYOK shim: 録音と再生", () => {
	test("録音した往復は replay でそのまま再現できる", async () => {
		const dir = tempDir("record");
		const script = writeJsonl(dir, "script.jsonl", [translationReply("録音された訳文")]);
		const record = path.join(dir, "transcript.jsonl");
		const recording = await startShim({ backend: new ScriptBackend({ file: script }), recordFile: record });
		const body = {
			messages: [
				{ role: "system", content: "S" },
				{ role: "user", content: "本文" },
			],
		};
		await ask(recording.base, body, { Authorization: "Bearer sk-very-secret-value" });
		await recording.close();

		const replaying = await startShim({ backend: new ReplayBackend({ file: record }) });
		try {
			const { status, json } = await ask(replaying.base, body);
			assert.equal(status, 200);
			assert.equal(JSON.parse(json.choices[0].message.content).translation, "録音された訳文");
		} finally {
			await replaying.close();
		}
	});

	test("要求が録音と食い違ったら 409 で止まる（黙って合わない再生をしない）", async () => {
		const dir = tempDir("mismatch");
		const record = writeJsonl(dir, "transcript.jsonl", [
			{
				kind: "chat",
				request: { model: "test-model", stream: false, messages: [{ role: "user", content: "録音された本文" }] },
				reply: translationReply("録音された訳文"),
			},
		]);
		const shim = await startShim({ backend: new ReplayBackend({ file: record }) });
		try {
			const { status, json } = await ask(shim.base, { messages: [{ role: "user", content: "違う本文" }] });
			assert.equal(status, 409);
			assert.equal(json.error.type, "replay_mismatch");
		} finally {
			await shim.close();
		}
	});

	test("録音を使い切ったあとの 409 に、録音された回数がそのまま出る", async () => {
		const dir = tempDir("exhaust-replay");
		const request = { model: "test-model", stream: false, messages: [{ role: "user", content: "同じ本文" }] };
		const record = writeJsonl(dir, "transcript.jsonl", [
			{ kind: "chat", request, reply: translationReply("1回目") },
			{ kind: "chat", request, reply: translationReply("2回目") },
		]);
		const shim = await startShim({ backend: new ReplayBackend({ file: record }) });
		try {
			assert.equal((await ask(shim.base, { messages: request.messages })).status, 200);
			assert.equal((await ask(shim.base, { messages: request.messages })).status, 200);
			const third = await ask(shim.base, { messages: request.messages });
			assert.equal(third.status, 409);
			// 使い切ったあとでも「録音に2回あった」と言えること（待ち行列の残り 0 を数えない）
			assert.match(third.json.error.message, /録音に 2 回ある/);
		} finally {
			await shim.close();
		}
	});

	test("録音に秘密を残さない（Authorization の値は伏せる）", async () => {
		const dir = tempDir("secret");
		const script = writeJsonl(dir, "script.jsonl", [translationReply("訳文")]);
		const record = path.join(dir, "transcript.jsonl");
		const shim = await startShim({ backend: new ScriptBackend({ file: script }), recordFile: record });
		try {
			await ask(shim.base, {}, { Authorization: "Bearer sk-very-secret-value" });
		} finally {
			await shim.close();
		}
		const raw = fs.readFileSync(record, "utf8");
		assert.ok(!raw.includes("sk-very-secret-value"), "録音に API キーが残っています");
		assert.ok(raw.includes("<masked:"), "伏せた印が残っていません");
	});

	test("知らない入口も録音に残る（何を叩きに来たかを捨てない）", async () => {
		const dir = tempDir("unknown");
		const script = writeJsonl(dir, "script.jsonl", [translationReply("訳文")]);
		const record = path.join(dir, "transcript.jsonl");
		const shim = await startShim({ backend: new ScriptBackend({ file: script }), recordFile: record });
		try {
			await fetch(`${shim.base}/embeddings`, { method: "POST", body: "{}" });
		} finally {
			await shim.close();
		}
		const entries = readJsonl(record);
		assert.equal(entries[0].kind, "other");
		assert.match(entries[0].path, /embeddings$/);
	});
});

suite("BYOK shim: 郵便受け（live）", () => {
	test("要求が届くと req と digest が現れ、res を置くと返る", async () => {
		const mailbox = tempDir("mailbox");
		const shim = await startShim({ backend: new LiveBackend({ mailbox, answerTimeoutSec: 10, pollIntervalMs: 50 }) });
		try {
			const pending = ask(shim.base, { messages: [{ role: "user", content: "訳してほしい本文" }] });
			// 郵便受けに要求が現れるのを待つ
			const requestFile = path.join(mailbox, "req-001.json");
			for (let tries = 0; tries < 100 && !fs.existsSync(requestFile); tries += 1) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(fs.existsSync(requestFile), "req-001.json が現れません");
			const digest = fs.readFileSync(path.join(mailbox, "digest-001.md"), "utf8");
			assert.ok(digest.includes("訳してほしい本文"));

			fs.writeFileSync(path.join(mailbox, "res-001.json"), JSON.stringify(translationReply("手で書いた訳文")));
			const { status, json } = await pending;
			assert.equal(status, 200);
			assert.equal(JSON.parse(json.choices[0].message.content).translation, "手で書いた訳文");
		} finally {
			await shim.close();
		}
	});

	test("答えを待ちきれなければ 504 と、何を待っていたかを返す", async () => {
		const mailbox = tempDir("timeout");
		const shim = await startShim({
			backend: new LiveBackend({ mailbox, answerTimeoutSec: 0.3, pollIntervalMs: 50 }),
		});
		try {
			const { status, json } = await ask(shim.base, {});
			assert.equal(status, 504);
			assert.match(json.error.message, /res-001\.json/);
		} finally {
			await shim.close();
		}
	});
});

suite("BYOK shim: ダイジェストは差分だけを見せる", () => {
	const first = {
		model: "m",
		stream: false,
		tools: [{ function: { name: "read_file", description: "ファイルを読む" } }],
		messages: [
			{ role: "system", content: "長い指示" },
			{ role: "user", content: "1つめ" },
		],
	};

	test("初回はツール定義の中身を見せる", () => {
		const digest = buildDigest({ seq: 1, body: first, requestFile: "req", replyFile: "res" });
		assert.ok(digest.includes("read_file"));
		assert.ok(digest.includes("1つめ"));
	});

	test("2回目は同じツール定義と同じ履歴を省く", () => {
		const second = { ...first, messages: [...first.messages, { role: "user", content: "2つめ" }] };
		const digest = buildDigest({ seq: 2, body: second, previousBody: first, requestFile: "req", replyFile: "res" });
		assert.ok(digest.includes("前回と同じ"), "ツール定義が省かれていません");
		assert.ok(digest.includes("先頭 2 件は前回と同じ"), "履歴が省かれていません");
		assert.ok(digest.includes("2つめ"));
		assert.ok(!digest.includes("長い指示"), "前回と同じ内容が残っています");
	});

	test("道具を呼ぶだけの発言でも、何を呼んだかが要約に出る", () => {
		// 道具を呼ぶ相手では assistant の本文が空になる。本文しか見ないと呼び出しが消える
		const body = {
			model: "m",
			messages: [
				{ role: "user", content: "調べて" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
				},
				{ role: "tool", tool_call_id: "c1", content: "README.md" },
			],
		};
		const digest = buildDigest({ seq: 1, body, requestFile: "req", replyFile: "res" });
		assert.ok(digest.includes("道具を呼ぶ: `bash`"), "呼び出した道具の名前が出ていません");
		assert.ok(digest.includes('{"command":"ls"}'), "呼び出しの引数が出ていません");
		assert.ok(!digest.includes("```\nnull\n```"), "本文なしが null と表示されています");
		// どの呼び出しに対する結果かが分からないと、往復の対応が追えない
		assert.ok(digest.includes("tool（c1 の結果）"), "結果と呼び出しの対応が出ていません");
	});

	test("長いメッセージは切って、全文の場所を添える", () => {
		const long = { model: "m", messages: [{ role: "user", content: "あ".repeat(5000) }] };
		const digest = buildDigest({ seq: 1, body: long, requestFile: "req-001.json", replyFile: "res", clipChars: 100 });
		assert.ok(digest.includes("ここで切りました"));
		assert.ok(digest.includes("req-001.json"));
		assert.ok(digest.length < 2000);
	});
});

suite("BYOK shim: agent（別のエージェントを翻訳役にする）", () => {
	test("翻訳役の答えが応答本文になり、system prompt がそのまま渡る", async () => {
		const backend = new AgentBackend({ command: process.execPath, extraArgs: [], cwd: tempDir("agent") });
		// 偽 claude を「claude コマンド」として使う
		backend.buildArgs = (system) => [FAKE_CLAUDE, "--system-prompt", system];
		const shim = await startShim({ backend });
		try {
			const { status, json } = await ask(shim.base, {
				messages: [
					{ role: "system", content: "あなたは翻訳者です" },
					{ role: "user", content: "本文です" },
				],
			});
			assert.equal(status, 200);
			const content = json.choices[0].message.content;
			assert.ok(content.includes("system=あなたは翻訳者です"));
			assert.ok(content.includes("prompt=本文です"));
			// 翻訳役が報告したトークン数がそのまま usage に載る
			assert.equal(json.usage.prompt_tokens, 11);
			assert.equal(json.usage.completion_tokens, 22);
			assert.equal(json.usage.prompt_tokens_details.cached_tokens, 3);
		} finally {
			await shim.close();
		}
	});

	test("翻訳役が落ちたら 502 で、理由が本文に載る", async () => {
		const backend = new AgentBackend({ command: process.execPath, cwd: tempDir("agent-fail") });
		backend.buildArgs = (system) => [FAKE_CLAUDE, "--system-prompt", system];
		const shim = await startShim({ backend });
		try {
			const { status, json } = await ask(shim.base, { messages: [{ role: "user", content: "FAIL" }] });
			assert.equal(status, 502);
			assert.match(json.error.message, /異常終了/);
		} finally {
			await shim.close();
		}
	});

	test("同時に走る翻訳役の数が上限を超えない", async () => {
		const backend = new AgentBackend({ command: process.execPath, concurrency: 2, cwd: tempDir("agent-par") });
		backend.buildArgs = (system) => [FAKE_CLAUDE, "--system-prompt", system];
		const shim = await startShim({ backend });
		try {
			const asks = Array.from({ length: 6 }, () => ask(shim.base, { messages: [{ role: "user", content: "SLOW" }] }));
			const results = await Promise.all(asks);
			assert.ok(results.every((result) => result.status === 200));
			assert.equal(backend.stats().peakConcurrency, 2);
		} finally {
			await shim.close();
		}
	});

	test("複数の要求を同時に受け付ける（順番待ちにしない）", async () => {
		const backend = new AgentBackend({ command: process.execPath, concurrency: 6, cwd: tempDir("agent-par2") });
		backend.buildArgs = (system) => [FAKE_CLAUDE, "--system-prompt", system];
		const shim = await startShim({ backend });
		try {
			const started = Date.now();
			await Promise.all(
				Array.from({ length: 6 }, () => ask(shim.base, { messages: [{ role: "user", content: "SLOW" }] })),
			);
			const elapsed = Date.now() - started;
			// 1件 400ms。逐次なら 2400ms を超えるはず
			assert.ok(elapsed < 2000, `並列に走っていません: ${elapsed}ms`);
			assert.ok(backend.stats().peakConcurrency >= 2);
		} finally {
			await shim.close();
		}
	});

	test("会話が1往復なら、本文をそのまま翻訳役へ渡す", async () => {
		const { renderPrompt, splitConversation } = await import("../lib/backends.mjs");
		const { system, turns } = splitConversation([
			{ role: "system", content: "S" },
			{ role: "user", content: "本文" },
		]);
		assert.equal(system, "S");
		assert.equal(renderPrompt(turns), "本文");
	});

	test("道具の往復を、頼まれごとと取り違えずに並べる", async () => {
		const { renderPrompt, splitConversation } = await import("../lib/backends.mjs");
		const { turns } = splitConversation([
			{ role: "system", content: "S" },
			{ role: "user", content: "調べて" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "README.md" },
		]);
		const rendered = renderPrompt(turns);
		assert.ok(rendered.includes('道具を呼んだ: bash({"command":"ls"})'), "呼び出しが落ちています");
		// 実行結果を「依頼」として並べると、頼まれごとと結果の区別がつかなくなる
		assert.ok(rendered.includes("【道具の実行結果】\nREADME.md"), "実行結果が別扱いになっていません");
		assert.ok(!rendered.includes("【依頼】\nREADME.md"), "実行結果が依頼として並んでいます");
	});

	test("会話が複数往復なら、誰の発言かが分かる形に並べる", async () => {
		const { renderPrompt } = await import("../lib/backends.mjs");
		const rendered = renderPrompt([
			{ role: "user", content: "1回目" },
			{ role: "assistant", content: "答え" },
			{ role: "user", content: "2回目" },
		]);
		assert.ok(rendered.includes("【依頼】\n1回目"));
		assert.ok(rendered.includes("【これまでのあなたの返答】\n答え"));
	});
});
