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
	| "anchor-not-found";

/** パッチ適用の結果。成功なら適用後テキスト、失敗なら理由を持つ */
export type PatchApplyResult =
	| { ok: true; text: string }
	| { ok: false; reason: PatchFailureReason };

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
