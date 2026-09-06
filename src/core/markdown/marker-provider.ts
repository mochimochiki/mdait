import { Logger } from "../../infra/logging/logger";
import { calculateHash } from "../hash/hash-calculator";
import { isSuspiciousShrink } from "../matching/shrink-guard";
import { assignSeats } from "../unit-state/seat-keys";
import { alignEntriesToUnits } from "../unit-state/unit-state-align";
import {
	type UnitStateEntry,
	UnitStateStore,
	isHeldBackEntry,
	isLiveBodyEntry,
} from "../unit-state/unit-state-store";
import type { FrontMatter } from "./front-matter";
import {
	FRONTMATTER_MARKER_KEY,
	parseFrontmatterMarker,
	serializeFrontmatterMarker,
} from "./frontmatter-translation";
import { MdaitMarker } from "./mdait-marker";
import type { MdaitUnit } from "./mdait-unit";

const logger = Logger.getInstance();

/**
 * マーカーの保管先を解決するためのファイルコンテキスト
 *
 * external では対象ファイルのパスをキーに外部ストアを引くため必要になる。
 * embedded（既定）では未使用。
 */
export interface MarkerFileContext {
	/** 対象ファイルの絶対パス（external でストア検索に使う。embedded では未使用） */
	filePath?: string;
	/** "source" | "target"（現状は両ロール同一処理。呼び出し側の文脈提示用） */
	role?: "source" | "target";
	/**
	 * 読み込み時の照合結果の控え。`attachMarkers` が書き、`detachMarkers` が読んで消す。
	 *
	 * 「この行はいまの本文のどこにも対応が付かなかった」と分かるのは**読み込み時**だけで、
	 * 席から降ろすかどうかを決めているのは**書き出し時**である。あいだで sync が原文から
	 * 消えた章を作り直すため、書き出し側はユニット数が元に戻った姿しか見ておらず、
	 * 「減った」という事実に一度も触れない（roadmap-v01 の P03）。その事実を運ぶための控え。
	 *
	 * 同じ ctx で parse → stringify する呼び出しでだけ効く。控えが無ければ書き出し側が
	 * その場で照合し直すので、ctx を共有しない呼び出し（markers-migration の中間
	 * stringify・embed 経路）でも席は動かない。
	 */
	alignment?: MarkerAlignmentMemo;
	/**
	 * この書き換えが「人が明示的に頼んだ削除」か（ユニットの削除・verify-deletion の一括削除）。
	 *
	 * 立っていると、どのユニットにも対応しなかった行を**席へ預けず刈る**。
	 * 走査の副作用で減ったのではなく人が消したと分かっているので、預ける相手がいない。
	 * ユニットが0件になる形（最後の1ユニットを消した）も含めて刈る。
	 */
	deliberateDeletion?: boolean;
}

/**
 * 読み込み時の照合結果のうち、書き出し時の判断に要る分だけの控え。
 *
 * 行そのものではなく `order` で覚える。控えを取ってから使うまでのあいだにストアが
 * 書き換わりうるので（`movePath` など）、そのときのストアを正として引き直す。
 */
export interface MarkerAlignmentMemo {
	/**
	 * 対応が付かなかった行の席のキー。席から降ろす候補。
	 *
	 * `from` も `need` も持たない行は含めない。本文から計算し直せる行を預かっても、
	 * 守るものが無いまま行が増えるだけである。
	 */
	readonly unmatchedSeats: readonly string[];
	/**
	 * 席に着いていない行から拾い戻された行の本文 hash。その行を消す。
	 *
	 * 書き出しが席のキーで書き直すため、残すと同じ状態の行が二重になる。
	 */
	readonly recoveredHeldHashes: readonly string[];
	/**
	 * ユニットごとの「いま座っている席」。**添字ではなくユニットそのものを鍵にする。**
	 *
	 * 書き出しはこれを見て席を据え置く。読み込み時にしか分からない（書き出し側は sync が
	 * 作り直したあとの姿しか見ていない）ので、控えとして運ぶ。
	 *
	 * 添字で覚えてはいけない。読み込みと書き出しのあいだで sync がユニットを差し替えるため、
	 * **「章を1つ消して1つ足す」だけで添字がずれる**（長さは同じままなので気づけない）。
	 * 実測では、それだけで削除点より後ろの席が全部書き換わっていた — つまりこの仕組みが
	 * いちばん潰したかった「ブロック丸ごとの書き換え」がそのまま残っていた。
	 */
	readonly seatByUnit: ReadonlyMap<MdaitUnit, string>;
}

