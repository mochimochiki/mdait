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
 *
 * **既訳の採用（adopt）は本文ユニットと同じ規則に従う。** 訳文側の frontmatter に対象キーの
 * 値が入っていれば、それは人が書いた訳であって「まだ訳していない」ではない。`need:translate`
 * を付けると次の trans が機械翻訳で上書きする（実測: 取り込み直後に人の付けた英語タイトルが
 * 消えた）。訳文ファイルがまだ無い経路（`targetFrontMatter` が undefined）は原文から複製する
 * だけなので、値があっても既訳ではない — 採用しない。
 *
 * @param sourceFrontMatter ソース側のfrontmatter
 * @param targetFrontMatter ターゲット側のfrontmatter
 * @param keys 翻訳対象キー一覧
 * @param options adopt: 既訳の採用モードか
 * @returns sourceFrontMatter, targetFrontMatter, processed
 */
export function syncFrontmatterMarkers(
	sourceFrontMatter: FrontMatter | undefined,
	targetFrontMatter: FrontMatter | undefined,
	keys: string[],
	options: { adopt?: boolean } = {},
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

	// 既訳の採用: マーカーが無く、訳文側に自前の値が入っているときだけ
	const adoptTarget =
		options.adopt === true &&
		!existingMarker &&
		targetFrontMatter !== undefined &&
		calculateFrontmatterHash(targetFrontMatter, keys) !== null;

	// 共通ロジックを使用してターゲットマーカーを同期
	const targetResult = syncTargetMarker({
		sourceHash,
		targetHash,
		existingMarker,
		adoptTarget,
	});

	setFrontmatterMarker(workingTarget, targetResult.marker);
	return { sourceFrontMatter, targetFrontMatter: workingTarget, processed: true };
}
