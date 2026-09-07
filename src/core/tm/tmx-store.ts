import * as fs from "node:fs";
import * as path from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { Logger } from "../../infra/logging/logger";
import { atomicWriteFileSync } from "../../infra/workspace/atomic-write";
import { calculateHash } from "../hash/hash-calculator";
import { hasConflictMarkersInDataFile } from "../markdown/conflict-markers";
import { computeTrigrams, normalizeForTm } from "./tm-text-normalizer";
import type { ExistingTmEntriesItem, LegacyTmEntry, TmEntry, TmMatch, TmVariant } from "./types";

/** TMXバージョン */
const TMX_VERSION = "1.4";

/** XMLプロパティタイプ定数 */
const PROP_TYPE_HASH = "x-hash";
const PROP_TYPE_PRIMARY = "x-primary";

/** XML宣言 */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** fast-xml-parser属性プレフィックス */
const ATTR_PREFIX = "@_";

/** 配列として強制するタグ名 */
const ARRAY_TAG_NAMES = new Set(["tu", "tuv", "prop"]);

const logger = Logger.getInstance();

function inferPrimaryFromVariants(tuid: string, variants: Iterable<TmVariant>): string | null {
	const candidates = [...variants].map((variant) => variant.text).filter((text) => text.length > 0);
	for (const text of candidates) {
		if (calculateHash(text, true) === tuid) {
			return text;
		}
	}
	return candidates.length === 1 ? candidates[0] : null;
}

/**
 * XMLテキストをエスケープする
 */
export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * XMLエスケープを解除する
 */
export function unescapeXml(text: string): string {
	return text
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

/**
 * TU 1つを**1行**に組み立てる builder（モジュールスコープで再利用）。
 *
 * **1 TU = 1 行にするのは、合流で競合させないためである。** 整形して1つの TU を10行ほどに
 * 散らすと、2人が別々の文を登録しただけで行が隣り合ってぶつかる（実測: 500件へ両側20件ずつで
 * 16/20、2000件へ50件ずつで 18/20）。1行なら `.gitattributes` の `merge=union` が効き、
 * 両方の行が残る。重複した TU は読み込みが畳む。
 */
const tuBuilder = new XMLBuilder({
	ignoreAttributes: false,
	attributeNamePrefix: ATTR_PREFIX,
	format: false,
	suppressEmptyNode: true,
	processEntities: true,
});

/**
 * 文字列を符号位置の順で比べる（`localeCompare` は実行環境のロケールで答えが変わる）。
 */
function compareCodePoints(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** fast-xml-parser パーサー（モジュールスコープで再利用） */
const tmxParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: ATTR_PREFIX,
	isArray: (_name: string, jpath: string) => {
		const tagName = jpath.split(".").pop() ?? "";
		return ARRAY_TAG_NAMES.has(tagName);
	},
	processEntities: true,
	trimValues: false,
});

/**
 * パース済みTUノードからTmEntryに変換する
 */
function parseTuNode(tuNode: Record<string, unknown>): TmEntry | null {
	let tuid = String(tuNode[`${ATTR_PREFIX}tuid`] ?? "");
	let primary = "";
	const variants = new Map<string, TmVariant>();

	// <prop> 要素を処理
	const props = (tuNode.prop as Array<Record<string, unknown>>) ?? [];
	for (const prop of props) {
		const type = prop[`${ATTR_PREFIX}type`] as string;
		const value = String(prop["#text"] ?? "");
		switch (type) {
			case PROP_TYPE_HASH:
				if (!tuid) {
					tuid = value;
				}
				break;
			case PROP_TYPE_PRIMARY:
				primary = value;
				break;
		}
	}

	if (!tuid) {
		return null;
	}

	// <tuv> 要素を処理
	const tuvs = (tuNode.tuv as Array<Record<string, unknown>>) ?? [];
	for (const tuv of tuvs) {
		const lang = tuv[`${ATTR_PREFIX}xml:lang`] as string;
		const text = String(tuv.seg ?? "");
		if (lang) {
			variants.set(lang, { text });
		}
	}

	if (!primary) {
		primary = inferPrimaryFromVariants(tuid, variants.values()) ?? "";
	}

	if (!primary) {
		return null;
	}

	const entry: TmEntry = {
		tuid,
		primary,
		variants,
	};
	return entry;
}

function isLegacyTmEntry(entry: TmEntry | LegacyTmEntry): entry is LegacyTmEntry {
	return "sentenceHash" in entry;
}

function normalizeEntry(entry: TmEntry | LegacyTmEntry): TmEntry {
	if (!isLegacyTmEntry(entry)) {
		return { ...entry };
	}

	const sortedVariants = [...entry.segments.entries()];
	const primary =
		inferPrimaryFromVariants(
			entry.sentenceHash,
			sortedVariants.map(([, text]) => ({ text })),
		) ?? "";
	return {
		tuid: entry.sentenceHash,
		primary,
		variants: new Map(sortedVariants.map(([lang, text]) => [lang, { text }])),
	};
}

