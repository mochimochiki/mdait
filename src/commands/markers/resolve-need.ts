/**
 * @file resolve-need.ts
 * @description
 *   need フラグ解決（除去）コマンド。
 *   CodeLens「Mark as Reviewed」（`mdait.codelens.clearNeed`）と同等の操作を、
 *   ファイル単位・複数ユニットまとめてプログラム的に実行する（LM Tool `mdait_resolve` から利用）。
 *   マーカー変異は `removeNeedTag()` のみで、hash / from / 本文には一切触れない。
 *   embedded / external 両モードの差異は resolveMarkerIO 経由の parse/stringify に乗ることで吸収する
 *   （external は provider.detachMarkers が unit-state ストアへ書き戻す。ai-review の review-core と同じ経路）。
 *   マーカー境界の探索は markdown パーサーに委譲するため、コードブロック内のサンプルマーカーには
 *   誤マッチしない（生の正規表現探索は行わない）。
 * @module commands/markers/resolve-need
 */
import * as vscode from "vscode";
import { markdownParser } from "../../core/markdown/parser";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { StatusManager } from "../../core/status/status-manager";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { Logger } from "../../infra/logging/logger";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { FileMutex } from "../../infra/workspace/file-mutex";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";

const logger = Logger.getInstance();

/** 既定で解決対象とする need 種別（translate / revise は明示指定時のみ解決する） */
export const DEFAULT_RESOLVABLE_NEEDS: readonly string[] = ["review", "verify-deletion"];

/** 解決対象の選択オプション */
export interface NeedResolutionOptions {
	/** 対象ユニットの hash。省略時は needs フィルタに一致する全ユニット */
	unitHashes?: string[];
	/** 解決対象の need 種別フィルタ。省略時は DEFAULT_RESOLVABLE_NEEDS */
	needs?: string[];
}

/** 解決されたユニット */
export interface ResolvedNeedUnit {
	hash: string;
	title?: string;
	/** 除去した need フラグの生値 */
	need: string;
}

/** スキップ理由 */
export type NeedSkipReason = "not-found" | "already-resolved" | "need-not-selected";

/** スキップされたユニット */
export interface SkippedNeedUnit {
	hash: string;
	reason: NeedSkipReason;
}

/** applyNeedResolution の結果 */
export interface NeedResolutionResult {
	resolved: ResolvedNeedUnit[];
	skipped: SkippedNeedUnit[];
	/** 1件以上のマーカーを変更したか */
	changed: boolean;
}

/** resolveNeedForFile の結果 */
export interface ResolveNeedFileResult extends NeedResolutionResult {
	/** 解決後にファイル内へ残っている need フラグの生値一覧（内訳集計は呼び出し側で行う） */
	remainingNeedFlags: string[];
}

/**
 * need フラグが選択フィルタに一致するかを判定する。
 * "revise" 指定は revise@{oldhash} 形式にも一致する。
 */
export function needMatchesSelection(need: string, selected: readonly string[]): boolean {
	if (selected.includes(need)) {
		return true;
	}
	return selected.includes("revise") && need.startsWith("revise@");
}

function toResolvedUnit(unit: MdaitUnit, removedNeed: string): ResolvedNeedUnit {
	const resolved: ResolvedNeedUnit = { hash: unit.marker?.hash ?? "", need: removedNeed };
	if (unit.title) {
		resolved.title = unit.title;
	}
	return resolved;
}

/**
 * パース済みユニット列に対して need フラグ解決を適用する（純関数的コア。VS Code 非依存）。
 * マーカーの need のみを除去し、hash / from / 本文には触れない。冪等:
 * 同じ入力で2回目を実行すると resolved は 0 件になる（unitHashes 指定時は already-resolved でスキップ）。
 *
 * @param units パース済みユニット（マーカーを直接変異させる）
 * @param options 対象選択オプション
 */
