import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../../infra/logging/logger";
import { atomicWriteFileSync } from "../../infra/workspace/atomic-write";
import { calculateHash } from "../hash/hash-calculator";

const logger = Logger.getInstance();

/** unit-stateファイル名 */
const UNIT_STATE_FILENAME = "unit-state";

/** ヘッダーコメント行 */
const HEADER_LINES = [
	"# mdait unit-state — 翻訳ユニットの状態管理",
	"# path\torder\tlevel\ttitleHash\thash\tfrom\tneed",
];

/** TSVのカラム数 */
const EXPECTED_COLUMN_COUNT = 7;

/** 読み取りに傷があった回に、上書きの直前で原本を写す先 */
const SALVAGE_FILENAME = "unit-state.broken";

/** ディレクトリごとに置く区画の数 */
const BUCKETS_PER_DIR = 64;

/** 合流で残る競合マーカーの行か（`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`） */
function isConflictMarkerLine(line: string): boolean {
	return /^(<{7}|\|{7}|={7}|>{7})(\s|$)/.test(line);
}

/**
 * 読み取れなかったもの・畳んだものの内訳。すべて 0 なら、ファイルは丸ごと読めている。
 */
export interface UnitStateParseReport {
	/** 形が分からず読み飛ばした行数 */
	skipped: number;
	/** 合流の競合マーカーとして読み飛ばした行数 */
	conflictMarkers: number;
	/** 同じ席（path と order）に2行以上来たので、席を分けた回数 */
	duplicates: number;
}

/** 傷なく読み切れたか */
export function isCleanParse(report: UnitStateParseReport): boolean {
	return report.skipped === 0 && report.conflictMarkers === 0 && report.duplicates === 0;
}

/**
 * 同じ席に2行来たとき、席に残すほうを決める。
 *
 * **どちらを選んでも正しさは変わらない。** 席の意味（何番目か）は次の sync が
 * `alignEntriesToUnits` で本文と突き合わせて付け直すので、ここでの選択は
 * 「どちらが先に本文と照合されるか」しか変えない。大事なのは**どちらも捨てないこと**と、
 * **誰がどの順で合流させても同じ答えになること**の2つである。順で決めると（＝先勝ち・
 * 後勝ち）、同じ競合を2人が別々に片付けたときに違うバイト列が出て、それがまた競合する。
 *
 * 情報の多いほう（`from` があるか、`need` があるか）を残し、並んだら文字列の順で決める。
 */
function seatPriority(entry: UnitStateEntry): string {
	const rank = (entry.from ? 2 : 0) + (entry.need ? 1 : 0);
	return `${9 - rank}\t${entry.hash}\t${entry.from}\t${entry.need}`;
}

/**
 * 「保留席」の order の始まり。
 *
 * 刈り取りを見送った行をここ以降の order へ移すことで、「本文のどこにも対応する場所が無い行」
 * だと行そのものから分かるようにする。列を増やすと既存の `unit-state` が警告なく全行
 * スキップされるため（7列固定）、覚えるための場所は既存の列の中に作る必要がある。
 * 実運用のユニット数（1ファイル数百件）とは桁が違うので、生きている order と衝突しない。
 */
export const HELD_ORDER_BASE = 1_000_000;

/**
 * frontmatter マーカー（`mdait.front`）の行の `order`。1ファイルに1つだけ。
 *
 * frontmatter は本文の並びに属さないので、本文ユニットの `order`（0..N-1）とも
 * 保留席（`HELD_ORDER_BASE` 以降）とも重ならない席をここに予約する。列を増やすと
 * 既存の `unit-state` が警告付きで全行スキップされる（7列固定）ため、目印は既存の
 * 列の中に作る必要がある。
 *
 * 保留席より**上**に置くのが要点である。末尾の刈り取り・保留への退避はどちらも
 * `order < HELD_ORDER_BASE` の行だけを対象にするので、ここに居る限り
 * 「ユニットが減った」という理由で消されることが構造的に起こらない。
 */
export const FRONT_MATTER_ORDER = 2_000_000;

/** frontmatter マーカーの行か */
export function isFrontMatterEntry(entry: UnitStateEntry): boolean {
	return entry.order === FRONT_MATTER_ORDER;
}

/**
 * 保留席に居る（＝いまの本文に対応する場所が無い）行か。
 *
 * frontmatter の行は order が桁で見れば保留席より上だが、席ではない。除かないと
 * 本文 hash の一致で本文ユニットへ拾われうるし、席の採番が毎回その上へ逃げていく。
 */
export function isHeldBackEntry(entry: UnitStateEntry): boolean {
	return entry.order >= HELD_ORDER_BASE && !isFrontMatterEntry(entry);
}

/**
 * いまの本文の**位置**を持っている行か（＝保留席でも frontmatter でもない）。
 *
 * 行には3つの種別がある。`order` の桁で見分けられるが、桁を各所で書き下すと
 * 種別が1つ増えるたびに全部を直して回ることになり、必ずどこかが取り残される
 * （実測: P05a で frontmatter の行が増えたとき、数える側が2箇所取り残された）。
 * 見分けは必ずこの3つの述語を通す。
 *
 * - `isLiveBodyEntry` … いまの本文の何番目か、という意味を持つ行
 * - `isHeldBackEntry` … 保留席。意味は持つが位置は持たない
 * - `isFrontMatterEntry` … frontmatter。本文の並びに属さない
 */
export function isLiveBodyEntry(entry: UnitStateEntry): boolean {
	return entry.order < HELD_ORDER_BASE;
}

