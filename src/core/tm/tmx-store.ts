import * as fs from "node:fs";
import * as path from "node:path";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { TmEntry, TmMatch, TmUsedIn, TmxData, TmxHeader } from "./types";

/** TMXのデフォルトヘッダー */
const DEFAULT_HEADER: TmxHeader = {
	creationtool: "mdait",
	creationtoolversion: "0.0.1",
	datatype: "Markdown",
	segtype: "sentence",
	"o-tmf": "mdait",
	srclang: "*all*",
};

/** TMXバージョン */
const TMX_VERSION = "1.4";

/** XMLプロパティタイプ定数 */
const PROP_TYPE_HASH = "x-mdait-hash";
const PROP_TYPE_CREATED_AT = "x-mdait-created-at";
const PROP_TYPE_USED_IN = "x-mdait-used-in";

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
 * usedIn文字列をパースする
 * 形式: "相対パス#ユニットハッシュ"
 */
function parseUsedIn(value: string): TmUsedIn {
	const separatorIndex = value.lastIndexOf("#");
	if (separatorIndex === -1) {
		return { unitPath: value, unitHash: "" };
	}
	return {
		unitPath: value.substring(0, separatorIndex),
		unitHash: value.substring(separatorIndex + 1),
	};
}

/**
 * usedInを文字列にシリアライズする
 * 形式: "相対パス#ユニットハッシュ"
 */
function formatUsedIn(usedIn: TmUsedIn): string {
	return `${usedIn.unitPath}#${usedIn.unitHash}`;
}

/**
 * パース済みTUノードからTmEntryに変換する
 */
function parseTuNode(tuNode: Record<string, unknown>): TmEntry | null {
	let sentenceHash = "";
	let createdAt = "";
	const usedIn: TmUsedIn[] = [];
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
			case PROP_TYPE_CREATED_AT:
				createdAt = value;
				break;
			case PROP_TYPE_USED_IN:
				usedIn.push(parseUsedIn(value));
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

	return {
		sentenceHash,
		segments,
		usedIn,
		createdAt,
	};
}

/**
 * TMX XMLを全件パースする
 */
function parseTmx(xml: string): TmxData {
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

	return {
		version: TMX_VERSION,
		header: { ...DEFAULT_HEADER },
		entries,
	};
}

/**
 * TmEntryをXMLBuilder用オブジェクトに変換する
 */
function buildTuObject(entry: TmEntry): Record<string, unknown> {
	const props: Record<string, unknown>[] = [];
	props.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_HASH, "#text": entry.sentenceHash });
	props.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_CREATED_AT, "#text": entry.createdAt });

	for (const usedInItem of entry.usedIn) {
		props.push({ [`${ATTR_PREFIX}type`]: PROP_TYPE_USED_IN, "#text": formatUsedIn(usedInItem) });
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
 * TmxDataを完全なTMX XML文字列にシリアライズする
 */
function serializeTmx(data: TmxData): string {
	const h = data.header;

	// エントリーをハッシュ順でソート（決定的出力、git差分最小化）
	const sortedEntries = [...data.entries.values()].sort((a, b) => a.sentenceHash.localeCompare(b.sentenceHash));
	const tuArray = sortedEntries.map((entry) => buildTuObject(entry));

	const tmxObject = {
		tmx: {
			[`${ATTR_PREFIX}version`]: data.version,
			header: {
				[`${ATTR_PREFIX}creationtool`]: h.creationtool,
				[`${ATTR_PREFIX}creationtoolversion`]: h.creationtoolversion,
				[`${ATTR_PREFIX}datatype`]: h.datatype,
				[`${ATTR_PREFIX}segtype`]: h.segtype,
				[`${ATTR_PREFIX}o-tmf`]: h["o-tmf"],
				[`${ATTR_PREFIX}srclang`]: h.srclang,
			},
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
 * - CRUD操作: addEntry, addUsedIn, updateTarget, lookupByHash, lookupBatch
 */
export class TmxStore {
	private static instance: TmxStore | null = null;
	private loadedFilePath: string | null = null;
	private loadedMtime = 0;

	/** sentenceHash → TmEntry */
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
		const data = parseTmx(xml);
		this.index = data.entries;
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

		const data: TmxData = {
			version: TMX_VERSION,
			header: { ...DEFAULT_HEADER },
			entries: this.index,
		};

		const xml = serializeTmx(data);
		fs.writeFileSync(filePath, xml, "utf-8");

		// save後のファイルmtimeを記録（次回getInstanceでリロードを回避）
		this.loadedFilePath = filePath;
		this.loadedMtime = fs.statSync(filePath).mtimeMs;
	}

	/**
	 * 新規エントリーを追加する。
	 * 同一sentenceHashが既に存在する場合は、ターゲット訳文を最新で上書きし、usedInを追加する。
	 * @param entry 追加するエントリー
	 */
	addEntry(entry: TmEntry): void {
		const existing = this.index.get(entry.sentenceHash);
		if (existing) {
			// 既存: セグメントを最新で上書き
			for (const [lang, text] of entry.segments) {
				existing.segments.set(lang, text);
			}
			// usedInを追加（重複チェック）
			for (const newUsedIn of entry.usedIn) {
				this.addUsedInToEntry(existing, newUsedIn);
			}
		} else {
			// 新規
			this.index.set(entry.sentenceHash, { ...entry, segments: new Map(entry.segments), usedIn: [...entry.usedIn] });
		}
	}

	/**
	 * 既存エントリーに出典情報を追加する。
	 * @param hash sentenceHash
	 * @param usedIn 追加する出典情報
	 * @returns 追加できた場合true
	 */
	addUsedIn(hash: string, usedIn: TmUsedIn): boolean {
		const entry = this.index.get(hash);
		if (!entry) {
			return false;
		}
		this.addUsedInToEntry(entry, usedIn);
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
		const firstUsedIn = entry.usedIn.length > 0 ? formatUsedIn(entry.usedIn[0]) : "";
		return {
			sentenceHash: entry.sentenceHash,
			source,
			target,
			firstUsedIn,
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

	/**
	 * usedInの重複チェック付き追加（内部ヘルパー）
	 */
	private addUsedInToEntry(entry: TmEntry, newUsedIn: TmUsedIn): void {
		const exists = entry.usedIn.some(
			(existing) => existing.unitPath === newUsedIn.unitPath && existing.unitHash === newUsedIn.unitHash,
		);
		if (!exists) {
			entry.usedIn.push(newUsedIn);
		}
	}
}
