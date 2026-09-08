/**
 * mdait.json のテキストをキー単位で更新・削除する純粋ロジック。
 * 既存キーの順序・インデント文字・末尾改行を保持する。
 * ファイル I/O は行わない（呼び出し側 = settings-panel / markers-migration の責務）。
 * mdait.json を書き換えるコードは必ずここを経由し、ファイル全体の再整形を起こさない。
 * VS Code API 非依存（単体テスト対象）。
 *
 * **書き換えるのは触ったキーの値だけで、他のバイト列は1バイトも動かさない。**
 * かつては `JSON.parse` → 書き換え → `JSON.stringify` と組み直していたため、1項目の
 * 変更でインライン配列が展開された。実測（人が手で書いた15行の設定で `sync.level` を
 * 1つ変える）: **15行が57行に膨らみ、git の差分が 52 追加 / 10 削除**。設定ファイルは
 * git 管理下にあるので、その差分はそのまま他人の変更とぶつかる火種になる
 * （docs/design/merge-resilience.md）。
 *
 * 位置を測る係は `json-text-locator.ts` に分けてある。差し替えたあとは必ず読み直して、
 * 組み直しで得られるはずの値と一致するか確かめ、**食い違ったら組み直しへ落とす** —
 * 位置合わせを外すくらいなら、行が動いても正しい JSON を書くほうがましである。
 */
import { detectDocumentStyle } from "../../core/markdown/document-style";
import { type JsonObjectSpan, findMember, scanObject, scanRootObject } from "./json-text-locator";


/**
 * JSON テキストからインデント文字列を検出する。
 * 最初にインデントされた行のインデントを採用し、見つからなければ 2 スペースを返す。
 */
export function detectIndent(text: string): string {
	const match = text.match(/^([ \t]+)\S/m);
	return match ? normalizeIndentUnit(match[1]) : "  ";
}

/** 検出したインデント（深さ N 段の可能性がある）を 1 段分の単位に正規化する */
function normalizeIndentUnit(indent: string): string {
	if (indent.startsWith("\t")) {
		return "\t";
	}
	// スペースの場合、トップレベル直下の 1 段目にマッチしている想定だが、
	// 深い行にマッチした場合に備えて 2 または 4 の約数に丸める
	if (indent.length % 4 === 0 && indent.length > 4) {
		return "    ";
	}
	if (indent.length % 2 === 0 && indent.length > 2) {
		return "  ";
	}
	return indent;
}

/**
 * JSON テキストの指定パスへ値を設定した新しいテキストを返す。
 * 中間オブジェクトが存在しない場合は作成する。
 * @throws JSON として不正なテキストの場合
 */
export function setConfigValue(
	text: string,
	path: string[],
	value: unknown,
): string {
	if (path.length === 0) {
		throw new Error("Empty setting path");
	}
	const root = parseObject(text);
	let node = root;
	for (const key of path.slice(0, -1)) {
		const child = node[key];
		if (child === undefined || child === null || typeof child !== "object" || Array.isArray(child)) {
			const created: Record<string, unknown> = {};
			node[key] = created;
			node = created;
		} else {
			node = child as Record<string, unknown>;
		}
	}
	node[path[path.length - 1]] = value;
	return editLocally(text, () => setValueInPlace(text, path, value), root);
}

/**
 * JSON テキストから指定パスのキーを削除した新しいテキストを返す。
 * 削除の結果空になった親オブジェクトは（ルートを除き）刈り取る。
 * パスが存在しない場合は元のテキストをそのまま返す。
 * @throws JSON として不正なテキストの場合
 */
export function removeConfigValue(text: string, path: string[]): string {
	if (path.length === 0) {
		throw new Error("Empty setting path");
	}
	const root = parseObject(text);
	const parents: Record<string, unknown>[] = [root];
	let node = root;
	for (const key of path.slice(0, -1)) {
		const child = node[key];
		if (child === undefined || child === null || typeof child !== "object" || Array.isArray(child)) {
			return text; // パスが存在しない
		}
		node = child as Record<string, unknown>;
		parents.push(node);
	}
	const leafKey = path[path.length - 1];
	if (!(leafKey in node)) {
		return text;
	}
	delete node[leafKey];
	// 空になった親オブジェクトをルートに向かって刈り取る
	let removedPath = path;
	for (let i = parents.length - 1; i >= 1; i--) {
		if (Object.keys(parents[i]).length === 0) {
			delete parents[i - 1][path[i - 1]];
			removedPath = path.slice(0, i);
		} else {
			break;
		}
	}
	return editLocally(text, () => removeValueInPlace(text, removedPath), root);
}