/**
 * unit-stateエントリ。
 * 非MDファイルは「ファイル＝単一ユニット」（order=0, level=0, titleHash=""）の特殊形、
 * MD-external は同一 path に複数 order 行を持つ。
 */
export interface UnitStateEntry {
	/** ワークスペース相対パス（/区切り） */
	path: string;
	/** ファイル内ユニット順序（0始まり） */
	order: number;
	/** 見出しレベル（非MD・先頭本文ユニット=0） */
	level: number;
	/** タイトルのhash（非MD・本文ユニット=""） */
	titleHash: string;
	/** ユニット本文のCRC32 hash（= marker.hash） */
	hash: string;
	/** 翻訳元hash */
	from: string;
	/** '' | 'translate' | 'revise@...' | 'review' */
	need: string;
}

/**
 * 翻訳ユニットの状態を管理するストア。
 * `.mdait/unit-state` のTSV行ベースフォーマットを読み書きする。
 * 非MDファイル（N=1）とMD-external（N>1）を単一モデルで扱う。
 * シングルトンパターン（StatusManagerに倣う）。
 */
export class UnitStateStore {
	private static instance: UnitStateStore | undefined;
	/**
	 * `path` → (`order` → 行) の二段。
	 *
	 * ファイル単位の操作（読み出し・件数・保留席・刈り取り・移動）が**ワークスペース全体の
	 * 行数ではなく、そのファイルの行数にしか比例しない**ようにするための形である。
	 * 平坦な `Map` に索引を別途持たせる手もあるが、索引と本体がずれる余地を作らずに済む。
	 *
	 * 副次的に、キーに NUL を使わなくなったので `git diff` がこのファイルをテキストとして
	 * 扱うようになった（以前は `--text` を付けないと差分が出なかった）。
	 */
	private byPath: Map<string, Map<number, UnitStateEntry>> = new Map();
	/**
	 * **まだディスクへ書いていない変更**。`path` → (`order` → 行、または `null`＝消したこと)。
	 *
	 * `load()` は表を丸ごと捨ててディスクから読み直す。この記録が無いと、読み直しに
	 * 割り込まれた書き手の成果がそこで消える。**しかも消えたことは誰にも分からない** —
	 * 書き手はそのあと `save()` を呼ぶので、欠けた表がそのまま永続化される。
	 *
	 * いちばん重いのは一括変換（markers-migration）で、本文からマーカーを剥がしてから
	 * 表へ移し、保存は全ファイル終わったあとの1回である。読み直しに割り込まれると、
	 * マーカーは**本文にも表にも残らず復旧できない**。
	 *
	 * 消したこと（`null`＝墓標）も覚える必要がある。覚えないと、読み直しで消したはずの行が
	 * ディスクから復活する（embedded への一括変換は行を消す操作なので、まさにこれを踏む）。
	 *
	 * ロックで守る手もあるが、翻訳は AI の応答を待つあいだファイル単位の排他を握っており、
	 * そこへ表の排他を足すと順序が逆転してデッドロックになる。外側へ出せばフォルダ翻訳の
	 * 並列（既定3・最大8）が直列に落ちる。**読み直しの側を割り込みに強くすれば、
	 * 書き手にロックを足さずに済む**（ADR-260831-01）。
	 */
	private pending: Map<string, Map<number, UnitStateEntry | null>> = new Map();
	private dirty = false;
	private loaded = false;
	private mdaitDir: string | undefined;
	/** 直近の読み取りの内訳 */
	private lastParseReport: UnitStateParseReport = { skipped: 0, conflictMarkers: 0, duplicates: 0 };
	/** 読み取りに傷があったので、次の上書きの前に原本を写す */
	private needsSalvage = false;

	private constructor() {}

	static getInstance(): UnitStateStore {
		if (!UnitStateStore.instance) {
			UnitStateStore.instance = new UnitStateStore();
		}
		return UnitStateStore.instance;
	}

	static dispose(): void {
		UnitStateStore.instance = undefined;
	}

	/** そのファイルの行（無ければ undefined）。読み取り専用の用途に使う */
	private rowsOf(filePath: string): Map<number, UnitStateEntry> | undefined {
		return this.byPath.get(filePath);
	}

	/** そのファイルの行（無ければ作る）。書き込みの用途に使う */
	private ensureRows(filePath: string): Map<number, UnitStateEntry> {
		const rows = this.byPath.get(filePath);
		if (rows) {
			return rows;
		}
		const created = new Map<number, UnitStateEntry>();
		this.byPath.set(filePath, created);
		return created;
	}

	/**
	 * 1行を消す。**そのファイルの行が空になったら path ごと畳む。**
	 * 畳まないと、消えたファイルの分だけ空の入れ物が残り、全走査がその数に比例して重くなる。
	 */
	private deleteRow(filePath: string, order: number): boolean {
		const rows = this.byPath.get(filePath);
		if (!rows?.delete(order)) {
			return false;
		}
		if (rows.size === 0) {
			this.byPath.delete(filePath);
		}
		return true;
	}

	/** 全ファイルの全行を順に返す（走査順は保証しない） */
	private *allEntries(): IterableIterator<UnitStateEntry> {
		for (const rows of this.byPath.values()) {
			yield* rows.values();
		}
	}

	/** 保存待ちの変更を1件覚える（`null` は「消した」） */
	private recordPending(filePath: string, order: number, entry: UnitStateEntry | null): void {
		const rows = this.pending.get(filePath);
		if (rows) {
			rows.set(order, entry);
			return;
		}
		this.pending.set(filePath, new Map([[order, entry]]));
	}

