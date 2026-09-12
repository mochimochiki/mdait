/**
 * @file conflict-sections.ts
 * @description
 *   競合マーカーの入ったファイルから、**両側と共通の祖先を丸ごと切り出す**（roadmap-v04 P02）。
 *
 *   切り出すのは「競合ブロックの中の行」ではなく、**それぞれの陣営から見た完全なファイル**で
 *   ある。理由は、対象ごとに読み方が違うからである — TMX は XML、用語集は CSV か YAML、
 *   `unit-state` は TSV。ブロックの中を行として渡すと、引用符の中に改行を持つ CSV の値や
 *   XML の入れ子を、この係が知らないまま切り刻むことになる。**完全なファイルを3つ作って、
 *   それぞれを本物のパーサーに通せば、どの形式でも正しく読める。**
 *
 *   ```
 *   <<<<<<< HEAD          ← 自分の側（ours）が始まる
 *   ...
 *   ||||||| base          ← diff3 形式のときだけ。共通の祖先
 *   ...
 *   =======
 *   ...
 *   >>>>>>> theirs        ← 相手の側（theirs）が終わる
 *   ```
 *
 *   共通の祖先が取れるのは diff3 形式のときだけである（`merge.conflictStyle` が `diff3` か
 *   `zdiff3`）。取れなければ `base` は `undefined` で、判定の材料が1つ減るだけで先へ進める。
 *
 * @module core/conflict/conflict-sections
 */

/** 競合ブロック1つ（レポートと Hover で「どこが」を言うために位置も持つ） */
export interface ConflictSection {
	/** ファイルの先頭からの行番号（0始まり）。`<<<<<<<` の行 */
	startLine: number;
	/** `>>>>>>>` の行 */
	endLine: number;
	/** 自分の側の行 */
	ours: string[];
	/** 相手の側の行 */
	theirs: string[];
	/** 共通の祖先の行（diff3 形式のときだけ） */
	base?: string[];
}

/** 競合マーカーの入ったファイルを解いた結果 */
export interface ConflictedFileSides {
	/** 競合ブロックがあったか */
	conflicted: boolean;
	/** 自分の側から見た完全なファイル */
	ours: string;
	/** 相手の側から見た完全なファイル */
	theirs: string;
	/** 共通の祖先から見た完全なファイル（diff3 形式で、全ブロックが祖先を持つときだけ） */
	base?: string;
	/** 競合ブロックの一覧 */
	sections: ConflictSection[];
}

/** 7文字ちょうどで始まる競合マーカーの行か（見出しの下線や引用と取り違えないため） */
function markerKind(line: string): "ours" | "base" | "sep" | "theirs" | undefined {
	if (!/^(<{7}|\|{7}|={7}|>{7})(\s|$)/.test(line)) {
		return undefined;
	}
	switch (line[0]) {
		case "<":
			return "ours";
		case "|":
			return "base";
		case "=":
			return "sep";
		default:
			return "theirs";
	}
}

/**
 * 競合マーカーの入ったファイルから、両側と（あれば）共通の祖先を切り出す。
 *
 * **読むだけで、1バイトも書かない。** 閉じていない競合ブロック（手で直しかけて途中で
 * やめたファイル）は、そこまでに読めた分を採って終わる — 壊れた入力で例外を投げると、
 * 解決の経路そのものが使えなくなるからである。
 */
export function splitConflictedFile(content: string): ConflictedFileSides {
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingEol = content.endsWith("\n");
	const lines = content.split(/\r?\n/);
	const body = hadTrailingEol ? lines.slice(0, -1) : lines;

	const ours: string[] = [];
	const theirs: string[] = [];
	const base: string[] = [];
	const sections: ConflictSection[] = [];
	/** 共通の祖先が1つでも欠けたら、祖先の全文は組み立てられない */
	let everySectionHasBase = true;

	let state: "plain" | "ours" | "base" | "theirs" = "plain";
	let current: ConflictSection | undefined;

	for (let i = 0; i < body.length; i++) {
		const line = body[i];
		const marker = markerKind(line);

		if (marker === "ours" && state === "plain") {
			state = "ours";
			current = { startLine: i, endLine: i, ours: [], theirs: [] };
			continue;
		}
		if (marker === "base" && state === "ours") {
			state = "base";
			if (current) {
				current.base = [];
			}
			continue;
		}
		if (marker === "sep" && (state === "ours" || state === "base")) {
			state = "theirs";
			continue;
		}
		if (marker === "theirs" && state === "theirs") {
			state = "plain";
			if (current) {
				current.endLine = i;
				if (!current.base) {
					everySectionHasBase = false;
				}
				sections.push(current);
				current = undefined;
			}
			continue;
		}

		switch (state) {
			case "plain":
				ours.push(line);
				theirs.push(line);
				base.push(line);
				break;
			case "ours":
				ours.push(line);
				current?.ours.push(line);
				break;
			case "base":
				base.push(line);
				current?.base?.push(line);
				break;
			case "theirs":
				theirs.push(line);
				current?.theirs.push(line);
				break;
		}
	}

	// 閉じていないブロックも、そこまで読めた分を採る（壊れた入力で解決の道を塞がない）
	if (current) {
		current.endLine = body.length - 1;
		everySectionHasBase = everySectionHasBase && current.base !== undefined;
		sections.push(current);
	}

	const join = (rows: string[]) => `${rows.join(eol)}${hadTrailingEol && rows.length > 0 ? eol : ""}`;
	return {
		conflicted: sections.length > 0,
		ours: join(ours),
		theirs: join(theirs),
		// 祖先を1つでも欠くと、組み立てた「祖先の全文」はどの版でもない別物になる
		base: sections.length > 0 && everySectionHasBase ? join(base) : undefined,
		sections,
	};
}
