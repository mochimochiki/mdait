import { type StatusItem, StatusItemType } from "./status-item";

/**
 * StatusItemツリーをfromHashで再帰検索し、一致するユニットを返す
 * @param items StatusItemの配列またはツリー
 * @param fromHash 検索対象のfromHash
 * @returns 一致するStatusItem（type: "unit"）の配列
 */
export function findUnitsByFromHash(items: StatusItem[], fromHash: string): StatusItem[] {
	const results: StatusItem[] = [];
	
	for (const item of items) {
		if (item.type === StatusItemType.Unit && item.fromHash === fromHash) {
			results.push(item);
		}
		
		if (item.children) {
			results.push(...findUnitsByFromHash(item.children, fromHash));
		}
	}
	
	return results;
}

/**
 * StatusItemツリーをunitHashで再帰検索し、一致するユニットを返す
 * @param items StatusItemの配列またはツリー
 * @param unitHash 検索対象のunitHash
 * @returns 一致するStatusItem（type: "unit"）、見つからない場合はundefined
 */
export function findUnitByHash(items: StatusItem[], unitHash: string): StatusItem | undefined {
	for (const item of items) {
		if (item.type === StatusItemType.Unit && item.unitHash === unitHash) {
			return item;
		}
		
		if (item.children) {
			const found = findUnitByHash(item.children, unitHash);
			if (found) {
				return found;
			}
		}
	}
	
	return undefined;
}

/**
 * 指定ファイルパス内の未翻訳ユニット（needFlag付き）を取得
 * @param items StatusItemの配列またはツリー
 * @param filePath 対象ファイルパス
 * @returns 未翻訳のStatusItem（type: "unit"）の配列
 */
export function getUntranslatedUnits(items: StatusItem[], filePath: string): StatusItem[] {
	const results: StatusItem[] = [];
	
	for (const item of items) {
		if (item.type === StatusItemType.File && item.filePath === filePath && item.children) {
			for (const child of item.children) {
				if (child.type === StatusItemType.Unit && child.needFlag) {
					results.push(child);
				}
			}
		}
		
		if (item.children) {
			results.push(...getUntranslatedUnits(item.children, filePath));
		}
	}
	
	return results;
}

/**
 * StatusItemツリーから進捗情報を集計
 * @param items StatusItemの配列またはツリー
 * @returns 集計結果 { totalUnits, translatedUnits, errorUnits }
 */
export function aggregateProgress(items: StatusItem[]): {
	totalUnits: number;
	translatedUnits: number;
	errorUnits: number;
} {
	let totalUnits = 0;
	let translatedUnits = 0;
	let errorUnits = 0;
	
	for (const item of items) {
		if (item.type === StatusItemType.Unit) {
			totalUnits++;
			if (item.status === "translated") {
				translatedUnits++;
			} else if (item.status === "error") {
				errorUnits++;
			}
		}
		
		if (item.children) {
			const childProgress = aggregateProgress(item.children);
			totalUnits += childProgress.totalUnits;
			translatedUnits += childProgress.translatedUnits;
			errorUnits += childProgress.errorUnits;
		}
	}
	
	return { totalUnits, translatedUnits, errorUnits };
}

/**
 * 指定パス配下のStatusItemを再帰検索
 * @param items StatusItemの配列またはツリー
 * @param targetPath 検索対象のディレクトリまたはファイルパス
 * @returns 一致するStatusItem、見つからない場合はundefined
 */
export function findItemByPath(items: StatusItem[], targetPath: string): StatusItem | undefined {
	for (const item of items) {
		if (
			(item.type === StatusItemType.Directory && item.directoryPath === targetPath) ||
			(item.type === StatusItemType.File && item.filePath === targetPath)
		) {
			return item;
		}
		
		if (item.children) {
			const found = findItemByPath(item.children, targetPath);
			if (found) {
				return found;
			}
		}
	}
	
	return undefined;
}

/**
 * エラー状態のアイテムを抽出
 * @param items StatusItemの配列またはツリー
 * @returns エラー状態のStatusItemの配列
 */
export function getErrorItems(items: StatusItem[]): StatusItem[] {
	const results: StatusItem[] = [];
	
	for (const item of items) {
		if (item.status === "error" || item.hasParseError) {
			results.push(item);
		}
		
		if (item.children) {
			results.push(...getErrorItems(item.children));
		}
	}
	
	return results;
}

/**
 * StatusItemツリーをフラットな配列に変換
 * @param items StatusItemの配列またはツリー
 * @param filterType 特定のタイプのみ抽出する場合に指定
 * @returns フラット化されたStatusItemの配列
 */
export function flattenStatusItems(items: StatusItem[], filterType?: StatusItemType): StatusItem[] {
	const results: StatusItem[] = [];
	
	for (const item of items) {
		if (!filterType || item.type === filterType) {
			results.push(item);
		}
		
		if (item.children) {
			results.push(...flattenStatusItems(item.children, filterType));
		}
	}
	
	return results;
}

/**
 * StatusItemの状態を更新
 * @param items StatusItemの配列またはツリー
 * @param targetHash 更新対象のunitHash
 * @param updates 更新する内容
 * @returns 更新が成功したかどうか
 */
export function updateStatusItem(
	items: StatusItem[],
	targetHash: string,
	updates: Partial<StatusItem>
): boolean {
	for (const item of items) {
		if (item.type === StatusItemType.Unit && item.unitHash === targetHash) {
			Object.assign(item, updates);
			return true;
		}
		
		if (item.children && updateStatusItem(item.children, targetHash, updates)) {
			return true;
		}
	}
	
	return false;
}