	/**
	 * 1行を書く。**表を書き換える入口はここと `dropRow` / `dropPath` の3つだけ。**
	 *
	 * 直に `byPath` を触ると保存待ちの記録から漏れ、`load()` の割り込みでその変更だけが
	 * 静かに消える。漏れは実行時にしか現れないので、入口を絞って構造的に防ぐ。
	 */
	private putRow(entry: UnitStateEntry): void {
		this.ensureRows(entry.path).set(entry.order, entry);
		this.recordPending(entry.path, entry.order, entry);
		this.dirty = true;
	}

	/** 1行を消す。消したことも保存待ちとして覚える（`putRow` を見よ） */
	private dropRow(filePath: string, order: number): boolean {
		if (!this.deleteRow(filePath, order)) {
			return false;
		}
		this.recordPending(filePath, order, null);
		this.dirty = true;
		return true;
	}

	/** そのファイルの行をすべて消す（`putRow` を見よ） */
	private dropPath(filePath: string): number {
		const rows = this.byPath.get(filePath);
		if (!rows || rows.size === 0) {
			return 0;
		}
		const removed = rows.size;
		for (const order of rows.keys()) {
			this.recordPending(filePath, order, null);
		}
		this.byPath.delete(filePath);
		this.dirty = true;
		return removed;
	}

	/**
	 * 読み直したばかりの表へ、保存待ちの変更を当て直す。
	 *
	 * ディスクとメモリが食い違ったら**メモリを採る**。食い違うのは別のウィンドウや外部の
	 * 道具が書いた場合だが、この表はもともと1つのプロセスが持つ前提で、そちらの安全は
	 * 別に用意されていない。ここで採るべきは「いま書いている最中の変更」のほうである。
	 */
	private replayPending(): void {
		if (this.pending.size === 0) {
			this.dirty = false;
			return;
		}
		for (const [filePath, rows] of this.pending) {
			for (const [order, entry] of rows) {
				if (entry === null) {
					this.deleteRow(filePath, order);
				} else {
					this.ensureRows(filePath).set(order, entry);
				}
			}
		}
		// 当て直した変更はまだディスクに無い。`save()` が書き出すまで dirty のまま
		this.dirty = true;
		logger.debug("unit-state", "Replayed unsaved changes over a reload", {
			paths: this.pending.size,
		});
	}

	/**
	 * `.mdait/unit-state` を読み込む。
	 *
	 * **保存待ちの変更は捨てない。** ディスクを読み終えたあとに当て直す（`replayPending`）。
	 * sync はこの関数を無条件に呼ぶので、捨てると「翻訳や一括変換の最中に sync を回すと、
	 * それまでの成果が無言で消える」という壊れ方になる。
	 */
	load(mdaitDir: string): void {
		this.mdaitDir = mdaitDir;
		this.byPath.clear();

		const filePath = path.join(mdaitDir, UNIT_STATE_FILENAME);
		if (!fs.existsSync(filePath)) {
			this.loaded = true;
			this.replayPending();
			return;
		}

		const content = fs.readFileSync(filePath, "utf-8");
		// **CRLF でも同じに読む。** 書き出しは LF だが、git の `core.autocrlf` や SVN の
		// `svn:eol-style=native` は取り出すときに CRLF へ変えうる。`\n` だけで切ると
		// 7列目 `need` の末尾に `\r` が残り、`need !== ""` が全行で真になる
		const lines = content.split(/\r?\n/);
		const report: UnitStateParseReport = { skipped: 0, conflictMarkers: 0, duplicates: 0 };

		for (const line of lines) {
			// 空行・コメント行をスキップ
			if (line.trim() === "" || line.startsWith("#")) {
				continue;
			}

			if (isConflictMarkerLine(line)) {
				report.conflictMarkers++;
				continue;
			}

			const columns = line.split("\t");
			if (columns.length !== EXPECTED_COLUMN_COUNT) {
				report.skipped++;
				logger.warn("unit-state", "Skipping malformed line (expected 7 columns)", {
					columnCount: columns.length,
					line: line.substring(0, 100),
				});
				continue;
			}

			const [filePathCol, orderStr, levelStr, titleHash, hash, from, need] = columns;
			const order = Number.parseInt(orderStr, 10);
			const level = Number.parseInt(levelStr, 10);
			if (Number.isNaN(order) || Number.isNaN(level)) {
				report.skipped++;
				logger.warn("unit-state", "Skipping line with invalid order/level", {
					line: line.substring(0, 100),
				});
				continue;
			}

			const entry: UnitStateEntry = {
				path: filePathCol,
				order,
				level,
				titleHash,
				hash,
				from,
				need,
			};
			this.seatOnLoad(entry, report);
		}

		this.loaded = true;
		// `replayPending` は保存待ちが無ければ dirty を落とす（＝ディスクと同じ、の意）。
		// 傷を畳んだ回はディスクと同じではないので、後始末はそのあとに置く
		this.replayPending();
		this.afterLoad(report);
	}

