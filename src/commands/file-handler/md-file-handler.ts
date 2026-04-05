import * as vscode from "vscode";
import { parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { markdownParser } from "../../core/markdown/parser";
import type { FileStatusItem } from "../../core/status/status-item";
import { Configuration } from "../../infra/config/configuration";
import type { TransPair } from "../../infra/config/configuration";
import { syncNew_CoreProc, sync_CoreProc } from "../sync/sync-command";
import { transFile_CoreProc } from "../trans/trans-command";
import type { Translator } from "../trans/translator";
import type {
	FileHandler,
	FileSyncResult,
	FileTranslateResult,
} from "./file-handler";
import { StatusCollector } from "./status-collector";

/**
 * Markdownファイル用のFileHandler実装。
 * 既存の sync_CoreProc / syncNew_CoreProc に委譲し、
 * DiffResult → FileSyncResult の変換のみを行う。
 */
export class MdFileHandler implements FileHandler {
	readonly fileType = "md" as const;

	async sync(sourceFile: string, targetFile: string): Promise<FileSyncResult> {
		const config = Configuration.getInstance();
		const diffResult = await sync_CoreProc(sourceFile, targetFile, config);
		return {
			added: diffResult.added,
			modified: diffResult.modified,
			deleted: diffResult.deleted,
			unchanged: diffResult.unchanged,
			revisionsNeeded: diffResult.revisionsNeeded ?? 0,
		};
	}

	async syncNew(
		sourceFile: string,
		targetFile: string,
	): Promise<FileSyncResult> {
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
		const document = await vscode.workspace.fs.readFile(
			vscode.Uri.file(filePath),
		);
		const decoder = new TextDecoder("utf-8");
		const content = decoder.decode(document);
		const parsed = markdownParser.parse(content, config);

		const hasUnitMarker = parsed.units.some(
			(unit) => unit.marker.hash !== null,
		);
		const hasFrontmatterMarker = parsed.frontMatter
			? parseFrontmatterMarker(parsed.frontMatter) !== null
			: false;

		return hasUnitMarker || hasFrontmatterMarker;
	}
}
