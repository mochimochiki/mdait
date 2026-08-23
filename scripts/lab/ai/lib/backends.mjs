/*
 * 「何を返すか」を決める5つのやり方。
 *
 *   echo   : 原文から決まった訳文をその場で作って返す。無人・速い・毎回同じ
 *   live   : 郵便受け。人（またはエージェント）がファイルで答える
 *   script : 台本を順に返す。無人
 *   replay : 録音を再生する。要求が録音と食い違ったら止まる
 *   agent  : claude コマンドを1回起動して、その答えを返す。無人で、並列に走る
 *
 * どれも同じ形（reply エンベロープ）を返す。エンベロープの中身は wire.mjs が
 * OpenAI の形に組み立てる。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildDigest } from "./digest.mjs";
import { readJsonl } from "./transcript.mjs";

/** 要求が録音と食い違ったときに投げる。呼び出し側は 409 に変換する */
export class ReplayMismatchError extends Error {}

/** 台本を使い切ったなど、shim の使い方の間違いを伝える */
export class ShimUsageError extends Error {}

/** reply エンベロープとして妥当か調べ、駄目なら理由を返す（良ければ null） */
export function validateReply(reply) {
	if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
		return "応答は JSON オブジェクトである必要があります";
	}
	const known = new Set([
		"text",
		"tool_calls",
		"delay",
		"finish_reason",
		"http_status",
		"error",
		"raw_chunks",
		"usage",
	]);
	for (const key of Object.keys(reply)) {
		if (!known.has(key)) return `知らない鍵 "${key}" があります。使えるのは: ${[...known].join(", ")}`;
	}
	if (reply.text !== undefined && typeof reply.text !== "string") return "text は文字列にしてください";
	if (reply.tool_calls !== undefined) {
		if (!Array.isArray(reply.tool_calls)) return "tool_calls は配列にしてください";
		for (const call of reply.tool_calls) {
			if (!call || typeof call.name !== "string") return "tool_calls の各要素には name（文字列）が要ります";
		}
	}
	if (
		reply.text === undefined &&
		reply.tool_calls === undefined &&
		reply.http_status === undefined &&
		reply.raw_chunks === undefined
	) {
		return "text / tool_calls / raw_chunks / http_status のどれか1つは要ります";
	}
	if (reply.delay !== undefined && (typeof reply.delay !== "number" || reply.delay < 0)) {
		return "delay は0以上の秒数（数値）にしてください";
	}
	if (
		reply.finish_reason !== undefined &&
		!["stop", "length", "tool_calls", "content_filter"].includes(reply.finish_reason)
	) {
		return "finish_reason は stop / length / tool_calls / content_filter のどれかにしてください";
	}
	return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------------------
// echo（原文から決まった訳文を作る）
// --------------------------------------------------------------------------

/** 原文の始まりを示す目印。この行より後ろが訳す対象になる */
const SOURCE_TEXT_SEPARATOR = "=== SOURCE TEXT ===";

/** コードブロックの退避先につけられる目印 */
const CODE_BLOCK_PLACEHOLDER = /__CODE_BLOCK_PLACEHOLDER_\d+__/g;

/**
 * 要求のメッセージから、訳す対象の原文を取り出す。
 *
 * 指示文には翻訳の向きや用語集も載っているので、目印より後ろだけを見る。
 * 目印が無ければ（フロントマターの title のような短い依頼）本文をまるごと対象にする。
 */
export function extractSourceText(messages) {
	const last = [...(messages || [])].reverse().find((message) => message.role === "user");
	const raw = last?.content;
	const content = Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : "";
	const at = content.indexOf(SOURCE_TEXT_SEPARATOR);
	return (at >= 0 ? content.slice(at + SOURCE_TEXT_SEPARATOR.length) : content).trim();
}

/**
 * 原文から、決まった形の訳文を作る。時刻も乱数も混ぜないので、同じ原文なら毎回同じ答えになる。
 *
 * 空白を潰して先頭だけを使うが、コードブロックの目印（`__CODE_BLOCK_PLACEHOLDER_0__`）は
 * 長さの勘定に入れず必ず全部残す。落とすと mdait 側で本文からコードブロックが消えるため。
 * JSON を壊す `{` `}` は取り除く。
 *
 * @param {string} source 原文
 * @param {{limit?: number}} options limit は目印を除いた本文の上限文字数（既定 200）
 */