	/**
	 * 読み込みで1行を席に着ける。**同じ席に2行来ても、どちらも捨てない。**
	 *
	 * 合流のあとのファイルには、同じ `(path, order)` の行が2つ並ぶ（`merge=union` は
	 * 両陣営の行を残し、競合マーカー入りのファイルでも両陣営の行はどちらも読めるため）。
	 * かつてはここで後勝ちに潰しており、**負けた側の `from` / `need` / `revise@` が
	 * 警告も残さず消えていた** — 控えが他所に無いので、消えたことに気づく手掛かりも無い。
	 *
	 * 溢れた行は保留席（`HELD_ORDER_BASE` 以降）へ逃がす。保留席の行は本文 hash の
	 * 完全一致でしか拾われないので（`unit-state-align.ts`）、**弱い手掛かりで取り違える
	 * ことが構造的に起きない**。原稿がその陣営の版だったときだけ、自動で戻る。
	 */
	private seatOnLoad(entry: UnitStateEntry, report: UnitStateParseReport): void {
		const rows = this.ensureRows(entry.path);
		const sitting = rows.get(entry.order);
		if (!sitting) {
			rows.set(entry.order, entry);
			return;
		}

		report.duplicates++;
		// 席に残すほうと、保留席へ回すほうを、読んだ順に依らず決める
		const [stays, leaves] =
			seatPriority(entry) < seatPriority(sitting) ? [entry, sitting] : [sitting, entry];
		rows.set(entry.order, stays);

		// 同じ中身の行が既に保留席に居るなら席は増やさない（同じ hash の席は1つで足りる）
		let nextSeat = HELD_ORDER_BASE;
		for (const row of rows.values()) {
			if (!isHeldBackEntry(row)) {
				continue;
			}
			nextSeat = Math.max(nextSeat, row.order + 1);
			if (row.hash === leaves.hash && row.from === leaves.from && row.need === leaves.need) {
				return;
			}
		}
		rows.set(nextSeat, { ...leaves, order: nextSeat });
	}

	/**
	 * 読み終わったあとの後始末。**傷があった回だけ**、原本を横へ写す予約をして、
	 * 畳んだ結果を書き戻せるようにする。
	 *
	 * `dirty` を立てるのが要点である。立てないと `save()` が何も書かず、席を分けた結果は
	 * メモリの中だけで消える。次に誰かが書いた瞬間、また同じ後勝ちのファイルが残る。
	 */
	private afterLoad(report: UnitStateParseReport): void {
		this.lastParseReport = report;
		if (isCleanParse(report)) {
			return;
		}
		this.needsSalvage = true;
		this.dirty = true;
		logger.warn("unit-state", "Read a damaged unit-state; kept every row that could be read", {
			skipped: report.skipped,
			conflictMarkers: report.conflictMarkers,
			duplicates: report.duplicates,
		});
	}

	/** 直近の読み取りの内訳（傷の有無を呼び出し側が知るため） */
	getLastParseReport(): UnitStateParseReport {
		return { ...this.lastParseReport };
	}

	/** 変更があればファイルに書き戻し */
	save(mdaitDir: string): void {
		if (!this.dirty) {
			return;
		}

		const filePath = path.join(mdaitDir, UNIT_STATE_FILENAME);

		const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
		const bucketOf = (p: string) => (Number.parseInt(calculateHash(p.slice(dirOf(p).length), false).substring(0, 2), 16) % BUCKETS_PER_DIR);
		const sortedEntries = [...this.allEntries()].sort((a, b) => {
			const d = dirOf(a.path).localeCompare(dirOf(b.path));
			if (d !== 0) return d;
			const ba = bucketOf(a.path);
			const bb = bucketOf(b.path);
			if (ba !== bb) return ba < bb ? -1 : 1;
			const c = a.path.localeCompare(b.path);
			return c !== 0 ? c : a.order - b.order;
		});

		const lines: string[] = [...HEADER_LINES];
		// ファイルごとのブロックを「空行・見出し・空行」の3行で挟む。
		//
		// **空行1つでは隣のブロックを守れない。** 3方向マージは変更のまわりの数行を手掛かりに
		// 使うので、ブロックが丸ごと消えると（記事を1本消した枝を合流させたとき）その手掛かりが
		// 隣のブロックの行まで食い込み、**触ってもいない記事の行が競合する**。実測では、
		// 記事を1本消した枝と、別の記事を訳した枝を合わせると、訳した側の行が二重になって
		// 後勝ちで翻訳前に巻き戻り、消したはずの記事の行も復活した。
		//
		// 見出し行はローダーが `#` として読み飛ばすので、**形式は1バイトも変わらない**
		// （古い版の mdait もそのまま読める）。人が diff を見るときの目印にもなる。
		let prevPath: string | undefined;
		let prevDir: string | undefined;
		let bucketCursor = 0;
		const fillBuckets = (dir: string, upTo: number) => {
			while (bucketCursor < upTo) {
				lines.push(`# ${dir}[${bucketCursor.toString(16).padStart(2, "0")}]`);
				bucketCursor++;
			}
		};
		for (const entry of sortedEntries) {
			if (entry.path !== prevPath) {
				const dir = dirOf(entry.path);
				if (dir !== prevDir) {
					if (prevDir !== undefined) fillBuckets(prevDir, BUCKETS_PER_DIR);
					bucketCursor = 0;
					prevDir = dir;
				}
				fillBuckets(dir, bucketOf(entry.path) + 1);
				lines.push("", `# ${entry.path}`, "");
			}
			lines.push(
				`${entry.path}\t${entry.order}\t${entry.level}\t${entry.titleHash}\t${entry.hash}\t${entry.from}\t${entry.need}`,
			);
			prevPath = entry.path;
		}

		if (prevDir !== undefined) fillBuckets(prevDir, BUCKETS_PER_DIR);
		// 末尾改行を付与
		const content = `${lines.join("\n")}\n`;
		this.salvageBeforeOverwrite(filePath, mdaitDir);
		atomicWriteFileSync(filePath, content, "utf-8");
		this.dirty = false;
		// ディスクに載ったので、もう当て直す必要は無い
		this.pending.clear();
	}