function parseObject(text: string): Record<string, unknown> {
	const parsed = JSON.parse(text) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Configuration root must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/**
 * 元テキストのインデント・改行コード・末尾改行を引き継いで stringify する。
 *
 * 改行コードを引き継がないと、**Windows で書かれた設定ファイルが1項目の変更で全行 LF へ
 * 倒れる**（`JSON.stringify` は必ず LF で書く）。この形は原稿では `managed-write` が
 * 防いでいるが、`.mdait/` の中はその対象外なので、ここで同じことをする。
 */
function stringifyLike(originalText: string, value: unknown): string {
	const indent = detectIndent(originalText);
	const eol = detectDocumentStyle(originalText).eol;
	const serialized = JSON.stringify(value, null, indent);
	const body = eol === "\r\n" ? serialized.replace(/\n/g, "\r\n") : serialized;
	return originalText.endsWith("\n") ? `${body}${eol}` : body;
}

/**
 * 局所的な書き換えを試し、結果が組み直しと同じ値になったときだけ採る。
 *
 * @param text 元のテキスト
 * @param edit 局所的な書き換え（位置が合わなければ投げてよい）
 * @param expected 組み直しで得られるはずの値
 */
function editLocally(text: string, edit: () => string, expected: Record<string, unknown>): string {
	try {
		const edited = edit();
		if (JSON.stringify(JSON.parse(edited)) === JSON.stringify(expected)) {
			return edited;
		}
	} catch {
		// 位置を測れなかった。組み直しへ落とす
	}
	return stringifyLike(text, expected);
}

/** 書き方の癖（インデント1段分と改行コード） */
interface TextStyle {
	indent: string;
	eol: string;
}

function detectStyle(text: string): TextStyle {
	return { indent: detectIndent(text), eol: detectDocumentStyle(text).eol };
}

/**
 * 値を JSON にする。`depth` はそのキーの前に入るインデントの段数。
 * `inline` なら1行に収める（元が1行で書かれていた値を、行を増やさずに差し替えるため）。
 */
function renderValue(value: unknown, depth: number, style: TextStyle, inline: boolean): string {
	if (inline) {
		return JSON.stringify(value) ?? "null";
	}
	const serialized = JSON.stringify(value, null, style.indent) ?? "null";
	const padded = serialized.split("\n").join(`\n${style.indent.repeat(depth)}`);
	return style.eol === "\r\n" ? padded.split("\n").join("\r\n") : padded;
}

/** 残りのキーを入れ子のオブジェクトに畳む（`keys[0]` に載せる値を返す） */
function nestRemaining(keys: readonly string[], value: unknown): unknown {
	let nested = value;
	for (let i = keys.length - 1; i >= 1; i--) {
		nested = { [keys[i]]: nested };
	}
	return nested;
}

/** 指定パスへ値を書く（触るのはそのキーの値だけ） */
function setValueInPlace(text: string, path: string[], value: unknown): string {
	const style = detectStyle(text);
	let span: JsonObjectSpan = scanRootObject(text);
	let depth = 1;
	for (let i = 0; i < path.length; i++) {
		const member = findMember(span, path[i]);
		if (!member) {
			return insertMember(text, span, path[i], nestRemaining(path.slice(i), value), depth, style);
		}
		if (i === path.length - 1) {
			const wasInline = !text.slice(member.valueStart, member.valueEnd).includes("\n");
			const rendered = renderValue(value, depth, style, wasInline);
			return text.slice(0, member.valueStart) + rendered + text.slice(member.valueEnd);
		}
		if (text[member.valueStart] !== "{") {
			// 途中のキーがオブジェクトではない。作り直しが要るので組み直しへ落とす
			throw new Error("Intermediate value is not an object");
		}
		span = scanObject(text, member.valueStart);
		depth++;
	}
	throw new Error("Empty setting path");
}

/** オブジェクトの末尾へメンバーを1つ足す */
function insertMember(
	text: string,
	span: JsonObjectSpan,
	key: string,
	value: unknown,
	depth: number,
	style: TextStyle,
): string {
	// 元が1行で書かれているオブジェクトには1行のまま足す（行数を増やさない）
	const objectIsInline = !text.slice(span.start, span.end).includes("\n");
	const rendered = `${JSON.stringify(key)}: ${renderValue(value, depth, style, objectIsInline)}`;
	if (span.members.length === 0) {
		const inner = objectIsInline
			? ` ${rendered} `
			: `${style.eol}${style.indent.repeat(depth)}${rendered}${style.eol}${style.indent.repeat(depth - 1)}`;
		return text.slice(0, span.start + 1) + inner + text.slice(span.end - 1);
	}
	const last = span.members[span.members.length - 1];
	const separator = objectIsInline ? ", " : `,${style.eol}${style.indent.repeat(depth)}`;
	return text.slice(0, last.valueEnd) + separator + rendered + text.slice(last.valueEnd);
}

/** 指定パスのメンバーを消す（触るのはその1メンバーとその区切りだけ） */
function removeValueInPlace(text: string, path: readonly string[]): string {
	let span: JsonObjectSpan = scanRootObject(text);
	for (let i = 0; i < path.length; i++) {
		const member = findMember(span, path[i]);
		if (!member) {
			throw new Error("Setting path not found");
		}
		if (i === path.length - 1) {
			const index = span.members.indexOf(member);
			if (span.members.length === 1) {
				// 唯一のメンバーだった。空のオブジェクトに畳む（中の空白ごと落とす）
				return text.slice(0, span.start + 1) + text.slice(span.end - 1);
			}
			if (index > 0) {
				// ひとつ前のメンバーの終端から自分の終端まで（＝手前のカンマごと）落とす
				return text.slice(0, span.members[index - 1].valueEnd) + text.slice(member.valueEnd);
			}
			// 先頭のメンバー。自分の起点から次のメンバーの起点まで（＝後ろのカンマごと）落とす
			return text.slice(0, member.sepStart) + text.slice(span.members[index + 1].sepStart);
		}
		if (text[member.valueStart] !== "{") {
			throw new Error("Intermediate value is not an object");
		}
		span = scanObject(text, member.valueStart);
	}
	throw new Error("Empty setting path");
}
