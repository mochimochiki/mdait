/**
 * @file mdait-conflicts.ts
 * @description
 *   `.mdait` の中に残っている**未解決の合流の競合**を数える（roadmap-v04 P01）。
 *
 *   合流で衝突しても、いままで mdait は何も言わなかった。用語集の CSV は同じ語の2行目を
 *   跡も残さず捨て、`translations.tmx` はログに1行書いて次の保存で消していた。SVN では
 *   TM も用語集も読むのを拒んで手が止まる。**気づく手立てが1つも無かった**のがいちばんの
 *   損で、ここはその手立てを作る係である（ADR-260911-02）。
 *
 *   数えるだけで、**1バイトも書かない**。解くのは P02（AI の一発）と P03（人が決める）である。
 *
 * ## 数えるもの
 *
 * - **競合マーカーの入ったファイル** … `unit-state` / `unit-registry` / `translations.tmx` /
 *   設定から解決した用語集の実ファイルの4つ。`mdait.json` と原稿は対象外（人の領域）
 * - **合流で降ろされた `unit-state` の行** … 2人が同じ席に別々の `from` / `need` を書いた跡。
 *   本文から消えた章を預かる行（正規の用途）は数えない（ADR-260911-03）
 *
 *   この2つは**同じ競合の別の時点**である。合流の直後はファイルにマーカーが残っており、
 *   mdait が1度読むと畳まれて行になる。どちらの時点でも同じ件数が見えるように両方数える。
 *
 * @module core/conflict/mdait-conflicts
 */
import * as fs from "node:fs";
import { hasConflictMarkersInDataFile } from "../markdown/conflict-markers";
import { type UnitStateEntry, isMergeHeldEntry } from "../unit-state/unit-state-store";

/** 競合マーカーが残りうる `.mdait` のファイルの種別 */
export type ConflictFileKind = "unit-state" | "unit-registry" | "tm" | "terms";

/**
 * ファイルの見た目（更新時刻と寸法）。中身を読み直すかどうかの判断に使う。
 *
 * `unit-registry` は数 MB になるので、ツリーが描き変わるたびに全文を走査させない。
 * 見た目が動いていなければ前の答えをそのまま返す。**動いていたら必ず読み直す** —
 * 内容が同じでも読み直すだけで、取りこぼすことは無い。
 */
type FileStamp = string;

/** 競合マーカーの入ったファイル1つ */
export interface ConflictedFile {
	kind: ConflictFileKind;
	/** 絶対パス */
	filePath: string;
	/**
	 * 数えたときのファイルの見た目（更新時刻と寸法）。
	 *
	 * **パスだけでは「同じ競合か」を言えない。** 別の合流が来ても人が手で直しても、
	 * 競合しているファイルの並びは変わらないことがある。中身が動いたかを見るのはここ。
	 */
	stamp: FileStamp;
}

/** 合流で席から降ろされた `unit-state` の行1つ */
export interface MergeHeldRow {
	/** 原稿のワークスペース相対パス */
	path: string;
	/** 押し出された元の行の身元（`u<席のキー>` か `f`） */
	seat: string;
	/** 本文の hash */
	hash: string;
	from: string;
	need: string;
}

/** 未解決の競合の一覧 */
export interface MdaitConflicts {
	files: ConflictedFile[];
	heldRows: MergeHeldRow[];
	/** 人が片付ける件数（ファイル1つで1件、行1つで1件） */
	total: number;
}

/** 数える対象のファイル（絶対パス。まだ無いものも渡してよい） */
export interface ConflictFilePaths {
	unitState: string;
	unitRegistry: string;
	tm: string;
	terms: string;
}

/** 件数が 0 の結果（設定がまだ無い作業場などで使う） */
export function noConflicts(): MdaitConflicts {
	return { files: [], heldRows: [], total: 0 };
}

/**
 * 見た目には**パスも入れる**。覚え書きは作業場をまたいで生き残るので（`conflict-source.ts` の
 * スキャナはモジュールに1つ）、設定でパスが変わったのに新しいパスのファイルの更新時刻と
 * 寸法がたまたま同じだと、前のパスの答えをそのまま返してしまう。
 */

function stampOf(filePath: string): FileStamp {
	try {
		const stat = fs.statSync(filePath);
		return `${filePath}\u0000${stat.mtimeMs}:${stat.size}`;
	} catch {
		return `${filePath}\u0000-`; // 無いファイルは競合しようがない
	}
}