	/**
	 * 読み取りに傷があった回だけ、上書きの直前に原本を横へ写す。
	 *
	 * 畳んだ結果は正しいはずだが、**間違っていたときに戻る先がどこにも無い** — `from` と
	 * `need` はこのファイルにしか無く、本文から計算し直せない（`revise@X` の X はなおさら）。
	 *
	 * 既に `unit-state.broken` があるなら**上書きしない**。まだ誰も片付けていない避難先を、
	 * 次に壊れた回のもので潰すと、最初の事故の姿が消える（`unit-registry` と同じ作法）。
	 */
	private salvageBeforeOverwrite(filePath: string, mdaitDir: string): void {
		if (!this.needsSalvage) {
			return;
		}
		this.needsSalvage = false;
		const salvagePath = path.join(mdaitDir, SALVAGE_FILENAME);
		try {
			if (!fs.existsSync(filePath)) {
				return;
			}
			if (fs.existsSync(salvagePath)) {
				logger.warn("unit-state", `Kept the existing ${SALVAGE_FILENAME}; this run's file was not saved aside`);
				return;
			}
			fs.copyFileSync(filePath, salvagePath);
			logger.warn("unit-state", `Saved the unit-state as it was read to ${SALVAGE_FILENAME} before overwriting it`);
		} catch (error) {
			logger.warn("unit-state", "Failed to save the original unit-state", { error: String(error) });
		}
	}

	/**
	 * mdaitDirを設定し、未ロードの場合のみ読み込む。
	 * syncSingleFile等の単独トリガーで呼び出す。
	 */
	ensureLoaded(mdaitDir: string): void {
		this.mdaitDir = mdaitDir;
		if (!this.loaded) {
			this.load(mdaitDir);
		}
	}

	/** 遅延ロード: 未ロードならmdaitDirからauto-load（内部用） */
	private autoLoad(): void {
		if (!this.loaded && this.mdaitDir) {
			this.load(this.mdaitDir);
		}
	}

	getEntry(filePath: string, order: number): UnitStateEntry | undefined {
		this.autoLoad();
		return this.rowsOf(filePath)?.get(order);
	}

	setEntry(entry: UnitStateEntry): void {
		this.autoLoad();
		this.putRow(entry);
	}

	removeEntry(filePath: string, order: number): void {
		this.autoLoad();
		this.dropRow(filePath, order);
	}

	/**
	 * 指定パスの行をすべて削除する（保留席の行も含む）。
	 *
	 * ファイルそのものを手放すとき（孤立訳文の破棄）に使う。走査の副作用ではなく
	 * 人の明示的な宣言に対応する操作なので、`cleanupOrphansInScope` の3分割は通さない。
	 *
	 * @returns 削除されたエントリ数
	 */
	removeEntriesByPath(filePath: string): number {
		this.autoLoad();
		return this.dropPath(filePath);
	}

	/**
	 * 行の `path` を付け替える（ファイルの移動に追随させる）。
	 *
	 * `oldPath` に一致する行と、`oldPath` を先頭に持つ行（＝ディレクトリごと動かした場合の
	 * 配下）の両方を動かす。フォルダの移動はイベント1件でファイルが何十件も動くため、
	 * ファイル単位の呼び出しに割り戻していると取りこぼす。
	 *
	 * 行き先に既に行があれば**先に消してから**移す。上書きで移すと、移動先のファイルが
	 * 元々持っていた行のうち order が大きいものだけが残り、次の parse で「余った行」として
	 * 別の章に拾われる。移動は上書きであって併合ではない。
	 *
	 * @param oldPath 移動元（ワークスペース相対・/区切り）
	 * @param newPath 移動先（同上）
	 * @returns 付け替えたエントリ数
	 */
	movePath(oldPath: string, newPath: string): number {
		this.autoLoad();
		if (oldPath === newPath || oldPath === "") {
			return 0;
		}
		const oldPrefix = `${oldPath}/`;
		// 走査するのは**パスの一覧**であって行の一覧ではない。フォルダの移動は
		// イベント1件でファイルが何十件も動くため、ここが行数に比例すると効いてくる
		const moving: Array<{ from: string; to: string }> = [];
		for (const filePath of this.byPath.keys()) {
			if (filePath === oldPath) {
				moving.push({ from: filePath, to: newPath });
			} else if (filePath.startsWith(oldPrefix)) {
				moving.push({ from: filePath, to: `${newPath}/${filePath.substring(oldPrefix.length)}` });
			}
		}
		if (moving.length === 0) {
			return 0;
		}
		// 行き先の行を掃除する。移動元と行き先が重なる形（入れ子のディレクトリ移動）でも
		// 取りこぼさないよう、動かす分を先に取り出してから行き先を消す
		const detached = moving.map(({ from, to }) => {
			const rows = this.byPath.get(from);
			this.dropPath(from);
			return { to, rows };
		});
		for (const { to } of detached) {
			this.dropPath(to);
		}
		let moved = 0;
		for (const { to, rows } of detached) {
			if (!rows) {
				continue;
			}
			for (const entry of rows.values()) {
				this.putRow({ ...entry, path: to });
				moved++;
			}
		}
		return moved;
	}

