import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../../config/configuration";
import { loadIndexFile } from "../../core/index/index-manager";
import type { IndexFile } from "../../core/index/index-types";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { MarkdownItParser } from "../../core/markdown/parser";
import { FileExplorer } from "../../utils/file-explorer";
import type { StatusItem, StatusType } from "./status-item";
import { StatusItemType } from "./status-item";

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
	public async collectAll(config: Configuration): Promise<StatusItem[]> {
		const statusItems: StatusItem[] = [];

		try {
			// インデックスファイルの読み込みを試行
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			let indexFile: IndexFile | null = null;
			if (workspaceRoot) {
				indexFile = await loadIndexFile(workspaceRoot);
			}

			if (indexFile) {
				// インデックスファイルがある場合は高速な収集を行う
				statusItems.push(...(await this.collectAllFromIndex(indexFile, config)));
			}
		} catch (error) {
			console.error("Error collecting file statuses:", error);
			vscode.window.showErrorMessage(
				vscode.l10n.t("Error collecting file statuses: {0}", (error as Error).message),
			);
		}

		// fileNameで昇順ソート
		statusItems.sort((a, b) => (a.fileName ?? "").localeCompare(b.fileName ?? ""));
		return statusItems;
	}

	/**
	 * 単一ファイルの翻訳状況を収集する
	 */
	public async collectFile(filePath: string): Promise<StatusItem> {
		const fileName = path.basename(filePath);

		try {
			// ファイルを読み込み
			const content = await fs.promises.readFile(filePath, "utf-8");

			// Markdownをパース
			const markdown = this.parser.parse(content);

			// ユニットの翻訳状況を分析
			let translatedUnits = 0;
			const totalUnits = markdown.units.length;
			const children: StatusItem[] = [];

			for (const unit of markdown.units) {
				const unitStatus = this.determineUnitStatus(unit);
				children.push({
					type: StatusItemType.Unit,
					label: unit.title,
					status: unitStatus,
					unitHash: unit.marker?.hash || "",
					title: unit.title,
					headingLevel: unit.headingLevel,
					fromHash: unit.marker?.from || undefined,
					needFlag: unit.marker?.need || undefined,
					startLine: unit.startLine,
					endLine: unit.endLine,
					contextValue: "mdaitUnit",
				});
				if (unitStatus === "translated") {
					translatedUnits++;
				}
			}

			// ファイル全体の状態を決定
			const status = this.determineFileStatus(translatedUnits, totalUnits);

			return {
				type: StatusItemType.File,
				label: fileName,
				status,
				filePath,
				fileName,
				translatedUnits,
				totalUnits,
				hasParseError: false,
				children,
				contextValue: "mdaitFile",
				collapsibleState: children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
			};
		} catch (error) {
			console.error(`Error processing file ${filePath}:`, error);

			return {
				type: StatusItemType.File,
				label: fileName,
				status: "error",
				filePath,
				fileName,
				translatedUnits: 0,
				totalUnits: 0,
				hasParseError: true,
				errorMessage: (error as Error).message,
				children: [],
				contextValue: "mdaitFile",
				collapsibleState: vscode.TreeItemCollapsibleState.None,
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

	/**
	 * インデックスファイルから高速にファイル状況を収集する
	 */
	private async collectAllFromIndex(
		indexFile: IndexFile,
		config: Configuration,
	): Promise<StatusItem[]> {
		const fileMap = new Map<string, StatusItem>();
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		if (!workspaceRoot) {
			return [];
		}

		// インデックスから各ファイルの情報を集計
		for (const hash in indexFile.units) {
			const entries = indexFile.units[hash];
			for (const entry of entries) {
				// 相対パスから絶対パスを計算
				const absolutePath = path.resolve(workspaceRoot, entry.path);

				// targetディレクトリのファイルのみを対象とする
				const isTargetFile = config.transPairs.some((pair) => {
					const targetDirNormalized = path.resolve(workspaceRoot, pair.targetDir);
					const fileDir = path.dirname(absolutePath);
					return (
						fileDir === targetDirNormalized || fileDir.startsWith(targetDirNormalized + path.sep)
					);
				});

				if (!isTargetFile) {
					continue;
				}

				let fileStatus = fileMap.get(absolutePath);
				if (!fileStatus) {
					fileStatus = {
						type: StatusItemType.File,
						label: path.basename(absolutePath),
						status: "translated",
						filePath: absolutePath,
						fileName: path.basename(absolutePath),
						translatedUnits: 0,
						totalUnits: 0,
						hasParseError: false,
						children: [],
						contextValue: "mdaitFile",
						collapsibleState: vscode.TreeItemCollapsibleState.None,
					};
					fileMap.set(absolutePath, fileStatus);
				}

				// ユニット情報を追加
				const unitStatus: StatusItem = {
					type: StatusItemType.Unit,
					label: entry.title,
					status: entry.needFlag ? "needsTranslation" : "translated",
					unitHash: hash,
					title: entry.title,
					headingLevel: this.extractHeadingLevel(entry.title),
					startLine: entry.startLine,
					endLine: entry.endLine,
					needFlag: entry.needFlag || undefined,
					fromHash: entry.from || undefined,
					contextValue: "mdaitUnit",
				};
        if (fileStatus) {
          fileStatus.children = fileStatus.children || [];
          fileStatus.children.push(unitStatus);
          fileStatus.totalUnits = (fileStatus.totalUnits ?? 0) + 1;
          if (!entry.needFlag) {
            fileStatus.translatedUnits = (fileStatus.translatedUnits ?? 0) + 1;
          }
        }
			}
		}

		// ファイル単位での状態を更新
		const fileStatuses: StatusItem[] = [];
		for (const fileStatus of fileMap.values()) {
			fileStatus.status = this.determineFileStatus(
				fileStatus.translatedUnits ?? 0,
				fileStatus.totalUnits ?? 0,
			);
			fileStatus.collapsibleState = (fileStatus.children && fileStatus.children.length > 0)
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None;
			fileStatuses.push(fileStatus);
		}

		return fileStatuses;
	}

	/**
	 * タイトル文字列から見出しレベルを抽出する
	 */
	private extractHeadingLevel(title: string): number {
		const match = title.match(/^(#{1,6})\s/);
		return match ? match[1].length : 0;
	}
}
