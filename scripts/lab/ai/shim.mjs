#!/usr/bin/env node
/*
 * AI shim（旧 BYOK shim）— mdait の翻訳相手を手元に用意する。
 *
 * mdait の設定を
 *   "ai": { "provider": "openai", "openai": { "baseURL": "http://127.0.0.1:8080/v1" } }
 * にすると、翻訳の要求がこのサーバーへ来る。誰が答えるかは --mode で選ぶ。
 *
 * 使い方は README.md を見てください。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentBackend, EchoBackend, LiveBackend, ReplayBackend, ScriptBackend } from "./lib/backends.mjs";
import { defaultMailbox } from "./lib/paths.mjs";
import { createShimServer } from "./lib/server.mjs";

const USAGE = `AI shim — mdait の翻訳相手を手元に用意する

  node scripts/lab/ai/shim.mjs [オプション]

共通
  --mode <echo|live|script|replay|agent>  誰が答えるか（既定: live）
  --port <番号>                      待ち受けポート（既定: 8080。0 で空きポートを自動取得）
  --model <名前>                     /v1/models で名乗る名前（既定: byok-shim）
  --record <ファイル>                やり取りを録音する（あとで --mode replay に使える）
  --heartbeat <秒>                   ストリーミング中に心拍を打つ間隔（既定: 10）
  --quiet                            進行の表示を止める

echo（原文から決まった訳文をその場で作る。無人・速い・毎回同じ）
  --delay <ミリ秒>                   答えるまで黙っている時間（既定: 0）
  --echo-limit <文字数>              訳文に使う本文の長さ（既定: 200）

live（郵便受け。人やエージェントがファイルで答える）
  --mailbox <ディレクトリ>           既定: scripts/lab/ai/mailbox（MDAIT_LAB_DIR があればその下）
  --answer-timeout <秒>              答えを待つ上限（既定: 900）
  --clip <文字数>                    ダイジェストで1メッセージを切る長さ（既定: 1200）

script（台本を順に返す。無人）
  --script <ファイル.jsonl>          必須
  --script-loop                      使い切ったら先頭へ戻る

replay（録音を再生する。食い違ったら 409 で止まる）
  --replay <ファイル.jsonl>          必須

agent（claude コマンドを翻訳役として起動する。無人・並列）
  --agent-command <コマンド>         既定: claude
  --agent-model <モデル>             claude の --model に渡す
  --agent-concurrency <数>           同時に走らせる上限（既定: 4）
  --agent-timeout <秒>               1回あたりの上限（既定: 300）
  --agent-cwd <ディレクトリ>         翻訳役の作業場所（既定: shim の作業用ディレクトリ）
`;

/** 何も指定しなかったときの設定。コマンド行からも embed.mjs からも同じものを使う */
export function defaultOptions() {
	return {
		mode: "live",
		port: 8080,
		model: "byok-shim",
		heartbeat: 10,
		mailbox: defaultMailbox(),
		answerTimeout: 900,
		clip: 1200,
		delay: 0,
		echoLimit: 200,
		scriptLoop: false,
		agentCommand: "claude",
		agentConcurrency: 4,
		agentTimeout: 300,
		quiet: false,
	};
}

function parseArgs(argv) {
	const options = defaultOptions();
	for (let at = 0; at < argv.length; at += 1) {
		const flag = argv[at];
		const next = () => {
			at += 1;
			if (at >= argv.length) throw new Error(`${flag} には値が要ります`);
			return argv[at];
		};
		switch (flag) {
			case "--help":
			case "-h":
				process.stdout.write(USAGE);
				process.exit(0);
				break;
			case "--mode":
				options.mode = next();
				break;
			case "--port":
				options.port = Number(next());
				break;
			case "--model":
				options.model = next();
				break;
			case "--record":
				options.record = path.resolve(next());
				break;
			case "--heartbeat":
				options.heartbeat = Number(next());
				break;
			case "--mailbox":
				options.mailbox = path.resolve(next());
				break;
			case "--answer-timeout":
				options.answerTimeout = Number(next());
				break;
			case "--clip":
				options.clip = Number(next());
				break;
			case "--delay":
				options.delay = Number(next());
				break;
			case "--echo-limit":
				options.echoLimit = Number(next());
				break;
			case "--script":
				options.script = path.resolve(next());
				break;
			case "--script-loop":
				options.scriptLoop = true;
				break;
			case "--replay":
				options.replay = path.resolve(next());
				break;
			case "--agent-command":
				options.agentCommand = next();
				break;
			case "--agent-model":
				options.agentModel = next();
				break;
			case "--agent-concurrency":
				options.agentConcurrency = Number(next());
				break;
			case "--agent-timeout":
				options.agentTimeout = Number(next());
				break;
			case "--agent-cwd":
				options.agentCwd = path.resolve(next());
				break;
			case "--quiet":
				options.quiet = true;
				break;
			default:
				throw new Error(`知らないオプションです: ${flag}`);
		}
	}
	return options;
}

export function buildBackend(options) {
	switch (options.mode) {
		case "echo":
			return new EchoBackend({ delayMs: options.delay ?? 0, limit: options.echoLimit ?? 200 });
		case "live":
			return new LiveBackend({
				mailbox: options.mailbox,
				answerTimeoutSec: options.answerTimeout,
				clipChars: options.clip,
			});
		case "script":
			if (!options.script) throw new Error("--mode script には --script <ファイル> が要ります");
			return new ScriptBackend({ file: options.script, loop: options.scriptLoop });
		case "replay":
			if (!options.replay) throw new Error("--mode replay には --replay <ファイル> が要ります");
			return new ReplayBackend({ file: options.replay });
		case "agent": {
			// 翻訳役に、この作業場のファイルを見せない。素の翻訳者として振る舞わせるため
			const cwd = options.agentCwd ?? path.join(options.mailbox, "agent-cwd");
			fs.mkdirSync(cwd, { recursive: true });
			return new AgentBackend({
				command: options.agentCommand,
				model: options.agentModel,
				concurrency: options.agentConcurrency,
				timeoutSec: options.agentTimeout,
				cwd,
			});
		}
		default:
			throw new Error(`知らないモードです: ${options.mode}（echo / live / script / replay / agent）`);
	}
}

function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error.message}\n\n${USAGE}`);
		process.exit(2);
	}

	if (options.mode === "live") fs.mkdirSync(options.mailbox, { recursive: true });

	let backend;
	try {
		backend = buildBackend(options);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}

	const log = options.quiet ? () => {} : (message) => process.stderr.write(`[shim] ${message}\n`);
	const server = createShimServer({
		backend,
		model: options.model,
		recordFile: options.record,
		heartbeatSec: options.heartbeat,
		log,
	});

	server.listen(options.port, "127.0.0.1", () => {
		const port = server.address().port;
		// 1行目は機械が読む。起動スクリプトはここからポートを拾う
		process.stdout.write(`PORT=${port}\n`);
		log(`${options.mode} モードで待ち受けます: http://127.0.0.1:${port}/v1`);
		if (options.mode === "live") log(`郵便受け: ${options.mailbox}`);
		if (options.record) log(`録音: ${options.record}`);
	});

	const shutdown = () => {
		log(`受けた要求: ${JSON.stringify(server.stats())}`);
		server.close(() => process.exit(0));
		// 開いたままの接続があっても、待たせすぎない
		setTimeout(() => process.exit(0), 2000).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main();
}
