/*
 * 改訂ベンチの候補（バリアント）。
 *
 * 1つの候補は「指示文のテンプレート」と「返ってきた文字列をパッチに戻して当てる手順」の組。
 * 比べたいのは**出力の形式**なので、形式に関わらない部分（役割の説明・言語の縛り・
 * コードブロックの扱い・user-section）は全候補で**同じ文面**にしてある。ここを候補ごとに
 * 書き換えると、勝敗が形式の差なのか言い回しの差なのか分からなくなる。
 *
 * 例外は `current` だけで、これは本番の `DEFAULT_TRANS_REVISE_PATCH` を**そのまま**使う。
 * 基準線は写し取るのではなく現物でなければ意味がない（言い換えた時点で別物になる）。
 *
 * 各候補が持つもの:
 *   template          … `<!-- mdait:user-section -->` を含む完全なテンプレート
 *   parseEnvelope(raw)… モデルの生の答えからパッチ本文を取り出す（封筒を開ける）
 *   applyPatch(prev, patch) … 前回訳文にパッチを当てる
 *
 * 返す失敗理由は、本番の `PatchFailureReason` に合わせられるものは合わせてある
 * （`empty-patch` / `unrecognized-format` / `no-changes` / `anchor-not-found`）。
 * 候補固有の失敗はそれと重ならない名前を付ける。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

// out/ を読む前に vscode を差し替える。sweep.mjs と同じ手口
require(path.join(REPO, "scripts", "lab", "vscode-shim.js"));

const { DEFAULT_TRANS_REVISE_PATCH, USER_SECTION_MARKER } = require(path.join(REPO, "out", "prompts", "defaults.js"));
const { applySimplePatch } = require(path.join(REPO, "out", "core", "diff", "diff-generator.js"));
const { extractJsonFromResponse, detectJsonInContent } = require(
	path.join(REPO, "out", "commands", "trans", "response-validator.js"),
);
const { applyPatch: applyUnifiedDiff } = require("diff");

export { USER_SECTION_MARKER };

// ---------------------------------------------------------------------------
// 形式に関わらない共通部分（`current` 以外の全候補が共有する）
// ---------------------------------------------------------------------------

/**
 * 本番テンプレートの前置きと同じことを言う。文面も本番から写している
 * （形式の節だけを差し替えたいので、それ以外は動かさない）。
 */
const SHARED_HEAD = `You are a professional translator specializing in Markdown documents.

Your task is to update the previous translation to reflect changes made to the source text.

CRITICAL RULE (HIGHEST PRIORITY):
- You MUST preserve the original Markdown structure EXACTLY.
- Breaking Markdown structure is strictly forbidden.

ABSOLUTE LANGUAGE CONSTRAINT:
- All updated text MUST be written in the target language specified in the user message.

USER MESSAGE STRUCTURE:
The user message begins with a "Translation Direction" section (source / target / context languages), followed by reference sections (optionally Surrounding Text, Terminology, Translation Memory Reference, and always Previous Translation and Source Text Changes). Use them as instructed below; do NOT treat them as the text to patch.
A line containing only "=== SOURCE TEXT ===" marks the start of the current (revised) source text.

CODE BLOCKS:
- Code blocks in the source text appear as __CODE_BLOCK_PLACEHOLDER_n__, while the Previous Translation shows its code blocks in full. The two shapes describe the SAME code: this is an artifact of preparing the source text, not a source change.
- Never turn a code block into a placeholder or a placeholder into code, and never translate either form.
- Code blocks in the Surrounding Text section are collapsed to __CODE_BLOCK_OMITTED__; never copy that marker into your answer.

Instructions:
1. Update the PREVIOUS TRANSLATION so that it reflects the source changes.
2. Only change the parts required by the source diff. Keep unchanged parts intact.
3. Do NOT alter Markdown syntax, line breaks, or indentation.`;