	/**
	 * 刈り取りを見送った末尾のエントリを「保留席」へ移す（detachMarkers から呼ぶ）。
	 *
	 * order を `HELD_ORDER_BASE` 以降へ付け替えるだけで、内容（hash / from / need）は変えない。
	 * こうしておくと、次に読むときその行が「取り残された行」だと**行そのものから分かる**。
	 * 列を増やさずに覚えられるので、7列固定の形式を崩さずに済む。
	 *
	 * これが無いと、いまのユニット数との比率でしか保留を推し量れず、ユニットが少し増えた
	 * だけで取り残された行が「普通の余り」に見え、順序で新しい章に貼り付いてしまう。
	 *
	 * @returns 保留席へ移したエントリ数
	 */
	parkEntriesFrom(filePath: string, fromOrder: number): number {
		this.autoLoad();
		const moving: UnitStateEntry[] = [];
		for (const entry of this.rowsOf(filePath)?.values() ?? []) {
			if (entry.order < HELD_ORDER_BASE && entry.order >= fromOrder) {
				moving.push(entry);
			}
		}
		moving.sort((a, b) => a.order - b.order);
		return this.moveToHeldSeats(filePath, moving);
	}

	/**
	 * 指定した order の行を「保留席」へ移す（`parkEntriesFrom` の位置によらない版）。
	 *
	 * 末尾かどうかではなく「**いまの本文に対応が付かなかった**」ことを根拠に退避する。
	 * 文書の途中の章が1つ消えたとき、sync が原文からその章を作り直すのでユニット数は
	 * 元に戻り、末尾を見る `parkEntriesFrom` は何も拾えない。対応が付かなかった事実を
	 * 知っているのは読み込み時（`alignEntriesToUnits`）だけなので、そこから運ばれた
	 * order をそのまま受け取る（`MarkerFileContext.alignment`）。
	 *
	 * 既に保留席に居る行と、指定に無い行は動かさない。
	 *
	 * @param filePath 対象ファイル（ワークスペース相対）
	 * @param orders 退避する行の order（保留席の order を渡しても無視する）
	 * @returns 保留席へ移したエントリ数
	 */
	parkEntries(filePath: string, orders: readonly number[]): number {
		this.autoLoad();
		if (orders.length === 0) {
			return 0;
		}
		const wanted = new Set(orders);
		const moving: UnitStateEntry[] = [];
		for (const order of [...wanted].sort((a, b) => a - b)) {
			if (order >= HELD_ORDER_BASE) {
				continue;
			}
			const entry = this.rowsOf(filePath)?.get(order);
			if (entry) {
				moving.push(entry);
			}
		}
		return this.moveToHeldSeats(filePath, moving);
	}

	/**
	 * 行を保留席（`HELD_ORDER_BASE` 以降）へ移す共通処理。
	 *
	 * **同じ本文 hash の行は保留席に1つしか置かない。** 保留席の行は本文 hash の完全一致
	 * でしか拾われないため、同じ hash の行が2つあっても片方は永遠に使われない。同じ章を
	 * 消して貼り戻すたびに席が増えるのを防ぐ意味もある（増えるのは「消えたきり戻って
	 * こなかった、内容の異なる章」の数だけになる）。
	 *
	 * @param moving order 昇順に並んだ、保留席へ移す行
	 */
	private moveToHeldSeats(filePath: string, moving: readonly UnitStateEntry[]): number {
		if (moving.length === 0) {
			return 0;
		}
		// ここで読むのは席の採番のためだけ。書き込みは putRow / dropRow を通す
		const rows = this.rowsOf(filePath);
		let nextSeat = HELD_ORDER_BASE;
		const seatByHash = new Map<string, number>();
		for (const entry of rows?.values() ?? []) {
			if (isHeldBackEntry(entry)) {
				nextSeat = Math.max(nextSeat, entry.order + 1);
				if (entry.hash) {
					seatByHash.set(entry.hash, entry.order);
				}
			}
		}
		let parked = 0;
		for (const entry of moving) {
			this.dropRow(filePath, entry.order);
			// 同じ本文の席が既にあるなら、席は増やさず中身を新しいほうで置き換える。
			// hash が同じなら拾われ方は同じで、from / need は新しいほうが現在に近い
			const taken = entry.hash ? seatByHash.get(entry.hash) : undefined;
			const seat = taken ?? nextSeat++;
			this.putRow({ ...entry, order: seat });
			if (entry.hash) {
				seatByHash.set(entry.hash, seat);
			}
			if (taken === undefined) {
				parked++;
			}
		}
		return parked;
	}

	/**
	 * 指定した order の行を削除する。
	 *
	 * 保留席から拾い戻された行を席から外すために使う（`detachMarkers` が通常の order で
	 * 書き直すので、席に残すと同じ状態の行が二重になる）。
	 *
	 * @returns 削除されたエントリ数
	 */
	dropEntries(filePath: string, orders: readonly number[]): number {
		this.autoLoad();
		let removed = 0;
		for (const order of orders) {
			if (this.dropRow(filePath, order)) {
				removed++;
			}
		}
		return removed;
	}

	/**
	 * 指定パスの、order が fromOrder 以上の**通常の行**を削除する。
	 * ユニットが減ったときに末尾の旧エントリが残るのを防ぐ（detachMarkers から呼ぶ）。
	 *
	 * **保留席（`HELD_ORDER_BASE` 以降）の行は消さない。** 保留席の order は必ず
	 * いまのユニット数より大きいので、範囲で消すと「ユニット数が元に戻った瞬間に
	 * 保留席が全部消える」ことになり、席が本来の役目（本文が戻ってくるまで状態を
	 * 預かる）を果たせない。席の行を消すのは、拾い戻されたとき（`dropEntries`）と
	 * ファイルそのものを手放すとき（`removeEntriesByPath`）だけである（ADR-260809-01）。
	 *
	 * @returns 削除されたエントリ数
	 */
	pruneEntriesFrom(filePath: string, fromOrder: number): number {
		this.autoLoad();
		const rows = this.rowsOf(filePath);
		if (!rows) {
			return 0;
		}
		let removed = 0;
		for (const order of [...rows.keys()]) {
			if (order >= fromOrder && order < HELD_ORDER_BASE && this.dropRow(filePath, order)) {
				removed++;
			}
		}
		return removed;
	}

