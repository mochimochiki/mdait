/**
 * mdait.json のテキストをキー単位で更新・削除する純粋ロジック。
 * 既存キーの順序・インデント文字・末尾改行を保持する。
 * ファイル I/O は行わない（呼び出し側 = settings-panel の責務）。
 * VS Code API 非依存（単体テスト対象）。
 */

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
	return stringifyLike(text, root);
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
	for (let i = parents.length - 1; i >= 1; i--) {
		if (Object.keys(parents[i]).length === 0) {
			delete parents[i - 1][path[i - 1]];
		} else {
			break;
		}
	}
	return stringifyLike(text, root);
}

function parseObject(text: string): Record<string, unknown> {
	const parsed = JSON.parse(text) as unknown;
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Configuration root must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** 元テキストのインデント・末尾改行スタイルを引き継いで stringify する */
function stringifyLike(originalText: string, value: unknown): string {
	const indent = detectIndent(originalText);
	const serialized = JSON.stringify(value, null, indent);
	return originalText.endsWith("\n") ? `${serialized}\n` : serialized;
}