/**
 * マーカーの「出し入れ口」を抽象化する Strategy。
 *
 * 埋め込みマーカーは「境界生成」と「物理追従」を密結合で担っている。
 * パーサー内部に if 分岐を増やさず、マーカーの永続化方式を差し替えられるよう、
 * parse/stringify にこの Provider を注入する。
 *
 * - embedded（既定）: マーカーは本文に埋め込まれるため attach/detach は no-op。
 * - external: 外部ストア `.mdait/unit-state` と attach/detach で橋渡しする。
 */
export interface MarkerProvider {
	readonly mode: "embedded" | "external";
	/** 境界生成にマーカーを使うか（embedded=true, external=false） */
	readonly markersFormBoundaries: boolean;
	/** parse 後: 外部由来マーカーをユニットに後付けする（embedded は no-op） */
	attachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void;
	/** stringify 前: ユニットからマーカーを引き取り永続化する（embedded は no-op） */
	detachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void;
	/**
	 * parse 後: frontmatter マーカーを外部ストアから後付けする（embedded は no-op）。
	 *
	 * 本文ユニットと別の入口になっているのは、frontmatter が本文の並びに属さないためで、
	 * 扱いの原則は同じ。読み手（ツリー・CodeLens・need の解決）は `parse` の返り値の
	 * frontmatter を見るだけでよく、モードを意識しない。
	 */
	attachFrontMatter(frontMatter: FrontMatter | undefined, ctx?: MarkerFileContext): void;
	/** stringify 前: frontmatter マーカーを引き取り永続化する（embedded は no-op） */
	detachFrontMatter(frontMatter: FrontMatter | undefined, ctx?: MarkerFileContext): void;
}

/**
 * 既定の埋め込みマーカー Provider。
 *
 * マーカーは本文に埋め込まれている前提のため、attach/detach は何もしない。
 * stringify 時の埋め込みは MdaitUnit.toString() が担う（現行どおり）。
 */
export class EmbeddedMarkerProvider implements MarkerProvider {
	readonly mode = "embedded" as const;
	readonly markersFormBoundaries = true;

	attachMarkers(): void {
		/* no-op: マーカーは本文に埋め込み済み */
	}

	detachMarkers(): void {
		/* no-op: MdaitUnit.toString() が埋め込む */
	}

	attachFrontMatter(): void {
		/* no-op: マーカーは frontmatter に書き込み済み */
	}

	detachFrontMatter(): void {
		/* no-op: frontmatter の raw がそのまま出力される */
	}
}

/**
 * 既定で使用する埋め込み Provider のシングルトンインスタンス。
 */
export const embeddedMarkerProvider: MarkerProvider = new EmbeddedMarkerProvider();

/**
 * 外部ストア（`.mdait/unit-state`）とユニットを橋渡しする Provider。
 *
 * - マーカーは本文に埋め込まず、`UnitStateStore` に `(path, order)` キーで保管する。
 * - attach: store のエントリを order 昇順で取得し、ユニット配列 index（=order）を主キーに
 *   マーカーを後付けする。titleHash は補助検証のみ（不一致でも index マッチを採用）。
 * - detach: 各ユニットを order=index でストアに書き込む（save は呼ばない。sync 完了時に1回）。
 *
 * `ctx.filePath` はワークスペース相対・/区切りを契約とする（正規化は呼び出し側の責務）。
 */