	/**
	 * 指定パスの**すべての**行の数（frontmatter の行も保留席も含む）。
	 *
	 * 「そのパスに行が1つでも在るか」を問うときだけ使う。**「訳文に守るべき状態が
	 * 残っているか」を問うのに使ってはならない** — frontmatter の行は本文が1つも
	 * 無くても在りうるので、本文の話をしているつもりで数えると常に1以上になる
	 * （`countBodyEntriesByPath` を使うこと）。
	 */
	countEntriesByPath(filePath: string): number {
		this.autoLoad();
		return this.rowsOf(filePath)?.size ?? 0;
	}

	/**
	 * 指定パスの**本文の行**の数（frontmatter の行を除く。保留席は含む）。
	 *
	 * 数え方は `getEntriesByPath` と同じで、配列を作らないだけの版である。
	 * 「訳文が空になったが状態は残っているか」「この訳文はまだ行を持っていないか」
	 * といった、**本文ユニットについての問い**はすべてこちらを通す。
	 *
	 * 保留席を含めるのは、席の行が「消えた章の from / need を預かっている」＝
	 * 守るべき状態そのものだからである。位置の話（末尾を刈るか）だけが席を
	 * 除いて数える（`countLiveEntriesByPath`）。
	 */
	countBodyEntriesByPath(filePath: string): number {
		this.autoLoad();
		let count = 0;
		for (const entry of this.rowsOf(filePath)?.values() ?? []) {
			if (!isFrontMatterEntry(entry)) {
				count++;
			}
		}
		return count;
	}

	/**
	 * 指定パスの、保留席に居ない行の数を返す。
	 *
	 * 末尾を刈るかどうかの判定（`shouldPruneTail`）はこちらを使う。保留席の行を数に
	 * 入れると、席がある間ずっと「行がユニットより多い」ことになり、席の数だけ
	 * 「減った」と誤って見える。席の行はもう位置を持っていないので、位置の話には数えない。
	 */
	countLiveEntriesByPath(filePath: string): number {
		this.autoLoad();
		let count = 0;
		for (const entry of this.rowsOf(filePath)?.values() ?? []) {
			if (isLiveBodyEntry(entry)) {
				count++;
			}
		}
		return count;
	}

	/**
	 * 指定パスの**本文の行**を order 昇順で返す（attachMarkers 用）。
	 *
	 * frontmatter の行は含めない。呼び出し側はどれも「本文ユニットの並び」を欲しがって
	 * いて、混ざると本文ユニットに化ける。frontmatter が要るときは
	 * `getFrontMatterEntry` を名指しで呼ぶ — 取り違えたときに黙って壊れるより、
	 * 呼び忘れて何も出ないほうが気づける。
	 */
	getEntriesByPath(filePath: string): UnitStateEntry[] {
		this.autoLoad();
		return [...(this.rowsOf(filePath)?.values() ?? [])]
			.filter((entry) => !isFrontMatterEntry(entry))
			.sort((a, b) => a.order - b.order);
	}

