/**
 * JSON テキストの中で、どのキーがどの位置に書かれているかだけを測る。
 *
 * `JSON.parse` は値しか返さないので、位置を知りたい側は自前で走る必要がある。
 * ここが返す位置を使うと、**触ったキーの値だけを差し替えて、それ以外のバイト列を
 * 1バイトも動かさずに**書き換えられる。組み直し（`JSON.stringify`）は書き方の癖を
 * すべて既定へ倒すので、1項目の変更で無関係な行まで差分になり、合流でぶつかる。
 *
 * 対象は `JSON.parse` が通るテキストだけである（コメントも末尾カンマも無い）。
 * 呼び出し側は必ず `JSON.parse` で検証してから渡す。
 * VS Code API 非依存（単体テスト対象）。
 */

/** オブジェクトの中の1メンバー（`"key": value`）の位置 */
export interface JsonMember {
	key: string;
	/** 直前の `{` か、ひとつ前のメンバーを閉じたカンマの直後（前の空白・改行を含む起点） */
	sepStart: number;
	/** キーの開き `"` の位置 */
	keyStart: number;
	/** 値の開始位置 */
	valueStart: number;
	/** 値の終端の次の位置 */
	valueEnd: number;
}

/** オブジェクト1つ分の位置 */
export interface JsonObjectSpan {
	/** `{` の位置 */
	start: number;
	/** `}` の次の位置 */
	end: number;
	members: JsonMember[];
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** 空白を読み飛ばした先の位置を返す */
export function skipWhitespace(text: string, index: number): number {
	let i = index;
	while (i < text.length && WHITESPACE.has(text[i])) {
		i++;
	}
	return i;
}

/** 文字列リテラルの終端の次の位置を返す（`text[index]` が `"` であること） */
function skipString(text: string, index: number): number {
	let i = index + 1;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === '"') {
			return i + 1;
		}
		i++;
	}
	throw new SyntaxError("Unterminated string in JSON text");
}

/** 値の終端の次の位置を返す（`index` は値の先頭） */
function skipValue(text: string, index: number): number {
	const c = text[index];
	if (c === '"') {
		return skipString(text, index);
	}
	if (c === "{" || c === "[") {
		let i = index;
		let depth = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === '"') {
				i = skipString(text, i);
				continue;
			}
			if (ch === "{" || ch === "[") {
				depth++;
			} else if (ch === "}" || ch === "]") {
				depth--;
				if (depth === 0) {
					return i + 1;
				}
			}
			i++;
		}
		throw new SyntaxError("Unterminated object or array in JSON text");
	}
	// 数値 / true / false / null
	let i = index;
	while (i < text.length && !WHITESPACE.has(text[i]) && text[i] !== "," && text[i] !== "}" && text[i] !== "]") {
		i++;
	}
	if (i === index) {
		throw new SyntaxError("Expected a JSON value");
	}
	return i;
}

/**
 * `{` から始まるオブジェクトを走り、メンバーの位置を並べて返す。
 * @param start `{` の位置
 */
export function scanObject(text: string, start: number): JsonObjectSpan {
	if (text[start] !== "{") {
		throw new SyntaxError("Expected '{'");
	}
	const members: JsonMember[] = [];
	let i = start + 1;
	let sepStart = i;
	for (;;) {
		const keyStart = skipWhitespace(text, i);
		if (text[keyStart] === "}") {
			return { start, end: keyStart + 1, members };
		}
		if (text[keyStart] !== '"') {
			throw new SyntaxError("Expected a JSON object key");
		}
		const keyEnd = skipString(text, keyStart);
		const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
		const colon = skipWhitespace(text, keyEnd);
		if (text[colon] !== ":") {
			throw new SyntaxError("Expected ':' after a JSON object key");
		}
		const valueStart = skipWhitespace(text, colon + 1);
		const valueEnd = skipValue(text, valueStart);
		members.push({ key, sepStart, keyStart, valueStart, valueEnd });
		const after = skipWhitespace(text, valueEnd);
		if (text[after] === ",") {
			i = after + 1;
			sepStart = i;
			continue;
		}
		if (text[after] === "}") {
			return { start, end: after + 1, members };
		}
		throw new SyntaxError("Expected ',' or '}' in a JSON object");
	}
}

/** ルートのオブジェクトを走る（先頭の空白は読み飛ばす） */
export function scanRootObject(text: string): JsonObjectSpan {
	return scanObject(text, skipWhitespace(text, 0));
}

/** メンバーを名前で引く */
export function findMember(span: JsonObjectSpan, key: string): JsonMember | undefined {
	return span.members.find((member) => member.key === key);
}
