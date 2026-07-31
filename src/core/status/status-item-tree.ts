import * as path from "node:path";
import * as vscode from "vscode";
import { DebugFireRecorder } from "../../infra/debug/debug-fire-recorder";
import {
	type DirectoryStatusItem,
	type FileStatusItem,
	Status,
	type StatusItem,
	StatusItemType,
	type UnitStatusItem,
	getUnitsFromFile,
	isCountedInProgress,
	isDirectoryStatusItem,
	isFileStatusItem,
	isTranslateNeed,
	isUnitStatusItem,
} from "./status-item";

/**
 * 2つのパスが同一、または child が parent の配下かを判定する。
 * 単純な前方一致は `/docs/en` と `/docs/en-US` を取り違えるため、
 * 必ずパス区切り境界で比較する（ADR-260724-01）。
 */
function isSameOrUnder(child: string, parent: string): boolean {
	if (child === parent) {
		return true;
	}
	const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
	return child.startsWith(prefix);
}

/**
 * 要対応ユニットの表示順を決める比較関数（ファイルパス昇順→開始行昇順→ハッシュ昇順）。
 *
 * ロケール依存の比較（localeCompare）は環境によって結果が変わりうるため使わない。
 * 「同じ状態なら常に同じ並び」を保証することが目的であり、これは見た目の問題ではなく
 * 表示の信頼に関わる（ADR-260724-01）。「次の要対応へ」コマンドもこの順序に従う。
 */
export function compareNeedsAttentionUnits(a: UnitStatusItem, b: UnitStatusItem): number {
	if (a.filePath !== b.filePath) {
		return a.filePath < b.filePath ? -1 : 1;
	}
	const lineDiff = (a.startLine ?? 0) - (b.startLine ?? 0);
	if (lineDiff !== 0) {
		return lineDiff;
	}
	if (a.unitHash === b.unitHash) {
		return 0;
	}
	return a.unitHash < b.unitHash ? -1 : 1;
}

/**
 * StatusItemのファーストクラスコレクション
 * ディレクトリ・ファイル・ユニットの階層構造を効率的に管理する
 *
 * 更新通知の方針（ADR-260724-01）:
 * 変更の宛先（どのノードを描き直すべきか）は一切判定せず、「変更があった」ことだけを
 * 1本のイベントで通知する。宛先の判定は「要対応ノードだけ更新されない」不具合の発生源
 * であったため、設計から削除した。束ねと再描画は StatusManager 側が担う。
 */
export class StatusItemTree {
	// ========== event ==========
	// Event
	private readonly _onTreeChanged = new vscode.EventEmitter<void>();
	public readonly onTreeChanged: vscode.Event<void> = this._onTreeChanged.event;

	/**
	 * 「ツリーに変更があった」ことを通知する。デバッグ計装（fire履歴記録）を挟む。
	 * デバッグIPC無効時はレコーダーが no-op のため本番挙動は変わらない。
	 */
	private notifyChanged(): void {
		if (this.suppressNotify) {
			return;
		}
		DebugFireRecorder.getInstance().record("tree", undefined);
		this._onTreeChanged.fire();
	}

	/** buildTree など、多数の変更をまとめて行う間の通知を抑止するフラグ */
	private suppressNotify = false;

	// ========== member ==========
	private readonly fileItemMap = new Map<string, FileStatusItem>(); // ファイルパスをキーとする
	private readonly directoryItemMap = new Map<string, DirectoryStatusItem>(); // ディレクトリパスをキーとする
	/**
	 * ユニット検索用の索引（ファイルパス+ユニットハッシュをキーとする）。
	 * ユニットの本体は FileStatusItem.children であり、本マップはそこへの参照を持つだけの
	 * 索引である。ファイル更新のたびに当該ファイル分を丸ごと張り直すため、ハッシュが変わって
	 * 消えたユニットが残留することはない（ADR-260724-01）。
	 */
	private readonly unitItemMapWithPath = new Map<string, UnitStatusItem>();
	private rootDirectories: string[] = [];
	private configBaseDir: string | undefined = undefined;

	// ========== 取得 ==========

