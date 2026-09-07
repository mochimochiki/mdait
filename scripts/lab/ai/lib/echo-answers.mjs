/*
 * 偽の AI（echo）が「訳文以外」も答えられるようにする。
 *
 * mdait が AI へ投げる仕事は翻訳だけではない。用語を拾う・訳語を埋める・文の対を作る、
 * の3つは答えが **JSON の配列（またはオブジェクト）** で、訳文を1つ返すだけの echo では
 * 相手にならなかった。そのせいで探索的検証（sweep）の P9・P10 は「増えないが、それは
 * 偽の AI の限界」という INFO で止まっていて、中身を確かめられていなかった。
 *
 * ここでは指示文（system）の言い回しから仕事の種類を見分け、**指示文と依頼文に実際に
 * 書かれている文字列だけを使って**答えを組み立てる。作り話を混ぜないのは、mdait 側に
 * 「用語は原文に出てくること」「文の対は原文・訳文の一部であること」という検査があり、
 * そこを通らないと結局0件になるため。
 *
 * 決まりごと（echo の約束）
 *   - 時刻も乱数も使わない。同じ要求には毎回同じ答えを返す
 *   - 分からない種類の仕事は null を返し、呼び出し側が従来どおり訳文を返す
 */

/** 用語（対訳あり）・用語（原文のみ）で使う、拾う語の上限 */
const MAX_TERMS = 3;

/** 文の対で使う、返す対の上限 */
const MAX_TM_PAIRS = 5;

/** 指示文（system）を1つの文字列にまとめて取り出す */
function systemText(messages) {
	return (messages || [])
		.filter((message) => message.role === "system")
		.map((message) => (Array.isArray(message.content) ? message.content.join("\n") : String(message.content ?? "")))
		.join("\n");
}

/** 最後の依頼文（user）を取り出す */
function userText(messages) {
	const last = [...(messages || [])].reverse().find((message) => message.role === "user");
	const raw = last?.content;
	return Array.isArray(raw) ? raw.join("\n") : typeof raw === "string" ? raw : "";
}

/** `開始` と `終了` に挟まれた部分を取り出す（見つからなければ空文字） */
function between(text, start, end) {
	const from = text.indexOf(start);
	if (from < 0) return "";
	const rest = text.slice(from + start.length);
	const to = end ? rest.indexOf(end) : -1;
	return (to < 0 ? rest : rest.slice(0, to)).trim();
}

/**
 * 何を頼まれているかを、指示文の言い回しから見分ける。
 *
 * 見ているのは `src/prompts/defaults.ts` の既定の指示文にしか出てこない言い回し。
 * 指示文を書き換えたときにここが古びたら、答えは翻訳（既定）に落ちるだけで、
 * 黙って嘘の答えを返すことはない。
 */
export function classifyEchoRequest(messages) {
	const system = systemText(messages);
	if (system.includes("<primaryLanguageUnit>")) return "tm-pairs";
	if (system.includes('"sourceTerm"')) {
		return system.includes('"targetTerm"') ? "term-detect-pairs" : "term-detect-source";
	}
	if (system.includes("mapping source terms to translated terms")) return "term-translate";
	if (system.includes("Extract term correspondences")) return "term-extract";
	return "translation";
}