export class ExternalMarkerProvider implements MarkerProvider {
	readonly mode = "external" as const;
	readonly markersFormBoundaries = false;

	/**
	 * @param storeOverride テスト用に注入するストア。未指定時は呼び出しごとに
	 *   `UnitStateStore.getInstance()` を解決する（dispose 後の差し替えにも追従する）。
	 */
	constructor(private readonly storeOverride?: UnitStateStore) {}

	/** 実際に使用するストア（注入があればそれ、無ければ現行シングルトン） */
	private get store(): UnitStateStore {
		return this.storeOverride ?? UnitStateStore.getInstance();
	}

	attachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void {
		const filePath = ctx?.filePath;
		if (!filePath) {
			return;
		}
		const entries = this.store.getEntriesByPath(filePath);
		// 「何番目か」ではなく中身で突き合わせる。章の挿入・削除・並べ替えで
		// 対応がずれないようにするため（詳細は unit-state-align.ts）。
		// 席に着いていない行（＝前回の刈り取りを見送って取り残された行）は、順序で機械的に埋める段から外す。
		// 内容が一致すれば拾えるので、章が戻ってくれば正しく復帰する。
		const held = new Set<number>();
		for (let i = 0; i < entries.length; i++) {
			if (isHeldBackEntry(entries[i])) {
				held.add(i);
			}
		}
		const aligned = alignEntriesToUnits(entries, units, held);
		let unmatchedUnits = 0;
		const matched = new Set<UnitStateEntry>();
		for (let i = 0; i < units.length; i++) {
			const entry = aligned[i];
			if (!entry) {
				// 対応する行が無い＝新しく増えたユニット。マーカー不在のまま sync が新規と判定する
				unmatchedUnits++;
				continue;
			}
			matched.add(entry);
			units[i].marker = new MdaitMarker(entry.hash, entry.from || null, entry.need || null);
		}
		if (ctx) {
			ctx.alignment = buildAlignmentMemo(entries, units, matched, aligned);
		}
		if (unmatchedUnits > 0 || entries.length !== units.length) {
			logger.debug("marker", "attached external markers", {
				path: filePath,
				entries: entries.length,
				units: units.length,
				unmatchedUnits,
			});
		}
	}

	detachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void {
		const filePath = ctx?.filePath;
		if (!filePath) {
			return;
		}
		// 読み込み時に「対応が付かなかった」と分かった行を、上書きされる前に席から降ろす。
		// 控えは一度だけ使う（同じ ctx で二度書き出しても二重に効かないように消す）。
		const memo = ctx.alignment;
		ctx.alignment = undefined;
		if (memo) {
			this.applyAlignmentMemo(filePath, memo);
		}

		// 席のキーを決める。**いま座っている行は据え置く**（`seat-keys.ts`）。
		// 毎回 0..N-1 に振り直していた頃は、章を1つ挿すだけでその記事のブロックが
		// 丸ごと書き換わり、同じ記事への別の編集と必ず領域が重なっていた。
		const before = this.store.getEntriesByPath(filePath);
		const preferred = this.seatPreferences(before, units, memo);
		const seats = assignSeats(preferred);
		// **据え置かれた席**（もとの行がそのまま座り続ける席）。ここに無い席の行には、
		// どのユニットも座っていない
		const kept = new Set(seats.filter((seat, i) => seat === preferred[i]));

		// それでも上書きで失われる状態を数える。控えが無い呼び出し（ctx を共有しない parse →
		// stringify）でも席は動かないが、章そのものが消えていれば行の行き先は無い
		// （docs/design/unit-state.md §17）。刈り取りにも退避にもログがあるのに、
		// 実際に状態を失う経路だけ記録が無いと追跡できない。
		const lostState = countLostStateEntries(before, units, kept);

		// **どのユニットも座らなかった行の始末を、書き込みより先に済ませる。**
		// あとにすると、新しい章に配った席がその行を踏み、預けも刈りもされないまま
		// 黙って消える（実測: 3章のうち2章が照合できず、片方の状態が消えた）。
		const leftovers = before.filter((e) => isLiveBodyEntry(e) && !kept.has(e.seat)).map((e) => e.seat);
		const entryCount = this.store.countLiveEntriesByPath(filePath);
		if (leftovers.length > 0) {
			if (ctx.deliberateDeletion || shouldPruneTail(entryCount, units.length)) {
				// 消す側は今まで無言だった。掃除も刈り取り見送りもログを出すのに、
				// 実際に状態を失う操作だけが記録に残らないのは追跡のしようがない
				const removed = this.store.dropEntries(filePath, leftovers);
				if (removed > 0) {
					logger.info("marker", "Pruned unit-state entries that no unit claimed", {
						path: filePath,
						units: units.length,
						removed,
					});
				}
			} else {
				const parked = this.store.parkEntries(filePath, leftovers);
				// 新たに預かった分があるときだけ警告する。預かっている状態は安定なので、
				// 毎 sync（autoSyncOnSave を含む）同じ警告を積むと読む価値が無くなる
				if (parked > 0) {
					logger.warn("marker", "Skipped pruning unit-state entries: unit count dropped sharply", {
						path: filePath,
						entries: entryCount,
						units: units.length,
						parked,
						note: "If this is not a real deletion (unclosed code fence, sync.level change), fix it and sync again — the state is kept.",
					});
				}
			}
		}

		for (let i = 0; i < units.length; i++) {
			const unit = units[i];
			this.store.setEntry({
				path: filePath,
				kind: "unit",
				seat: seats[i],
				level: unit.headingLevel,
				titleHash: calculateHash(unit.title),
				hash: unit.marker?.hash ?? "",
				from: unit.marker?.from ?? "",
				need: unit.marker?.need ?? "",
			});
		}
		if (lostState > 0) {
			logger.warn("marker", "Overwrote unit-state entries whose translation state has no place left", {
				path: filePath,
				units: units.length,
				lostState,
				note: "A unit was removed from the document and its from/need is gone. Pasting the text back will not restore it (docs/design/unit-state.md §17).",
			});
		}
		// store.save() は呼ばない。sync 完了時に1回だけ保存する。
	}

	/**
	 * ユニットごとの「いま座っている席」を出す。
	 *
	 * 読み込み時の控え（`attachMarkers` が置く）があればそれを使う。無い呼び出し
	 * （ctx を共有しない parse → stringify）では**その場で照合し直す** — ここで
	 * 0..N-1 に落とすと、席を据え置く意味がその経路だけ消えるうえ、ストアに残っている
	 * 古い席と番号が混ざって「余った行」が湧く。
	 *
	 * どちらの場合も、**いまストアに生きている席だけ**を採る。控えを取ってからここへ
	 * 来るまでのあいだに行が動いている（席から降ろした・席へ戻した）ためである。
	 */
	private seatPreferences(
		before: readonly UnitStateEntry[],
		units: readonly MdaitUnit[],
		memo: MarkerAlignmentMemo | undefined,
	): Array<string | undefined> {
		const live = new Set(before.filter(isLiveBodyEntry).map((e) => e.seat));
		const keepLive = (seat: string | undefined) => (seat !== undefined && live.has(seat) ? seat : undefined);
		if (memo) {
			return units.map((unit) => keepLive(memo.seatByUnit.get(unit)));
		}
		const held = new Set<number>();
		for (let i = 0; i < before.length; i++) {
			if (isHeldBackEntry(before[i])) {
				held.add(i);
			}
		}
		return alignEntriesToUnits(before, units, held).map((entry) => keepLive(entry?.seat));
	}

