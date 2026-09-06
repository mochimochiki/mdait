import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../../infra/logging/logger";
import { atomicWriteFileSync } from "../../infra/workspace/atomic-write";
import { calculateHash } from "../hash/hash-calculator";
import { assignSeats, isSeatKey } from "./seat-keys";

const logger = Logger.getInstance();

/** unit-stateファイル名 */
const UNIT_STATE_FILENAME = "unit-state";

/** ヘッダーコメント行 */
const HEADER_LINES = [
	"# mdait unit-state — 翻訳ユニットの状態管理",
	"# path\tkind\tseat\tlevel\ttitleHash\thash\tfrom\tneed",
];

/** TSVのカラム数 */
const EXPECTED_COLUMN_COUNT = 8;

/** 旧形式（`path order level titleHash hash from need`）のカラム数 */
const LEGACY_COLUMN_COUNT = 7;

/** 読み取りに傷があった回に、上書きの直前で原本を写す先 */
const SALVAGE_FILENAME = "unit-state.broken";

/** ディレクトリごとに置く区画の数 */
const BUCKETS_PER_DIR = 64;

/** ファイルごとの「席に着いていない行を置く区画」の見出しに付ける印 */
const UNSEATED_SECTION_SUFFIX = "[unseated]";

/** 合流で残る競合マーカーの行か（`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>`） */
function isConflictMarkerLine(line: string): boolean {
	return /^(<{7}|\|{7}|={7}|>{7})(\s|$)/.test(line);
}

/**
 * 行の種別。**桁のトリックではなく、独立した列で表す。**
 *
 * かつては `order` の桁で見分けていた（100万以上なら保留席、200万なら frontmatter）。
 * 種別が1つ増えるたびに桁を読む場所を全部直して回ることになり、必ずどこかが取り残される
 * （実測: frontmatter の行が増えたとき、数える側が2箇所取り残された）。
 *
 * - `unit` … いまの本文のどこかに対応する行。席のキー（`seat`）で並ぶ
 * - `held` … 消えた章の状態を預かっている行。位置は持たない。**本文の hash が身元**
 * - `front` … frontmatter マーカーの行。1ファイルに1つだけ。本文の並びに属さない
 */
export type UnitStateKind = "unit" | "held" | "front";

const KINDS: readonly UnitStateKind[] = ["unit", "held", "front"];

/** その文字列が行の種別か */
function toKind(value: string): UnitStateKind | undefined {
	return (KINDS as readonly string[]).includes(value) ? (value as UnitStateKind) : undefined;
}

/**
 * 読み取れなかったもの・畳んだものの内訳。すべて 0 なら、ファイルは丸ごと読めている。
 */
export interface UnitStateParseReport {
	/** 形が分からず読み飛ばした行数 */
	skipped: number;
	/** 合流の競合マーカーとして読み飛ばした行数 */
	conflictMarkers: number;
	/** 同じ席に2行以上来たので、席を分けた回数 */
	duplicates: number;
	/** 旧形式（7列）から読み替えた行数 */
	migrated: number;
}

/** 傷なく読み切れたか */
export function isCleanParse(report: UnitStateParseReport): boolean {
	return report.skipped === 0 && report.conflictMarkers === 0 && report.duplicates === 0;
}

/**
 * 同じ席に2行来たとき、席に残すほうを決める。
 *
 * **どちらを選んでも正しさは変わらない。** 席の意味（本文の何番目か）は次の sync が
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

/** 2つの行が全列とも同じか（＝ファイルに書けば1バイトも違わないか） */
function sameRow(a: UnitStateEntry, b: UnitStateEntry): boolean {
	return (
		a.path === b.path &&
		a.kind === b.kind &&
		a.seat === b.seat &&
		a.level === b.level &&
		a.titleHash === b.titleHash &&
		a.hash === b.hash &&
		a.from === b.from &&
		a.need === b.need
	);
}

/** frontmatter マーカーの行か */
export function isFrontMatterEntry(entry: UnitStateEntry): boolean {
	return entry.kind === "front";
}

/**
 * 席に着いていない行か（＝いまの本文に対応する場所が無い行）。
 *
 * 順序では拾われず、**本文の hash が完全に一致したときだけ**拾い戻される
 * （`unit-state-align.ts`）。だから章が戻ってくれば正しく復帰し、戻ってこなければ
 * 無害に居座るだけになる。
 */
export function isHeldBackEntry(entry: UnitStateEntry): boolean {
	return entry.kind === "held";
}

