/**
 * 新しく訳すユニットを、一定の分量までまとめて1回の依頼にする（ADR-261109-01）。
 *
 * 1ユニットずつ頼むと、同じ指示文を毎回送るうえ、AI は節1つ分しか見えない。
 * 実験では、約 2,500 字ずつまとめると入力が 3.5 分の1になり、章の中の見出しと相互参照の訳が揃った。
 * 区切りは章やファイルではなく **一度に渡す分量** で決める。
 *
 * ここは VS Code に依存しない。依頼の組み立てと答えの分解だけを持つ。
 */

/** まとまりの中で、ユニットの頭に置く区切りの行 */
export function unitSeparator(n: number): string {
	return `@@@ UNIT ${n} @@@`;
}

const SEPARATOR_LINE = /^@@@ UNIT (\d+) @@@[ \t]*$/;

/**
 * まとめてよいユニットを、ファイルの中で連続するものごとに、分量の上限まで束ねる。
 *
 * - `eligible` が偽のユニット（改訂など）はまとまりを切る。そのユニット自身はどのまとまりにも入らない。
 * - ファイルの中で隣り合っていないユニット（間に訳さないユニットがある）は、別のまとまりにする。
 *   間のユニットを飛ばして訳すと、AI が文の流れを取り違える。
 * - 1ユニットだけで上限を超えるものは、それだけで1つのまとまりにする。
 *
 * @param units 訳す順のユニット。`position` はファイルの中の位置（0始まり）
 * @param budget 1回に渡す原文の文字数の上限
 * @returns まとまりの並び（各要素は `units` の添字）。まとめないユニットは含まない
 */
export function planBatches(
	units: readonly { position: number; length: number; eligible: boolean }[],
	budget: number,
): number[][] {
	const batches: number[][] = [];
	let current: number[] = [];
	let size = 0;
	let lastPosition = Number.NaN;
	const flush = () => {
		if (current.length > 0) {
			batches.push(current);
		}
		current = [];
		size = 0;
	};
	units.forEach((unit, index) => {
		if (!unit.eligible) {
			flush();
			lastPosition = Number.NaN;
			return;
		}
		const adjacent = unit.position === lastPosition + 1;
		if (current.length > 0 && (!adjacent || size + unit.length > budget)) {
			flush();
		}
		current.push(index);
		size += unit.length;
		lastPosition = unit.position;
	});
	flush();
	return batches;
}

/** まとまりの原文を、区切りの行を挟んで1つの文にする */
export function joinBatchSource(texts: readonly string[]): string {
	return texts.map((text, i) => `${unitSeparator(i + 1)}\n${text}`).join("\n\n");
}

/**
 * AI の答えをユニットごとに分ける。分けられなければ `undefined`。
 *
 * - 区切りの行が 1, 2, …, n の順にそろっていること。
 * - **先頭の区切りだけが抜けた答えは受け入れる**（実測で、まとまりの約 3% がこの形で返った）。
 *   区切りの前に本文があり、残りが 2, …, n とそろっているなら、その本文を1つ目のユニットとみなす。
 * - どのユニットの訳も空でないこと。
 */
export function splitBatchResponse(text: string, count: number): string[] | undefined {
	const lines = text.split("\n");
	const parts: string[][] = [];
	const numbers: number[] = [];
	let head: string[] = [];
	for (const line of lines) {
		const m = SEPARATOR_LINE.exec(line.trimEnd());
		if (m) {
			numbers.push(Number(m[1]));
			parts.push([]);
			continue;
		}
		if (parts.length === 0) {
			head.push(line);
		} else {
			parts[parts.length - 1].push(line);
		}
	}
	const headText = head.join("\n").trim();
	if (numbers.length === count - 1 && headText !== "" && numbers.every((n, i) => n === i + 2)) {
		parts.unshift(head);
		numbers.unshift(1);
		head = [];
	}
	if (numbers.length !== count || !numbers.every((n, i) => n === i + 1)) {
		return undefined;
	}
	if (head.join("\n").trim() !== "") {
		// 1つ目の区切りの前に本文がある。どのユニットのものか決められない
		return undefined;
	}
	const out = parts.map((p) => p.join("\n").replace(/^\n+/, "").replace(/\s+$/, ""));
	if (out.some((p) => p.trim() === "")) {
		return undefined;
	}
	return out;
}
