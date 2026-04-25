import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import type { Configuration, CopyAssetsConfig } from "../../infra/config/configuration";
import { Logger } from "../../infra/logging/logger";
import { DiffType, type UnitDiff } from "./diff-detector";

const logger = Logger.getInstance();

/**
 * パス抽出ロジックの差し替え口。
 * 将来Hugoショートコード等に対応可能にするための拡張ポイント。
 */
export interface AssetPathExtractor {
	extractPaths(content: string): string[];
}

/**
 * Markdown標準記法 ![alt](./path) と [text](./path) からアセットパスを抽出する
 */
export class MarkdownAssetPathExtractor implements AssetPathExtractor {
	extractPaths(content: string): string[] {
		const paths: string[] = [];

		// 画像パスを抽出: ![alt](path) — スペースか ) で終端してタイトル属性を除外
		const imageRegex = /!\[.*?\]\(([^\s)]+)/g;
		for (const match of content.matchAll(imageRegex)) {
			if (match[1]) {
				paths.push(match[1]);
			}
		}

		// リンクパスを抽出: [text](path)（画像を除く）— スペースか ) で終端してタイトル属性を除外
		const linkRegex = /(?<!!)\[.*?\]\(([^\s)]+)/g;
		for (const match of content.matchAll(linkRegex)) {
			if (match[1]) {
				paths.push(match[1]);
			}
		}

		return paths;
	}
}

/**
 * copyDiffAssets への入力パラメータ
 */
export interface CopyDiffAssetsParams {
	diffs: UnitDiff[];
	/** ソースファイルのユニット群 */
	sourceUnits: MdaitUnit[];
	/** ソースファイルの絶対パス */
	sourceFile: string;
	config: Configuration;
	/** 省略時は MarkdownAssetPathExtractor を使用 */
	extractor?: AssetPathExtractor;
	/**
	 * 旧原文コンテンツのローダー。hash からスナップショットを返す。
	 * 省略時は UnitRegistryManager.getInstance().loadUnitRegistry を使用。
	 * テストで差し替え可能。
	 */
	loadOldSource?: (hash: string) => Promise<string | null>;
}

/**
 * `sync.copyAssets` / `transPairs[].copyAssets` の有効値を解決する。
 *
 * - 戻り値が `null` の場合: コピー機能は無効（呼び出し側で早期リターン）
 * - 戻り値の `whitelist` が `null` の場合: 拡張子ホワイトリストなし（除外フィルタを通過した全アセットをコピー）
 * - 戻り値の `whitelist` が `Set<string>` の場合: その拡張子だけをコピー対象とする
 */
export function resolveCopyAssets(
	pairValue: CopyAssetsConfig | undefined,
	globalValue: CopyAssetsConfig,
): { whitelist: Set<string> | null } | null {
	const value = pairValue !== undefined ? pairValue : globalValue;
	if (value === false) {
		return null;
	}
	if (value === true) {
		return { whitelist: null };
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return null;
		}
		return { whitelist: new Set(value.map((e) => e.toLowerCase())) };
	}
	// 想定外の型（JSON Schemaを通過していない設定値等）は安全側で無効扱い
	logger.warn("sync", "Invalid copyAssets value, treating as disabled", { value });
	return null;
}

/**
 * 差分に応じてアセットファイルをソースからターゲットへコピーする。
 *
 * 比較基準はすべて **原文側**。旧原文は unit-registry から取得する。
 *
 * - ADDED: 新原文ユニット内の全相対パスアセットをコピー
 * - UNCHANGED + need:revise@{oldhash}: unit-registry から旧原文を読み、新原文パスから
 *   旧原文パスを差し引いた「新規追加されたパスのみ」コピー。旧原文が取得できない場合は
 *   差分不明として新原文の全パスをコピー（安全フォールバック）
 * - UNCHANGED + need:translate（@なし）: 旧原文が存在しないので新原文の全パスをコピー
 * - UNCHANGED + need が無い / verify-deletion / review / 他: コピーしない
 * - MODIFIED / DELETED: コピーしない
 *
 * フィルタ（すべての分岐で共通）:
 * - 外部URL（http:/https:/protocol-relative）
 * - 絶対パス
 * - sourceDir 外（パストラバーサル）
 * - 存在しないファイル
 * - 翻訳対象拡張子（.md および config.trans.extensions）
 * - `copyAssets` がホワイトリスト指定の場合、それ以外の拡張子
 *
 * `sync.copyAssets`（または `transPairs[].copyAssets`）が `false` / 空配列の場合は
 * 何もせずに早期リターンする。pair が見つからない場合も同様。
 */
export async function copyDiffAssets(params: CopyDiffAssetsParams): Promise<void> {
	const {
		diffs,
		sourceUnits,
		sourceFile,
		config,
		extractor = new MarkdownAssetPathExtractor(),
		loadOldSource = (hash: string) =>
			UnitRegistryManager.getInstance().loadUnitRegistry(hash),
	} = params;

	const pair = config.getTransPairForSourceFile(sourceFile);
	if (!pair) {
		return;
	}

	const effective = resolveCopyAssets(pair.copyAssets, config.sync.copyAssets);
	if (effective === null) {
		return;
	}

	const configBaseDir = config.getConfigBaseDir();
	const absoluteSourceDir = path.resolve(configBaseDir, pair.sourceDir);
	const absoluteTargetDir = path.resolve(configBaseDir, pair.targetDir);
	const srcFileDir = path.dirname(sourceFile);

	// 翻訳対象拡張子（.md + config.trans.extensions）は小文字化した Set で比較
	const excludedExtensions = new Set<string>([".md"]);
	for (const ext of config.trans.extensions ?? []) {
		excludedExtensions.add(ext.toLowerCase());
	}

	// sourceUnits を marker.hash でマップ化（UNCHANGED 処理で新原文を引くのに使用）
	const sourceHashMap = new Map<string, MdaitUnit>();
	for (const unit of sourceUnits) {
		if (unit.marker?.hash) {
			sourceHashMap.set(unit.marker.hash, unit);
		}
	}

	for (const diff of diffs) {
		const targets = await collectTargetPaths(diff, {
			extractor,
			sourceHashMap,
			loadOldSource,
		});
		for (const assetPath of targets) {
			if (isExtensionFiltered(assetPath, excludedExtensions, effective.whitelist)) {
				continue;
			}
			await copyAssetFile(assetPath, srcFileDir, absoluteSourceDir, absoluteTargetDir);
		}
	}
}