	/**
	 * ステータスツリーが空かどうかを判定
	 * @returns true: ファイルが1つも登録されていない、false: 1つ以上登録されている
	 */
	public isEmpty(): boolean {
		return this.fileItemMap.size === 0;
	}

	/**
	 * ファイルStatusItemを取得
	 */
	public getFile(filePath: string): FileStatusItem | undefined {
		return this.fileItemMap.get(filePath);
	}

	/**
	 * 全ファイルStatusItemを取得（既存API互換性用）
	 */
	public getFilesAll(): FileStatusItem[] {
		return Array.from(this.fileItemMap.values());
	}

	/**
	 * 指定ディレクトリ集合の配下にあるファイルStatusItemのみを取得する。
	 * 表示・集計を選択中の transPair に揃えるための絞り込み（未指定なら全件）。
	 */
	public getFilesInScope(scopeDirs?: string[]): FileStatusItem[] {
		if (!scopeDirs) {
			return this.getFilesAll();
		}
		return this.getFilesAll().filter((file) => this.isInScope(file.filePath, scopeDirs));
	}

	/**
	 * 全ソースファイルStatusItemを取得
	 */
	public getSourceFilesAll(): FileStatusItem[] {
		return Array.from(this.fileItemMap.values()).filter((file) => file.status === Status.Source);
	}

	/**
	 * 指定ディレクトリ配下の全ファイル（サブディレクトリ含む）を取得
	 */
	public getFilesInDirectoryRecursive(dirPath: string): FileStatusItem[] {
		const result: FileStatusItem[] = [];

		for (const file of this.fileItemMap.values()) {
			if (isSameOrUnder(path.dirname(file.filePath), dirPath)) {
				result.push(file);
			}
		}

		return result;
	}

	/**
	 * 指定ディレクトリ配下の直下ファイルのみを取得（サブディレクトリは除く）
	 */
	private getFilesInDirectoryDirect(dirPath: string): FileStatusItem[] {
		const directoryItem = this.directoryItemMap.get(dirPath);
		if (!directoryItem?.children) return [];

		return directoryItem.children.filter((file): file is FileStatusItem => {
			if (!isFileStatusItem(file)) return false;
			return path.dirname(file.filePath) === dirPath;
		});
	}

	/**
	 * 指定ハッシュのユニットを取得
	 */
	public getUnit(unitHash: string, filePath: string): UnitStatusItem | undefined {
		// 特定ファイル内から検索
		const key = `${filePath}#${unitHash}`;
		if (this.unitItemMapWithPath.has(key)) {
			return this.unitItemMapWithPath.get(key);
		}
		return undefined;
	}

	/**
	 * 指定ファイルの翻訳ユニット一覧を取得
	 */
	public getUnitsInFile(filePath: string): UnitStatusItem[] {
		const fileItem = this.fileItemMap.get(filePath);
		if (!fileItem) return [];
		return getUnitsFromFile(fileItem);
	}

	/**
	 * review / verify-deletion 待ちのユニットをファイル横断で集める。
	 * StatusTreeProvider の「Needs Attention」仮想ノード（UX-R1: 判断サーフェスの完成）の
	 * データソース。escalated（AIレビューflagged）の集約は将来課題（ux.md B-4）。
	 *
	 * @param scopeDirs 集約対象を限定するディレクトリ（絶対パス）の集合。
	 *   ツリー本体が選択中の transPair だけを表示するため、要対応も同じ範囲に揃える
	 *   （未指定なら全ファイルが対象。ADR-260724-01）。
	 * @returns ファイルパス昇順→開始行昇順で安定ソートされたユニット列。
	 *   同じ状態なら常に同じ並びになることを保証する（並びの揺れは表示上の信頼を損なうため）。
	 */
	public getNeedsAttentionUnits(scopeDirs?: string[]): UnitStatusItem[] {
		const matches: UnitStatusItem[] = [];
		for (const file of this.getFilesInScope(scopeDirs)) {
			for (const unit of this.getUnitsInFile(file.filePath)) {
				if (unit.needFlag === "review" || unit.needFlag === "verify-deletion") {
					matches.push(unit);
				}
			}
		}
		return matches.sort(compareNeedsAttentionUnits);
	}

