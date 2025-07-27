import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Configuration } from "../../config/configuration";
import { FileExplorer } from "../../utils/file-explorer";
import type { MdaitUnit } from "../markdown/mdait-unit";
import { MarkdownItParser } from "../markdown/parser";
import type { StatusItem, StatusType } from "./status-item";
import { StatusItemType } from "./status-item";

/**
 * ファイルの翻訳状況を収集するクラス
 */
export class StatusCollector {
	/**
	 * ファイルシステム操作とMarkdownパースを行うためのユーティリティ
	 */
	private readonly fileExplorer: FileExplorer;
	private readonly parser: MarkdownItParser;

	constructor() {
		this.fileExplorer = new FileExplorer();
		this.parser = new MarkdownItParser();
	}

	/**
	 * 単一ファイルの翻訳状況を収集する
	 */
	public async retrieveFileStatus(filePath: string, config: Configuration): Promise<StatusItem> {
		const fileName = path.basename(filePath);

		try {
			// ファイルを読み込み
			const content = await fs.promises.readFile(filePath, "utf-8");

			// Markdownをパース
			const markdown = this.parser.parse(content);

			// ソースファイルかどうかを判定
			const isSource = this.fileExplorer.isSourceFile(filePath, config); // ユニットの翻訳状況を分析
			let translatedUnits = 0;
			const totalUnits = markdown.units.length;
			const children: StatusItem[] = [];

			for (const unit of markdown.units) {
				// ソースファイルの場合は常に'source'ステータス
				const unitStatus = isSource ? "source" : this.determineUnitStatus(unit);
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
				if (unitStatus === "translated") {
					translatedUnits++;
				}
			}

			// ファイル全体の状態を決定
			// ソースファイルの場合は常に'source'ステータス
			const status = isSource ? "source" : this.determineFileStatus(translatedUnits, totalUnits);

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
					const fileStatus = await this.retrieveFileStatus(filePath, config);
					fileStatuses.push(fileStatus);
				} catch (error) {
					console.error(`Error processing file ${filePath}:`, error);
					// エラーファイルも含める
					fileStatuses.push({
						type: StatusItemType.File,
						label: path.basename(filePath),
						status: "error",
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

	/**
	 * タイトル文字列から見出しレベルを抽出する
	 */
	private extractHeadingLevel(title: string): number {
		const match = title.match(/^(#{1,6})\s/);
		return match ? match[1].length : 0;
	}

	/**
	 * 【重い処理】全ファイルをパースしてStatusItemツリーを再構築する
	 * パフォーマンス負荷が高いため、通常は差分更新を使用することを推奨
	 * 初回実行時や、保険的な再構築が必要な場合のみ使用
	 */
	public async buildAllStatusItem(config: Configuration): Promise<StatusItem[]> {
		const statusItems: StatusItem[] = [];

		try {
			// 重複のないディレクトリリストを取得
			const { targetDirs, sourceDirs } = this.fileExplorer.getUniqueDirectories(config);

			// sourceディレクトリからsource情報を収集
			for (const sourceDir of sourceDirs) {
				const sourceDirItems = await this.collectAllFromDirectory(sourceDir, config);
				statusItems.push(...sourceDirItems);
			}

			// targetディレクトリから翻訳状況を収集
			for (const targetDir of targetDirs) {
				const targetDirItems = await this.collectAllFromDirectory(targetDir, config);
				statusItems.push(...targetDirItems);
			}
		} catch (error) {
			console.error("Error collecting file statuses:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error collecting file statuses: {0}", (error as Error).message));
		}

		// fileNameで昇順ソート
		statusItems.sort((a, b) => (a.fileName ?? "").localeCompare(b.fileName ?? ""));
		return statusItems;
	}

	/**
	 * 指定ファイルのStatusItemを再パース・再構築して新しい配列を返す
	 *
	 * ファイル監視やユーザー操作により特定のファイルが変更された場合に、
	 * 全体を再構築せずに該当ファイルのみを再パース・再構築することで
	 * パフォーマンスを向上させる。
	 *
	 * @param filePath 再構築対象のファイルパス
	 * @param existingStatusItems 既存のStatusItem配列
	 * @param config 設定情報（ソースファイル判定に使用）
	 * @returns 指定ファイルが再構築（または追加）された新しいStatusItem配列
	 *
	 * 処理内容:
	 * - 新規ファイル: 配列に新しいStatusItemを追加
	 * - 既存ファイル: 該当StatusItemのみを再パース・置換
	 * - エラー発生: 既存配列をそのまま返す（安全な fallback）
	 *
	 * 注意: このメソッドはimmutableな操作で、元の配列は変更せず新しい配列を返します
	 */
	public async retrieveUpdatedStatus(
		filePath: string,
		existingStatusItems: StatusItem[],
		config: Configuration,
	): Promise<StatusItem[]> {
		console.log(`StatusCollector: retrieveUpdatedStatus() - ${path.basename(filePath)}`);

		try {
			// 該当ファイルのStatusItemを検索（filePathで完全一致）
			const existingItemIndex = existingStatusItems.findIndex(
				(item) => item.type === StatusItemType.File && item.filePath === filePath,
			);

			if (existingItemIndex === -1) {
				// 新規ファイル: 新しいStatusItemを作成して配列に追加
				const newFileStatus = await this.retrieveFileStatus(filePath, config);
				return [...existingStatusItems, newFileStatus];
			}

			// 既存ファイル: 該当StatusItemのみを再パース・更新
			const updatedFileStatus = await this.retrieveFileStatus(filePath, config);
			const updatedStatusItems = [...existingStatusItems];
			updatedStatusItems[existingItemIndex] = updatedFileStatus;

			return updatedStatusItems;
		} catch (error) {
			console.error(`StatusCollector: retrieveUpdatedStatus() - エラー: ${filePath}`, error);
			// エラー時は既存配列をそのまま返す（安全な fallback）
			return existingStatusItems;
		}
	}
}