/** 本番と同じ user-section。全候補で共通（差分は system 側にしかない） */
const SHARED_USER_SECTION = `Translation Direction:
- Source language: {{sourceLang}}
- Target language: {{targetLang}}
- Context language (for termSuggestions "context" quotes): {{contextLang}}
{{#surroundingText}}
Surrounding Text (for reference only, do NOT translate):
{{surroundingText}}
{{/surroundingText}}
{{#terms}}
Terminology (preferred translations):
{{terms}}
{{/terms}}
Previous Translation (target to patch):
{{previousTranslation}}
{{#tmReferences}}

## Translation Memory Reference

The following are past translations of similar sentences.
Use them as reference for consistency, but prioritize accuracy and context.

{{tmReferences}}
{{/tmReferences}}

Source Text Changes:
\`\`\`diff
{{sourceDiff}}
\`\`\``;

/** 行番号つき前回訳文を使う候補だけ、Previous Translation の見せ方を変える */
const NUMBERED_USER_SECTION = SHARED_USER_SECTION.replace(
	"Previous Translation (target to patch):\n{{previousTranslation}}",
	"Previous Translation (target to patch), with a line number and a tab before each line:\n{{numberedPreviousTranslation}}",
);

/** 素のテキストで返させる候補が共有する出力の約束 */
const PLAIN_TAIL = `
OUTPUT RULES:
1. Output the patch and nothing else.
2. Do NOT wrap your answer in a Markdown code block.
3. Do NOT write any explanation before or after the patch.
4. Do NOT output JSON.`;

/** 本文を丸ごと組み立てる */
function compose(formatSection, tail = PLAIN_TAIL, userSection = SHARED_USER_SECTION) {
	return `${SHARED_HEAD}\n\n${formatSection}\n${tail}\n${USER_SECTION_MARKER}\n${userSection}`;
}

// ---------------------------------------------------------------------------
// 封筒を開ける
// ---------------------------------------------------------------------------

/** 前後のコードフェンスを剥がす。モデルはよく ```…``` で包んでくる */
function stripFence(text) {
	const trimmed = text.trim();
	const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return match ? match[1] : trimmed;
}

/**
 * JSON の封筒（`current` 用）。本番と同じ道具で開ける。
 * @returns {{ok:true, patch:string} | {ok:false, reason:string, detail?:string}}
 */
function openJsonEnvelope(raw) {
	if (!raw || !raw.trim()) return { ok: false, reason: "empty-response" };
	let parsed;
	try {
		parsed = JSON.parse(extractJsonFromResponse(raw));
	} catch (error) {
		return { ok: false, reason: "envelope-broken", detail: String(error?.message ?? error) };
	}
	if (!parsed || typeof parsed !== "object" || typeof parsed.targetPatch !== "string") {
		return { ok: false, reason: "patch-missing" };
	}
	const nested = detectJsonInContent(parsed.targetPatch);
	if (nested?.detected) {
		return { ok: false, reason: "nested-json", detail: nested.pattern };
	}
	return { ok: true, patch: parsed.targetPatch };
}