	/**
	 * trans が自動で処理できる翻訳待ちユニット（need:translate / need:revise@…）を数える。
	 *
	 * sync 完了通知の「今すぐ翻訳」導線に使う。「今回の実行で新しく生じた件数」ではなく
	 * 「現在ツリーに残っている件数」を返すことが重要である。前者だけを見ると、
	 * 変更なしの2回目以降の sync で翻訳待ちが残っているのに導線が消えてしまう。
	 *
	 * @param scopeDirs 集計対象を限定するディレクトリ（絶対パス）の集合。
	 *   sync / trans が処理する選択中の transPair と同じ範囲に揃える（未指定なら全ファイル）。
	 */
	public countPendingTranslationUnits(scopeDirs?: string[]): number {
		let count = 0;
		for (const file of this.getFilesInScope(scopeDirs)) {
			for (const unit of this.getUnitsInFile(file.filePath)) {
				if (isTranslateNeed(unit.needFlag)) {
					count++;
				}
			}
		}
		return count;
	}

	/**
	 * 指定 transPair（絶対パス）でまだ sync 管理下に入っていないファイル数を数える。
	 *
	 * マーカーの無いファイルは進捗の分母（totalUnits）に入らないため、初回 sync の
	 * 前後で分母が大きく変わって見える。「分母に入っていないファイルがある」ことを
	 * ツリー上で明示するための集計であり、判定はスキャン済みのツリー参照のみで行う
	 * （追加のファイルI/Oは発生させない）。
	 *
	 * 数える対象:
	 * 1. target ディレクトリ配下の「マーカーなし」ファイル
	 *    （Status.Source かつ全ユニットのハッシュが空。非MDは unit-state 未登録で
	 *    children が空のため同条件で数えられる。独立ユニットのみのファイルは
	 *    ハッシュを持つため誤検出しない）
	 * 2. source ディレクトリ配下で、対応する target ファイルがまだツリーに存在しないもの
	 *    （sync が target を新規作成するケース。空ファイルは sync が処理しないため除外）
	 */
	public countFilesNotYetSynced(sourceDirAbs: string, targetDirAbs: string): number {
		let count = 0;

		// 1. target 側: マーカーなしの既存ファイル
		for (const file of this.getFilesInDirectoryRecursive(targetDirAbs)) {
			if (file.status !== Status.Source) {
				continue;
			}
			const markerless = (file.children ?? []).every((unit) => !unit.unitHash);
			if (markerless) {
				count++;
			}
		}

		// 2. source 側: target ファイルがまだ無いもの
		for (const file of this.getFilesInDirectoryRecursive(sourceDirAbs)) {
			// source が target の祖先になる構成（例: docs → docs/ja）では
			// target 配下のファイルを source として数えない
			if (isSameOrUnder(path.dirname(file.filePath), targetDirAbs)) {
				continue;
			}
			// 空ファイルは sync が処理しない（ユニットもfrontmatterも無い）ため除外
			if (file.status === Status.Empty) {
				continue;
			}
			const rel = path.relative(sourceDirAbs, file.filePath);
			const expectedTarget = path.join(targetDirAbs, rel);
			if (!this.fileItemMap.has(expectedTarget)) {
				count++;
			}
		}

		return count;
	}

	/**
	 * ファイルが対象ディレクトリ集合のいずれかの配下にあるかを判定する
	 */
	private isInScope(filePath: string, scopeDirs: string[]): boolean {
		const dir = path.dirname(filePath);
		return scopeDirs.some((scopeDir) => isSameOrUnder(dir, scopeDir));
	}

	/**
	 * 指定ハッシュのユニットを検索（ファイルパスなしでスキャン）
	 * 全ファイルから検索するため、どのファイルか不定であることに注意
	 */
	public getUnitByHash(unitHash: string): UnitStatusItem | undefined {
		// 全ファイルから検索（ハッシュのみでスキャン）
		for (const [key, unit] of this.unitItemMapWithPath) {
			if (unit.unitHash === unitHash) {
				return unit;
			}
		}

		return undefined;
	}

