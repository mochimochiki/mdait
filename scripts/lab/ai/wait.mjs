#!/usr/bin/env node
/*
 * 次の質問が来るまで待って、来たら要約の置き場所を1行出して終わる。
 *
 * エージェントは自分で眠って待つことができない。かわりに「終わったら呼び戻される」
 * 性質を使う。これをバックグラウンドで走らせておけば、質問が届いた時点でこれが終わり、
 * そこで呼び戻される。答えを書いたら、また同じものを起こし直す。これで1往復になる。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const options = { mailbox: path.join(HERE, "mailbox"), timeoutSec: 1800, intervalMs: 300 };
	for (let at = 0; at < argv.length; at += 1) {
		const flag = argv[at];
		if (flag === "--mailbox") options.mailbox = path.resolve(argv[++at]);
		else if (flag === "--timeout") options.timeoutSec = Number(argv[++at]);
		else if (flag === "--interval") options.intervalMs = Number(argv[++at]);
		else if (flag === "-h" || flag === "--help") {
			process.stdout.write("node scripts/byok-shim/wait.mjs [--mailbox DIR] [--timeout SEC] [--interval MS]\n");
			process.exit(0);
		} else {
			process.stderr.write(`知らないオプションです: ${flag}\n`);
			process.exit(2);
		}
	}
	return options;
}

/** まだ答えていない要求のうち、いちばん古いものの番号を返す */
export function findPending(mailbox) {
	if (!fs.existsSync(mailbox)) return undefined;
	const tags = fs
		.readdirSync(mailbox)
		.map((name) => /^req-(\d+)\.json$/.exec(name))
		.filter(Boolean)
		.map((match) => match[1])
		.sort();
	return tags.find((tag) => !fs.existsSync(path.join(mailbox, `res-${tag}.json`)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const deadline = Date.now() + options.timeoutSec * 1000;
	while (Date.now() < deadline) {
		const tag = findPending(options.mailbox);
		if (tag) {
			process.stdout.write(`${path.join(options.mailbox, `digest-${tag}.md`)}\n`);
			process.exit(0);
		}
		await sleep(options.intervalMs);
	}
	process.stderr.write(`${options.timeoutSec} 秒待ちましたが、答えるべき要求は来ませんでした\n`);
	process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main();
}