/**
 * 1つのファイルに競合マーカーが残っているか。
 *
 * 原稿用の `hasConflictMarkers` ではなく `hasConflictMarkersInDataFile` を使う。
 * 原稿用はコードブロックの中を数えないが、`.mdait` の中のファイルにコードブロックの
 * 概念は無く、行頭の生の `<<<<<<<` は合流の結果にしか現れない。
 */
function isConflicted(filePath: string): boolean {
	try {
		return hasConflictMarkersInDataFile(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// 読めないファイルは competing しているとは言えない。読めない事実は
		// それぞれのストアが自分の経路で報告する（ここで二重に鳴らさない）
		return false;
	}
}

/**
 * `.mdait` の未解決の競合を数える。
 *
 * 選択中の transPair で絞らない。`.mdait` のファイルはワークスペースに1つずつで
 * 言語ペアに属さないし、**競合を数え落とすより、選択の外のものまで見せるほうが安全**
 * だからである。
 *
 * @param paths 数える対象のファイル（絶対パス）
 * @param entries `unit-state` の全行。省略すると行は数えない
 */
export function collectMdaitConflicts(
	paths: ConflictFilePaths,
	entries: readonly UnitStateEntry[] = [],
): MdaitConflicts {
	const files: ConflictedFile[] = [];
	const candidates: ReadonlyArray<[ConflictFileKind, string]> = [
		["unit-state", paths.unitState],
		["unit-registry", paths.unitRegistry],
		["tm", paths.tm],
		["terms", paths.terms],
	];
	for (const [kind, filePath] of candidates) {
		if (filePath && isConflicted(filePath)) {
			files.push({ kind, filePath, stamp: stampOf(filePath) });
		}
	}

	const heldRows = collectMergeHeldRows(entries, files);
	return { files, heldRows, total: files.length + heldRows.length };
}

/**
 * 合流で降ろされた行を拾う。ただし **`unit-state` にまだ競合マーカーが残っているあいだは
 * 1行も返さない。**
 *
 * この2つは**同じ競合の別の時点**だからである。マーカーの入った `unit-state` を読むと、
 * 読み込みは両陣営の行を拾って片方を席から降ろす — つまりファイルの競合1つが、そのまま
 * 行の競合として**同時にメモリに現れる**。両方数えると1つの合流が2件に見え、ツリーにも
 * 二重に並ぶ。マーカーが残っているうちはファイル1件として数え、畳んで書き戻されたあとに
 * 行として数える。
 */
function collectMergeHeldRows(
	entries: readonly UnitStateEntry[],
	files: readonly ConflictedFile[],
): MergeHeldRow[] {
	if (files.some((file) => file.kind === "unit-state")) {
		return [];
	}
	return entries.filter(isMergeHeldEntry).map((entry) => ({
		path: entry.path,
		seat: entry.seat,
		hash: entry.hash,
		from: entry.from,
		need: entry.need,
	}));
}

/**
 * 同じ答えを何度も聞かれる場所（ステータスバー・ツリー）のための覚え書き付きの数え方。
 *
 * ファイルの見た目が動いていなければ前の答えを返す。`unit-state` の行は
 * メモリの上にあるので毎回数え直す（走査の費用はファイルの読み直しに比べて無視できる）。
 */
export class MdaitConflictScanner {
	private stamps = new Map<ConflictFileKind, FileStamp>();
	private files: ConflictedFile[] = [];
	private scannedOnce = false;

	/**
	 * @param paths 数える対象のファイル（絶対パス）
	 * @param entries `unit-state` の全行
	 */
	scan(paths: ConflictFilePaths, entries: readonly UnitStateEntry[] = []): MdaitConflicts {
		const candidates: ReadonlyArray<[ConflictFileKind, string]> = [
			["unit-state", paths.unitState],
			["unit-registry", paths.unitRegistry],
			["tm", paths.tm],
			["terms", paths.terms],
		];
		const moved = !this.scannedOnce || candidates.some(([kind, filePath]) => this.stamps.get(kind) !== stampOf(filePath));
		if (moved) {
			this.files = collectMdaitConflicts(paths).files;
			this.stamps = new Map(candidates.map(([kind, filePath]) => [kind, stampOf(filePath)]));
			this.scannedOnce = true;
		}
		const heldRows = collectMergeHeldRows(entries, this.files);
		return { files: this.files, heldRows, total: this.files.length + heldRows.length };
	}

	/** 覚え書きを捨てて、次の `scan` で必ず読み直させる */
	invalidate(): void {
		this.scannedOnce = false;
	}
}
