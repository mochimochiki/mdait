import { createPatch } from "diff";

/**
 * unified diff形式で差分を生成
 * @param oldContent 旧コンテンツ
 * @param newContent 新コンテンツ
 * @param fileName ファイル名（オプション、diff出力のヘッダに使用）
 * @returns unified diff文字列
 */
export function createUnifiedDiff(oldContent: string, newContent: string, fileName = "content"): string {
	return createPatch(fileName, oldContent, newContent, "", "", { context: 3 });
}

/**
 * 差分があるかどうかを判定
 * @param oldContent 旧コンテンツ
 * @param newContent 新コンテンツ
 * @returns true: 差分あり、false: 差分なし
 */
export function hasDiff(oldContent: string, newContent: string): boolean {
	return oldContent !== newContent;
}

/**
 * パッチ適用の失敗理由。
 *
 * 以前は失敗をすべて `null` に潰していたため、確認ダイアログにもレポートにも
 * 「なぜ失敗したのか」を出せなかった（AIが形式を守らなかったのか、原文が動いて
 * 目印が消えたのかで、利用者が取るべき次の一手は正反対になる）。
 */
export type PatchFailureReason =
	/** パッチが空（AIが何も返さなかった） */
	| "empty-patch"
	/** `=`/`-`/`+` 形式になっていない（AIが別の書式で返した） */
	| "unrecognized-format"
	/** 形式は合っているが変更行（`-`/`+`）が1つも無い */
	| "no-changes"
	/** 目印にする周辺行が訳文側に見つからない（訳文が手で編集された等） */
	| "anchor-not-found"
	/**
	 * 旧原文が手元に無く、差分そのものを作れなかった（パッチを試すまで行かなかった）。
	 * `applySimplePatch` は返さない。差分を作る前の段階で使う。
	 */
	| "no-source-diff"
	/** 行番号方式で、ブロックが `END` で閉じられていない */
	| "unterminated-block"
	/** 行番号方式で、指された行が訳文に存在しない（範囲外・逆順） */
	| "bad-range"
	/** 行番号方式で、指示どうしが同じ行を取り合っている（当てる順序で結果が変わる） */
	| "overlapping-ops";

/** パッチ適用の結果。成功なら適用後テキスト、失敗なら理由を持つ */
export type PatchApplyResult = { ok: true; text: string } | { ok: false; reason: PatchFailureReason };

/**
 * 改訂パッチの書き方。**推測させないための型**。
 *
 * `linenum` … 前回訳文に行番号を振って渡し、`REPLACE` / `INSERT AFTER` / `DELETE` で指させる。
 *             前回訳文を1行も写させないので、目印が Markdown とぶつかる問題を構造的に持たない。
 *             既定（ADR-260903-01）。
 * `prefixed` … 旧来の `=`/`-`/`+`。**利用者が指示文を上書きしているときだけ**使う
 *             （既存の上書きはこの形式に向けて書かれているため）。
 */
export type PatchFormat = "linenum" | "prefixed";

/**
 * 改訂パッチを当てる**唯一の入口**。
 *
 * **どちらの形式で読むかは引数で決まり、中身からは推測しない。** 推測させると、
 * 一方の形式のつもりで書かれた答えをもう一方として「読めてしまう」ことがある
 * （たとえば `prefixed` の当てはめ器はプレフィックスの無い行を黙って文脈行として扱うので、
 * 別形式のパッチでも当たったように見えて本文が壊れる）。
 */
export function applyRevisionPatch(baseContent: string, patch: string, format: PatchFormat): PatchApplyResult {
	return format === "linenum" ? applyLineNumberPatch(baseContent, patch) : applySimplePatch(baseContent, patch);
}

/** 行番号方式の1つの指示 */
interface LineOp {
	kind: "replace" | "insert" | "delete";
	/** 1始まりの開始行。`insert` は「この行の後ろへ」の意味で 0（先頭）も許す */
	from: number;
	/** 1始まりの終了行（`from` と同じなら1行だけ） */
	to: number;
	body: string[];
}