	/**
	 * frontmatter マーカーをストアから frontmatter オブジェクトへ載せる。
	 *
	 * 行が無いときは何もしない。ファイル側に古いマーカーが残っている（外部化する前から
	 * ある既存のワークスペース）場合はそれがそのまま残り、`detachFrontMatter` が
	 * ストアへ退避してファイルから消す。**移行はこの往復で済む**ので、移行専用の
	 * 経路を別に持たない。
	 */
	attachFrontMatter(frontMatter: FrontMatter | undefined, ctx?: MarkerFileContext): void {
		const filePath = ctx?.filePath;
		if (!filePath || !frontMatter) {
			return;
		}
		// 行の有無に関わらず先に印を付ける。sync はこのあと frontmatter マーカーを
		// `set()` で書き換えるので、印が無いとその時点で `_raw` へ漏れる
		frontMatter.markExternalKey(FRONTMATTER_MARKER_KEY);
		const entry = this.store.getFrontMatterEntry(filePath);
		if (!entry) {
			return;
		}
		const marker = new MdaitMarker(entry.hash, entry.from || null, entry.need || null);
		frontMatter.attachExternalValue(FRONTMATTER_MARKER_KEY, serializeFrontmatterMarker(marker));
	}

	/**
	 * frontmatter マーカーをストアへ引き取り、frontmatter オブジェクトから外す。
	 *
	 * frontmatter そのものが無いファイルでは行に触らない。マーカーを消してよいと
	 * 判断できるのは「frontmatter を読んだうえでマーカーが無かった」ときだけで、
	 * 「frontmatter が無い」は読めていないのと同じである（ADR-260810-02 と同じ考え方）。
	 */
	detachFrontMatter(frontMatter: FrontMatter | undefined, ctx?: MarkerFileContext): void {
		const filePath = ctx?.filePath;
		if (!filePath || !frontMatter) {
			return;
		}
		const marker = parseFrontmatterMarker(frontMatter);
		this.store.setFrontMatterEntry(filePath, {
			hash: marker?.hash ?? "",
			from: marker?.from ?? "",
			need: marker?.need ?? "",
		});
		frontMatter.stripExternalValueFromRaw(FRONTMATTER_MARKER_KEY);
	}

	/**
	 * 読み込み時の控えを適用する（書き出しで行が上書きされる前に呼ぶ）。
	 *
	 * 控えは `order` しか持たないので、いまのストアを正として引き直す。控えを取ってから
	 * ここへ来るまでのあいだにストアが書き換わっている可能性があるため（リネーム追随の
	 * `movePath`、別のコマンドの書き込み）、控えの中身を鵜呑みにはしない。
	 */
	private applyAlignmentMemo(filePath: string, memo: MarkerAlignmentMemo): void {
		// 先に席から外す。外す前に席へ移すと、同じ本文 hash の突き合わせ（席は1本文1席）で
		// 拾い戻したばかりの行が「既にある席」と見なされ、退避したい行が置けなくなる
		const recovered = this.store.dropHeldEntries(filePath, memo.recoveredHeldHashes);
		const parked = this.store.parkEntries(filePath, memo.unmatchedSeats);
		if (recovered > 0 || parked > 0) {
			logger.info("marker", "Applied held seats from the parse-time alignment", {
				path: filePath,
				parked,
				recovered,
			});
		}
	}

}