export function buildEchoTranslation(source, { limit = 200 } = {}) {
	const squashed = String(source ?? "")
		.replace(/\s+/g, " ")
		.replace(/[{}]/g, "")
		.trim();

	const pieces = [];
	let budget = limit;
	let cursor = 0;
	const pushPlain = (plain) => {
		const text = plain.trim();
		if (text.length === 0 || budget <= 0) return;
		pieces.push(text.slice(0, budget));
		budget -= Math.min(text.length, budget);
	};
	for (const match of squashed.matchAll(CODE_BLOCK_PLACEHOLDER)) {
		pushPlain(squashed.slice(cursor, match.index));
		pieces.push(match[0]);
		cursor = match.index + match[0].length;
	}
	pushPlain(squashed.slice(cursor));

	return `${pieces.join(" ")} [MT]`.trim();
}

export class EchoBackend {
	/**
	 * @param {object} options
	 * @param {number} options.delayMs 答えるまで黙っている時間（ミリ秒）。UI の「翻訳中」を見るのに使う
	 * @param {number} options.limit 訳文に使う本文の上限文字数
	 */
	constructor({ delayMs = 0, limit = 200 } = {}) {
		this.delayMs = Math.max(0, delayMs);
		this.limit = limit;
		this.name = "echo";
		this.answered = 0;
	}

	async respond(body) {
		if (this.delayMs > 0) await sleep(this.delayMs);
		this.answered += 1;
		const translation = buildEchoTranslation(extractSourceText(body.messages), { limit: this.limit });
		return { text: JSON.stringify({ translation, termSuggestions: [] }) };
	}

	stats() {
		return { answered: this.answered, delayMs: this.delayMs };
	}
}

// --------------------------------------------------------------------------
// script
// --------------------------------------------------------------------------

export class ScriptBackend {
	constructor({ file, loop = false }) {
		this.replies = readJsonl(file);
		if (this.replies.length === 0) throw new ShimUsageError(`台本 ${file} が空です`);
		for (const [index, reply] of this.replies.entries()) {
			const problem = validateReply(reply);
			if (problem) throw new ShimUsageError(`台本 ${file} の ${index + 1} 件目: ${problem}`);
		}
		this.loop = loop;
		this.used = 0;
		this.name = "script";
	}

	async respond() {
		if (this.used >= this.replies.length) {
			if (!this.loop) {
				throw new ShimUsageError(
					`台本を使い切りました（${this.replies.length} 件）。要求のほうが多いので、台本を足すか --script-loop を付けてください`,
				);
			}
		}
		const reply = this.replies[this.used % this.replies.length];
		this.used += 1;
		return reply;
	}
}

// --------------------------------------------------------------------------
// replay
// --------------------------------------------------------------------------

/** 比較に使う形へ落とす。id や時刻など、毎回変わるものは見ない */
function requestFingerprint(body) {
	return JSON.stringify({
		model: body.model ?? null,
		stream: Boolean(body.stream),
		messages: (body.messages || []).map((m) => ({ role: m.role, content: m.content })),
	});
}

export class ReplayBackend {
	constructor({ file }) {
		this.entries = readJsonl(file).filter((entry) => entry.kind === "chat");
		if (this.entries.length === 0) {
			throw new ShimUsageError(`録音 ${file} に再生できるやり取り（kind:"chat"）がありません`);
		}
		// 中身で引く。ファイル単位の並列翻訳では要求の到着順が毎回変わるので、
		// 並び順で突き合わせると、同じ仕事なのに再生が失敗してしまう
		this.byFingerprint = new Map();
		// 録音時点の件数を別に数えておく。byFingerprint の待ち行列は使うたびに減るので、
		// 使い切ったあとに数えても 0 しか出てこず、食い違いの原因を伝えられない
		this.recordedCounts = new Map();
		for (const entry of this.entries) {
			const key = requestFingerprint(entry.request);
			if (!this.byFingerprint.has(key)) this.byFingerprint.set(key, []);
			this.byFingerprint.get(key).push(entry.reply);
			this.recordedCounts.set(key, (this.recordedCounts.get(key) ?? 0) + 1);
		}
		this.used = 0;
		this.name = "replay";
	}

	async respond(body) {
		this.used += 1;
		const key = requestFingerprint(body);
		const queue = this.byFingerprint.get(key);
		if (!queue || queue.length === 0) {
			const reason = queue
				? `同じ要求は録音に ${this.recordedCounts.get(key)} 回あるが、その回数を超えて来ました`
				: "この要求は録音にありません";
			throw new ReplayMismatchError(
				[`${this.used} 回目の要求が録音と合いません。${reason}`, `今回: ${key.slice(0, 800)}`].join("\n"),
			);
		}
		return queue.shift();
	}

