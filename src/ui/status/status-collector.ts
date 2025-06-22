import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { MarkdownItParser } from "../../core/markdown/parser";
import { FileExplorer } from "../../utils/file-explorer";
import type { FileStatus, StatusType, UnitStatus } from "./status-item";

/**
 * ファイルの翻訳状況を収集するクラス
 */
export class StatusCollector {
	private readonly fileExplorer: FileExplorer;
	private readonly parser: MarkdownItParser;

	constructor() {
		this.fileExplorer = new FileExplorer();
		this.parser = new MarkdownItParser();
	}
	/**
	 * 設定に基づいて全ファイルの翻訳状況を収集する（Targetディレクトリのみ）
	 */
	public async collectAllFileStatuses(config: Configuration): Promise<FileStatus[]> {
		const fileStatuses: FileStatus[] = [];

		try {
			// 各翻訳ペアのTargetディレクトリに対してファイル状況を収集
			for (const transPair of config.transPairs) {
				const targetStatuses = await this.collectFileStatusesInDirectory(
					transPair.targetDir,
					config,
				);

				fileStatuses.push(...targetStatuses);
			}
		} catch (error) {
			console.error("Error collecting file statuses:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error collecting file statuses: {0}", (error as Error).message),
			);
		}

		// fileNameで昇順ソート
		fileStatuses.sort((a, b) => a.fileName.localeCompare(b.fileName));
		return fileStatuses;
	}

	/**
	 * 指定されたディレクトリ内のファイル状況を収集する
	 */
	private async collectFileStatusesInDirectory(
		directoryPath: string,
		config: Configuration,
	): Promise<FileStatus[]> {
		const fileStatuses: FileStatus[] = [];

		// ワークスペースのルートパスを取得
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return fileStatuses;
		}

		const absoluteDirectoryPath = path.resolve(workspaceRoot, directoryPath);

		// ディレクトリが存在するかチェック
		if (!this.fileExplorer.directoryExists(absoluteDirectoryPath)) {
			return fileStatuses;
		}

		try {
			// Markdownファイルを検索
			const markdownFiles = await this.fileExplorer.findFilesInDirectory(
				absoluteDirectoryPath,
				[".md"],
				"**/*.md",
				config.ignoredPatterns,
			);

			// 各ファイルの状況を収集
			for (const filePath of markdownFiles) {
				const fileStatus = await this.collectFileStatus(filePath);
				fileStatuses.push(fileStatus);
			}
		} catch (error) {
			console.error(`Error collecting files in directory ${directoryPath}:`, error);
		}

		return fileStatuses;
	}
	/**
	 * 単一ファイルの翻訳状況を収集する
	 */
	private async collectFileStatus(filePath: string): Promise<FileStatus> {
		const fileName = path.basename(filePath);

		try {
			// ファイルを読み込み
			const content = await fs.promises.readFile(filePath, "utf-8");

			// Markdownをパース
			const markdown = this.parser.parse(content);

			// ユニットの翻訳状況を分析
			let translatedUnits = 0;
			const totalUnits = markdown.units.length;
			const units: UnitStatus[] = [];

			for (const unit of markdown.units) {
				const unitStatus = this.determineUnitStatus(unit);
				units.push({
					hash: unit.marker?.hash || "",
					title: unit.title,
					headingLevel: unit.headingLevel,
					status: unitStatus,
					startLine: unit.startLine,
					endLine: unit.endLine,
					fromHash: unit.marker?.from || undefined,
					needFlag: unit.marker?.need || undefined,
				});

				if (unitStatus === "translated") {
					translatedUnits++;
				}
			}

			// ファイル全体の状態を決定
			const status = this.determineFileStatus(translatedUnits, totalUnits);

			return {
				filePath,
				fileName,
				status,
				translatedUnits,
				totalUnits,
				hasParseError: false,
				units,
			};
		} catch (error) {
			console.error(`Error processing file ${filePath}:`, error);

			return {
				filePath,
				fileName,
				status: "error",
				translatedUnits: 0,
				totalUnits: 0,
				hasParseError: true,
				errorMessage: (error as Error).message,
			};
		}
	}

	/**
	 * 個別ユニットの翻訳状態を決定する
	 */
	private determineUnitStatus(unit: MdaitUnit): StatusType {
		if (!unit.marker) {
			return "unknown";
		}

		if (unit.marker.need === "translate") {
			return "needsTranslation";
		}

		if (unit.marker.need) {
			// review, verify-deletion などその他のneedフラグ
			return "needsTranslation";
		}

		return "translated";
	}

	/**
	 * ファイルの全体的な翻訳状態を決定する
	 */
	private determineFileStatus(translatedUnits: number, totalUnits: number): StatusType {
		if (totalUnits === 0) {
			return "unknown";
		}

		if (translatedUnits === totalUnits) {
			return "translated";
		}

		return "needsTranslation";
	}
}
