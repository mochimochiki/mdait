import * as fs from "node:fs";
import * as path from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { TmEntry, TmMatch } from "./types";

/** TMXバージョン */
const TMX_VERSION = "1.4";

/** XMLプロパティタイプ定数 */
const PROP_TYPE_HASH = "x-hash";
const PROP_TYPE_UNIT = "x-unit";
const PROP_TYPE_SOURCE_HASH = "x-source-hash";

/** XML宣言 */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** fast-xml-parser属性プレフィックス */
const ATTR_PREFIX = "@_";

/** 配列として強制するタグ名 */
const ARRAY_TAG_NAMES = new Set(["tu", "tuv", "prop"]);

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
	let sentenceHash = "";
	let unitPath = "";
	let sourceHash: string | undefined;
	const segments = new Map<string, string>();

	// <prop> 要素を処理
	const props = (tuNode.prop as Array<Record<string, unknown>>) ?? [];
	for (const prop of props) {
		const type = prop[`${ATTR_PREFIX}type`] as string;
		const value = String(prop["#text"] ?? "");
		switch (type) {
			case PROP_TYPE_HASH:
				sentenceHash = value;
				break;
			case PROP_TYPE_UNIT:
				unitPath = value;
				break;
			case PROP_TYPE_SOURCE_HASH:
				sourceHash = value;
				break;
		}
	}

	if (!sentenceHash) {
		return null;
	}

	// <tuv> 要素を処理
	const tuvs = (tuNode.tuv as Array<Record<string, unknown>>) ?? [];
	for (const tuv of tuvs) {
		const lang = tuv[`${ATTR_PREFIX}xml:lang`] as string;
		const text = String(tuv.seg ?? "");
		if (lang) {
			segments.set(lang, text);
		}
	}

	const entry: TmEntry = {
		sentenceHash,
		segments,
		unitPath,
	};
	if (sourceHash) {
		entry.sourceHash = sourceHash;
	}
	return entry;
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
				entries.set(entry.sentenceHash, entry);
			}
		}
	}

	return entries;
}

/**
 * TmEntryをXMLBuilder用オブジェクトに変換する
 */
function buildTuObject(entry: TmEntry): Record<string, unknown> {
	const props: Record<string, unknown>[] = [];
	props.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_HASH, "#text": entry.sentenceHash });
	if (entry.unitPath) {
		props.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_UNIT, "#text": entry.unitPath });
	}
	if (entry.sourceHash) {
		props.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_SOURCE_HASH, "#text": entry.sourceHash });
	}

	// セグメントを言語コード順でソート（決定的出力）
	const sortedLangs = [...entry.segments.keys()].sort();
	const tuvs: Record<string, unknown>[] = [];
	for (const lang of sortedLangs) {
		const text = entry.segments.get(lang) as string;
		tuvs.push({ [`${ATTR_PREFIX}xml:lang`]: lang, seg: text });
	}

	return { prop: props, tuv: tuvs };
}

/**
 * エントリーMap を完全なTMX XML文字列にシリアライズする
 */
