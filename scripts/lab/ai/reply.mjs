#!/usr/bin/env node
/*
 * 郵便受けに答えを置く。形が違っていればその場で教える。
 *
 *   node scripts/lab/ai/reply.mjs 001 --text "訳文"
 *   node scripts/lab/ai/reply.mjs 001 --json '{"text":"...","delay":3}'
 *   echo '{"text":"..."}' | node scripts/lab/ai/reply.mjs 001
 *   node scripts/lab/ai/reply.mjs --next --translation "訳文だけ渡す（JSONに包む）"
 *
 * --translation は mdait の trans が期待する {"translation": "..."} に包んでから渡す。
 * 手で JSON を書くと引用符の入れ子で必ず間違えるので、翻訳を返すときはこれを使う。
 */
import fs from "node:fs";
import path from "node:path";
import { validateReply } from "./lib/backends.mjs";
import { defaultMailbox } from "./lib/paths.mjs";
import { findPending } from "./wait.mjs";

function readStdin() {
	try {
		return fs.readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const options = { mailbox: defaultMailbox() };
	let tag;
	for (let at = 0; at < argv.length; at += 1) {
		const flag = argv[at];
		if (flag === "--mailbox") options.mailbox = path.resolve(argv[++at]);
		else if (flag === "--text") options.text = argv[++at];
		else if (flag === "--translation") options.translation = argv[++at];
		else if (flag === "--json") options.json = argv[++at];
		else if (flag === "--file") options.file = path.resolve(argv[++at]);
		else if (flag === "--next") options.next = true;
		else if (flag === "-h" || flag === "--help") {
			process.stdout.write(
				"node scripts/lab/ai/reply.mjs <番号|--next> [--text S | --translation S | --json S | --file F] [--mailbox DIR]\n",
			);
			process.exit(0);
		} else if (!flag.startsWith("--")) tag = flag;
		else {
			process.stderr.write(`知らないオプションです: ${flag}\n`);
			process.exit(2);
		}
	}

	if (options.next || !tag) {
		tag = findPending(options.mailbox);
		if (!tag) {
			process.stderr.write("答えるべき要求が郵便受けにありません\n");
			process.exit(1);
		}
	}
	tag = String(tag).padStart(3, "0");

	let reply;
	if (options.translation !== undefined) {
		reply = { text: JSON.stringify({ translation: options.translation, termSuggestions: [] }) };
	} else if (options.text !== undefined) {
		reply = { text: options.text };
	} else if (options.json !== undefined) {
		reply = JSON.parse(options.json);
	} else if (options.file) {
		reply = JSON.parse(fs.readFileSync(options.file, "utf8"));
	} else {
		const raw = readStdin().trim();
		if (!raw) {
			process.stderr.write("答えの中身がありません（--text / --translation / --json / --file / 標準入力）\n");
			process.exit(2);
		}
		reply = JSON.parse(raw);
	}

	const problem = validateReply(reply);
	if (problem) {
		process.stderr.write(`答えの形が違います: ${problem}\n`);
		process.exit(2);
	}

	// 途中まで書いたものを shim に読まれないよう、別名で書いてから置き換える
	const target = path.join(options.mailbox, `res-${tag}.json`);
	const temporary = `${target}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(reply, null, 2));
	fs.renameSync(temporary, target);
	process.stdout.write(`${target}\n`);
}

main().catch((error) => {
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
});