/**
 * 行番号方式のパッチを当てる。
 *
 *   REPLACE 12-14 / REPLACE 7   … その行を body で置き換える
 *   INSERT AFTER 20             … その行の後ろへ body を差し込む（0 は先頭）
 *   DELETE 30-31                … その行を消す
 *   各ブロックは END で閉じる
 *
 * 前回訳文を1行も写させないので、`anchor-not-found` という失敗の形が存在しない。
 * 代わりに数え間違いが `bad-range` として出る。
 */
export function applyLineNumberPatch(baseContent: string, patch: string): PatchApplyResult {
	const text = patch.trim();
	if (!text) return { ok: false, reason: "empty-patch" };

	const lines = baseContent.split("\n");
	const tokens = text.split("\n");
	const ops: LineOp[] = [];

	for (let at = 0; at < tokens.length; at += 1) {
		const head = tokens[at].trim();
		const replace = /^REPLACE\s+(\d+)\s*(?:-\s*(\d+))?$/i.exec(head);
		const insert = /^INSERT\s+AFTER\s+(\d+)$/i.exec(head);
		const remove = /^DELETE\s+(\d+)\s*(?:-\s*(\d+))?$/i.exec(head);
		if (!replace && !insert && !remove) continue;

		const body: string[] = [];
		let cursor = at + 1;
		while (cursor < tokens.length && tokens[cursor].trim().toUpperCase() !== "END") {
			body.push(tokens[cursor]);
			cursor += 1;
		}
		// 閉じ忘れを「残り全部が本文」として飲み込むと、訳文の末尾が丸ごと入れ替わる
		if (cursor >= tokens.length) return { ok: false, reason: "unterminated-block" };
		at = cursor;

		if (replace) {
			const from = Number(replace[1]);
			ops.push({ kind: "replace", from, to: replace[2] ? Number(replace[2]) : from, body });
		} else if (insert) {
			const from = Number(insert[1]);
			ops.push({ kind: "insert", from, to: from, body });
		} else if (remove) {
			const from = Number(remove[1]);
			ops.push({ kind: "delete", from, to: remove[2] ? Number(remove[2]) : from, body: [] });
		}
	}

	if (ops.length === 0) return { ok: false, reason: "unrecognized-format" };

	for (const op of ops) {
		if (!Number.isInteger(op.from) || !Number.isInteger(op.to) || op.to < op.from) {
			return { ok: false, reason: "bad-range" };
		}
		// 差し込みは「0 行目の後ろ」＝先頭を許す。置換と削除は実在する行だけ
		const lowest = op.kind === "insert" ? 0 : 1;
		if (op.from < lowest || op.to > lines.length) return { ok: false, reason: "bad-range" };
	}

	// **同じ行を2つの指示が取り合っていたら当てない。** 後ろから当てる実装なので、
	// 重なったまま進めると当てる順序で結果が変わる（黙って別の文書ができる）
	const spans = ops
		.filter((op) => op.kind !== "insert")
		.map((op) => ({ from: op.from, to: op.to }))
		.sort((a, b) => a.from - b.from);
	for (let at = 1; at < spans.length; at += 1) {
		if (spans[at].from <= spans[at - 1].to) return { ok: false, reason: "overlapping-ops" };
	}

	// 後ろから当てる。前から当てると、当てた分だけ後ろの行番号がずれる
	const ordered = [...ops].sort((a, b) => b.from - a.from);
	const result = [...lines];
	for (const op of ordered) {
		if (op.kind === "insert") {
			result.splice(op.from, 0, ...op.body);
		} else {
			result.splice(op.from - 1, op.to - op.from + 1, ...op.body);
		}
	}

	const applied = result.join("\n");
	if (applied === baseContent) return { ok: false, reason: "no-changes" };
	return { ok: true, text: applied };
}

/** 前回訳文に1始まりの行番号とタブを付ける（行番号方式でモデルへ渡す形） */
export function numberLinesForPatch(text: string): string {
	return text
		.split("\n")
		.map((line, at) => `${at + 1}\t${line}`)
		.join("\n");
}