/**
 * 末尾の余った行を刈ってよいか。
 *
 * 守りたいのは「ユニットが 0 件になった」ときだけではなく「**一時的に減った**」ときである。
 * コードブロックの閉じ忘れでパースが崩れる、`sync.level` の設定を変えて見出しの粒度が
 * 変わる、といった理由でユニット数は簡単に激減する。その状態で刈ると、原因を直して
 * ユニット数が戻っても、消えた `from`/`need` は戻らない。
 *
 * 刈らないと決めた行は捨て置かれるのではなく、**席から降ろして位置の意味を剥がす**
 * （`UnitStateStore.parkEntries`）。席に着いていない行は順序では拾われず、内容（本文の hash・
 * 見出しの hash とレベル）が一致したときだけ拾われる。だから章が戻ってくれば正しく復帰し、
 * 戻ってこなければ無害に居座るだけになる。この保証があって初めて
 * 「消す側の失敗は取り返せず、残す側の失敗は取り返せる」という非対称が成り立つ。
 *
 * 位置を剥がさずに残すと、内容が1文字も一致しない古い行があとから増えた章に貼り付く。
 * 実測: 8ユニットから6章消して新章を1つ足すと、新章に削除済みの第2章の `from` が付き
 * `need:revise` になった（AI に無関係な章の差分が渡る）。
 *
 * 判定（`isSuspiciousShrink`）は sync の孤立ユニット自動削除と**同じものを使う**。
 * 行だけ守って本文を消したら意味が無いので、疑うかどうかの基準は1つでなければならない。
 *
 * **この判定は「余った行」にしか効かない。** 刈るかどうかを問われるのは、書き出しで
 * どのユニットにも席を譲らなかった行だけである（席に着いていない行はそもそも席を争っていない
 * ので、ユニット数がいくら増えても消えない）。人が明示的に頼んだ削除は判定を通さず必ず
 * 刈る（`MarkerFileContext.deliberateDeletion`）。詳しくは docs/design/unit-state.md §14。
 */
export function shouldPruneTail(entryCount: number, unitCount: number): boolean {
	if (unitCount === 0) {
		// 本文を一時的に空にした・パース途中の崩れた状態。そのファイルの行を丸ごと失わない
		return false;
	}
	if (entryCount - unitCount <= 0) {
		return true; // 減っていない（刈るものが無い）
	}
	return !isSuspiciousShrink(entryCount, unitCount);
}

/**
 * 読み込み時の照合結果から、書き出し時に要る分だけを取り出す。
 *
 * ユニットが0件のときは控えを作らない。本文を全選択して消した・コードブロックの閉じ忘れで
 * 以降が全部飲まれた、といった「一時的に潰れた」状態では**すべての行が対応なし**になるが、
 * それは章が消えた証拠ではない。`shouldPruneTail` が「ユニット0件なら刈らない」を先に返すのと
 * 同じ理由で、ここでも証拠として扱わない。
 *
 * @param entries そのファイルの行（並び順）
 * @param units いまパースしたユニット
 * @param matchedEntries 対応が付いた行
 * @param aligned ユニットごとに対応が付いた行（`units` と同じ長さ）
 */
export function buildAlignmentMemo(
	entries: readonly UnitStateEntry[],
	units: readonly MdaitUnit[],
	matchedEntries: ReadonlySet<UnitStateEntry>,
	aligned: ReadonlyArray<UnitStateEntry | undefined> = [],
): MarkerAlignmentMemo {
	const unmatchedSeats: string[] = [];
	const recoveredHeldHashes: string[] = [];
	const seatByUnit = new Map<MdaitUnit, string>();
	for (let i = 0; i < units.length; i++) {
		const entry = aligned[i];
		if (entry && isLiveBodyEntry(entry)) {
			seatByUnit.set(units[i], entry.seat);
		}
	}
	if (units.length === 0) {
		return { unmatchedSeats, recoveredHeldHashes, seatByUnit };
	}
	for (const entry of entries) {
		const matched = matchedEntries.has(entry);
		if (isHeldBackEntry(entry)) {
			if (matched) {
				// 本文が戻ってきて拾われた。書き出しが席のキーで書き直すので、こちらは消す
				recoveredHeldHashes.push(entry.hash);
			}
			continue;
		}
		if (matched) {
			continue;
		}
		if (!entry.hash) {
			continue; // 本文 hash が無い行は預けても拾い戻せない（拾うのは完全一致だけ）
		}
		if (!hasStateWorthHolding(entry)) {
			continue;
		}
		unmatchedSeats.push(entry.seat);
	}
	return { unmatchedSeats, recoveredHeldHashes, seatByUnit };
}

