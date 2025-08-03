import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { FileExplorer } from "../../utils/file-explorer";
import type { MdaitUnit } from "../markdown/mdait-unit";
import { MarkdownItParser } from "../markdown/parser";
import { Status, type StatusItem, StatusItemType } from "./status-item";
import { StatusItemTree } from "./status-item-tree";

/**
 * ファイルの翻訳状況を収集するクラス
 */
export class StatusCollector {
	/**
	 * ファイルシステム操作とMarkdownパースを行うためのユーティリティ
	 */
	private readonly fileExplorer: FileExplorer;

	/**
	 * Markdownのパースを行うためのパーサー
	 */
	private readonly parser: MarkdownItParser;

	/**
	 * 設定情報を取得するためのConfigurationインスタンス
	 */
	private readonly config: Configuration;

	/**
	 * Constructor
	 */
	constructor() {
		this.fileExplorer = new FileExplorer();
		this.parser = new MarkdownItParser();
		this.config = Configuration.getInstance();
	}

	/**
	 * buildAllStatusItem
	 * [重い処理]
	 * 対象となる全てのディレクトリをスキャンし、全ファイルのステータス情報を収集して StatusItemTree を構築します。
	 * 主にアプリケーションの初回起動時や、全体的な再同期が必要な場合に使用される高コストな処理です。
	 * @return Promise<StatusItemTree> - 全ステータスツリー
	 */
	public async buildAllStatusItem(): Promise<StatusItemTree> {
		const statusItemTree = new StatusItemTree();

		try {
			// 重複のないディレクトリリストを取得
			const { targetDirs, sourceDirs } = this.fileExplorer.getUniqueDirectories(this.config);
			const files: StatusItem[] = [];

			// sourceディレクトリからsource情報を収集
			for (const sourceDir of sourceDirs) {
				const sourceDirItems = await this.collectAllFromDirectory(sourceDir, this.config);
				files.push(...sourceDirItems);
			}

			// targetディレクトリから翻訳状況を収集
			for (const targetDir of targetDirs) {
				const targetDirItems = await this.collectAllFromDirectory(targetDir, this.config);
				files.push(...targetDirItems);
			}

			statusItemTree.build(files);
		} catch (error) {
			console.error("Error collecting file statuses:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error collecting file statuses: {0}", (error as Error).message));
		}

		return statusItemTree;
	}

	/**
	 * 単一ファイルの翻訳状況を実際のファイルの状態に基づいて取得する
	 * @param filePath - 対象ファイルのパス
	 * @return StatusItem - ファイルのステータス
	 */
	public async collectFileStatus(filePath: string): Promise<StatusItem> {
		const fileName = path.basename(filePath);

		try {
			// ファイルを読み込み
			const content = await fs.promises.readFile(filePath, "utf-8");

			// Markdownをパース
			const markdown = this.parser.parse(content, this.config);

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
					filePath,
					fileName,
				});
				if (unitStatus === Status.Translated) {
					translatedUnits++;
				}
			}

			// ファイル全体の状態を決定
			const status = this.determineFileStatus(translatedUnits, totalUnits, children);

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
				collapsibleState:
					children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
			};
		} catch (error) {
			console.error(`Error processing file ${filePath}:`, error);

			return {
				type: StatusItemType.File,
				label: fileName,
				status: Status.Error,
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

	// ========== 内部ユーティリティメソッド ==========

	/**
	 * 個別ユニットの翻訳状態を決定する
	 */
	private determineUnitStatus(unit: MdaitUnit): Status {
		// fromHashがない場合はソースユニット
		if (!unit.marker?.from) {
			return Status.Source;
		}

		if (!unit.marker) {
			return Status.Unknown;
		}

		if (unit.marker.need === "translate") {
			return Status.NeedsTranslation;
		}

		if (unit.marker.need) {
			// review, verify-deletion などその他のneedフラグ
			return Status.NeedsTranslation;
		}

		return Status.Translated;
	}

	/**
	 * ファイルの全体的な翻訳状態を決定する
	 */
	private determineFileStatus(translatedUnits: number, totalUnits: number, units: StatusItem[]): Status {
		if (totalUnits === 0) {
			return Status.Unknown;
		}

		// 1. `NeedsTranslation` のユニットが1つでもあれば、ファイルは `NeedsTranslation`
		const hasNeedsTranslation = units.some((u) => u.status === Status.NeedsTranslation);
		if (hasNeedsTranslation) {
			return Status.NeedsTranslation;
		}

		// 2. すべてのユニットが `Source` なら、ファイルは `Source`
		const allSource = units.every((u) => u.status === Status.Source);
		if (allSource) {
			return Status.Source;
		}

		// 3. すべてのユニットが `Translated` または `Source` なら、ファイルは `Translated`
		const isFullyTranslatedOrSource = units.every((u) => u.status === Status.Translated || u.status === Status.Source);
		if (isFullyTranslatedOrSource) {
			return Status.Translated;
		}

		// 4. それ以外のケース（`Unknown` などが混ざっている）は `NeedsTranslation` と見なす
		return Status.NeedsTranslation;
	}

	/**
	 * ディレクトリから直接ファイル状況を収集する
	 */
	private async collectAllFromDirectory(targetDir: string, config: Configuration): Promise<StatusItem[]> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return [];
		}

		const absoluteTargetDir = path.resolve(workspaceRoot, targetDir);

		try {
			// ディレクトリが存在するかチェック
			if (!fs.existsSync(absoluteTargetDir)) {
				return [];
			}

			// ディレクトリ内のMarkdownファイルを再帰的に検索
			const workspaceUri = vscode.Uri.file(workspaceRoot);
			const pattern = new vscode.RelativePattern(absoluteTargetDir, "**/*.md");
			const files = await vscode.workspace.findFiles(pattern, config.ignoredPatterns);
			const mdFiles = files.map((f) => f.fsPath);

			// 各ファイルの状況を収集
			const fileStatuses: StatusItem[] = [];
			for (const filePath of mdFiles) {
				try {
					const fileStatus = await this.collectFileStatus(filePath);
					fileStatuses.push(fileStatus);
				} catch (error) {
					console.error(`Error processing file ${filePath}:`, error);
					// エラーファイルも含める
					fileStatuses.push({
						type: StatusItemType.File,
						label: path.basename(filePath),
						status: Status.Error,
						filePath,
						fileName: path.basename(filePath),
						hasParseError: true,
						errorMessage: (error as Error).message,
						contextValue: "mdaitFile",
						collapsibleState: vscode.TreeItemCollapsibleState.None,
					});
				}
			}

			return fileStatuses;
		} catch (error) {
			console.error(`Error scanning directory ${absoluteTargetDir}:`, error);
			return [];
		}
	}
}