/**
 * TMX XMLを全件パースする
 */
function parseTmx(xml: string): Map<string, TmEntry> {
	const entries = new Map<string, TmEntry>();
	const parsed = tmxParser.parse(xml);
	const tuArray = parsed?.tmx?.body?.tu;

	if (Array.isArray(tuArray)) {
		for (const tuNode of tuArray) {
			const entry = parseTuNode(tuNode);
			if (!entry) {
				continue;
			}
			const existing = entries.get(entry.tuid);
			if (!existing) {
				entries.set(entry.tuid, entry);
				continue;
			}
			// **同じ tuid の TU が2つ並ぶのは、合流（`merge=union`）のあとの姿である。**
			// 後勝ちで潰すと、片方の枝で登録した訳が警告も無く消える（`unit-state` で
			// 同じことが起きていた。ADR-260906-03）。言語ごとに拾い集める。
			for (const [lang, variant] of entry.variants) {
				const kept = existing.variants.get(lang);
				if (!kept) {
					existing.variants.set(lang, variant);
				} else if (kept.text !== variant.text) {
					// 同じ原文に違う訳が2つ。TMX は1つしか持てないので先に出てきたほうを残す。
					// 黙って捨てないよう跡を残す（次の保存で片方が消えるため）
					logger.warn("tm", "Conflicting translations for the same source sentence; keeping the first", {
						tuid: entry.tuid,
						lang,
					});
				}
			}
		}
	}

	return entries;
}

/**
 * TmEntryをXMLBuilder用オブジェクトに変換する
 */
function buildTuObject(entry: TmEntry): Record<string, unknown> {
	// variant を言語コード順でソート（決定的出力）
	const sortedLangs = [...entry.variants.keys()].sort();
	const tuvs: Record<string, unknown>[] = [];
	for (const lang of sortedLangs) {
		const variant = entry.variants.get(lang) as TmVariant;
		tuvs.push({
			[`${ATTR_PREFIX}xml:lang`]: lang,
			seg: variant.text,
		});
	}

	return {
		[`${ATTR_PREFIX}tuid`]: entry.tuid,
		tuv: tuvs,
	};
}

/**
 * エントリーMap を完全なTMX XML文字列にシリアライズする
 */
function serializeTmx(entries: Map<string, TmEntry>): string {
	// 並べ替えは符号位置で比べる。`localeCompare` は**実行環境のロケールで答えが変わる**ので、
	// 全員が同じバイト列を書く前提のファイルには使えない（ADR-260906-07 と同じ理由）。
	const sortedEntries = [...entries.values()].sort((a, b) => compareCodePoints(a.tuid, b.tuid));
	// 行と行のあいだに空行や目印を挟むのは**効かない**。ここで出る競合は「両方が同じ隙間へ
	// 足した」形で、`unit-state` の実測でもこの形だけは並べ方をどう変えても消えなかった。
	// TU は tuid の順に並ぶので、20件ずつ足せばどこかは必ず隣り合う。union で解く。
	const tuLines = sortedEntries.map((entry) => tuBuilder.build({ tu: buildTuObject(entry) }).trim());

	return [XML_DECLARATION, `<tmx version="${TMX_VERSION}">`, "<body>", ...tuLines, "</body>", "</tmx>", ""].join("\n");
}

/**
 * TMXファイルのI/OとインメモリインデックスCRUDを担当する。
 *
 * 主要機能:
 * - TMX XMLのパース/シリアライズ
 * - Map<tuid, TmEntry>による高速検索（O(1)）
 * - CRUD操作: addEntry, getEntriesByUnitPath, lookupByHash, lookupBatch
 */
export class TmxStore {
	private static instance: TmxStore | null = null;
	private loadedFilePath: string | null = null;
	private loadedMtime = 0;

	/** tuid → TmEntry */
	private index = new Map<string, TmEntry>();

	/** 合流の途中で読み込みを見送ったか */
	private conflicted = false;

	/** lang → (trigram → Set<tuid>)（言語別転置インデックス） */
	private trigramIndex = new Map<string, Map<string, Set<string>>>();

	/** "${tuid}:${lang}" → trigrams（ランキング時の再計算を省くフォワードキャッシュ） */
	private trigramCache = new Map<string, Set<string>>();

	/**
	 * グローバルシングルトンを取得する（遅延初期化）。
	 * TMXファイルパスを指定して初回ロードまたはmtime変更時リロードする。
	 */
	static getInstance(tmxFilePath: string): TmxStore {
		if (!TmxStore.instance) {
			TmxStore.instance = new TmxStore();
		}
		TmxStore.instance.loadIfNeeded(tmxFilePath);
		return TmxStore.instance;
	}