export function applyNeedResolution(units: MdaitUnit[], options: NeedResolutionOptions = {}): NeedResolutionResult {
	const selected = options.needs && options.needs.length > 0 ? options.needs : [...DEFAULT_RESOLVABLE_NEEDS];
	const resolved: ResolvedNeedUnit[] = [];
	const skipped: SkippedNeedUnit[] = [];

	if (options.unitHashes && options.unitHashes.length > 0) {
		for (const hash of options.unitHashes) {
			const unit = units.find((u) => u.marker?.hash === hash);
			if (!unit?.marker) {
				skipped.push({ hash, reason: "not-found" });
				continue;
			}
			const need = unit.marker.need;
			if (!need) {
				skipped.push({ hash, reason: "already-resolved" });
				continue;
			}
			if (!needMatchesSelection(need, selected)) {
				skipped.push({ hash, reason: "need-not-selected" });
				continue;
			}
			unit.marker.removeNeedTag();
			resolved.push(toResolvedUnit(unit, need));
		}
	} else {
		for (const unit of units) {
			const need = unit.marker?.need;
			if (!need || !needMatchesSelection(need, selected)) {
				continue;
			}
			unit.marker?.removeNeedTag();
			resolved.push(toResolvedUnit(unit, need));
		}
	}

	return { resolved, skipped, changed: resolved.length > 0 };
}

/**
 * 1ファイル分の need フラグ解決を実行する。
 *
 * - 読み取り〜書き戻しの間は FileMutex でファイル単位に排他する（sync/trans との競合防止）
 * - embedded では本文のマーカー行が書き換わり、external では unit-state ストアが更新される
 * - 変更が無ければファイルへは書き込まない（冪等）
 *
 * @param absPath 対象ファイルの絶対パス
 * @param config 設定
 * @param options 対象選択オプション
 */
export async function resolveNeedForFile(
	absPath: string,
	config: Configuration,
	options: NeedResolutionOptions = {},
): Promise<ResolveNeedFileResult> {
	// external マーカーの場合は unit-state ストアを先にロードする（ai-review と同じ経路）
	if (config.isExternalMarkers()) {
		const mdaitDir = await ensureMdaitDir();
		if (mdaitDir) {
			UnitStateStore.getInstance().ensureLoaded(mdaitDir);
		}
	}

	let role: "source" | "target" = "target";
	try {
		role = new FileExplorer().isSourceFile(absPath, config) ? "source" : "target";
	} catch {
		// ワークスペース未設定等は target 扱い（codelens-command と同じフォールバック）
	}

	let outcome: ResolveNeedFileResult = { resolved: [], skipped: [], changed: false, remainingNeedFlags: [] };

	await FileMutex.getInstance().runExclusive([absPath], async () => {
		await flushDirtyDocument(absPath);

		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
		const io = resolveMarkerIO(config, absPath, role);
		const parsed = markdownParser.parse(content, config, io.provider, io.ctx);

		const result = applyNeedResolution(parsed.units, options);
		if (result.changed) {
			const encoder = new TextEncoder();
			const updatedContent = markdownParser.stringify(
				{ frontMatter: parsed.frontMatter, units: parsed.units },
				io.provider,
				io.ctx,
			);
			await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), encoder.encode(updatedContent));
		}

		const remainingNeedFlags = parsed.units
			.map((unit) => unit.marker?.need)
			.filter((need): need is string => !!need);
		outcome = { ...result, remainingNeedFlags };
	});

	if (outcome.changed) {
		// external マーカーの場合は unit-state ストアを保存する
		if (config.isExternalMarkers()) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().save(mdaitDir);
			}
		}
		await StatusManager.getInstance().refreshFileStatus(absPath);
		StatusManager.getInstance().notifyRootChanged();
	}

	logger.info("resolve", "Need flags resolved", {
		file: absPath,
		resolved: outcome.resolved.length,
		skipped: outcome.skipped.length,
	});
	return outcome;
}