	/**
	 * from属性が指定ハッシュと一致するターゲットユニットを検索する。
	 * まず`preferredFilePaths`で指定されたファイル群を順に走査し、見つからなければ全ファイルを対象に再検索する。
	 *
	 * @param fromHash ソースユニットのハッシュ値。`unit.fromHash` がこの値と一致するターゲットユニットを探索する。
	 * @param preferredFilePaths 優先して検索するファイルパスの配列。配列の先頭から順に、該当ファイル内のユニットを検索する。
	 *                          指定されたパスに対応するファイルが存在しない場合はスキップされる。未指定または空配列の場合は、直接全ファイル検索を行う。
	 * @returns
	 *   - 優先ファイルパス内で最初に見つかったユニット（`preferredFilePaths` に含まれるファイルから見つかった場合）
	 *   - 優先ファイルで見つからなかった場合は、全ファイルを対象にした検索で最初に見つかったユニット
	 *   - 上記いずれの検索でも見つからなかった場合は `undefined`
	 */
	public getTargetUnitByFromHash(fromHash: string, preferredFilePaths?: string[]): UnitStatusItem | undefined {
		// 優先ファイルパスがある場合は順番に検索
		if (preferredFilePaths) {
			for (const filePath of preferredFilePaths) {
				const fileItem = this.fileItemMap.get(filePath);
				if (fileItem?.children) {
					for (const unit of fileItem.children) {
						if (unit.fromHash === fromHash) {
							return unit;
						}
					}
				}
			}
		}

		// 優先ファイルで見つからなければ全ファイルから検索
		for (const unit of this.unitItemMapWithPath.values()) {
			if (unit.fromHash === fromHash) {
				return unit;
			}
		}

		return undefined;
	}

	/**
	 * 指定ファイル内の未翻訳ユニット（needFlag付き）を取得
	 */
	public getUnitsUntranslatedInFile(filePath: string): UnitStatusItem[] {
		const fileItem = this.fileItemMap.get(filePath);
		if (!fileItem) return [];
		return getUnitsFromFile(fileItem).filter((unit) => unit.needFlag);
	}

	/**
	 * 指定ディレクトリのStatusItemを取得
	 */
	public getDirectory(dirPath: string): DirectoryStatusItem | undefined {
		// 既存のディレクトリStatusItemを返す
		return this.directoryItemMap.get(dirPath);
	}

	/**
	 * 指定ディレクトリの子要素（ファイル・サブディレクトリ）を取得
	 * ツリー表示用に階層構造でStatusItemを返す
	 */
	public getDirectoryChildren(directoryPath: string): StatusItem[] {
		const items: StatusItem[] = [];

		// 直下のファイルを取得
		const directFiles = this.getFilesInDirectoryDirect(directoryPath);
		items.push(...directFiles);

		// サブディレクトリを取得
		const subDirPaths = this.getSubDirectoryPaths(directoryPath);
		for (const subDirPath of subDirPaths) {
			const subDirItem = this.getDirectory(subDirPath);
			if (subDirItem) {
				items.push(subDirItem);
			}
		}

		// ディレクトリ→ファイルの順で表示
		return [
			...items.filter((item) => item.type === StatusItemType.Directory),
			...items.filter((item) => item.type === StatusItemType.File),
		];
	}

	/**
	 * ルートディレクトリ一覧を取得（設定されたtransPairsに基づく）
	 */
	public getRootDirectoryItems(transPairDirs: string[]): DirectoryStatusItem[] {
		return transPairDirs
			.map((dirPath) => this.getDirectory(dirPath))
			.filter((item): item is DirectoryStatusItem => !!item);
	}

	// ========== 集計 ==========

	/**
	 * 全体の進捗情報を集計
	 */
	public aggregateProgress(): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		let totalUnits = 0;
		let translatedUnits = 0;
		let errorUnits = 0;

		for (const unit of this.unitItemMapWithPath.values()) {
			// 原文ユニットと凍結ユニットは進捗の分母に入れない。
			// 判定は必ず isCountedInProgress に委ねる（Status を直接見ると、
			// 分母の定義が変わったときにここだけ取り残される）
			if (!isCountedInProgress(unit)) {
				continue;
			}
			totalUnits++;
			if (unit.status === Status.Translated) {
				translatedUnits++;
			} else if (unit.status === Status.Error) {
				errorUnits++;
			}
		}

