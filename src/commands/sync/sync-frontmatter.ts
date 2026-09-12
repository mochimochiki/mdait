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
 * **マーカーの無い既訳は本文ユニットと同じ規則で守る**（`marker-sync.ts` の `needForFirstLink`）。
 * 訳文側の frontmatter に対象キーの値が入っていれば、それは人が書いた訳であって「まだ訳して
 * いない」ではない。`need:translate` を付けると次の trans が機械翻訳で上書きする（実測:
 * 取り込み直後に人の付けた英語タイトルが消えた）。取り込み（adopt）を頼まれたかどうかは
 * 関係ない — ふつうの sync でも同じ事故が起きる。訳文ファイルがまだ無い経路
 * （`targetFrontMatter` が undefined）は原文から複製するだけなので、値があっても既訳ではない。
 *
 * 丸写し（対象キーの値が原文と全部同じ）の扱いも本文ユニットと同じで translate に残す。
 * 理由は `needForFirstLink` の説明にある（確認待ちの出口が「確認済みにする」しか無い）。
 *
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

	// 既訳を守る: マーカーが無く、訳文側に自前の値が入っているときだけ
	const existingText =
		!existingMarker && targetFrontMatter !== undefined && calculateFrontmatterHash(targetFrontMatter, keys) !== null;

	// 共通ロジックを使用してターゲットマーカーを同期
	const targetResult = syncTargetMarker({
		sourceHash,
		targetHash,
		existingMarker,
		existingText,
	});

	setFrontmatterMarker(workingTarget, targetResult.marker);
	return { sourceFrontMatter, targetFrontMatter: workingTarget, processed: true };
}
