/**
 * @file key-merge.ts
 * @description
 *   競合した2つの版を**鍵で突き合わせて、決められるものは決めてしまう**（roadmap-v04 P02）。
 *
 *   `merge=union` をやめた代償として、「2人が別々のものを足しただけ」も同じ挿入位置に
 *   入れば1つの競合ブロックになる（TM の実測で 16/20・18/20）。**この形を人の前に出しては
 *   いけない** — 二択で解かせると必ず片方が消える。
 *
 *   そこで、ブロックの中身ではなく**鍵**（語・tuid・席）で突き合わせる。鍵ごとに見れば、
 *   人にしか決められないのは「**同じ鍵に別の値**」だけで、それ以外は決定的に決まる。
 *
 *   | 形 | 決め方 |
 *   |---|---|
 *   | 片方にしか無い鍵 | **両方採る**（足したほうを採る） |
 *   | 同じ鍵・同じ値 | 1つに畳む |
 *   | 同じ鍵・片方だけが祖先から変えた | **変えたほうを採る**（3方向マージの基本） |
 *   | 同じ鍵・触った項目が別 | 項目単位で両方採る（`mergeFields` を渡したときだけ） |
 *   | 同じ鍵・同じ項目に別の値 | **決まらない**。AI か人が決める |
 *   | 片方が消し・片方が直した | **決まらない**。消した側は「消した」という印で見せる |
 *
 *   祖先が無いとき（diff3 形式でない合流）は「片方が消した」と「片方が足した」を見分け
 *   られない。**そのときは必ず両方を採る** — 消えて困るほうが、余って困るより重いからである。
 *
 * @module core/conflict/key-merge
 */

/** どちらの陣営か */
export type ConflictSide = "ours" | "theirs";

/** 鍵の付いた1件 */
export interface KeyedEntry<T> {
	key: string;
	value: T;
}

/** 決まらなかった1件（AI か人が決める） */
export interface UndecidedEntry<T> {
	key: string;
	ours: T;
	theirs: T;
	/** 共通の祖先（diff3 形式で取れたときだけ） */
	base?: T;
	/**
	 * **自分の側がこの鍵を消していた。** `ours` には祖先の値が入る（消した側に見せる値が
	 * 無いので、何を消したのかが読めるようにする）。この印が付いた件で `ours` を採るとは
	 * 「消したままにする」ことで、祖先の値を書き戻すことではない。
	 */
	oursDeleted?: boolean;
	/** **相手の側がこの鍵を消していた。** 意味は `oursDeleted` と同じ */
	theirsDeleted?: boolean;
}

/** 突き合わせた結果 */
export interface KeyMergeResult<T> {
	/** 決定的に決まったもの。鍵の順に並ぶ */
	resolved: KeyedEntry<T>[];
	/** 同じ鍵に別の値が来て、決まらなかったもの */
	undecided: UndecidedEntry<T>[];
	/** 祖先を見て「片方が消した」と判断して落としたもの */
	deleted: string[];
}

/** 突き合わせ方の指定 */
export interface KeyMergeOptions<T> {
	/** 2つの値が同じか（＝どちらを採っても結果が変わらないか） */
	sameValue(a: T, b: T): boolean;
	/**
	 * 同じ鍵の2つの値を、**項目単位で**合わせられるなら合わせる。
	 *
	 * 「同じ語の訳語を片方が、note をもう片方が直した」形がこれにあたる。二択で解かせると
	 * どちらかの編集が消えるが、触った項目が重なっていなければ両方を残せる。
	 * **重なっていたら `undefined` を返すこと** — そこは人にしか決められない。
	 */
	mergeFields?(ours: T, theirs: T, base: T | undefined): T | undefined;
}

/** 鍵で引ける表にする。同じ鍵が2度来たら**先に来たほうを残す**（呼び出し側が順を決める） */
function byKey<T>(entries: readonly KeyedEntry<T>[]): Map<string, T> {
	const map = new Map<string, T>();
	for (const entry of entries) {
		if (!map.has(entry.key)) {
			map.set(entry.key, entry.value);
		}
	}
	return map;
}

/** 文字列を符号位置の順で比べる（`localeCompare` は実行環境のロケールで答えが変わる） */
function compareCodePoints(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 2つの版を鍵で突き合わせる。
 *
 * **誰がどの順で合流させても同じ答えになる。** 結果は鍵の符号位置の順に並べ、
 * 「先に読んだほう」で結果が変わらないようにしてある。
 *
 * @param ours 自分の側
 * @param theirs 相手の側
 * @param base 共通の祖先（取れなかったときは `undefined`）
 */
export function mergeByKey<T>(
	ours: readonly KeyedEntry<T>[],
	theirs: readonly KeyedEntry<T>[],
	base: readonly KeyedEntry<T>[] | undefined,
	options: KeyMergeOptions<T>,
): KeyMergeResult<T> {
	const oursMap = byKey(ours);
	const theirsMap = byKey(theirs);
	const baseMap = base ? byKey(base) : undefined;

	const resolved: KeyedEntry<T>[] = [];
	const undecided: UndecidedEntry<T>[] = [];
	const deleted: string[] = [];

	const keys = [...new Set([...oursMap.keys(), ...theirsMap.keys()])].sort(compareCodePoints);
	for (const key of keys) {
		const mine = oursMap.get(key);
		const yours = theirsMap.get(key);
		const ancestor = baseMap?.get(key);

		// 片方にしか無い鍵
		if (mine === undefined || yours === undefined) {
			const present = (mine ?? yours) as T;
			// 祖先に在って片方から消えている＝**片方が消した**。ただし残っている側が
			// 祖先から変えていないときだけ従う。変えているなら「直した」と「消した」が
			// ぶつかっているので、人が決める
			if (ancestor !== undefined) {
				if (options.sameValue(present, ancestor)) {
					deleted.push(key);
					continue;
				}
				// **消した側と直した側がぶつかっている。** 消した側には見せる値が無いので
				// 祖先の値を置き、「消した」ことは印で伝える。印を落とすと、消した側を
				// 採ったときに祖先の値が書き戻り、削除が黙って取り消される
				undecided.push(
					mine === undefined
						? { key, ours: ancestor, theirs: yours as T, base: ancestor, oursDeleted: true }
						: { key, ours: mine, theirs: ancestor, base: ancestor, theirsDeleted: true },
				);
				continue;
			}
			// 祖先が無ければ「消した」と「足した」を見分けられない。**必ず採る**
			resolved.push({ key, value: present });
			continue;
		}

		// 同じ鍵・同じ値
		if (options.sameValue(mine, yours)) {
			resolved.push({ key, value: mine });
			continue;
		}

		// 同じ鍵・片方だけが祖先から変えた（3方向マージの基本。決定的に決まる）
		if (ancestor !== undefined) {
			if (options.sameValue(mine, ancestor)) {
				resolved.push({ key, value: yours });
				continue;
			}
			if (options.sameValue(yours, ancestor)) {
				resolved.push({ key, value: mine });
				continue;
			}
		}

		// 同じ鍵・触った項目が別（重なっていなければ両方残せる）
		const merged = options.mergeFields?.(mine, yours, ancestor);
		if (merged !== undefined) {
			resolved.push({ key, value: merged });
			continue;
		}

		undecided.push({ key, ours: mine, theirs: yours, base: ancestor });
	}

	return { resolved, undecided, deleted };
}
