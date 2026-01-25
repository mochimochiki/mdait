import { FrontMatter } from "../../core/markdown/front-matter";

/**
 * level設定の同期処理の結果
 */
export interface LevelSyncResult {
	/** level設定が修正されたか */
	modified: boolean;
	/** 更新後の訳文コンテンツ（修正された場合のみ） */
	updatedTargetContent?: string;
}

/**
 * 原文と訳文のfrontmatterでmdait.sync.levelの設定値を検証し、不一致の場合は同期する
 *
 * @param sourceFrontMatter 原文のfrontmatter
 * @param targetContent 訳文の全コンテンツ
 * @returns 同期結果
 */
export function syncLevelSettings(sourceFrontMatter: FrontMatter | undefined, targetContent: string): LevelSyncResult {
	// 訳文のfrontmatterを解析
	const { frontMatter: targetFrontMatter, content: targetMainContent } = FrontMatter.parse(targetContent);

	// level値を取得
	const sourceLevel = sourceFrontMatter?.get<number>("mdait.sync.level");
	const targetLevel = targetFrontMatter?.get<number>("mdait.sync.level");

	// level値の型検証
	if (sourceLevel !== undefined && typeof sourceLevel !== "number") {
		throw new Error(`Invalid mdait.sync.level type in source. Expected number, got ${typeof sourceLevel}`);
	}
	if (targetLevel !== undefined && typeof targetLevel !== "number") {
		throw new Error(`Invalid mdait.sync.level type in target. Expected number, got ${typeof targetLevel}`);
	}

	// level設定が一致している場合は何もしない
	if (sourceLevel === targetLevel) {
		return { modified: false };
	}

	// level設定を訳文に反映
	let updatedTargetFrontMatter = targetFrontMatter;

	if (sourceLevel === undefined) {
		// 原文にlevel設定なし、訳文にあり → 訳文のlevel設定を削除
		// FrontMatter.delete()が自動的に空親オブジェクトをクリーンアップする
		if (targetFrontMatter) {
			targetFrontMatter.delete("mdait.sync.level");
		}
	} else {
		// 原文にlevel設定あり → 訳文に設定
		if (!targetFrontMatter) {
			// frontmatterが存在しない場合は新規作成
			updatedTargetFrontMatter = FrontMatter.empty();
		} else {
			updatedTargetFrontMatter = targetFrontMatter;
		}
		updatedTargetFrontMatter.set("mdait.sync.level", sourceLevel);
	}

	// 訳文コンテンツを生成
	const updatedTargetContent = updatedTargetFrontMatter
		? `${updatedTargetFrontMatter.stringify()}${targetMainContent}`
		: targetMainContent;

	return {
		modified: true,
		updatedTargetContent,
	};
}
