/**
 * @file sync-frontmatter.ts
 * @description
 *   frontmatterマーカー同期の純粋関数。
 *   sync-command.ts から抽出。vscode依存なし。
 * @module commands/sync/sync-frontmatter
 */
import { FrontMatter } from "../../core/markdown/front-matter";
import {
	calculateFrontmatterHash,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../core/markdown/frontmatter-translation";
import { syncSourceMarker, syncTargetMarker } from "./marker-sync";

/**
 * frontmatterマーカーを同期する
 * @param sourceFrontMatter ソース側のfrontmatter
 * @param targetFrontMatter ターゲット側のfrontmatter
 * @param keys 翻訳対象キー一覧
 * @returns sourceFrontMatter, targetFrontMatter, processed
 */
export function syncFrontmatterMarkers(
	sourceFrontMatter: FrontMatter | undefined,
	targetFrontMatter: FrontMatter | undefined,
	keys: string[],
): { sourceFrontMatter: FrontMatter | undefined; targetFrontMatter: FrontMatter | undefined; processed: boolean } {
	if (keys.length === 0) {
		return { sourceFrontMatter, targetFrontMatter, processed: false };
	}

	const sourceHash = calculateFrontmatterHash(sourceFrontMatter, keys);
	if (!sourceHash) {
		if (targetFrontMatter && parseFrontmatterMarker(targetFrontMatter)) {
			setFrontmatterMarker(targetFrontMatter, null);
		}
		return { sourceFrontMatter, targetFrontMatter, processed: false };
	}

	// Source側にもマーカーを設定（共通ロジック使用）
	if (sourceFrontMatter) {
		const existingSourceMarker = parseFrontmatterMarker(sourceFrontMatter);
		const sourceResult = syncSourceMarker(sourceHash, existingSourceMarker);
		if (sourceResult.changed) {
			setFrontmatterMarker(sourceFrontMatter, sourceResult.marker);
		}
	}

	// ターゲット側の処理
	let workingTarget = targetFrontMatter;
	if (!workingTarget) {
		workingTarget = sourceFrontMatter?.clone() ?? FrontMatter.empty();
	}

	const targetHash = calculateFrontmatterHash(workingTarget, keys, { allowEmpty: true });
	const existingMarker = parseFrontmatterMarker(workingTarget);

	// 共通ロジックを使用してターゲットマーカーを同期
	const targetResult = syncTargetMarker({
		sourceHash,
		targetHash,
		existingMarker,
	});

	setFrontmatterMarker(workingTarget, targetResult.marker);
	return { sourceFrontMatter, targetFrontMatter: workingTarget, processed: true };
}