	/**
	 * そのパス、またはその配下に行があるか（＝mdait が以前から知っている場所か）。
	 *
	 * 移動への追随が「行き先は動いてきた先か、前から在った場所か」を見分けるために使う
	 * （`core/unit-state/rename-plan.ts` の `planEntryMoves`）。ディレクトリの移動も
	 * 同じ問いになるので配下まで見るが、走査するのは**パスの一覧**であって行の一覧では
	 * ないため、ワークスペース全体の行数には比例しない。
	 */
	hasEntriesAtOrUnder(filePath: string): boolean {
		this.autoLoad();
		if ((this.rowsOf(filePath)?.size ?? 0) > 0) {
			return true;
		}
		const prefix = `${filePath}/`;
		for (const known of this.byPath.keys()) {
			if (known.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	/** 指定パスの frontmatter マーカーの行（無ければ undefined） */
	getFrontMatterEntry(filePath: string): UnitStateEntry | undefined {
		this.autoLoad();
		return this.rowsOf(filePath)?.get(FRONT_MATTER_ORDER);
	}

	/**
	 * 指定パスの frontmatter マーカーの行を書く。
	 *
	 * `hash` が空なら行を消す（マーカーが消えた状態を空の行として残さない）。
	 */
	setFrontMatterEntry(filePath: string, marker: { hash: string; from: string; need: string }): void {
		this.autoLoad();
		if (!marker.hash) {
			this.removeFrontMatterEntry(filePath);
			return;
		}
		this.putRow({
			path: filePath,
			order: FRONT_MATTER_ORDER,
			level: 0,
			titleHash: "",
			hash: marker.hash,
			from: marker.from,
			need: marker.need,
		});
	}

	/** 指定パスの frontmatter マーカーの行を消す */
	removeFrontMatterEntry(filePath: string): void {
		this.autoLoad();
		this.dropRow(filePath, FRONT_MATTER_ORDER);
	}

	/** need != '' のエントリ一覧 */
	getEntriesNeedingAction(): UnitStateEntry[] {
		this.autoLoad();
		return [...this.allEntries()].filter((e) => e.need !== "");
	}

	/** 全エントリを返す */
	getAllEntries(): UnitStateEntry[] {
		this.autoLoad();
		return [...this.allEntries()];
	}

	/**
	 * 不要になったエントリを削除する。extensions設定変更後の残留エントリクリーンアップ用。
	 * 同一pathの全order行がまとめて削除される。
	 *
	 * 行を3つに切り分ける（docs/design/unit-state.md §8）。
	 *
	 * 1. **config のどの pair のディレクトリにも属さない** → 消す。
	 *    ペアを設定から外した・ディレクトリ構成を変えた場合で、もうプロジェクトの一部ではない。
	 * 2. **config には載っているが今回走査していない** → 残す。
	 *    未選択の pair・sparse checkout・ブランチ切替。「実体が無い」ことを確かめていない。
	 * 3. **config に載っていて走査もしたが見つからなかった** → 消す。
	 *    extensions を変えて管理対象から外れたファイルなど。
	 *    ただし**その訳文がディスクに実在し、導出した原文だけが失われている**なら消さない。
	 *    それは「孤立した訳文」であって管理対象から外れたファイルではない（ADR-260806-01）。
	 *    走査で見つからないのは、走査が原文ディレクトリを起点にしていて原文が消えているためで、
	 *    訳文そのものは手つかずでそこにある。
	 *
	 * 軸が2つあるのは、選択が一時的なもので config が恒久的なものだからである。
	 * 選択だけを見るとプロジェクトの全体像が分からず、掃除が永久に効かなくなる。
	 *
	 * @returns 削除されたエントリ数
	 */
	cleanupOrphansInScope(scope: UnitStateScanScope): number {
		this.autoLoad();
		if (scope.configuredDirs.length === 0) {
			// 設定が読めていない・pair が1つも無い。全行を消しかねないので何もしない
			return 0;
		}
		// 判定はパス単位なので、行ごとではなくパスごとに1回だけ問う
		let removed = 0;
		const removedPaths: string[] = [];
		for (const [filePath, rows] of [...this.byPath.entries()]) {
			if (!shouldRemoveEntryPath(filePath, scope)) {
				continue;
			}
			removed += rows.size;
			removedPaths.push(filePath);
			this.dropPath(filePath);
		}
		if (removed > 0) {
			logger.debug("unit-state", "Removed unit-state entries that are no longer part of the project", {
				paths: removedPaths.slice(0, 20),
				removed,
			});
		}
		return removed;
	}
}

/**
 * 掃除の判断に使う範囲。
 *
 * どのパスもワークスペースルート相対・`/` 区切りで、`UnitStateEntry.path` と同じ基準にそろえる。
 */
export interface UnitStateScanScope {
	/** config の全 pair のディレクトリ（選択の有無に関わらず。末尾の `/` は不要） */
	configuredDirs: readonly string[];
	/** 今回実際に走査したディレクトリ（選択され、かつ1件以上のファイルを見つけたもの） */
	scannedDirs: readonly string[];
	/** 走査して実在を確認したファイル */
	seenPaths: ReadonlySet<string>;
	/**
	 * そのパスにファイルが実在するか。
	 *
	 * ファイルシステムは core からは触れないため、呼び出し側が与える。
	 * 省略時は常に偽（＝この規則が無かった頃と同じ挙動）。
	 */
	fileExists?: (filePath: string) => boolean;
}

/** 1行を消すべきか（`cleanupOrphansInScope` の判定本体。テスト用に公開） */
export function shouldRemoveEntryPath(filePath: string, scope: UnitStateScanScope): boolean {
	if (!isPathInDirs(filePath, scope.configuredDirs)) {
		return true; // 1. もうプロジェクトの一部ではない
	}
	if (!isPathInDirs(filePath, scope.scannedDirs)) {
		return false; // 2. 見に行っていないので分からない
	}
	if (scope.seenPaths.has(filePath)) {
		return false; // 3. 見に行って見つかった
	}
	// 4. 走査した一覧に無いが、**ファイルはそこに在る**。消さない。
	//
	//    「そのディレクトリを走査した」と「そのファイルを探した」は別である。走査の一覧に
	//    載らない理由は消えたことだけではない — `ignoredPatterns` で外した・`trans.extensions`
	//    から拡張子を外した・原文が消えて訳文だけ残った（孤立訳文）。**どれも「見に行って
	//    無かった」ではなく「初めから探していない」**なので、3分割の 2 と同じ側に属する。
	//
	//    行を消すと `from`（どの原文から訳したか）が失われる。これは本文から計算し直せない
	//    唯一の情報で、失うと除外を解いた瞬間に人の訳が `need:translate` ＝ AI が上書きして
	//    よい状態に戻る。実体が在るあいだは持っておく（ADR-260806-01 の備考どおり）。
	//
	//    掃除が効かなくなることは無い。ファイルが本当に消えればここは偽になって行も消える。
	//    残る行の数はディスクに在るファイルの数で頭打ちになる（§13 の「掃除が永久に効かない」
	//    はディレクトリを見に行かなくなる話で、こちらは実体に紐づいている）。
	return !(scope.fileExists?.(filePath) ?? false);
}

/**
 * パスが与えられたディレクトリのいずれかの配下にあるかを判定する。
 * `content/en` が `content/en2/x.md` に誤一致しないよう、区切り文字まで含めて比較する。
 */
export function isPathInDirs(filePath: string, dirs: readonly string[]): boolean {
	for (const dir of dirs) {
		const normalized = dir.replace(/\/+$/, "");
		if (normalized === "") {
			// ワークスペースルート自体が対象なら全てが範囲内
			return true;
		}
		if (filePath.startsWith(`${normalized}/`)) {
			return true;
		}
	}
	return false;
}