/** 記号や飾りを落として、語として扱える形にする */
function cleanWord(word) {
	return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** 文らしい単位に切る（行と、日本語・英語の文末で切る） */
function splitSentences(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.flatMap((line) => line.split(/(?<=[。！？])|(?<=[.!?])\s+/))
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

/**
 * 用語として拾う語を選ぶ。
 *
 * 長い語から順に選ぶ（見出し記号や助詞のような短い語を避けるため）。同じ長さのときは
 * 先に出てきたほうを選び、並びが要求ごとに揺れないようにする。
 */
function pickTerms(text, limit = MAX_TERMS) {
	const seen = new Map();
	const words = String(text ?? "").split(/[\s、。,.:;!?()[\]{}<>"'`|/\\#*_-]+/);
	for (const raw of words) {
		const word = cleanWord(raw);
		if (word.length < 3) continue;
		if (!seen.has(word)) seen.set(word, seen.size);
	}
	return [...seen.entries()]
		.sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
		.slice(0, limit)
		.map(([word]) => word);
}

/** その語を含む1行を探す（用語の context に使う） */
function contextLineFor(text, term) {
	const line = String(text ?? "")
		.split(/\r?\n/)
		.map((one) => one.trim())
		.find((one) => one.includes(term));
	return line && line.length > 0 ? line : term;
}

/**
 * 依頼文に `- 用語` / `- **用語** (context: …)` の形で並んだ語を拾う。
 *
 * 訳語を埋める依頼には、語の一覧のあとに対訳の見本が続く（`From these translation pairs:`）。
 * 見本の中の箇条書きまで語として拾わないよう、そこで切る。
 */
function listedTerms(text) {
	const terms = [];
	const [head] = String(text ?? "").split("From these translation pairs:");
	for (const line of head.split(/\r?\n/)) {
		const matched = /^\s*-\s+(?:\*\*(.+?)\*\*|(.+?))\s*(?:\(context:.*)?$/.exec(line);
		if (!matched) continue;
		const term = cleanWord(matched[1] ?? matched[2] ?? "");
		if (term.length > 0 && !terms.includes(term)) terms.push(term);
	}
	return terms;
}

/** 訳語は「原語 + [MT]」。原語がそのまま残るので、どこから来た訳語かが一目で分かる */
function echoTermTranslation(term) {
	return `${term} [MT]`;
}

/** 用語を拾う仕事の答え（原文のみ／対訳あり） */
function answerTermDetect(messages, withTarget) {
	const system = systemText(messages);
	const material = withTarget
		? between(system, "### Translation Pairs", "### Output Format")
		: between(system, "### Source Text", "### Output Format");
	const terms = pickTerms(material);
	if (terms.length === 0) return "[]";
	return JSON.stringify(
		terms.map((term) => ({
			sourceTerm: term,
			...(withTarget ? { targetTerm: echoTermTranslation(term) } : {}),
			variants: [],
			context: contextLineFor(material, term),
		})),
	);
}

/** 訳語を埋める仕事の答え（原語 → 訳語の対応表） */
function answerTermMap(messages) {
	const terms = listedTerms(userText(messages));
	const map = {};
	for (const term of terms) map[term] = echoTermTranslation(term);
	return JSON.stringify(map);
}

/**
 * 文の対を作る仕事の答え。
 *
 * mdait 側の検査（`commands/tm/commit-processor.ts`）が厳しい。
 *   - 1行であること
 *   - 原文ユニット・訳文ユニットの**一部そのまま**であること
 *   - 短すぎる文は登録しない（日本語 8 文字・英語 12 文字より短いもの）
 * だから、原文から切り出した文が訳文のほうにもそのまま入っているものだけを返す。
 * echo の訳文は原文を1行に潰したものなので、たいていの文はそのまま見つかる。
 */
function answerTmPairs(messages) {
	const system = systemText(messages);
	const primaryUnit = between(system, "<primaryLanguageUnit>", "</primaryLanguageUnit>");
	const localUnit = between(system, "<localLanguageUnit>", "</localLanguageUnit>");
	const pairs = [];
	for (const sentence of splitSentences(primaryUnit)) {
		if (pairs.length >= MAX_TM_PAIRS) break;
		if (sentence.length < 12) continue;
		if (/^[\d,.\s-]+$/.test(sentence)) continue;
		if (!localUnit.includes(sentence)) continue;
		if (pairs.some((pair) => pair.primary === sentence)) continue;
		pairs.push({ type: "new", tuid: "-", primary: sentence, local: sentence });
	}
	return JSON.stringify(pairs);
}

/**
 * 翻訳以外の仕事なら、その形の答えを組み立てて返す。
 * 見分けが付かなければ null（呼び出し側が訳文を返す）。
 */
export function buildEchoAnswer(messages) {
	switch (classifyEchoRequest(messages)) {
		case "term-detect-source":
			return answerTermDetect(messages, false);
		case "term-detect-pairs":
			return answerTermDetect(messages, true);
		case "term-translate":
		case "term-extract":
			return answerTermMap(messages);
		case "tm-pairs":
			return answerTmPairs(messages);
		default:
			return null;
	}
}