function serializeTmx(entries: Map<string, TmEntry>): string {
	// エントリーをハッシュ順でソート（決定的出力、git差分最小化）
	const sortedEntries = [...entries.values()].sort((a, b) => a.sentenceHash.localeCompare(b.sentenceHash));
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
 * - Map<sentenceHash, TmEntry>による高速検索（O(1)）
 * - CRUD操作: addEntry, setUnitPath, updateTarget, lookupByHash, lookupBatch
 */
export class TmxStore {
	private static instance: TmxStore | null = null;
	private loadedFilePath: string | null = null;
	private loadedMtime = 0;

	/** sentenceHash → TmEntry */
	private index = new Map<string, TmEntry>();

	/** sourceHash二次インデックス（O(1)検索用） */
	private sourceHashIndex = new Set<string>();

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
				this.sourceHashIndex.clear();
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
		this.sourceHashIndex.clear();

		if (!fs.existsSync(filePath)) {
			return;
		}

		const xml = fs.readFileSync(filePath, "utf-8");
		this.index = parseTmx(xml);
		this.rebuildSourceHashIndex();
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
	 * 新規エントリーを追加する。
	 * 同一sentenceHashが既に存在する場合は、ターゲット訳文を最新で上書きし、unitPathも最新で上書きする。
	 * @param entry 追加するエントリー
	 */
	addEntry(entry: TmEntry): void {
		const existing = this.index.get(entry.sentenceHash);
		if (existing) {
			// 既存: セグメントとunitPath、sourceHashを最新で上書き
			for (const [lang, text] of entry.segments) {
				existing.segments.set(lang, text);
			}
			existing.unitPath = entry.unitPath;
			if (entry.sourceHash) {
				// 旧sourceHashをインデックスから削除（他エントリが同じ値を持つ可能性は低いが、
				// rebuildSourceHashIndexを避けるため新値を追加し旧値は残存させる。
				// 実害なし: false positiveはスキップが起こるだけ）
				existing.sourceHash = entry.sourceHash;
				this.sourceHashIndex.add(entry.sourceHash);
			}
		} else {
			// 新規
			this.index.set(entry.sentenceHash, { ...entry, segments: new Map(entry.segments) });
			if (entry.sourceHash) {
				this.sourceHashIndex.add(entry.sourceHash);
			}
		}
	}

	/**
	 * 既存エントリーの出典パスを設定する。
	 * @param hash sentenceHash
	 * @param unitPath 設定する出典パス
	 * @returns 更新できた場合true
	 */
	setUnitPath(hash: string, unitPath: string): boolean {
		const entry = this.index.get(hash);
		if (!entry) {
			return false;
		}
		entry.unitPath = unitPath;
		return true;
	}

	/**
	 * 既存エントリーのターゲット訳文を更新する。
	 * @param hash sentenceHash
	 * @param lang 言語コード
	 * @param text 新しい訳文
	 * @returns 更新できた場合true
	 */
	updateTarget(hash: string, lang: string, text: string): boolean {
		const entry = this.index.get(hash);
		if (!entry) {
			return false;
		}
		entry.segments.set(lang, text);
		return true;
	}

	/**
	 * ハッシュで単一検索する。
	 * @param hash sentenceHash
	 * @returns 見つかったエントリー、またはundefined
	 */
	findByHash(hash: string): TmEntry | undefined {
		return this.index.get(hash);
	}

	/**
	 * ハッシュで検索し、指定ターゲット言語の訳文を含むTmMatchを返す。
	 * @param hash sentenceHash
	 * @param sourceLang ソース言語コード
	 * @param targetLang ターゲット言語コード
	 * @returns TmMatch、またはundefined
	 */
	lookupByHash(hash: string, sourceLang: string, targetLang: string): TmMatch | undefined {
		const entry = this.index.get(hash);
		if (!entry) {
			return undefined;
		}
		const source = entry.segments.get(sourceLang);
		const target = entry.segments.get(targetLang);
		if (!source || !target) {
			return undefined;
		}
		return {
			sentenceHash: entry.sentenceHash,
			source,
			target,
			firstUsedIn: entry.unitPath,
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
	 * 全エントリーのうち、指定言語のセグメントが一致するものを返す。
	 * @param text 検索テキスト
	 * @param lang 言語コード
	 * @returns 一致するエントリー配列
	 */
	searchBySource(text: string, lang: string): TmEntry[] {
		const results: TmEntry[] = [];
		for (const entry of this.index.values()) {
			const segment = entry.segments.get(lang);
			if (segment === text) {
				results.push(entry);
			}
		}
		return results;
	}

	/**
	 * 指定されたsourceHashがTMに登録済みかどうかを返す。
	 * ユニットの原文ハッシュがTMに存在するかの確認に使用。
	 * @param sourceHash ユニットの原文コンテンツハッシュ（MdaitMarker.hash）
	 * @returns 登録済みならtrue
	 */
	hasSourceHash(sourceHash: string): boolean {
		return this.sourceHashIndex.has(sourceHash);
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
		this.sourceHashIndex.clear();
	}

	/**
	 * sourceHash二次インデックスを再構築する。
	 * load()時に呼び出される。
	 */
	private rebuildSourceHashIndex(): void {
		this.sourceHashIndex.clear();
		for (const entry of this.index.values()) {
			if (entry.sourceHash) {
				this.sourceHashIndex.add(entry.sourceHash);
			}
		}
	}
}
