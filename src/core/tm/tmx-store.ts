import * as fs from "node:fs";
import * as path from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { calculateHash } from "../hash/hash-calculator";
import type { ExistingTmEntriesItem, LegacyTmEntry, TmEntry, TmMatch, TmVariant } from "./types";

/** TMXバージョン */
const TMX_VERSION = "1.4";

/** XMLプロパティタイプ定数 */
const PROP_TYPE_HASH = "x-hash";
const PROP_TYPE_PRIMARY = "x-primary";
const PROP_TYPE_UNIT = "x-unit";
const PROP_TYPE_UNIT_HASH = "x-unit-hash";

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
	let legacyUnitPath = "";
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
			case PROP_TYPE_UNIT:
				legacyUnitPath = value;
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
			let unitPath = legacyUnitPath;
			let unitHash: string | undefined;
			const tuvProps = (tuv.prop as Array<Record<string, unknown>>) ?? [];
			for (const prop of tuvProps) {
				const type = prop[`${ATTR_PREFIX}type`] as string;
				const value = String(prop["#text"] ?? "");
				if (type === PROP_TYPE_UNIT) {
					unitPath = value;
				}
				if (type === PROP_TYPE_UNIT_HASH) {
					unitHash = value;
				}
			}
			variants.set(lang, {
				text,
				...(unitPath ? { unitPath } : {}),
				...(unitHash ? { unitHash } : {}),
			});
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
		return entry;
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
		variants: new Map(
			sortedVariants.map(([lang, text]) => [lang, { text, ...(entry.unitPath ? { unitPath: entry.unitPath } : {}) }]),
		),
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
		const tuvProps: Record<string, unknown>[] = [];
		if (variant.unitPath) {
			tuvProps.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_UNIT, "#text": variant.unitPath });
		}
		if (variant.unitHash) {
			tuvProps.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_UNIT_HASH, "#text": variant.unitHash });
		}
		tuvs.push({
			[`${ATTR_PREFIX}xml:lang`]: lang,
			seg: variant.text,
			...(tuvProps.length > 0 ? { prop: tuvProps } : {}),
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
		fs.writeFileSync(filePath, xml, "utf-8");

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
			firstUsedIn: sourceVariant?.unitPath ?? targetVariant?.unitPath ?? "",
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
	 * 指定 unitPath に属する全 TmEntry を返す（純粋データアクセス）。
	 * フィルタリングは呼び出し元が行う。
	 */
	getEntriesByUnitPath(unitPath: string, primaryLang: string, _localLang: string): TmEntry[] {
		const results: TmEntry[] = [];
		for (const entry of this.index.values()) {
			const primaryVariant = entry.variants.get(primaryLang);
			if (!primaryVariant?.unitPath || primaryVariant.unitPath !== unitPath) {
				continue;
			}
			results.push(entry);
		}
		return results;
	}

	/**
	 * 現在の primaryUnit にアンカーされた既存 TM set を返す。
	 * @deprecated `getEntriesByUnitPath` へ移行してください。
	 */
	getExistingTmEntries(
		primaryUnitText: string,
		primaryLang: string,
		localLang: string,
		primaryUnitPath: string,
		primaryUnitHash?: string,
		localUnitText?: string,
		localUnitPath?: string,
		localUnitHash?: string,
	): ExistingTmEntriesItem[] {
		const sentenceCandidates = new Map<string, Array<TmEntry>>();
		for (const entry of this.index.values()) {
			const primaryVariant = entry.variants.get(primaryLang);
			if (!primaryVariant?.unitPath || primaryVariant.unitPath !== primaryUnitPath) {
				continue;
			}
			if (!primaryUnitText.includes(entry.primary.trim())) {
				continue;
			}
			const sentenceKey = entry.primary.trim();
			const bucket = sentenceCandidates.get(sentenceKey) ?? [];
			bucket.push(entry);
			sentenceCandidates.set(sentenceKey, bucket);
		}

		const results: ExistingTmEntriesItem[] = [];
		for (const candidates of sentenceCandidates.values()) {
			const prioritizedCandidates =
				primaryUnitHash &&
				candidates.some((candidate) => candidate.variants.get(primaryLang)?.unitHash === primaryUnitHash)
					? candidates.filter((candidate) => candidate.variants.get(primaryLang)?.unitHash === primaryUnitHash)
					: candidates;

			for (const entry of prioritizedCandidates) {
				const localVariant = entry.variants.get(localLang);
				const matchesPrimaryHash = Boolean(
					primaryUnitHash && entry.variants.get(primaryLang)?.unitHash === primaryUnitHash,
				);
				const matchesLocalHash = Boolean(
					localVariant?.unitHash &&
						localUnitHash &&
						localVariant.unitHash === localUnitHash &&
						(!localUnitPath || !localVariant.unitPath || localVariant.unitPath === localUnitPath),
				);
				const matchesLocalText = Boolean(
					localVariant?.text &&
						(localUnitText ?? "").includes(localVariant.text.trim()) &&
						(!localUnitPath || !localVariant.unitPath || localVariant.unitPath === localUnitPath),
				);
				const matchesPrimarySentenceOnly = !localVariant;
				if (!matchesPrimaryHash && !matchesLocalHash && !matchesLocalText && !matchesPrimarySentenceOnly) {
					continue;
				}
				results.push({
					tuid: entry.tuid,
					primarySentence: entry.primary,
					localSentence: localVariant?.text ?? null,
				});
			}
		}

		return results.sort((a, b) => a.tuid.localeCompare(b.tuid));
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
	}
}
