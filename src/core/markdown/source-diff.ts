/**
 * @file source-diff.ts
 * @description
 *   原文の新旧を行単位で比較する純関数。`need:revise` のユニットで「原文のどこが変わったか」を
 *   見せるために使う（ADR-260802-03）。旧原文は `.mdait/unit-registry` に保存済みなので、
 *   AI を呼ばずに確定的な差分を出せる。
 *
 *   VS Code API 非依存・単体テスト可能。
 * @module core/markdown/source-diff
 */
import { diffLines } from "diff";

/** 差分の1行 */
export interface SourceDiffLine {
	/** added=新原文にだけある / removed=旧原文にだけある / context=両方にある */
	kind: "added" | "removed" | "context";
	text: string;
}

/** 差分計算のオプション */
export interface SourceDiffOptions {
	/** 変更行の前後に付ける文脈行数（既定 1） */
	contextLines?: number;
	/** 返す最大行数（既定 40）。超えた分は切り捨てる（`truncated` が true になる） */
	maxLines?: number;
	/** 比較する最大入力行数（既定 400）。これを超えたら差分を出さない（重い比較を避ける） */
	maxInputLines?: number;
}

/** 差分計算の結果 */
export interface SourceDiffResult {
	lines: SourceDiffLine[];
	/** 追加された行数（全体） */
	added: number;
	/** 削除された行数（全体） */
	removed: number;
	/** maxLines で切り捨てたか */
	truncated: boolean;
	/** 入力が大きすぎて比較しなかったか */
	tooLarge: boolean;
}

/** 空の結果 */
function emptyResult(tooLarge = false): SourceDiffResult {
	return { lines: [], added: 0, removed: 0, truncated: false, tooLarge };
}

/**
 * 旧原文と新原文の行差分を計算する。
 *
 * 変更行の周りだけを文脈つきで返す。ユニット1件ぶんの本文を想定した規模（数十行）で使う。
 */
export function diffSourceLines(oldText: string, newText: string, options: SourceDiffOptions = {}): SourceDiffResult {
	const contextLines = options.contextLines ?? 1;
	const maxLines = options.maxLines ?? 40;
	const maxInputLines = options.maxInputLines ?? 400;

	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	if (oldLines.length > maxInputLines || newLines.length > maxInputLines) {
		return emptyResult(true);
	}
	if (oldText === newText) {
		return emptyResult();
	}

	const full = buildDiff(oldLines, newLines);
	const added = full.filter((l) => l.kind === "added").length;
	const removed = full.filter((l) => l.kind === "removed").length;
	if (added === 0 && removed === 0) {
		return emptyResult();
	}

	const focused = keepChangedWithContext(full, contextLines);
	const truncated = focused.length > maxLines;
	return {
		lines: truncated ? focused.slice(0, maxLines) : focused,
		added,
		removed,
		truncated,
		tooLarge: false,
	};
}

/** 末尾の空行を落として行に分割する（改行コードの差は無視する） */
function splitLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

/**
 * 行差分を組み立てる。比較そのものは `diff` パッケージに委ね、ここは表示用の形へ変換する
 * （差分アルゴリズムを自前で持たない。既存の `core/diff/diff-generator` と同じ依存）。
 */
function buildDiff(oldLines: string[], newLines: string[]): SourceDiffLine[] {
	const result: SourceDiffLine[] = [];
	for (const part of diffLines(`${oldLines.join("\n")}\n`, `${newLines.join("\n")}\n`)) {
		const kind: SourceDiffLine["kind"] = part.added ? "added" : part.removed ? "removed" : "context";
		for (const text of part.value.replace(/\n$/, "").split("\n")) {
			result.push({ kind, text });
		}
	}
	return result;
}

/** 変更行とその前後 contextLines 行だけを残す */
function keepChangedWithContext(lines: SourceDiffLine[], contextLines: number): SourceDiffLine[] {
	const keep = new Set<number>();
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].kind === "context") {
			continue;
		}
		const from = Math.max(0, index - contextLines);
		const to = Math.min(lines.length - 1, index + contextLines);
		for (let k = from; k <= to; k++) {
			keep.add(k);
		}
	}
	return lines.filter((_, index) => keep.has(index));
}

/**
 * 差分を Markdown のコードフェンス（```diff）へ整形する。
 * 表示は Hover が担うが、整形自体は純関数として持つ（テスト可能にするため）。
 *
 * **フェンスの長さは中身に合わせて伸ばす。** 原文にコードブロック（```）が含まれるのは
 * ドキュメントでは普通であり、固定長のフェンスだとそこでブロックが閉じてしまう。
 * 閉じた先は Hover の `isTrusted` な Markdown として解釈されるため、
 * 原文の中身が表示崩れどころかコマンドリンクとして解釈され得る。
 */
export function formatSourceDiff(result: SourceDiffResult): string {
	if (result.lines.length === 0) {
		return "";
	}
	const body = result.lines
		.map((line) => {
			const prefix = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
			return `${prefix}${line.text}`;
		})
		.join("\n");
	const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
	return [`${fence}diff`, body, fence].join("\n");
}

/** テキスト中で連続するバッククォートの最大長 */
function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) {
		longest = Math.max(longest, match[0].length);
	}
	return longest;
}