	/** テスト用にシングルトンをリセットする */
	static resetInstance(): void {
		TmxStore.instance = null;
	}

	/**
	 * ファイルが更新されている場合のみリロードする。
	 * save()後はloadedMtimeを更新するため、自分自身のsave後はリロードされない。
	 */
	private loadIfNeeded(filePath: string): void {
		if (!fs.existsSync(filePath)) {
			if (this.loadedFilePath !== filePath || this.index.size > 0) {
				this.index.clear();
				this.trigramIndex.clear();
				this.trigramCache.clear();
				this.loadedFilePath = filePath;
				this.loadedMtime = 0;
			}
			return;
		}
		const mtime = fs.statSync(filePath).mtimeMs;
		if (this.loadedFilePath === filePath && this.loadedMtime === mtime) {
			return; // 変更なし→スキップ
		}
		this.load(filePath);
		this.loadedFilePath = filePath;
		this.loadedMtime = mtime;
	}

	/** インデックスに直接アクセス（テスト用） */
	get entries(): ReadonlyMap<string, TmEntry> {
		return this.index;
	}

	/**
	 * TMXファイルを読み込み、インメモリインデックスを構築する。
	 * ファイルが存在しない場合は空インデックスを初期化する。
	 * @param filePath TMXファイルのパス
	 */
	load(filePath: string): void {
		this.index.clear();
		this.conflicted = false;

		if (!fs.existsSync(filePath)) {
			return;
		}

		const xml = fs.readFileSync(filePath, "utf-8");
		if (hasConflictMarkersInDataFile(xml)) {
			// **合流の途中の TM は読まない。** XML パーサーは競合マーカーを本文の一部として
			// 飲み込み、読めたところまでを返す（実測: 22件が21件になった）。そのまま次の登録で
			// 書き戻すと、失われたことに気づく手掛かりが1つも残らない。原稿に対する
			// 「合流の途中は触らない」（ADR-260906-04）と同じ扱いにする。
			this.conflicted = true;
			logger.warn("tm", "Translation memory is mid-merge; leaving it untouched", { filePath });
			return;
		}
		this.index = parseTmx(xml);
		this.rebuildTrigramIndex();
	}

	/** 合流の途中（競合マーカーが残っている）で、読み込みを見送ったか */
	get isConflicted(): boolean {
		return this.conflicted;
	}

	/**
	 * インメモリインデックスをTMX XMLとしてファイルに書き出す。
	 * ディレクトリが存在しない場合は再帰的に作成する。
	 * @param filePath TMXファイルのパス
	 */
	save(filePath: string): void {
		if (this.conflicted) {
			// 読めなかったものの上に書くと、解いていない競合ごと消える
			throw new Error("Translation memory is mid-merge; resolve the conflict before writing.");
		}
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const xml = serializeTmx(this.index);
		atomicWriteFileSync(filePath, xml, "utf-8");

		// save後のファイルmtimeを記録（次回getInstanceでリロードを回避）
		this.loadedFilePath = filePath;
		this.loadedMtime = fs.statSync(filePath).mtimeMs;
	}

	/**
	 * 新規エントリーを追加またはマージする。
	 * 同一tuidが既に存在する場合は、variant と provenance を最新でマージする。
	 * @param entry 追加するエントリー
	 */
	addEntry(entry: TmEntry | LegacyTmEntry): void {
		const normalizedEntry = normalizeEntry(entry);
		if (!normalizedEntry.primary) {
			return;
		}
		const existing = this.index.get(normalizedEntry.tuid);
		if (existing) {
			if (normalizedEntry.primary) {
				existing.primary = normalizedEntry.primary;
			}
			for (const [lang, variant] of normalizedEntry.variants) {
				existing.variants.set(lang, {
					...(existing.variants.get(lang) ?? {}),
					...variant,
				});
			}
		} else {
			this.index.set(normalizedEntry.tuid, {
				...normalizedEntry,
				variants: new Map([...normalizedEntry.variants.entries()].map(([lang, variant]) => [lang, { ...variant }])),
			});
		}
		this.indexEntry(normalizedEntry);
	}

	/**
	 * tuid で単一検索する。
	 */
	findByTuid(tuid: string): TmEntry | undefined {
		return this.index.get(tuid);
	}