	/** まだ使われていない録音の数。全部使い切ったかを確かめるのに使う */
	unusedCount() {
		let remaining = 0;
		for (const queue of this.byFingerprint.values()) remaining += queue.length;
		return remaining;
	}

	stats() {
		return { recorded: this.entries.length, replayed: this.used, unused: this.unusedCount() };
	}
}

// --------------------------------------------------------------------------
// live（郵便受け）
// --------------------------------------------------------------------------

export class LiveBackend {
	constructor({ mailbox, answerTimeoutSec = 900, pollIntervalMs = 300, clipChars = 1200 }) {
		this.mailbox = mailbox;
		this.answerTimeoutMs = answerTimeoutSec * 1000;
		this.pollIntervalMs = pollIntervalMs;
		this.clipChars = clipChars;
		this.previousBody = undefined;
		this.name = "live";
		fs.mkdirSync(mailbox, { recursive: true });
	}

	async respond(body, { seq }) {
		const tag = String(seq).padStart(3, "0");
		const requestFile = path.join(this.mailbox, `req-${tag}.json`);
		const digestFile = path.join(this.mailbox, `digest-${tag}.md`);
		const replyFile = path.join(this.mailbox, `res-${tag}.json`);

		fs.writeFileSync(requestFile, JSON.stringify(body, null, 2));
		fs.writeFileSync(
			digestFile,
			buildDigest({
				seq,
				body,
				previousBody: this.previousBody,
				requestFile,
				replyFile,
				clipChars: this.clipChars,
			}),
		);
		this.previousBody = body;

		const deadline = Date.now() + this.answerTimeoutMs;
		while (Date.now() < deadline) {
			if (fs.existsSync(replyFile)) {
				const raw = fs.readFileSync(replyFile, "utf8");
				// 書き込み途中を読んでしまうことがあるので、読めるまで待つ
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch {
					await sleep(this.pollIntervalMs);
					continue;
				}
				const problem = validateReply(parsed);
				if (problem) {
					return {
						http_status: 400,
						error: { message: `${replyFile} の形が違います: ${problem}` },
					};
				}
				return parsed;
			}
			await sleep(this.pollIntervalMs);
		}
		return {
			http_status: 504,
			error: {
				message: `${Math.round(this.answerTimeoutMs / 1000)} 秒待ちましたが ${replyFile} が現れませんでした`,
			},
		};
	}
}

// --------------------------------------------------------------------------
// agent（claude コマンドを翻訳役として起動する）
// --------------------------------------------------------------------------

/** 同時に走らせる子プロセスの数を抑えるための順番待ち */
class Semaphore {
	constructor(limit) {
		this.limit = limit;
		this.running = 0;
		this.waiting = [];
	}

	async acquire() {
		if (this.running < this.limit) {
			this.running += 1;
			return;
		}
		await new Promise((resolve) => this.waiting.push(resolve));
		this.running += 1;
	}

	release() {
		this.running -= 1;
		const next = this.waiting.shift();
		if (next) next();
	}
}

/**
 * system ロールと、それ以外の会話を切り分ける。
 * claude コマンドは system prompt を専用の引数で受け取るので、混ぜずに渡す。
 */
export function splitConversation(messages) {
	const systemParts = [];
	const turns = [];
	for (const message of messages || []) {
		const content =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? message.content.join("")
					: "";
		if (message.role === "system") systemParts.push(content);
		// 道具の呼び出しは本文と別の場所に入っている。ここで落とすと、
		// 何を実行しようとしたのかが翻訳役に伝わらない
		else turns.push({ role: message.role, content, toolCalls: message.tool_calls });
	}
	return { system: systemParts.join("\n\n"), turns };
}

/**
 * 会話を1本のプロンプト文字列にする。
 * 1往復（user 1件）なら中身そのまま。複数往復なら、誰の発言かが分かる形に並べる。
 */
export function renderPrompt(turns) {
	if (turns.length === 1 && turns[0].role === "user") return turns[0].content;
	return turns.map(renderTurn).join("\n\n");
}

