import * as fs from "node:fs";
import * as path from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { atomicWriteFileSync } from "../../infra/workspace/atomic-write";
import { calculateHash } from "../hash/hash-calculator";
import { computeTrigrams, normalizeForTm } from "./tm-text-normalizer";
import type { ExistingTmEntriesItem, LegacyTmEntry, TmEntry, TmMatch, TmVariant } from "./types";

/** TMXバージョン */
const TMX_VERSION = "1.4";

/** XMLプロパティタイプ定数 */
const PROP_TYPE_HASH = "x-hash";
const PROP_TYPE_PRIMARY = "x-primary";
const PROP_TYPE_WEIGHT = "x-wt";

/** XML宣言 */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** fast-xml-parser属性プレフィックス */
const ATTR_PREFIX = "@_";

/** 配列として強制するタグ名 */
const ARRAY_TAG_NAMES = new Set(["tu", "tuv", "prop"]);

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
	let weight = 1;
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
			case PROP_TYPE_WEIGHT: {
				const parsedWeight = Number.parseFloat(value);
				if (Number.isFinite(parsedWeight)) {
					weight = Math.min(1, Math.max(0, parsedWeight));
				}
				break;
			}
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
		weight,
		variants,
	};
	return entry;
}

function isLegacyTmEntry(entry: TmEntry | LegacyTmEntry): entry is LegacyTmEntry {
	return "sentenceHash" in entry;
}

function normalizeEntry(entry: TmEntry | LegacyTmEntry): TmEntry {
	if (!isLegacyTmEntry(entry)) {
		return {
			...entry,
			weight: entry.weight ?? 1,
		};
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
		weight: 1,
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
			if (entry) {
				entries.set(entry.tuid, entry);
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

	// weight は非finite の可能性があるため、保存時にもサニタイズしてから使用する
	const rawWeight = entry.weight;
	const finiteWeight = Number.isFinite(rawWeight) ? (rawWeight as number) : 1;
	const safeWeight = Math.max(0, Math.min(1, finiteWeight));

	return {
		[`${ATTR_PREFIX}tuid`]: entry.tuid,
		prop: [
			{
				[`${ATTR_PREFIX}type`]: PROP_TYPE_WEIGHT,
				"#text": safeWeight.toFixed(6),
			},
		],
		tuv: tuvs,
	};
}

/**
 * エントリーMap を完全なTMX XML文字列にシリアライズする
 */
function serializeTmx(entries: Map<string, TmEntry>): string {
	// エントリーをtuid順でソート（決定的出力、git差分最小化）
	const sortedEntries = [...entries.values()].sort((a, b) => a.tuid.localeCompare(b.tuid));
	const tuArray = sortedEntries.map((entry) => buildTuObject(entry));

	const tmxObject = {
		tmx: {
			[`${ATTR_PREFIX}version`]: TMX_VERSION,
			body: tuArray.length > 0 ? { tu: tuArray } : {},
		},
	};

	const builder = new XMLBuilder({
		ignoreAttributes: false,
		attributeNamePrefix: ATTR_PREFIX,
		format: true,
		indentBy: "  ",
		suppressEmptyNode: true,
		processEntities: true,
	});

	const xmlBody = builder.build(tmxObject);
	return `${XML_DECLARATION}\n${xmlBody}`;
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

		if (!fs.existsSync(filePath)) {
			return;
		}

		const xml = fs.readFileSync(filePath, "utf-8");
		this.index = parseTmx(xml);
		this.rebuildTrigramIndex();
	}

	/**
	 * インメモリインデックスをTMX XMLとしてファイルに書き出す。
	 * ディレクトリが存在しない場合は再帰的に作成する。
	 * @param filePath TMXファイルのパス
	 */
	save(filePath: string): void {
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