/** いまの本文の**位置**を持っている行か */
export function isLiveBodyEntry(entry: UnitStateEntry): boolean {
	return entry.kind === "unit";
}

/**
 * 行の身元。ファイルの中で1行を指す鍵になる。
 *
 * - `unit` … 席のキー。二度と動かないので、章を1つ挿しても他の行は書き換わらない
 * - `held` … 本文の hash。**同じ本文の行は席に1つしか要らない**（拾い戻しは完全一致
 *   だけなので、同じ hash が2つあっても片方は永遠に使われない）。鍵にしておけば、
 *   同じ章を消して貼り戻すたびに行が増えることが構造的に起きない
 * - `front` … 1ファイルに1つなので、種別そのものが鍵になる
 */
export function entryKey(entry: UnitStateEntry): string {
	if (entry.kind === "unit") {
		return `u${entry.seat}`;
	}
	if (entry.kind === "held") {
		return `h${entry.hash}`;
	}
	return "f";
}

/**
 * ファイルの中で行を並べる順。**席のある行が先、席に着いていない行が後ろ。**
 *
 * 席に着いていない行は「増えたり減ったりする行」なので、まとめて後ろへ置き、
 * 手前に区画の見出しを挟む。そうしないと、増える場所が最後の章の行の隣になって
 * 合流でぶつかる（`save` の `openTail` を見よ）。
 */
function rowOrder(entry: UnitStateEntry): string {
	if (entry.kind === "unit") {
		return `0${entry.seat}`;
	}
	return entry.kind === "front" ? "1" : `2${entry.hash}`;
}

/**
 * 旧形式（`path order level titleHash hash from need`）の1行を読み替える。
 *
 * 旧形式は行の種別を `order` の桁で表していた（100万以上なら保留席、200万なら
 * frontmatter）。本文の行の席のキーは、そのファイルの行をすべて読んで並びが
 * 決まってからでないと配れないので、ここでは `order` をそのまま返す。
 *
 * @returns 読めなければ `undefined`
 */
function readLegacyLine(columns: readonly string[]): { order: number; entry: UnitStateEntry } | undefined {
	const [filePath, orderStr, levelStr, titleHash, hash, from, need] = columns;
	const order = Number.parseInt(orderStr, 10);
	const level = Number.parseInt(levelStr, 10);
	if (Number.isNaN(order) || Number.isNaN(level)) {
		return undefined;
	}
	const kind: UnitStateKind = order >= 2_000_000 ? "front" : order >= 1_000_000 ? "held" : "unit";
	return { order, entry: { path: filePath, kind, seat: "", level, titleHash, hash, from, need } };
}

/**
 * unit-stateエントリ。
 * 非MDファイルは「ファイル＝単一ユニット」（`unit` 1行・level=0・titleHash=""）の特殊形、
 * MD-external は同一 path に複数の `unit` 行を持つ。
 */
export interface UnitStateEntry {
	/** ワークスペース相対パス（/区切り） */
	path: string;
	/** 行の種別 */
	kind: UnitStateKind;
	/** 席のキー（`unit` のときだけ意味を持つ。`held` / `front` は ""） */
	seat: string;
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
	 * `path` → (行の身元 → 行) の二段。
	 *
	 * ファイル単位の操作（読み出し・件数・席の上げ下ろし・刈り取り・移動）が**ワークスペース全体の
	 * 行数ではなく、そのファイルの行数にしか比例しない**ようにするための形である。
	 * 平坦な `Map` に索引を別途持たせる手もあるが、索引と本体がずれる余地を作らずに済む。
	 *
	 * 副次的に、キーに NUL を使わなくなったので `git diff` がこのファイルをテキストとして
	 * 扱うようになった（以前は `--text` を付けないと差分が出なかった）。
	 */
	private byPath: Map<string, Map<string, UnitStateEntry>> = new Map();
	/**
	 * **まだディスクへ書いていない変更**。`path` → (行の身元 → 行、または `null`＝消したこと)。
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
	private pending: Map<string, Map<string, UnitStateEntry | null>> = new Map();
	private dirty = false;
	private loaded = false;
	private mdaitDir: string | undefined;
	/** 直近の読み取りの内訳 */
	private lastParseReport: UnitStateParseReport = { skipped: 0, conflictMarkers: 0, duplicates: 0, migrated: 0 };
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
	private rowsOf(filePath: string): Map<string, UnitStateEntry> | undefined {
		return this.byPath.get(filePath);
	}