/** 1つの発言を、誰の何なのかが分かる形にする */
function renderTurn(turn) {
	if (turn.role === "assistant") {
		const calls = (turn.toolCalls ?? []).map((call) => {
			const fn = call.function ?? {};
			const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
			return `${fn.name ?? "(名前なし)"}(${args})`;
		});
		const body = [turn.content, calls.length > 0 ? `道具を呼んだ: ${calls.join(" / ")}` : ""]
			.filter(Boolean)
			.join("\n");
		return `【これまでのあなたの返答】\n${body || "（発言なし）"}`;
	}
	// 道具の実行結果を「依頼」として並べると、頼まれごとと結果の区別がつかなくなる
	if (turn.role === "tool") return `【道具の実行結果】\n${turn.content}`;
	return `【依頼】\n${turn.content}`;
}

export class AgentBackend {
	/**
	 * @param {object} options
	 * @param {string} options.command 起動するコマンド（既定: claude）
	 * @param {string|undefined} options.model 使うモデル（claude の --model に渡す）
	 * @param {number} options.concurrency 同時に走らせる上限
	 * @param {number} options.timeoutSec 1回あたりの待ち時間の上限
	 * @param {string} options.cwd 子プロセスの作業ディレクトリ
	 * @param {string[]} options.extraArgs 追加で渡す引数
	 */
	constructor({ command = "claude", model, concurrency = 4, timeoutSec = 300, cwd, extraArgs = [] }) {
		this.command = command;
		this.model = model;
		this.timeoutMs = timeoutSec * 1000;
		this.cwd = cwd;
		this.extraArgs = extraArgs;
		this.semaphore = new Semaphore(Math.max(1, concurrency));
		this.name = "agent";
		this.concurrency = Math.max(1, concurrency);
		/** 実測用。最大でいくつ同時に走ったか */
		this.peakConcurrency = 0;
	}

	buildArgs(system) {
		const args = [
			"-p",
			"--tools",
			"",
			"--output-format",
			"json",
			"--no-session-persistence",
			// 翻訳役に、この作業場のルール（CLAUDE.md やプラグイン）を持ち込ませない。
			// 持ち込むと「mdait を知っている翻訳者」になってしまい、素の挙動が見えなくなる
			"--safe-mode",
		];
		if (system && system.trim().length > 0) args.push("--system-prompt", system);
		if (this.model) args.push("--model", this.model);
		args.push(...this.extraArgs);
		return args;
	}

	async respond(body) {
		const { system, turns } = splitConversation(body.messages);
		const prompt = renderPrompt(turns);

		await this.semaphore.acquire();
		this.peakConcurrency = Math.max(this.peakConcurrency, this.semaphore.running);
		try {
			const result = await this.runOnce(system, prompt);
			return result;
		} finally {
			this.semaphore.release();
		}
	}

	runOnce(system, prompt) {
		return new Promise((resolve) => {
			const child = spawn(this.command, this.buildArgs(system), {
				cwd: this.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
			});

			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			};

			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish({
					http_status: 504,
					error: { message: `翻訳役の応答が ${this.timeoutMs / 1000} 秒を超えました` },
				});
			}, this.timeoutMs);

			child.stdout.on("data", (buffer) => {
				stdout += buffer.toString();
			});
			child.stderr.on("data", (buffer) => {
				stderr += buffer.toString();
			});
			child.on("error", (error) => {
				finish({ http_status: 502, error: { message: `${this.command} を起動できません: ${error.message}` } });
			});
			child.on("close", (code) => {
				if (code !== 0) {
					finish({
						http_status: 502,
						error: { message: `${this.command} が異常終了しました（終了コード ${code}）: ${stderr.slice(0, 800)}` },
					});
					return;
				}
				try {
					const parsed = JSON.parse(stdout);
					if (parsed.is_error) {
						finish({ http_status: 502, error: { message: `翻訳役がエラーを返しました: ${parsed.result ?? ""}` } });
						return;
					}
					finish({
						text: typeof parsed.result === "string" ? parsed.result : "",
						usage: {
							prompt_tokens: parsed.usage?.input_tokens,
							completion_tokens: parsed.usage?.output_tokens,
							cached_tokens: parsed.usage?.cache_read_input_tokens ?? 0,
						},
					});
				} catch (error) {
					finish({
						http_status: 502,
						error: { message: `翻訳役の出力を JSON として読めません: ${error.message}: ${stdout.slice(0, 400)}` },
					});
				}
			});

			child.stdin.end(prompt);
		});
	}

	stats() {
		return { concurrencyLimit: this.concurrency, peakConcurrency: this.peakConcurrency };
	}
}