/**
 * シンプルパッチを適用する。
 * `=`/`-`/`+` プレフィックス形式をサポート。複数チャンク対応。
 *
 * フォーマット:
 *   =コンテキスト行（`=`を除去した部分が元テキスト）
 *   -削除行
 *   +追加行
 *   =コンテキスト行
 *
 * @param baseContent パッチ適用対象の元テキスト
 * @param patch パッチ文字列
 * @returns 適用後のテキスト、または失敗理由
 */
export function applySimplePatch(baseContent: string, patch: string): PatchApplyResult {
	const trimmedPatch = patch.trim();
	if (!trimmedPatch) {
		return { ok: false, reason: "empty-patch" };
	}

	// Prefixed mode（=/-/+ 形式）
	if (!hasPrefixedContextLines(trimmedPatch)) {
		return { ok: false, reason: "unrecognized-format" };
	}

	const chunks = parsePrefixedPatchChunks(trimmedPatch);
	if (chunks.length === 0) {
		return { ok: false, reason: "no-changes" };
	}

	const applied = applyChunks(baseContent, chunks);
	if (applied === null) {
		return { ok: false, reason: "anchor-not-found" };
	}
	return { ok: true, text: applied };
}

interface SimplePatchChunk {
	contextBefore: string[];
	oldLines: string[];
	newLines: string[];
	contextAfter: string[];
}

/**
 * `=`プレフィックス付きコンテキスト行が存在するか判定する。
 * 1行でも`=`で始まる行があれば prefixed mode と見なす。
 */
function hasPrefixedContextLines(patch: string): boolean {
	const lines = patch.split("\n");
	return lines.some((line) => line.startsWith("="));
}

type LineClassification = { type: "context" | "old" | "new"; content: string };

/**
 * 分類済み行リストからチャンクを構築する共通ロジック。
 */
function buildChunksFromClassified(classified: LineClassification[]): SimplePatchChunk[] {
	type Range = { start: number; end: number };
	const changeRanges: Range[] = [];
	let rangeStart = -1;

	for (let i = 0; i < classified.length; i++) {
		const isChange = classified[i].type === "old" || classified[i].type === "new";
		if (isChange && rangeStart === -1) {
			rangeStart = i;
		} else if (!isChange && rangeStart !== -1) {
			changeRanges.push({ start: rangeStart, end: i - 1 });
			rangeStart = -1;
		}
	}
	if (rangeStart !== -1) {
		changeRanges.push({ start: rangeStart, end: classified.length - 1 });
	}

	if (changeRanges.length === 0) return [];

	const chunks: SimplePatchChunk[] = [];
	for (let r = 0; r < changeRanges.length; r++) {
		const range = changeRanges[r];
		const prevEnd = r > 0 ? changeRanges[r - 1].end + 1 : 0;
		const nextStart = r < changeRanges.length - 1 ? changeRanges[r + 1].start : classified.length;

		const contextBefore = classified.slice(prevEnd, range.start).map((c) => c.content);
		const contextAfter = classified.slice(range.end + 1, nextStart).map((c) => c.content);

		const oldLines: string[] = [];
		const newLines: string[] = [];
		for (let i = range.start; i <= range.end; i++) {
			if (classified[i].type === "old") oldLines.push(classified[i].content);
			if (classified[i].type === "new") newLines.push(classified[i].content);
		}

		chunks.push({ contextBefore, oldLines, newLines, contextAfter });
	}

	return chunks;
}

/**
 * Prefixed mode パーサー。
 * "=" = context、"-" = old、"+" = new。
 * 空行はコンテキストとして扱う（LLMが `=` プレフィックスを忘れるケース対応）。
 * プレフィックスのない非空行もコンテキストとして扱う（LLMの部分的な忘れ対応）。
 */