	/**
	 * tuid で検索し、指定ターゲット言語の訳文を含むTmMatchを返す。
	 * @param hash tuid
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @returns TmMatch、またはundefined
	 */
	lookupByHash(hash: string, sourceLang: string, targetLang: string): TmMatch | undefined {
		const entry = this.index.get(hash);
		if (!entry) {
			return undefined;
		}
		const sourceVariant = entry.variants.get(sourceLang);
		const targetVariant = entry.variants.get(targetLang);
		const source = sourceVariant?.text;
		const target = targetVariant?.text;
		if (!source || !target) {
			return undefined;
		}
		return {
			sentenceHash: entry.tuid,
			source,
			target,
			firstUsedIn: "",
			// ハッシュで引き当てたということは、正規化した本文が同じということ
			similarity: 1,
		};
	}

	/**
	 * 複数ハッシュでバッチ検索する。
	 * @param hashes sentenceHash配列
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @returns TmMatch配列（見つからなかったハッシュは除外）
	 */
	lookupBatch(hashes: string[], sourceLang: string, targetLang: string): TmMatch[] {
		const results: TmMatch[] = [];
		for (const hash of hashes) {
			const match = this.lookupByHash(hash, sourceLang, targetLang);
			if (match) {
				results.push(match);
			}
		}
		return results;
	}

	/**
	 * 原文テキストによるTMヒット検索。
	 * 全エントリーのうち、指定言語のvariantが一致するものを返す。
	 * @param text 検索テキスト
	 * @param lang 言語コード
	 * @returns 一致するエントリー配列
	 */
	searchBySource(text: string, lang: string): TmEntry[] {
		const results: TmEntry[] = [];
		for (const entry of this.index.values()) {
			const segment = entry.variants.get(lang)?.text;
			if (segment === text) {
				results.push(entry);
			}
		}
		return results;
	}

	/**
	 * 全 TmEntry を返す（純粋データアクセス）。
	 * フィルタリングは呼び出し元が行う。
	 */
	getEntriesByUnitPath(_unitPath: string, primaryLang: string, _localLang: string): TmEntry[] {
		const results: TmEntry[] = [];
		for (const entry of this.index.values()) {
			if (entry.variants.has(primaryLang)) {
				results.push(entry);
			}
		}
		return results;
	}

	/**
	 * trigram クエリで候補エントリーを絞り込む。
	 * クエリを正規化して trigram を生成し、ヒット数降順で lang variant を持つエントリーを返す。
	 * @param query 検索クエリテキスト
	 * @param lang 対象言語コード（このvariantを持つエントリーのみ返す）
	 * @param limit 最大返却件数（デフォルト: 200）
	 */
	findCandidatesByTrigram(query: string, lang: string, limit = 200): TmEntry[] {
		const norm = normalizeForTm(query);
		const queryTrigrams = computeTrigrams(norm);
		if (queryTrigrams.size === 0) {
			return [];
		}

		const langMap = this.trigramIndex.get(lang);
		if (!langMap) {
			return [];
		}

		const hitCount = new Map<string, number>();
		for (const trigram of queryTrigrams) {
			const tuids = langMap.get(trigram);
			if (tuids) {
				for (const tuid of tuids) {
					hitCount.set(tuid, (hitCount.get(tuid) ?? 0) + 1);
				}
			}
		}

		return [...hitCount.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([tuid]) => this.index.get(tuid))
			.filter((entry): entry is TmEntry => entry?.variants.has(lang) ?? false)
			.slice(0, limit);
	}

	/**
	 * 登録エントリー数を返す。
	 */
	getEntryCount(): number {
		return this.index.size;
	}

	/**
	 * すべてのエントリーをクリアする。
	 */
	clear(): void {
		this.index.clear();
		this.trigramIndex.clear();
		this.trigramCache.clear();
	}

	/** 全エントリーの全 variant テキストを lang 別に再インデックスする（load専用） */
	private rebuildTrigramIndex(): void {
		this.trigramIndex.clear();
		this.trigramCache.clear();
		for (const entry of this.index.values()) {
			this.indexEntry(entry);
		}
	}

	/** 全 variant のテキストを lang 別に trigram インデックスへ追加する */
	private indexEntry(entry: TmEntry): void {
		for (const [lang, variant] of entry.variants) {
			const norm = normalizeForTm(variant.text);
			const trigrams = computeTrigrams(norm);
			this.trigramCache.set(`${entry.tuid}:${lang}`, trigrams);
			let langMap = this.trigramIndex.get(lang);
			if (!langMap) {
				langMap = new Map<string, Set<string>>();
				this.trigramIndex.set(lang, langMap);
			}
			for (const trigram of trigrams) {
				let tuids = langMap.get(trigram);
				if (!tuids) {
					tuids = new Set();
					langMap.set(trigram, tuids);
				}
				tuids.add(entry.tuid);
			}
		}
	}

	/**
	 * ランカーが候補の trigram を再計算せずに参照するための読み取り専用ビューを返す。
	 * キー形式: "${tuid}:${lang}"
	 */
	getTrigramCache(): ReadonlyMap<string, ReadonlySet<string>> {
		return this.trigramCache;
	}
}