/**
 * その行に「席を取ってまで預かる値打ちのある状態」があるか。
 *
 * - `from` も `need` も無い行: 本文から計算し直せるので預ける意味が無い。
 * - `need:translate` の行: 「まだ人が訳していない」という意味しか持たない。章が消えて
 *   戻ってきたとき、sync は原文から同じ状態をそのまま作り直す。**sync が自分で作り直した
 *   訳文の複製**（原文の丸写し）もこの形なので、預けると席が実際の編集と関係なく増える。
 *
 * 預けるのは、失うと人の作業が消えるものだけに絞る。席が増える条件を
 * 「消えたきり戻ってこなかった、内容の異なる章」だけに保つための線引きでもある。
 */
function hasStateWorthHolding(entry: UnitStateEntry): boolean {
	if (entry.need && entry.need !== "translate") {
		return true; // review / revise@... / isolate / verify-deletion は人の判断が要る
	}
	return Boolean(entry.from) && !entry.need; // 訳し終えた行（from があり need が空）
}

/**
 * 既定で使用する外部 Provider のシングルトンインスタンス。
 */
export const externalMarkerProvider: MarkerProvider = new ExternalMarkerProvider();

/**
 * 書き出しで失われる「翻訳の状態」を数える（純関数）。
 *
 * 数えるのは `from` か `need` を持っていた行だけである。それ以外（hash だけの行）は
 * 本文から計算し直せるので、消えても取り返しがつく。いまの本文のどこかに同じ hash が
 * あるなら、その行は位置が変わっただけで失われていない。
 *
 * **同じ `from` を持つユニットが居ることも「失われていない」印である。** 訳文の hash は
 * 訳し直せば必ず変わるので、hash だけで見ると翻訳が成功するたびに「失った」と数えて
 * しまう（既定テンプレートは external なので、初回の翻訳で全員がこの警告を見ていた）。
 * `from` は原文を指す値で訳し直しても変わらないから、章がまだそこに在ることが分かる。
 * 狼少年をやめないと、本当に状態を落としたとき（マージの取りこぼしなど）に読まれない。
 *
 * @param previous 書き出す前にストアが持っていた行
 * @param units これから書き出すユニット
 * @param taken これから書き出す席のキー。ここに無い行は上書きされないので、
 *   刈り取り／退避の判断が別に下される（数に入れない）
 */
export function countLostStateEntries(
	previous: readonly UnitStateEntry[],
	units: readonly MdaitUnit[],
	taken: ReadonlySet<string>,
): number {
	if (previous.length === 0) {
		return 0;
	}
	const survivingHashes = new Set<string>();
	const survivingFroms = new Set<string>();
	for (const unit of units) {
		if (unit.marker?.hash) {
			survivingHashes.add(unit.marker.hash);
		}
		if (unit.marker?.from) {
			survivingFroms.add(unit.marker.from);
		}
	}
	let lost = 0;
	for (const entry of previous) {
		if (isHeldBackEntry(entry)) {
			continue; // 席に着いていない行は上書きされない（席のキーを持たないため）
		}
		if (!entry.hash || (!entry.from && !entry.need)) {
			continue; // 守るべき状態が無い
		}
		if (!taken.has(entry.seat)) {
			continue; // どのユニットにも席を譲っていない。刈り取り／保留の判断が別に下される
		}
		if (survivingHashes.has(entry.hash)) {
			continue; // 位置が変わっただけ
		}
		if (entry.from && survivingFroms.has(entry.from)) {
			continue; // 訳し直しただけ（章はまだそこに在る）
		}
		lost++;
	}
	return lost;
}
