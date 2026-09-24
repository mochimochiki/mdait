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
	frontmatterTranslatableText,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../core/markdown/frontmatter-translation";
import { syncSourceMarker, syncTargetMarker } from "./marker-sync";
import { isWrittenOverTranslateMark } from "./untranslated-copy";

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
 * 理由は `needForFirstLink` の説明にある（まだ訳していないのだから、人に確認を頼む理由が無い）。
 *
 * **翻訳待ちの印を付けたあとで人が値を書き込んだら確認待ちへ切り替える**のも本文ユニットと同じ
 * （`isWrittenOverTranslateMark`。ADR-260923-07 / -09）。frontmatter の「中身」は翻訳対象キーの値で、
 * ハッシュと同じもの（`frontmatterTranslatableText`）を比べる。
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

	// 翻訳待ちの印を付けたあとで人が値を書き込んでいたら確認待ちへ（本文ユニットと同じ規則）。
	// 古い原文の丸写しを写し直す処理は frontmatter には無いので、丸写しの判定はいまの原文との比較だけで足りる
	if (
		existingMarker &&
		targetFrontMatter !== undefined &&
		isWrittenOverTranslateMark(
			existingMarker.need,
			existingMarker.hash,
			targetHash ?? "",
			frontmatterTranslatableText(targetFrontMatter, keys),
			frontmatterTranslatableText(sourceFrontMatter, keys),
			false,
		)
	) {
		existingMarker.setNeed("review");
	}

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
