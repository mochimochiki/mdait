import { Logger } from "../../infra/logging/logger";
import { calculateHash } from "../hash/hash-calculator";
import { isSuspiciousShrink } from "../matching/shrink-guard";
import { alignEntriesToUnits } from "../unit-state/unit-state-align";
import { type UnitStateEntry, UnitStateStore, isHeldBackEntry } from "../unit-state/unit-state-store";
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
	 * 保留席へ移すかどうかを決めているのは**書き出し時**である。あいだで sync が原文から
	 * 消えた章を作り直すため、書き出し側はユニット数が元に戻った姿しか見ておらず、
	 * 「減った」という事実に一度も触れない（roadmap-v01 の P03）。その事実を運ぶための控え。
	 *
	 * 同じ ctx で parse → stringify する呼び出しでだけ効く。控えが無ければ従来どおり
	 * 末尾を見る判定に落ちるので、ctx を共有しない呼び出し（markers-migration の中間
	 * stringify・embed 経路）は挙動が変わらない。
	 */
	alignment?: MarkerAlignmentMemo;
}

/**
 * 読み込み時の照合結果のうち、書き出し時の判断に要る分だけの控え。
 *
 * 行そのものではなく `order` で覚える。控えを取ってから使うまでのあいだにストアが
 * 書き換わりうるので（`movePath` など）、そのときのストアを正として引き直す。
 */