	/** そのファイルの行（無ければ作る）。書き込みの用途に使う */
	private ensureRows(filePath: string): Map<string, UnitStateEntry> {
		const rows = this.byPath.get(filePath);
		if (rows) {
			return rows;
		}
		const created = new Map<string, UnitStateEntry>();
		this.byPath.set(filePath, created);
		return created;
	}

	/**
	 * 1行を消す。**そのファイルの行が空になったら path ごと畳む。**
	 * 畳まないと、消えたファイルの分だけ空の入れ物が残り、全走査がその数に比例して重くなる。
	 */
	private deleteRow(filePath: string, key: string): boolean {
		const rows = this.byPath.get(filePath);
		if (!rows?.delete(key)) {
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
	private recordPending(filePath: string, key: string, entry: UnitStateEntry | null): void {
		const rows = this.pending.get(filePath);
		if (rows) {
			rows.set(key, entry);
			return;
		}
		this.pending.set(filePath, new Map([[key, entry]]));
	}

	/**
	 * 1行を書く。**表を書き換える入口はここと `dropRow` / `dropPath` の3つだけ。**
	 *
	 * 直に `byPath` を触ると保存待ちの記録から漏れ、`load()` の割り込みでその変更だけが
	 * 静かに消える。漏れは実行時にしか現れないので、入口を絞って構造的に防ぐ。
	 */
	private putRow(entry: UnitStateEntry): void {
		const rows = this.ensureRows(entry.path);
		const key = entryKey(entry);
		const sitting = rows.get(key);
		if (sitting && sameRow(sitting, entry)) {
			// **同じ値を入れ直しただけなら、何も起きなかったことにする。**
			//
			// sync は毎回すべてのユニットを書き戻すので、1文字も変わっていない回でも
			// ここが全行分呼ばれる。無条件に `dirty` を立てると、そのたびに
			// `.mdait/unit-state` の更新時刻が動き、SVN や git から見て「変わった」
			// ファイルになる。翻訳を1つも触っていない日でもコミットに載り、
			// 中身が同じ行同士の合流を毎回起こすことになる。
			//
			// `pending` にも積まない。積むと `load()` の割り込みのあとで
			// 「読み直した値を、同じ値で上書きする」だけの当て直しが走り、
			// `replayPending` が `dirty` を立てるので結局書いてしまう。
			return;
		}
		rows.set(key, entry);
		this.recordPending(entry.path, key, entry);
		this.dirty = true;
	}

	/** 1行を消す。消したことも保存待ちとして覚える（`putRow` を見よ） */
	private dropRow(filePath: string, key: string): boolean {
		if (!this.deleteRow(filePath, key)) {
			return false;
		}
		this.recordPending(filePath, key, null);
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
		for (const key of rows.keys()) {
			this.recordPending(filePath, key, null);
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
			for (const [key, entry] of rows) {
				if (entry === null) {
					this.deleteRow(filePath, key);
				} else {
					this.ensureRows(filePath).set(key, entry);
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
		const report: UnitStateParseReport = { skipped: 0, conflictMarkers: 0, duplicates: 0, migrated: 0 };
		// 旧形式（7列・`order` が数）の行は、そのファイルの分をすべて読んでからでないと
		// 席のキーへ読み替えられない（並びが分からないと隣が決まらない）ので、いったん貯める
		const legacy = new Map<string, Array<{ order: number; entry: UnitStateEntry }>>();

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
			if (columns.length === LEGACY_COLUMN_COUNT) {
				const converted = readLegacyLine(columns);
				if (!converted) {
					report.skipped++;
					logger.warn("unit-state", "Skipping malformed legacy line", { line: line.substring(0, 100) });
					continue;
				}
				report.migrated++;
				if (converted.entry.kind === "unit") {
					const bucket = legacy.get(converted.entry.path);
					if (bucket) {
						bucket.push(converted);
					} else {
						legacy.set(converted.entry.path, [converted]);
					}
				} else {
					this.seatOnLoad(converted.entry, report);
				}
				continue;
			}

			if (columns.length !== EXPECTED_COLUMN_COUNT) {
				report.skipped++;
				logger.warn("unit-state", "Skipping malformed line (expected 8 columns)", {
					columnCount: columns.length,
					line: line.substring(0, 100),
				});
				continue;
			}

			const [filePathCol, kindStr, seat, levelStr, titleHash, hash, from, need] = columns;
			const kind = toKind(kindStr);
			const level = Number.parseInt(levelStr, 10);
			if (!kind || Number.isNaN(level)) {
				report.skipped++;
				logger.warn("unit-state", "Skipping line with an unknown kind or level", {
					line: line.substring(0, 100),
				});
				continue;
			}
			if (kind === "unit" && !isSeatKey(seat)) {
				report.skipped++;
				logger.warn("unit-state", "Skipping unit line with a malformed seat key", {
					line: line.substring(0, 100),
				});
				continue;
			}

			this.seatOnLoad(
				{ path: filePathCol, kind, seat: kind === "unit" ? seat : "", level, titleHash, hash, from, need },
				report,
			);
		}

		// 旧形式の本文行を、並びの順に席へ着ける。**同じ `order` の行が2つあれば
		// 合流の取りこぼしなので、片方は席から降ろす**（どちらも捨てない）
		for (const rows of legacy.values()) {
			rows.sort((a, b) => a.order - b.order || seatPriority(a.entry).localeCompare(seatPriority(b.entry)));
			const winners: UnitStateEntry[] = [];
			for (const row of rows) {
				if (winners.length > 0 && row.order === rows[rows.indexOf(row) - 1].order) {
					report.duplicates++;
					this.seatOnLoad({ ...row.entry, kind: "held", seat: "" }, report);
					continue;
				}
				winners.push(row.entry);
			}
			const seats = assignSeats(new Array(winners.length).fill(undefined));
			winners.forEach((entry, i) => {
				this.seatOnLoad({ ...entry, seat: seats[i] }, report);
			});
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
	 * 溢れた行は席から降ろす（`kind: "held"`）。席に着いていない行は本文 hash の
	 * 完全一致でしか拾われないので（`unit-state-align.ts`）、**弱い手掛かりで取り違える
	 * ことが構造的に起きない**。原稿がその陣営の版だったときだけ、自動で戻る。
	 */
	private seatOnLoad(entry: UnitStateEntry, report: UnitStateParseReport): void {
		const rows = this.ensureRows(entry.path);
		const key = entryKey(entry);
		const sitting = rows.get(key);
		if (!sitting) {
			rows.set(key, entry);
			return;
		}
		if (sameRow(sitting, entry)) {
			return; // まったく同じ行が2度来ただけ。畳んでも何も失われない
		}

		report.duplicates++;
		// 席に残すほうと、席から降ろすほうを、読んだ順に依らず決める
		const [stays, leaves] = seatPriority(entry) < seatPriority(sitting) ? [entry, sitting] : [sitting, entry];
		rows.set(key, stays);

		// 降ろしたほうは席を持たない行（`held`）にする。**本文の hash が身元**なので、
		// 同じ本文の行が既に居れば増えないし、次に本文が戻ってくれば拾い戻される
		if (!leaves.hash) {
			return; // 本文 hash が無い行は拾い戻せない。預けても席が埋まるだけ
		}
		const held: UnitStateEntry = { ...leaves, kind: "held", seat: "" };
		const heldKey = entryKey(held);
		if (!rows.has(heldKey)) {
			rows.set(heldKey, held);
		}
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
		if (report.migrated > 0) {
			// 旧形式を読み替えただけで、失ったものは無い。新しい形で書き戻したいので
			// `dirty` は立てるが、原本の避難（`needsSalvage`）は要らない
			this.dirty = true;
			logger.info("unit-state", "Read rows written in the previous format and converted them", {
				migrated: report.migrated,
			});
		}
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
			return c !== 0 ? c : rowOrder(a).localeCompare(rowOrder(b));
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
		let tailOpened = false;
		let needBlank = false;
		const fillBuckets = (dir: string, upTo: number) => {
			while (bucketCursor < upTo) {
				lines.push(`# ${dir}[${bucketCursor.toString(16).padStart(2, "0")}]`);
				bucketCursor++;
			}
		};
		// ファイルごとに「席に着いていない行（`held` / `front`）を置く区画」を、**行が1つも
		// 無くても常に開ける。**
		//
		// それらの行は本文の行のうしろに並ぶ。章を1つ消すと、その行が `held` へ移って
		// **ブロックの末尾に1行増える** — 増える場所がちょうど最後の章の行の隣なので、
		// 同じ記事の最後の章を別の枝が直していると必ず競合する（実測 S10）。区画をいつも
		// 開けておけば、増える行は「見出しと空行のうしろ」に入るので、最後の章の行との
		// あいだに変わらない行が3つ挟まる。見出しはローダーが読み飛ばす。
		const openTail = () => {
			if (prevPath === undefined || tailOpened) {
				return;
			}
			lines.push("", `# ${prevPath} ${UNSEATED_SECTION_SUFFIX}`, "");
			tailOpened = true;
			needBlank = false;
		};
		for (const entry of sortedEntries) {
			if (entry.path !== prevPath) {
				openTail();
				const dir = dirOf(entry.path);
				if (dir !== prevDir) {
					if (prevDir !== undefined) fillBuckets(prevDir, BUCKETS_PER_DIR);
					bucketCursor = 0;
					prevDir = dir;
				}
				fillBuckets(dir, bucketOf(entry.path) + 1);
				lines.push("", `# ${entry.path}`, "");
				prevPath = entry.path;
				tailOpened = false;
				needBlank = false;
			}
			if (!isLiveBodyEntry(entry)) {
				openTail();
			}
			if (needBlank) {
				// **行と行のあいだにも空行を1つ置く。**
				//
				// 3方向マージは「変えた行が隣り合っている」だけで競合を出す。挟むものが
				// 何も無いと、同じ記事の**隣り合う章**を2人が別々に訳しただけで人の手が
				// 要る（実測 S6: 第1章と第2章をそれぞれ改訂 → git も diff3 も競合）。
				// あいだに1行でも変わらない行があれば、どちらの変更もそのまま通る。
				//
				// 空行はローダーが読み飛ばすので、**形式は1バイトも変わらない**
				// （古い版の mdait もそのまま読める）。増えるのは行数だけで、
				// 1行あたり1バイトしか太らない。
				lines.push("");
			}
			lines.push(
				`${entry.path}\t${entry.kind}\t${entry.seat}\t${entry.level}\t${entry.titleHash}\t${entry.hash}\t${entry.from}\t${entry.need}`,
			);
			needBlank = true;
		}

		openTail();
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

	/**
	 * 「ファイル＝単一ユニット」の行を返す（非Markdown の訳文・原文）。
	 *
	 * かつては `getEntry(path, 0)` と書いていた。`0` が「先頭の席」ではなく「その
	 * ファイルの唯一の行」を意味していることは呼び出し側にしか無く、席のキーが
	 * 位置を表さなくなった今は名前で言うほうが正しい。**Markdown には使わない**
	 * （複数の席があるので「唯一の行」が定義できない）。
	 */
	getSoleEntry(filePath: string): UnitStateEntry | undefined {
		this.autoLoad();
		for (const entry of this.rowsOf(filePath)?.values() ?? []) {
			if (isLiveBodyEntry(entry)) {
				return entry;
			}
		}
		return undefined;
	}

	/** 席のキーで本文の行を引く（無ければ undefined） */
	getUnitEntry(filePath: string, seat: string): UnitStateEntry | undefined {
		this.autoLoad();
		return this.rowsOf(filePath)?.get(`u${seat}`);
	}

	/** 本文の hash で、席に着いていない行を引く（無ければ undefined） */
	getHeldEntry(filePath: string, hash: string): UnitStateEntry | undefined {
		this.autoLoad();
		return this.rowsOf(filePath)?.get(`h${hash}`);
	}

	/** 席のキーで本文の行を消す */
	removeUnitEntry(filePath: string, seat: string): void {
		this.autoLoad();
		this.dropRow(filePath, `u${seat}`);
	}

	/** 「ファイル＝単一ユニット」の行を書く（`getSoleEntry` を見よ） */
	setSoleEntry(filePath: string, marker: { hash: string; from: string; need: string }): void {
		this.autoLoad();
		const sitting = this.getSoleEntry(filePath);
		this.putRow({
			path: filePath,
			kind: "unit",
			seat: sitting?.seat ?? assignSeats([undefined])[0],
			level: 0,
			titleHash: "",
			hash: marker.hash,
			from: marker.from,
			need: marker.need,
		});
	}

	setEntry(entry: UnitStateEntry): void {
		this.autoLoad();
		this.putRow(entry);
	}

	/** 1行を消す */
	removeEntry(entry: UnitStateEntry): void {
		this.autoLoad();
		this.dropRow(entry.path, entryKey(entry));
	}

	/**
	 * 指定パスの行をすべて削除する（席に着いていない行も含む）。
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
	 * 元々持っていた行のうち席のキーが重ならなかったものだけが残り、次の parse で
	 * 「余った行」として別の章に拾われる。移動は上書きであって併合ではない。
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
	 * 指定した席の行を、席から降ろす（`held` にする）。
	 *
	 * 末尾かどうかではなく「**いまの本文に対応が付かなかった**」ことを根拠に退避する。
	 * 文書の途中の章が1つ消えたとき、sync が原文からその章を作り直すのでユニット数は
	 * 元に戻るため、位置で見ていると何も拾えない。対応が付かなかった事実を
	 * 知っているのは読み込み時（`alignEntriesToUnits`）だけなので、そこから運ばれた
	 * 席のキーをそのまま受け取る（`MarkerFileContext.alignment`）。
	 *
	 * **同じ本文 hash の行は1つしか置かない。** 席に着いていない行は本文 hash の完全一致
	 * でしか拾われないため、同じ hash の行が2つあっても片方は永遠に使われない。同じ章を
	 * 消して貼り戻すたびに行が増えるのを防ぐ意味もある（増えるのは「消えたきり戻って
	 * こなかった、内容の異なる章」の数だけになる）。身元が hash なので、この重複除去は
	 * 数える必要すらなく**構造的に**起きる。
	 *
	 * @param filePath 対象ファイル（ワークスペース相対）
	 * @param seats 退避する行の席のキー
	 * @returns 新たに預かった行の数（既に同じ本文を預かっていた分は数えない）
	 */
	parkEntries(filePath: string, seats: readonly string[]): number {
		this.autoLoad();
		if (seats.length === 0) {
			return 0;
		}
		const rows = this.rowsOf(filePath);
		let parked = 0;
		for (const seat of [...new Set(seats)].sort()) {
			const entry = rows?.get(`u${seat}`);
			if (!entry) {
				continue;
			}
			this.dropRow(filePath, `u${seat}`);
			if (!entry.hash) {
				continue; // 本文 hash が無い行は拾い戻せない。預けても行が増えるだけ
			}
			const held: UnitStateEntry = { ...entry, kind: "held", seat: "" };
			// 同じ本文を既に預かっているなら、中身を新しいほうで置き換える（数には入れない）。
			// hash が同じなら拾われ方は同じで、from / need は新しいほうが現在に近い
			const taken = rows?.has(entryKey(held)) ?? false;
			this.putRow(held);
			if (!taken) {
				parked++;
			}
		}
		return parked;
	}

	/**
	 * 席に着いていない行を、本文 hash を指定して消す。
	 *
	 * 本文が戻ってきて拾い戻された行を外すために使う（`detachMarkers` が席のキーで
	 * 書き直すので、残すと同じ状態の行が二重になる）。
	 *
	 * @returns 削除されたエントリ数
	 */
	dropHeldEntries(filePath: string, hashes: readonly string[]): number {
		this.autoLoad();
		let removed = 0;
		for (const hash of hashes) {
			if (this.dropRow(filePath, `h${hash}`)) {
				removed++;
			}
		}
		return removed;
	}

	/**
	 * 指定した席の行を消す。
	 *
	 * @returns 削除されたエントリ数
	 */
	dropEntries(filePath: string, seats: readonly string[]): number {
		this.autoLoad();
		let removed = 0;
		for (const seat of seats) {
			if (this.dropRow(filePath, `u${seat}`)) {
				removed++;
			}
		}
		return removed;
	}

	/**
	 * 指定パスの**すべての**行の数（frontmatter の行も、席に着いていない行も含む）。
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
	 * 指定パスの**本文の行**の数（frontmatter の行を除く。席に着いていない行は含む）。
	 *
	 * 数え方は `getEntriesByPath` と同じで、配列を作らないだけの版である。
	 * 「訳文が空になったが状態は残っているか」「この訳文はまだ行を持っていないか」
	 * といった、**本文ユニットについての問い**はすべてこちらを通す。
	 *
	 * 席に着いていない行を含めるのは、その行が「消えた章の from / need を預かっている」＝
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
	 * 指定パスの、席に着いている行の数を返す。
	 *
	 * 刈るかどうかの判定（`shouldPruneTail`）はこちらを使う。席に着いていない行を数に
	 * 入れると、預かっている間ずっと「行がユニットより多い」ことになり、その数だけ
	 * 「減った」と誤って見える。預かりの行はもう位置を持っていないので、位置の話には数えない。
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
	 * 指定パスの**本文の行**を並び順で返す（attachMarkers 用）。席のある行が先、
	 * 席に着いていない行が後ろに来る。
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
			.sort((a, b) => rowOrder(a).localeCompare(rowOrder(b)));
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
		return this.rowsOf(filePath)?.get("f");
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
			kind: "front",
			seat: "",
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
		this.dropRow(filePath, "f");
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