/**
 * diff からコピー対象のパス一覧を返す。フィルタ・コピー実行は呼び出し側。
 */
async function collectTargetPaths(
	diff: UnitDiff,
	ctx: {
		extractor: AssetPathExtractor;
		sourceHashMap: Map<string, MdaitUnit>;
		loadOldSource: (hash: string) => Promise<string | null>;
	},
): Promise<string[]> {
	if (diff.type === DiffType.ADDED && diff.source) {
		return ctx.extractor.extractPaths(diff.source.content);
	}

	if (diff.type !== DiffType.UNCHANGED || !diff.source) {
		return [];
	}

	const need = diff.source.marker?.need ?? null;
	const isRevise = need?.startsWith("revise@") === true;
	const isTranslate = need === "translate";
	if (!isRevise && !isTranslate) {
		return [];
	}

	// 新原文ユニットを marker.from（新 source hash）から引く
	const newSourceHash = diff.source.marker?.from;
	if (!newSourceHash) {
		return [];
	}
	const newSourceUnit = ctx.sourceHashMap.get(newSourceHash);
	if (!newSourceUnit) {
		return [];
	}
	const newPaths = ctx.extractor.extractPaths(newSourceUnit.content);

	if (isTranslate) {
		// 旧原文なし: 新原文の全パスを対象に
		return newPaths;
	}

	// revise@{oldhash}: 旧原文との diff
	const oldHash = diff.source.marker?.getOldHashFromNeed();
	if (!oldHash) {
		return newPaths;
	}
	const oldSourceContent = await ctx.loadOldSource(oldHash);
	if (oldSourceContent === null) {
		// 旧原文が unit-registry に無い場合は差分不明として全コピー
		return newPaths;
	}
	const oldPaths = new Set(ctx.extractor.extractPaths(oldSourceContent));
	return newPaths.filter((p) => !oldPaths.has(p));
}

/**
 * 拡張子による除外判定。以下のいずれかに該当する場合 true（= スキップ）。
 * - 翻訳対象拡張子（`.md` または `config.trans.extensions`）に一致する
 * - ホワイトリストが指定されており、そのいずれにも一致しない
 *
 * 外部URLや絶対パス等は呼び出し側の copyAssetFile で弾く。
 */
function isExtensionFiltered(
	assetPath: string,
	excludedExtensions: Set<string>,
	whitelist: Set<string> | null,
): boolean {
	// クエリ・フラグメントを除いた拡張子で判定
	const withoutQuery = assetPath.split(/[?#]/)[0];
	const ext = path.extname(withoutQuery).toLowerCase();

	// 翻訳対象拡張子は常に除外
	if (ext.length > 0 && excludedExtensions.has(ext)) {
		return true;
	}

	// ホワイトリスト指定時は、リストにない拡張子は除外
	if (whitelist !== null && !whitelist.has(ext)) {
		return true;
	}

	return false;
}

/**
 * 単一アセットファイルをソースからターゲットへコピーする。
 * 外部URL・絶対パス・パストラバーサルの場合はスキップ。
 */
async function copyAssetFile(
	assetPath: string,
	srcFileDir: string,
	absoluteSourceDir: string,
	absoluteTargetDir: string,
): Promise<void> {
	// 外部URLをスキップ
	if (
		assetPath.startsWith("http://") ||
		assetPath.startsWith("https://") ||
		assetPath.startsWith("//")
	) {
		return;
	}

	// 絶対パスをスキップ
	if (assetPath.startsWith("/")) {
		return;
	}

	// コピー元パスを解決
	const resolvedSrc = path.resolve(srcFileDir, assetPath);

	// パストラバーサルチェック: absoluteSourceDir の外に出る場合はスキップ
	const relToSourceDir = path.relative(absoluteSourceDir, resolvedSrc);
	if (relToSourceDir.startsWith("..") || path.isAbsolute(relToSourceDir)) {
		logger.warn("sync", "Asset path traversal detected, skipping", {
			assetPath,
			resolvedSrc,
			absoluteSourceDir,
		});
		return;
	}

	// コピー元が存在しない場合はスキップ
	if (!fs.existsSync(resolvedSrc)) {
		logger.warn("sync", "Asset file not found, skipping", {
			assetPath,
			resolvedSrc,
		});
		return;
	}

	// コピー先パスを計算
	const targetAssetPath = path.join(absoluteTargetDir, relToSourceDir);

	// コピー先ディレクトリを作成
	await fsPromises.mkdir(path.dirname(targetAssetPath), { recursive: true });

	// ファイルをコピー
	await fsPromises.copyFile(resolvedSrc, targetAssetPath);
}