function parsePrefixedPatchChunks(patch: string): SimplePatchChunk[] {
	const lines = patch.split("\n");
	const classified: LineClassification[] = [];

	for (const line of lines) {
		if (line.startsWith("=")) {
			classified.push({ type: "context", content: line.slice(1) });
		} else if (line.startsWith("-")) {
			classified.push({ type: "old", content: line.slice(1) });
		} else if (line.startsWith("+")) {
			classified.push({ type: "new", content: line.slice(1) });
		} else {
			// 空行またはプレフィックスなし行 → コンテキスト
			classified.push({ type: "context", content: line });
		}
	}

	return buildChunksFromClassified(classified);
}

/**
 * チャンクリストを順に適用する。
 */
function applyChunks(baseContent: string, chunks: SimplePatchChunk[]): string | null {
	let result = baseContent;
	for (const chunk of chunks) {
		const applied = applySimplePatchChunk(result, chunk);
		if (applied === null) {
			return null;
		}
		result = applied;
	}
	return result;
}

/**
 * 1つのチャンクをベーステキストに適用する。
 *
 * Strategy 1: contextBefore末尾 + oldLines で精密マッチ
 * Strategy 2: contextBefore + contextAfter のアンカーだけで位置特定（old行が不正でも動く）
 */
function applySimplePatchChunk(baseContent: string, chunk: SimplePatchChunk): string | null {
	const { contextBefore, oldLines, newLines, contextAfter } = chunk;

	// --- Strategy 1: context + old lines で精密マッチ ---
	const matchContext = contextBefore.slice(-3);
	if (matchContext.length > 0 && oldLines.length > 0) {
		const searchBlock = [...matchContext, ...oldLines].join("\n");
		const replaceBlock = [...matchContext, ...newLines].join("\n");
		const idx = baseContent.indexOf(searchBlock);
		if (idx !== -1) {
			return baseContent.slice(0, idx) + replaceBlock + baseContent.slice(idx + searchBlock.length);
		}
		// fuzzyマッチ: 末尾空白を無視
		const normalizedBase = baseContent.replace(/[^\S\n]+$/gm, "");
		const normalizedSearch = searchBlock.replace(/[^\S\n]+$/gm, "");
		const fuzzyIdx = normalizedBase.indexOf(normalizedSearch);
		if (fuzzyIdx !== -1) {
			const originalEnd = fuzzyIdx + normalizedSearch.length;
			return baseContent.slice(0, fuzzyIdx) + replaceBlock + baseContent.slice(originalEnd);
		}
	}

	// --- Strategy 1b: insert-only（oldLines空、contextのみで位置特定） ---
	if (matchContext.length > 0 && oldLines.length === 0 && newLines.length > 0) {
		const anchorText = matchContext.join("\n");
		const idx = baseContent.indexOf(anchorText);
		if (idx !== -1) {
			const insertPos = idx + anchorText.length;
			return `${baseContent.slice(0, insertPos)}\n${newLines.join("\n")}${baseContent.slice(insertPos)}`;
		}
	}

	// --- Strategy 2: context-only アンカーマッチ ---
	// contextBefore末尾でSTART位置、contextAfter先頭でEND位置を特定
	const anchorBefore = contextBefore.slice(-3).join("\n");
	const anchorAfter = contextAfter.slice(0, 3).join("\n");

	if (anchorBefore) {
		const beforeIdx = baseContent.indexOf(anchorBefore);
		if (beforeIdx !== -1) {
			const gapStart = beforeIdx + anchorBefore.length;
			if (anchorAfter) {
				const afterIdx = baseContent.indexOf(anchorAfter, gapStart);
				if (afterIdx !== -1) {
					// anchorBefore と anchorAfter の間を newLines で置換
					return `${baseContent.slice(0, gapStart)}\n${newLines.join("\n")}\n${baseContent.slice(afterIdx)}`;
				}
			}
			// contextAfterが無い場合: oldLinesの行数分を置き換え
			if (oldLines.length > 0) {
				const baseLines = baseContent.split("\n");
				const gapLineIdx = baseContent.slice(0, gapStart).split("\n").length;
				const before = baseLines.slice(0, gapLineIdx);
				const after = baseLines.slice(gapLineIdx + oldLines.length);
				return [...before, ...newLines, ...after].join("\n");
			}
		}
	}

	return null;
}