		return { totalUnits, translatedUnits, errorUnits };
	}

	/**
	 * 指定ディレクトリの進捗情報を集計
	 */
	public aggregateDirectoryProgress(dirPath: string): {
		totalUnits: number;
		translatedUnits: number;
		errorUnits: number;
	} {
		const files = this.getFilesInDirectoryRecursive(dirPath);
		const targetFiles = this.getTargetFiles(files);
		let totalUnits = 0;
		let translatedUnits = 0;
		let errorUnits = 0;

		for (const file of targetFiles) {
			totalUnits += file.totalUnits;
			translatedUnits += file.translatedUnits;
			if (file.children) {
				for (const unit of file.children) {
					if (unit.status === Status.Error) {
						errorUnits++;
					}
				}
			}
		}

		return { totalUnits, translatedUnits, errorUnits };
	}

	// ========== 操作 ==========

	/**
	 * ツリーを初期化
	 */
	public clear(): void {
		this.fileItemMap.clear();
		this.directoryItemMap.clear();
		this.unitItemMapWithPath.clear();
		this.rootDirectories = [];
		this.configBaseDir = undefined;
	}

	public dispose(): void {
		// EventEmitterの破棄
		this._onTreeChanged.dispose();
	}

	/**
	 * ツリーを構築
	 * @param files - FileStatusItemの配列
	 */
	public buildTree(files: FileStatusItem[], rootDirs: string[], configBaseDir?: string): void {
		this.clear();
		this.rootDirectories = rootDirs;
		this.configBaseDir = configBaseDir;

		console.log("=>build");
		const startTime = performance.now();
		// 構築中はファイルごとの通知を抑止し、完了後に1回だけ通知する
		this.suppressNotify = true;
		try {
			for (const file of files) {
				this.addOrUpdateFile(file);
			}
		} finally {
			this.suppressNotify = false;
		}
		this.notifyChanged();

		const endTime = performance.now();
		console.log(`<=build (${Math.round(endTime - startTime)}ms)`);
	}

	/**
	 * FileItemを更新
	 */
	public addOrUpdateFile(fileItem: FileStatusItem): void {
		this.recalcFileTranslating(fileItem);

		const existingItem = this.fileItemMap.get(fileItem.filePath);
		if (existingItem) {
			// 既存のファイルStatusItemを更新
			// Assignを使うことでStatusItemのインスタンス自体は保持しつつ、最新の状態に更新(代入してしまうとgetTreeItemで古い状態が返る可能性があるため)
			Object.assign(existingItem, fileItem);
		} else {
			this.fileItemMap.set(fileItem.filePath, fileItem);
		}

		// ユニット索引を当該ファイル分だけ張り直す。
		// 「値だけ上書き」だと、消えたユニット（ハッシュ変更・ユニット削除）が索引に残り続け、
		// getUnitByHash / getTargetUnitByFromHash が実在しないユニットを返しうる。
		this.rebuildUnitIndexForFile(this.fileItemMap.get(fileItem.filePath));

		// ディレクトリ更新
		this.addOrUpdateDirectory(fileItem);

		this.notifyChanged();
	}

	/**
	 * 指定ファイルをツリーから取り除く（削除・リネーム・対象外化に対応）。
	 * ファイル・ユニット索引・親ディレクトリの子要素から除去し、祖先の集計を更新する。
	 * ファイルが無くなり空になったディレクトリは、ルートディレクトリを除いて併せて取り除く。
	 * @returns 実際に除去した場合 true（元から存在しなければ false）
	 */
	public removeFile(filePath: string): boolean {
		if (!this.fileItemMap.has(filePath)) {
			return false;
		}
		this.fileItemMap.delete(filePath);
		this.clearUnitIndexForFile(filePath);

		const dirPath = path.dirname(filePath);
		const directoryItem = this.directoryItemMap.get(dirPath);
		if (directoryItem?.children) {
			directoryItem.children = directoryItem.children.filter(
				(child) => !(isFileStatusItem(child) && child.filePath === filePath),
			);
		}

		// 集計更新が先。逆順にすると updateDirectoryAggregatesUpward が
		// 取り除いたディレクトリを作り直してしまう。
		const stopRoot = this.getRootDir(dirPath);
		this.updateDirectoryAggregatesUpward(dirPath, stopRoot);
		this.pruneEmptyDirectories(dirPath, stopRoot);

		this.notifyChanged();
		return true;
	}

	/**
	 * 指定ファイルのユニット索引を張り直す（既存エントリを全削除してから登録）
	 */
	private rebuildUnitIndexForFile(fileItem: FileStatusItem | undefined): void {
		if (!fileItem) {
			return;
		}
		this.clearUnitIndexForFile(fileItem.filePath);
		for (const unit of fileItem.children ?? []) {
			this.unitItemMapWithPath.set(`${fileItem.filePath}#${unit.unitHash}`, unit);
		}
	}

	/**
	 * 指定ファイルに属する索引エントリを全て削除する
	 */
	private clearUnitIndexForFile(filePath: string): void {
		const prefix = `${filePath}#`;
		for (const key of this.unitItemMapWithPath.keys()) {
			if (key.startsWith(prefix)) {
				this.unitItemMapWithPath.delete(key);
			}
		}
	}

	/**
	 * 配下にファイルが1つも無くなったディレクトリを、ルートに達するまで取り除く。
	 * ルートディレクトリ（transPairs の source/target）は空でも残す（選択中の対象は
	 * 常にツリーに出す）。
	 */
	private pruneEmptyDirectories(dirPath: string, stopRoot: string): void {
		let current = dirPath;
		while (current !== stopRoot) {
			// transPairs のルートディレクトリ自体は空でも消さない（選択中の対象は常に出す）。
			// stopRoot の算出が想定外だった場合の安全弁も兼ねる。
			if (this.isRootDirectory(current)) {
				return;
			}
			if (this.getFilesInDirectoryRecursive(current).length > 0) {
				return;
			}
			this.directoryItemMap.delete(current);
			const parent = path.dirname(current);
			if (parent === current) {
				return;
			}
			current = parent;
		}
	}

	/**
	 * 指定パスが transPairs のルートディレクトリそのものかを判定する
	 */
	private isRootDirectory(dirPath: string): boolean {
		const baseDir = this.configBaseDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const absoluteDirPath = path.resolve(dirPath);
		return this.rootDirectories.some((rootDir) => {
			const absoluteRootDir = baseDir ? path.resolve(baseDir, rootDir) : rootDir;
			return absoluteRootDir === absoluteDirPath;
		});
	}

	public updateFilePartial(filePath: string, updates: Partial<FileStatusItem>): FileStatusItem | undefined {
		const existingItem = this.fileItemMap.get(filePath);
		if (!existingItem) {
			return undefined;
		}

		// 既存のファイルStatusItemを更新
		Object.assign(existingItem, updates);

		// updates に children が含まれていても索引が古い配列を指し続けないよう張り直す
		// （索引と children の同一インスタンス性は updateUnit が依存する不変条件）
		this.rebuildUnitIndexForFile(existingItem);

		// ディレクトリ更新
		this.addOrUpdateDirectory(existingItem);
		this.notifyChanged();
		return existingItem;
	}

	/**
	 * DirectoryItemを部分更新
	 */
	public updateDirectoryPartial(
		directoryPath: string,
		updates: Partial<DirectoryStatusItem>,
	): DirectoryStatusItem | undefined {
		const existingItem = this.directoryItemMap.get(directoryPath);
		if (!existingItem) {
			return undefined;
		}

		// 既存のディレクトリStatusItemを更新
		Object.assign(existingItem, updates);

		// イベント通知
		this.notifyChanged();
		return existingItem;
	}

	/**
	 * UnitItemを部分更新
	 */
	public updateUnit(filePath: string, unitHash: string, updates: Partial<UnitStatusItem>): UnitStatusItem | undefined {
		const key = `${filePath}#${unitHash}`;
		const unit = this.unitItemMapWithPath.get(key);
		if (!unit) {
			return undefined;
		}

		// ユニットを更新。
		// 索引は children と同一インスタンスを指すため、子要素側への写し込みは不要。
		Object.assign(unit, updates);

		// 親ファイルの翻訳中フラグとディレクトリ集計を追随させる
		const fileItem = this.fileItemMap.get(filePath);
		if (fileItem) {
			this.recalcFileTranslating(fileItem);
			this.addOrUpdateDirectory(fileItem);
		}

		this.notifyChanged();
		return unit;
	}

	// ========== Private methods ==========

	/**
	 * ファイルの翻訳中フラグを子ユニット・frontmatterから再計算する
	 */
	private recalcFileTranslating(fileItem: FileStatusItem): void {
		fileItem.isTranslating = (fileItem.children ?? []).some((unit) => unit.isTranslating === true);
		// frontmatterの翻訳中フラグも考慮
		if (fileItem.frontmatter?.isTranslating) {
			fileItem.isTranslating = true;
		}
	}

	/**
	 * ソースファイルを除外したターゲットファイルのみ取得
	 */
	private getTargetFiles(files: FileStatusItem[]): FileStatusItem[] {
		return files.filter((file) => file.status !== Status.Source);
	}

	/**
	 * 特定のファイルに対してディレクトリマップを更新
	 */
	private addOrUpdateDirectory(fileItem: FileStatusItem): void {
		const dirPath = path.dirname(fileItem.filePath);
		const stopRoot = this.getRootDir(dirPath);
		const directoryItem = this.directoryItemMap.get(dirPath);
		if (directoryItem) {
			directoryItem.children = directoryItem.children || [];
			const index = directoryItem.children.findIndex((f) => isFileStatusItem(f) && f.filePath === fileItem.filePath);
			if (index >= 0) {
				Object.assign(directoryItem.children[index], fileItem);
			} else {
				directoryItem.children.push(fileItem);
			}
		}

		// 子の更新や集計はすべてこちらで面倒を見る
		this.updateDirectoryAggregatesUpward(dirPath, stopRoot);
	}

	/**
	 * 指定ディレクトリから親方向へ集計を再帰更新する（最上位でイベント発火）
	 */
	private updateDirectoryAggregatesUpward(dirPath: string, stopRoot?: string): void {
		const effectiveStopRoot = stopRoot ?? this.getRootDir(dirPath);
		let directoryItem = this.directoryItemMap.get(dirPath);
		if (!directoryItem) {
			// 直下ファイルを fileItemMap から収集して作成
			const directFiles = Array.from(this.fileItemMap.values()).filter((f) => path.dirname(f.filePath) === dirPath);
			directoryItem = this.createDirectoryStatusItem(dirPath, directFiles);
			this.directoryItemMap.set(dirPath, directoryItem);
		}

		// 集計の更新（共通処理）
		this.recalcDirectoryAggregate(dirPath, directoryItem);

		// 親があれば継続（通知は呼び出し元の公開メソッドが1回だけ行う）
		const parentDir = path.dirname(dirPath);
		if (dirPath !== effectiveStopRoot && parentDir !== dirPath) {
			this.updateDirectoryAggregatesUpward(parentDir, effectiveStopRoot);
		}
	}

	/**
	 * 再帰の停止ルートを判定する
	 */
	private getRootDir(dirPath: string): string {
		const baseDir = this.configBaseDir ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		try {
			// rootDirectoriesのうち最も深く一致するものを選ぶ。
			// 最初の一致を返すと、source が target の祖先になる構成
			// （例: sourceDir "docs" / targetDir "docs/ja"、sourceDir "."）で
			// 停止ルートが浅くなり、集計や刈り取りがターゲットのルートを越えてしまう。
			let best: string | undefined;
			for (const rootDir of this.rootDirectories) {
				const absoluteRootDir = baseDir ? path.resolve(baseDir, rootDir) : rootDir;
				const absoluteDirPath = path.resolve(dirPath);
				// ディレクトリ階層で比較
				if (isSameOrUnder(absoluteDirPath, absoluteRootDir)) {
					if (!best || absoluteRootDir.length > best.length) {
						best = absoluteRootDir;
					}
				}
			}
			if (best) {
				return best;
			}
		} catch {
			// FileExplorer 初期化不可などは無視してフォールバック
		}
		// フォールバック：configBaseDir（またはワークスペース）、なければドライブルート
		if (baseDir) return path.resolve(baseDir);
		return path.parse(path.resolve(dirPath)).root;
	}

	/**
	 * ディレクトリの集計・表示情報を更新（共通処理）
	 */
	private recalcDirectoryAggregate(dirPath: string, directoryItem: DirectoryStatusItem): void {
		// 再帰的に配下すべてのファイルから集計
		const allFiles = this.getFilesInDirectoryRecursive(dirPath);
		directoryItem.status = this.determineMergedStatus(allFiles);

		// ディレクトリのisTranslatingフラグを決定（再帰）
		directoryItem.isTranslating = allFiles.some((file) => file.isTranslating === true);

		// ディレクトリのラベル/集計値を更新（ターゲットファイルのみ）
		const targetFiles = this.getTargetFiles(allFiles);
		const totalUnits = targetFiles.reduce((sum, file) => sum + file.totalUnits, 0);
		const translatedUnits = targetFiles.reduce((sum, file) => sum + file.translatedUnits, 0);
		const dirName = path.basename(directoryItem.directoryPath) || directoryItem.directoryPath;
		directoryItem.label =
			directoryItem.status === Status.Source ? `${dirName}` : `${dirName} (${translatedUnits}/${totalUnits})`;

		directoryItem.totalUnits = totalUnits;
		directoryItem.translatedUnits = translatedUnits;
	}

	/**
	 * ディレクトリStatusItemを作成
	 */
	private createDirectoryStatusItem(dirPath: string, files: FileStatusItem[]): DirectoryStatusItem {
		const dirName = path.basename(dirPath) || dirPath;

		// 再帰的に配下すべてのファイルから集計（ターゲットファイルのみ）
		const allFiles = this.getFilesInDirectoryRecursive(dirPath);
		const targetFiles = this.getTargetFiles(allFiles);
		const totalUnits = targetFiles.reduce((sum, file) => sum + file.totalUnits, 0);
		const translatedUnits = targetFiles.reduce((sum, file) => sum + file.translatedUnits, 0);

		// ディレクトリの全体ステータスを決定（再帰）
		const status = this.determineMergedStatus(allFiles);

		// ディレクトリのisTranslatingフラグを決定（再帰）
		const isTranslating = allFiles.some((file) => file.isTranslating === true);

		// sourceディレクトリの場合は翻訳ユニット数を表示しない
		const label = status === Status.Source ? `${dirName}` : `${dirName} (${translatedUnits}/${totalUnits})`;

		// contextValueにステータスを反映（翻訳完了状態を識別）
		let contextValue: string;
		if (status === Status.Source) {
			contextValue = "mdaitDirectorySource";
		} else if (status === Status.Translated) {
			contextValue = "mdaitDirectoryTargetComplete";
		} else {
			contextValue = "mdaitDirectoryTarget";
		}

		return {
			type: StatusItemType.Directory,
			label,
			directoryPath: dirPath,
			status,
			isTranslating,
			contextValue,
			children: [...files], // 直下ファイルのコピーを保持
			totalUnits,
			translatedUnits,
		};
	}

	/**
	 * 指定ディレクトリ配下の全サブディレクトリパスを取得
	 */
	private getSubDirectoryPaths(parentDir: string): string[] {
		const subDirs = new Set<string>();

		for (const dirPath of this.directoryItemMap.keys()) {
			if (dirPath !== parentDir && isSameOrUnder(dirPath, parentDir)) {
				const rel = path.relative(parentDir, dirPath);
				const parts = rel.split(path.sep);
				if (parts.length > 0 && parts[0] !== "" && parts[0] !== ".") {
					const subDirPath = path.join(parentDir, parts[0]);
					subDirs.add(subDirPath);
				}
			}
		}

		return Array.from(subDirs);
	}

	/**
	 * 複数アイテムをマージした全体ステータスを決定する
	 */
	private determineMergedStatus(files: FileStatusItem[]): Status {
		if (files.length === 0) return Status.Unknown;

		const hasError = files.some((f) => f.status === Status.Error);
		if (hasError) return Status.Error;

		const allSource = files.every((f) => f.status === Status.Source || f.status === Status.Empty);
		if (allSource) return Status.Source;

		const totalUnits = files.reduce((sum, f) => sum + f.totalUnits, 0);
		const translatedUnits = files.reduce((sum, f) => sum + f.translatedUnits, 0);

		if (totalUnits === 0) return Status.Unknown;
		if (translatedUnits === totalUnits) return Status.Translated;
		return Status.NeedsTranslation;
	}
}