export interface MarkerAlignmentMemo {
	/**
	 * 対応が付かなかった通常の行の `order`。保留席へ移す候補。
	 *
	 * `from` も `need` も持たない行は含めない。本文から計算し直せる行を席に置いても、
	 * 守るものが無いまま席が埋まるだけである。
	 */
	readonly unmatchedOrders: readonly number[];
	/**
	 * 保留席から拾い戻された行の `order`。席から外す。
	 *
	 * 書き出しで通常の `order` に書き直されるため、席に残すと同じ状態の行が二重になる。
	 * 刈り取りが席の行を巻き込まなくなった（`pruneEntriesFrom`）ぶん、ここで外さないと
	 * 二重のまま居座る。
	 */
	readonly recoveredHeldOrders: readonly number[];
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
		// 保留席の行（＝前回の刈り取りを見送って取り残された行）は、順序で機械的に埋める段から外す。
		// 内容が一致すれば拾えるので、章が戻ってくれば正しく復帰する。
		const held = new Set<number>();
		for (let i = 0; i < entries.length; i++) {
			if (isHeldBackEntry(entries[i])) {
				held.add(i);
			}
		}
		const aligned = alignEntriesToUnits(entries, units, held);
		let unmatchedUnits = 0;
		const matchedOrders = new Set<number>();
		for (let i = 0; i < units.length; i++) {
			const entry = aligned[i];
			if (!entry) {
				// 対応する行が無い＝新しく増えたユニット。マーカー不在のまま sync が新規と判定する
				unmatchedUnits++;
				continue;
			}
			matchedOrders.add(entry.order);
			units[i].marker = new MdaitMarker(entry.hash, entry.from || null, entry.need || null);
		}
		if (ctx) {
			ctx.alignment = buildAlignmentMemo(entries, units.length, matchedOrders);
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
		// 読み込み時に「対応が付かなかった」と分かった行を、上書きされる前に保留席へ移す。
		// 控えは一度だけ使う（同じ ctx で二度書き出しても二重に効かないように消す）。
		const memo = ctx.alignment;
		ctx.alignment = undefined;
		if (memo) {
			this.applyAlignmentMemo(filePath, memo);
		}

		// それでも上書きで失われる状態を数える。控えが無い呼び出し（ctx を共有しない parse →
		// stringify）では、行がユニットの並び順でそのまま上書きされ、ユニット数が元に戻ると
		// 保留も刈り取りも起きないまま消える（docs/design/unit-state.md §17）。
		// 刈り取りにも保留にもログがあるのに、実際に状態を失う経路だけ記録が無いと追跡できない。
		const lostState = this.countLostState(filePath, units);

		for (let i = 0; i < units.length; i++) {
			const unit = units[i];
			this.store.setEntry({
				path: filePath,
				order: i,
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

		// ユニットが減ったときに末尾の旧エントリが残ると、次に増えたときそれを拾ってしまう。
		// ただし「一時的に減っただけ」のときは刈らず、保留席へ移して位置の意味だけを剥がす
		// （下記 shouldPruneTail / UnitStateStore.parkEntriesFrom）。
		const entryCount = this.store.countLiveEntriesByPath(filePath);
		if (shouldPruneTail(entryCount, units.length)) {
			const removed = this.store.pruneEntriesFrom(filePath, units.length);
			if (removed > 0) {
				// 消す側は今まで無言だった。掃除も刈り取り見送りもログを出すのに、
				// 実際に状態を失う操作だけが記録に残らないのは追跡のしようがない
				logger.info("marker", "Pruned unit-state entries beyond the current unit count", {
					path: filePath,
					units: units.length,
					removed,
				});
			}
		} else {
			const parked = this.store.parkEntriesFrom(filePath, units.length);
			// 新たに保留した分があるときだけ警告する。保留席がある状態は安定なので、
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
		// store.save() は呼ばない。sync 完了時に1回だけ保存する。
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
		const recovered = this.store.dropEntries(filePath, memo.recoveredHeldOrders);
		const parked = this.store.parkEntries(filePath, memo.unmatchedOrders);
		if (recovered > 0 || parked > 0) {
			logger.info("marker", "Applied held seats from the parse-time alignment", {
				path: filePath,
				parked,
				recovered,
			});
		}
	}

	/**
	 * 書き出しで失われる「翻訳の状態」を数える。
	 *
	 * 数えるのは `from` か `need` を持っていた行だけである。それ以外（hash だけの行）は
	 * 本文から計算し直せるので、消えても取り返しがつく。いまの本文のどこかに同じ hash が
	 * あるなら、その行は位置が変わっただけで失われていない。
	 */
	private countLostState(filePath: string, units: readonly MdaitUnit[]): number {
		const previous = this.store.getEntriesByPath(filePath);
		if (previous.length === 0) {
			return 0;
		}
		const survivingHashes = new Set<string>();
		for (const unit of units) {
			if (unit.marker?.hash) {
				survivingHashes.add(unit.marker.hash);
			}
		}
		let lost = 0;
		for (const entry of previous) {
			if (isHeldBackEntry(entry)) {
				continue; // 保留席は上書きされない（order が桁違いのため）
			}
			if (!entry.hash || (!entry.from && !entry.need)) {
				continue; // 守るべき状態が無い
			}
			if (entry.order >= units.length) {
				continue; // 末尾。刈り取り／保留の判断が別に下される
			}
			if (!survivingHashes.has(entry.hash)) {
				lost++;
			}
		}
		return lost;
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
 * 刈らないと決めた行は捨て置かれるのではなく、**保留席へ移して位置の意味を剥がす**
 * （`UnitStateStore.parkEntriesFrom`）。保留席の行は順序では拾われず、内容（本文の hash・
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
 * **保留席には寿命がある。** 保留席の order は必ず `units.length` より大きいので、いったん
 * この関数が真を返すと（＝ユニット数が保留席の数に追いつくと）保留席は全部消える。
 * `delete-unit.ts` の刈り取りも同じ経路を通る。詳しくは docs/design/unit-state.md §14。
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
 * @param entries そのファイルの行（order 昇順）
 * @param unitCount いまパースしたユニット数
 * @param matchedOrders 対応が付いた行の order
 */
export function buildAlignmentMemo(
	entries: readonly UnitStateEntry[],
	unitCount: number,
	matchedOrders: ReadonlySet<number>,
): MarkerAlignmentMemo {
	const unmatchedOrders: number[] = [];
	const recoveredHeldOrders: number[] = [];
	if (unitCount === 0) {
		return { unmatchedOrders, recoveredHeldOrders };
	}
	for (const entry of entries) {
		const matched = matchedOrders.has(entry.order);
		if (isHeldBackEntry(entry)) {
			if (matched) {
				// 本文が戻ってきて席から拾われた。書き出しが通常の order で書き直すので席を空ける
				recoveredHeldOrders.push(entry.order);
			}
			continue;
		}
		if (matched) {
			continue;
		}
		if (!entry.hash) {
			continue; // 本文 hash が無い行は席に置いても拾い戻せない（拾うのは完全一致だけ）
		}
		if (!hasStateWorthHolding(entry)) {
			continue;
		}
		unmatchedOrders.push(entry.order);
	}
	return { unmatchedOrders, recoveredHeldOrders };
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
