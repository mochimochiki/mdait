import * as vscode from "vscode";
import { parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { markdownParser } from "../../core/markdown/parser";
import type { FileStatusItem } from "../../core/status/status-item";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { Configuration } from "../../infra/config/configuration";
import type { TransPair } from "../../infra/config/configuration";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";
import type { SectionAligner } from "../adopt/section-aligner";
import { type DeclareIsolateResult, declareIsolateForFile } from "../markers/declare-isolate";
import { type DeleteUnitResult, deleteUnitFromFile } from "../markers/delete-unit";
import {
	type NeedResolutionOptions,
	type NeedTarget,
	type ResolveNeedFileResult,
	resolveNeedForFile,
} from "../markers/resolve-need";
import { syncNew_CoreProc, sync_CoreProc } from "../sync/sync-command";
import { transFile_CoreProc } from "../trans/trans-command";
import type { Translator } from "../trans/translator";
import type { FileHandler, FileSyncOptions, FileSyncResult, FileTranslateResult } from "./file-handler";
import { StatusCollector } from "./status-collector";

/**
 * Markdownファイル用のFileHandler実装。
 * 既存の sync_CoreProc / syncNew_CoreProc に委譲し、
 * DiffResult → FileSyncResult の変換のみを行う。
 */
export class MdFileHandler implements FileHandler {
	readonly fileType = "md" as const;

	async sync(
		sourceFile: string,
		targetFile: string,
		options?: FileSyncOptions,
		aligner?: SectionAligner,
	): Promise<FileSyncResult> {
		const config = Configuration.getInstance();
		const diffResult = await sync_CoreProc(sourceFile, targetFile, config, options, aligner);
		return {
			added: diffResult.added,
			modified: diffResult.modified,
			deleted: diffResult.deleted,
			unchanged: diffResult.unchanged,
			revisionsNeeded: diffResult.revisionsNeeded ?? 0,
			adopted: diffResult.adopted ?? 0,
			kept: diffResult.kept ?? 0,
			orphanReviewed: diffResult.orphanReviewed ?? 0,
			alignCorrections: diffResult.alignCorrections ?? 0,
		};
	}

	async syncNew(sourceFile: string, targetFile: string): Promise<FileSyncResult> {
		const config = Configuration.getInstance();
		const diffResult = await syncNew_CoreProc(sourceFile, targetFile, config);
		return {
			added: diffResult.added,
			modified: diffResult.modified,
			deleted: diffResult.deleted,
			unchanged: diffResult.unchanged,
			revisionsNeeded: diffResult.revisionsNeeded ?? 0,
		};
	}

	async translate(
		targetFilePath: string,
		_translator: Translator,
		_pair: TransPair,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
	): Promise<FileTranslateResult | undefined> {
		const uri = vscode.Uri.file(targetFilePath);
		const result = await transFile_CoreProc(uri, progress, token);
		if (!result) {
			return undefined;
		}
		return {
			translatedCount: result.translatedCount,
			patchedCount: result.patchedCount,
			skippedCount: result.skippedCount,
			tmHits: result.tmHits,
		};
	}

	async collectStatus(filePath: string): Promise<FileStatusItem> {
		const collector = new StatusCollector();
		return collector.collectFileStatus(filePath);
	}

	async isInitialized(filePath: string): Promise<boolean> {
		const config = Configuration.getInstance();
		const document = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(document);
		const parsed = markdownParser.parse(content, config);

		// frontmatter マーカーは両モードとも本文内に存在する
		const hasFrontmatterMarker = parsed.frontMatter ? parseFrontmatterMarker(parsed.frontMatter) !== null : false;

		// external では unit マーカーは本文ではなく unit-state に退避されるため、store を参照する
		if (config.isExternalMarkers()) {
			const mdaitDir = await ensureMdaitDir();
			if (mdaitDir) {
				UnitStateStore.getInstance().ensureLoaded(mdaitDir);
			}
			const rel = toWorkspaceRelativePath(filePath);
			const hasUnitState = UnitStateStore.getInstance().getEntriesByPath(rel).length > 0;
			return hasUnitState || hasFrontmatterMarker;
		}

		const hasUnitMarker = parsed.units.some((unit) => unit.marker.hash !== null);

		return hasUnitMarker || hasFrontmatterMarker;
	}

	// ===== マーカー／ユニット状態の書き換え =====

	async resolveNeed(filePath: string, options: NeedResolutionOptions = {}): Promise<ResolveNeedFileResult> {
		return resolveNeedForFile(filePath, Configuration.getInstance(), options);
	}

	async declareIsolate(filePath: string, target: NeedTarget): Promise<DeclareIsolateResult> {
		if (target.kind !== "unit") {
			// frontmatter は原文の同一ファイル内にあり伝播の概念がないため凍結の対象外
			return { declared: false, changed: false, hash: "", reason: "not-found" };
		}
		return declareIsolateForFile(filePath, target.hash, Configuration.getInstance());
	}

	async deleteUnit(filePath: string, target: NeedTarget): Promise<DeleteUnitResult> {
		if (target.kind !== "unit") {
			// frontmatter は本文ユニットではないため個別削除の対象外
			return { deleted: false, changed: false, hash: "", reason: "not-found" };
		}
		return deleteUnitFromFile(filePath, target.hash, Configuration.getInstance());
	}
}