/** 素のテキストの封筒。区切りがあれば中身を、無ければ全体をパッチとみなす */
function openPlainEnvelope(raw) {
	if (!raw || !raw.trim()) return { ok: false, reason: "empty-response" };
	const body = stripFence(raw);
	if (!body.trim()) return { ok: false, reason: "empty-patch" };
	// JSON を返してきたら、それは指示に従っていない（素のテキストを求めている）
	if (/^\s*\{\s*"[\w]+"\s*:/.test(body)) return { ok: false, reason: "unexpected-json" };
	return { ok: true, patch: body };
}

// ---------------------------------------------------------------------------
// 当てはめ
// ---------------------------------------------------------------------------

/** 標準 unified diff を当てる。`diff` パッケージの applyPatch をそのまま使う */
function applyUdiff(previous, patch) {
	const text = patch.trim();
	if (!text) return { ok: false, reason: "empty-patch" };
	// unified diff なら必ず @@ のハンクヘッダがある。無ければ別の書式で返している
	if (!/^@@ /m.test(text)) return { ok: false, reason: "unrecognized-format" };
	// 末尾に改行が無い diff は applyPatch が嫌がるので足しておく
	const normalized = text.endsWith("\n") ? text : `${text}\n`;
	for (const fuzz of [0, 2]) {
		const applied = applyUnifiedDiff(previous, normalized, { fuzzFactor: fuzz });
		if (applied !== false) return { ok: true, text: applied };
	}
	return { ok: false, reason: "anchor-not-found" };
}

/** SEARCH/REPLACE ブロックを当てる */
function applySearchReplace(previous, patch) {
	const text = patch.trim();
	if (!text) return { ok: false, reason: "empty-patch" };
	const blockPattern = /<<<<<<+ *SEARCH\s*\n([\s\S]*?)\n?======+\s*\n([\s\S]*?)\n?>>>>>>+ *REPLACE/g;
	const blocks = [...text.matchAll(blockPattern)];
	if (blocks.length === 0) return { ok: false, reason: "unrecognized-format" };

	let result = previous;
	for (const [, search, replace] of blocks) {
		if (search === replace) continue;
		if (search === "") return { ok: false, reason: "no-changes" };
		const at = result.indexOf(search);
		if (at === -1) {
			// 末尾の空白だけの食い違いは救う（本番の applySimplePatch と同じ寛容さ）。
			// **探した文字列と、切り出しに使う長さを必ず揃える** — 位置は末尾空白を
			// 落とした search で探すので、長さも落とした側で数えないと、差の分だけ
			// 後ろの文字を食う（SEARCH に空白が1つ紛れるだけで次の行と繋がる）
			const loose = result.replace(/[^\S\n]+$/gm, "");
			const looseSearch = search.replace(/[^\S\n]+$/gm, "");
			const looseAt = loose.indexOf(looseSearch);
			if (looseAt === -1) return { ok: false, reason: "search-not-found" };
			result = loose.slice(0, looseAt) + replace + loose.slice(looseAt + looseSearch.length);
			continue;
		}
		result = result.slice(0, at) + replace + result.slice(at + search.length);
	}
	if (result === previous) return { ok: false, reason: "no-changes" };
	return { ok: true, text: result };
}

/**
 * 行番号ベースの指示を当てる。
 *
 * REPLACE a-b / INSERT AFTER n / DELETE a-b の3つ。各ブロックは END で閉じる。
 * **前回訳文を1行も写させない**のがこの候補のねらいなので、当てはめ側も
 * 文字列の一致をいっさい見ない（行番号だけで決める）。
 */
function applyLineOps(previous, patch) {
	const text = patch.trim();
	if (!text) return { ok: false, reason: "empty-patch" };
	const lines = previous.split("\n");
	const ops = [];
	const tokens = text.split("\n");

	for (let at = 0; at < tokens.length; at += 1) {
		const head = tokens[at].trim();
		const replace = /^REPLACE\s+(\d+)\s*(?:-\s*(\d+))?$/i.exec(head);
		const insert = /^INSERT\s+AFTER\s+(\d+)$/i.exec(head);
		const remove = /^DELETE\s+(\d+)\s*(?:-\s*(\d+))?$/i.exec(head);
		if (!replace && !insert && !remove) continue;

		const body = [];
		let cursor = at + 1;
		while (cursor < tokens.length && tokens[cursor].trim().toUpperCase() !== "END") {
			body.push(tokens[cursor]);
			cursor += 1;
		}
		if (cursor >= tokens.length) return { ok: false, reason: "unterminated-block" };
		at = cursor;

		if (replace) {
			const from = Number(replace[1]);
			const to = replace[2] ? Number(replace[2]) : from;
			ops.push({ kind: "replace", from, to, body });
		} else if (insert) {
			ops.push({ kind: "insert", from: Number(insert[1]), to: Number(insert[1]), body });
		} else {
			const from = Number(remove[1]);
			const to = remove[2] ? Number(remove[2]) : from;
			ops.push({ kind: "delete", from, to, body: [] });
		}
	}

	if (ops.length === 0) return { ok: false, reason: "unrecognized-format" };

	for (const op of ops) {
		if (!Number.isInteger(op.from) || !Number.isInteger(op.to) || op.from < 1 || op.to < op.from) {
			return { ok: false, reason: "bad-range" };
		}
		// insert は末尾の後ろ（= 行数）まで許す。replace / delete は実在する行に限る
		const limit = op.kind === "insert" ? lines.length : lines.length;
		if (op.to > limit) return { ok: false, reason: "bad-range" };
	}

	// 後ろから当てる。前から当てると行番号がずれる
	const ordered = [...ops].sort((a, b) => b.from - a.from);
	const result = [...lines];
	for (const op of ordered) {
		if (op.kind === "replace") {
			result.splice(op.from - 1, op.to - op.from + 1, ...op.body);
		} else if (op.kind === "insert") {
			result.splice(op.from, 0, ...op.body);
		} else {
			result.splice(op.from - 1, op.to - op.from + 1);
		}
	}
	const text2 = result.join("\n");
	if (text2 === previous) return { ok: false, reason: "no-changes" };
	return { ok: true, text: text2 };
}

// ---------------------------------------------------------------------------
// 形式ごとの指示（ここだけが候補の違い）
// ---------------------------------------------------------------------------

const FORMAT_PREFIXED = `PATCH FORMAT:
Return a patch. Each line of the patch MUST start with exactly one of these prefixes:
  "="  context line — copied verbatim from the previous translation
  "-"  a line to remove
  "+"  a line to insert

Rules:
1. Show up to 3 lines of context before and after each change.
2. Put the prefix immediately before the content, with no space in between.
3. An empty context line is a line containing only "=".
4. Markdown content can itself start with "-" or "+" (list items, horizontal rules).
   You MUST still add the prefix:
     context list item: "=- item"
     remove list item:  "-- item"
     add list item:     "+- item"

EXAMPLE:
=## Features
=
=- Translation support
-- Sync support
+- Real-time sync
=- Term management`;

const FORMAT_UDIFF = `PATCH FORMAT:
Return a standard unified diff against the previous translation.

Rules:
1. Start each hunk with a header of the form "@@ -oldStart,oldCount +newStart,newCount @@".
2. Context lines start with a single space, removed lines with "-", added lines with "+".
3. Include up to 3 lines of context before and after each change.
4. Do NOT include "---" or "+++" file headers.
5. Line numbers refer to the previous translation, counting from 1.

EXAMPLE:
@@ -1,5 +1,5 @@
 ## Features

 - Translation support
-- Sync support
+- Real-time sync
 - Term management`;

const FORMAT_SEARCH_REPLACE = `PATCH FORMAT:
Return one or more SEARCH/REPLACE blocks. Each block has this exact shape:

<<<<<<< SEARCH
(text copied verbatim from the previous translation)
=======
(the text that should replace it)
>>>>>>> REPLACE

Rules:
1. The SEARCH text MUST match the previous translation character for character.
2. Keep the SEARCH text as short as possible while still being unique in the previous translation.
3. To insert new text, put the line it should follow in SEARCH, and that line plus the new text in REPLACE.
4. To delete text, leave the REPLACE side empty.
5. Emit one block per place that changes.

EXAMPLE:
<<<<<<< SEARCH
- Sync support
=======
- Real-time sync
>>>>>>> REPLACE`;

const FORMAT_LINE_OPS = `PATCH FORMAT:
The Previous Translation is shown with a line number and a tab at the start of every line.
Those numbers are NOT part of the text — never repeat them in your answer.

Return a list of edit blocks that refer to the previous translation BY LINE NUMBER.
You do not need to copy any existing line: name the lines and give the new text.

  REPLACE <from>-<to>      replace lines <from> through <to>
  (the new lines, without line numbers)
  END

  INSERT AFTER <n>         insert new lines directly after line <n>
  (the new lines, without line numbers)
  END

  DELETE <from>-<to>       delete lines <from> through <to>
  END

Rules:
1. Line numbers count from 1 and refer to the Previous Translation exactly as shown.
2. A single line is written as "REPLACE 7-7" or just "REPLACE 7".
3. Every block MUST be closed with a line containing only "END".
4. Blocks may be given in any order.

EXAMPLE (previous translation lines 1-4 are "## Features", "", "- Translation support", "- Sync support"):
REPLACE 4
- Real-time sync
END
INSERT AFTER 4
- Term management
END`;

const JSON_TAIL = `
Response Format:
Return ONLY valid JSON. Do NOT include markdown code blocks or explanations outside JSON.

{
  "targetPatch": "the patch text"
}

- The "targetPatch" field must contain ONLY the patch text, as plain text.
- Do NOT wrap the patch in code blocks and do NOT nest JSON inside it.
- Return ONLY valid JSON. Any extra text invalidates the response.`;

// ---------------------------------------------------------------------------
// 候補
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Variant
 * @property {string} id
 * @property {string} note
 * @property {string} template
 * @property {boolean} [numbered] 前回訳文に行番号を振って渡すか
 * @property {(raw:string)=>({ok:true,patch:string}|{ok:false,reason:string,detail?:string})} parseEnvelope
 * @property {(prev:string,patch:string)=>({ok:true,text:string}|{ok:false,reason:string})} applyPatch
 */

/** @type {Variant[]} */
export const VARIANTS = [
	{
		id: "current",
		note: "いまの本番。独自の =/-/+ 形式を JSON の targetPatch に詰める",
		template: DEFAULT_TRANS_REVISE_PATCH,
		parseEnvelope: openJsonEnvelope,
		applyPatch: applySimplePatch,
	},
	{
		id: "plain",
		note: "形式はいまのまま、JSON の封筒だけをやめる",
		template: compose(FORMAT_PREFIXED),
		parseEnvelope: openPlainEnvelope,
		applyPatch: applySimplePatch,
	},
	{
		id: "udiff",
		note: "標準の unified diff。モデルが訓練でいちばん見ている形",
		template: compose(FORMAT_UDIFF),
		parseEnvelope: openPlainEnvelope,
		applyPatch: applyUdiff,
	},
	{
		id: "searchreplace",
		note: "SEARCH/REPLACE ブロック。文脈行数の規則が要らない",
		template: compose(FORMAT_SEARCH_REPLACE),
		parseEnvelope: openPlainEnvelope,
		applyPatch: applySearchReplace,
	},
	{
		id: "linenum",
		note: "行番号で指す。**前回訳文を1行も写させない**のがねらい",
		template: compose(FORMAT_LINE_OPS, PLAIN_TAIL, NUMBERED_USER_SECTION),
		numbered: true,
		parseEnvelope: openPlainEnvelope,
		applyPatch: applyLineOps,
	},
	{
		id: "udiff-json",
		note: "unified diff を JSON の封筒に入れる。封筒だけの効き目を測る対照",
		template: compose(FORMAT_UDIFF, JSON_TAIL),
		parseEnvelope: openJsonEnvelope,
		applyPatch: applyUdiff,
	},
];

/** 名前で絞る（`--variants current,linenum`） */
export function selectVariants(only) {
	if (!only) return VARIANTS;
	const wanted = String(only)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const picked = wanted.map((name) => {
		const found = VARIANTS.find((v) => v.id === name);
		if (!found) {
			throw new Error(
				`--variants に知らない名前が入っています: ${name}（使えるのは ${VARIANTS.map((v) => v.id).join(" / ")}）`,
			);
		}
		return found;
	});
	return picked;
}

export const INTERNAL = { applyUdiff, applySearchReplace, applyLineOps, openJsonEnvelope, openPlainEnvelope };
