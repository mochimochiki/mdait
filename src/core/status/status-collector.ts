import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { FileExplorer } from "../../utils/file-explorer";
import { getFrontmatterTranslationKeys, parseFrontmatterMarker } from "../markdown/frontmatter-translation";
import type { MdaitUnit } from "../markdown/mdait-unit";
import { MarkdownItParser } from "../markdown/parser";
import {
	type FileStatusItem,
	type FrontmatterStatusItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "./status-item";
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
	public async buildStatusItemTree(): Promise<StatusItemTree> {
		const statusItemTree = new StatusItemTree();

		try {
			// 重複のないディレクトリリストを取得
			const { targetDirs, sourceDirs } = this.fileExplorer.getUniqueDirectories(this.config);
			const files: FileStatusItem[] = [];

			// sourceディレクトリからsource情報を収集
			for (const sourceDir of sourceDirs) {
				const sourceDirItems = await this.collectAllFromDirectory(sourceDir, this.config);
				// sort
				sourceDirItems.sort((a, b) => a.filePath.localeCompare(b.filePath));
				files.push(...sourceDirItems);
			}

			// targetディレクトリから翻訳状況を収集
			for (const targetDir of targetDirs) {
				const targetDirItems = await this.collectAllFromDirectory(targetDir, this.config);
				// sort
				targetDirItems.sort((a, b) => a.filePath.localeCompare(b.filePath));
				files.push(...targetDirItems);
			}

			const allDirs = [...sourceDirs, ...targetDirs];
			statusItemTree.buildTree(files, allDirs);
		} catch (error) {
			console.error("Error collecting file statuses:", error);
			vscode.window.showErrorMessage(vscode.l10n.t("Error collecting file statuses: {0}", (error as Error).message));
		}

		return statusItemTree;
	}

	/**
	 * 単一ファイルの翻訳状況を実際のファイルの状態に基づいて取得する
	 * @param filePath - 対象ファイルのパス
	 * @return FileStatusItem - ファイルのステータス
	 */
	public async collectFileStatus(filePath: string): Promise<FileStatusItem> {
		const fileName = path.basename(filePath);

		try {
			// ファイルを読み込み (workspaceEditを利用)
			const uri = vscode.Uri.file(filePath);
			const document = await vscode.workspace.fs.readFile(uri);
			const decoder = new TextDecoder("utf-8");
			const content = decoder.decode(document);

			// Markdownをパース
			const markdown = this.parser.parse(content, this.config);

			// ユニットの翻訳状況を分析
			let translatedUnits = 0;
			let totalUnits = 0; // ターゲットユニット数（ソース除外）
			const children: UnitStatusItem[] = [];

			// frontmatterの状態を収集（独立プロパティとして保持）
			const frontmatterKeys = getFrontmatterTranslationKeys(this.config);
			const frontmatterItem = this.collectFrontmatterStatus(markdown.frontMatter, frontmatterKeys, filePath, fileName);

			// markdown.units.lengthが0でfrontmatter項目もない場合は空のステータスを返す
			if (markdown.units.length === 0 && !frontmatterItem) {
				return {
					type: StatusItemType.File,
					label: fileName,
					status: Status.Empty,
					filePath,
					fileName,
					translatedUnits: 0,
					totalUnits: 0,
					hasParseError: false,
					children: [],
					frontmatter: undefined,
					contextValue: "mdaitFileTarget",
					collapsibleState: vscode.TreeItemCollapsibleState.None,
				};
			}

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
					contextValue: unitStatus === Status.Source ? "mdaitUnitSource" : "mdaitUnitTarget",
					filePath,
					fileName,
				});
				// ターゲットユニット（ソース以外）のみカウント
				if (unitStatus !== Status.Source) {
					totalUnits++;
					if (unitStatus === Status.Translated) {
						translatedUnits++;
					}
				}
			}

			// ファイル全体の状態を決定（frontmatter状態も考慮）
			const status = this.determineFileStatus(translatedUnits, totalUnits, children, frontmatterItem);

			// ソースファイルは全ユニット数、ターゲットファイルはターゲットユニット数を表示
			const displayTotalUnits = status === Status.Source ? children.length : totalUnits;

			return {
				type: StatusItemType.File,
				label: fileName,
				status,
				filePath,
				fileName,
				translatedUnits,
				totalUnits: displayTotalUnits,
				hasParseError: false,
				children,
				frontmatter: frontmatterItem ?? undefined,
				contextValue: status === Status.Source ? "mdaitFileSource" : "mdaitFileTarget",
				collapsibleState:
					children.length > 0 || frontmatterItem
						? vscode.TreeItemCollapsibleState.Collapsed
						: vscode.TreeItemCollapsibleState.None,
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
				frontmatter: undefined,
				contextValue: "mdaitFileTarget",
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

		// needsTranslation()メソッドで翻訳の必要性を判定
		if (unit.marker.needsTranslation()) {
			return Status.NeedsTranslation;
		}

		if (unit.marker.need) {
			// review, verify-deletion などその他のneedフラグ
			return Status.NeedsTranslation;
		}

		return Status.Translated;
	}

	/**
	 * frontmatterの翻訳状態を収集する
	 */
	private collectFrontmatterStatus(
		frontMatter: import("../markdown/front-matter").FrontMatter | undefined,
		keys: string[],
		filePath: string,
		fileName: string,
	): FrontmatterStatusItem | null {
		// 翻訳対象のキーがない場合はfrontmatter項目を作成しない
		if (keys.length === 0 || !frontMatter) {
			return null;
		}

		// mdait.frontマーカーを確認
		const marker = parseFrontmatterMarker(frontMatter);
		if (!marker) {
			// マーカーがない場合はfrontmatter項目を作成しない
			return null;
		}

		// from が存在しない場合はソース側
		const isSource = !marker.from;

		// ステータスを決定
		let status: Status;
		if (isSource) {
			status = Status.Source;
		} else if (marker.needsTranslation() || marker.need) {
			status = Status.NeedsTranslation;
		} else {
			status = Status.Translated;
		}

		return {
			type: StatusItemType.Frontmatter,
			label: "Frontmatter",
			status,
			filePath,
			fileName,
			fromHash: marker.from ?? undefined,
			needFlag: marker.need ?? undefined,
			contextValue: isSource ? "mdaitFrontmatterSource" : "mdaitFrontmatterTarget",
		};
	}

	/**
	 * ファイルの全体的な翻訳状態を決定する
	 * @param translatedUnits 翻訳済みユニット数
	 * @param totalUnits 合計ターゲットユニット数
	 * @param children 子要素（ユニット）
	 * @param frontmatterItem frontmatter項目（存在する場合）
	 */
	private determineFileStatus(
		translatedUnits: number,
		totalUnits: number,
		children: UnitStatusItem[],
		frontmatterItem: FrontmatterStatusItem | null | undefined,
	): Status {
		// childrenは既にUnitStatusItem[]なのでそのまま使用
		const units = children;

		// 1. すべてのユニットが `Source` でfrontmatterもSourceまたはなしなら、ファイルは `Source`
		const allUnitsSource = units.length > 0 && units.every((u) => u.status === Status.Source);
		const frontmatterIsSourceOrNone = !frontmatterItem || frontmatterItem.status === Status.Source;
		if (allUnitsSource && frontmatterIsSourceOrNone) {
			return Status.Source;
		}

		// 2. ターゲットユニットがなく、frontmatter項目もない場合
		if (totalUnits === 0 && !frontmatterItem) {
			return Status.Unknown;
		}

		// 3. frontmatterが `NeedsTranslation` なら、ファイルは `NeedsTranslation`
		if (frontmatterItem && frontmatterItem.status === Status.NeedsTranslation) {
			return Status.NeedsTranslation;
		}

		// 4. `NeedsTranslation` のユニットが1つでもあれば、ファイルは `NeedsTranslation`
		const hasNeedsTranslation = units.some((u) => u.status === Status.NeedsTranslation);
		if (hasNeedsTranslation) {
			return Status.NeedsTranslation;
		}

		// 5. すべてのユニットが `Translated` または `Source` で、frontmatterも `Translated` または Sourceなら、ファイルは `Translated`
		const isFullyTranslatedOrSource = units.every((u) => u.status === Status.Translated || u.status === Status.Source);
		const frontmatterIsTranslatedOrSource =
			!frontmatterItem || frontmatterItem.status === Status.Translated || frontmatterItem.status === Status.Source;
		if (isFullyTranslatedOrSource && frontmatterIsTranslatedOrSource) {
			// frontmatter-onlyファイルでfrontmatterがTranslatedの場合も考慮
			if (units.length === 0 && frontmatterItem?.status === Status.Translated) {
				return Status.Translated;
			}
			if (units.length > 0) {
				return Status.Translated;
			}
		}

		// 6. それ以外のケースは `NeedsTranslation` と見なす
		return Status.NeedsTranslation;
	}

	/**
	 * ディレクトリから直接ファイル状況を収集する
	 */
	private async collectAllFromDirectory(targetDir: string, config: Configuration): Promise<FileStatusItem[]> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return [];
		}

		const startTime = performance.now();
		const absoluteTargetDir = path.resolve(workspaceRoot, targetDir);

		try {
			// ディレクトリが存在するかチェック（非同期I/O）
			const stat = await fs.promises.stat(absoluteTargetDir).catch(() => null as fs.Stats | null);
			if (!stat || !stat.isDirectory()) {
				return [];
			}

			// ディレクトリ内のMarkdownファイルを再帰的に検索
			const includePattern = new vscode.RelativePattern(absoluteTargetDir, "**/*.md");
			const excludePattern = config.ignoredPatterns
				? (new vscode.RelativePattern(absoluteTargetDir, config.ignoredPatterns) as vscode.GlobPattern)
				: undefined;
			const files = await vscode.workspace.findFiles(includePattern, excludePattern);
			const mdFiles = files.map((f) => f.fsPath);

			// 各ファイルの状況を並列に収集（同時実行数を制限）
			const concurrency = Math.max(1, Math.min(os.cpus()?.length ?? 4, 16));
			const results: FileStatusItem[] = new Array(mdFiles.length);
			let index = 0;

			const worker = async () => {
				while (true) {
					const i = index++;
					if (i >= mdFiles.length) break;
					const filePath = mdFiles[i];
					try {
						results[i] = await this.collectFileStatus(filePath);
					} catch (error) {
						console.error(`Error processing file ${filePath}:`, error);
						// エラーファイルも含める
						results[i] = {
							type: StatusItemType.File,
							label: path.basename(filePath),
							status: Status.Error,
							filePath,
							fileName: path.basename(filePath),
							translatedUnits: 0,
							totalUnits: 0,
							hasParseError: true,
							errorMessage: (error as Error).message,
							contextValue: "mdaitFileTarget",
							collapsibleState: vscode.TreeItemCollapsibleState.None,
						};
					}
				}
			};

			const workers = Array.from({ length: Math.min(concurrency, mdFiles.length) }, () => worker());
			await Promise.all(workers);

			const checkPoint = performance.now();
			console.log(`collectAllFromDirectory: dir:${targetDir} ${Math.round(checkPoint - startTime)}ms`);
			return results;
		} catch (error) {
			console.error(`Error scanning directory ${absoluteTargetDir}:`, error);
			return [];
		}
	}
}
