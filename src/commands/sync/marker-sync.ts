/**
 * マーカー同期の共通ロジック
 * syncFrontmatterMarkersとupdateSectionHashesで共有される
 * 変更検出とneedフラグ設定のロジックを統一
 */

import { MdaitMarker } from "../../core/markdown/mdait-marker";

/**
 * マーカー同期のコンテキスト
 */
export interface MarkerSyncContext {
	/** 現在のソースハッシュ */
	sourceHash: string;
	/** 現在のターゲットハッシュ（ない場合はnull） */
	targetHash: string | null;
	/** 既存のターゲットマーカー（ない場合はnull） */
	existingMarker: MdaitMarker | null;
}

/**
 * マーカー同期の結果
 */
export interface MarkerSyncResult {
	/** 更新後のマーカー */
	marker: MdaitMarker;
	/** 変更があったかどうか */
	changed: boolean;
	/** 変更の種類 */
	changeType: "none" | "new" | "source-changed" | "target-changed";
}

/**
 * ソース側マーカーを同期する
 * - hashを計算して付与
 * - fromとneedは設定しない（ソース側なので）
 *
 * @param currentHash 現在のソースコンテンツのハッシュ
 * @param existingMarker 既存のマーカー（ない場合はnull）
 * @returns 同期結果
 */
export function syncSourceMarker(
	currentHash: string,
	existingMarker: MdaitMarker | null,
): MarkerSyncResult {
	if (!existingMarker) {
		// 新規マーカー作成
		return {
			marker: new MdaitMarker(currentHash),
			changed: true,
			changeType: "new",
		};
	}

	if (existingMarker.hash !== currentHash) {
		// ハッシュが変わった場合のみ更新
		existingMarker.hash = currentHash;
		return {
			marker: existingMarker,
			changed: true,
			changeType: "source-changed",
		};
	}

	// 変更なし
	return {
		marker: existingMarker,
		changed: false,
		changeType: "none",
	};
}

/**
 * ターゲット側マーカーを同期する
 * - 変更検出を行い、適切なneedフラグを設定
 *
 * @param context マーカー同期のコンテキスト
 * @returns 同期結果
 */
export function syncTargetMarker(context: MarkerSyncContext): MarkerSyncResult {
	const { sourceHash, targetHash, existingMarker } = context;

	// 新規マーカーの場合
	if (!existingMarker) {
		const marker = new MdaitMarker(targetHash ?? sourceHash, sourceHash);
		marker.setNeed("translate");
		return {
			marker,
			changed: true,
			changeType: "new",
		};
	}

	// 変更検出
	const isSourceChanged = existingMarker.from !== sourceHash;
	const isTargetChanged =
		targetHash !== null && existingMarker.hash !== targetHash;

	// 原文が revise@ のスナップショットと同じところへ戻ったら、改訂すべき差分はもう無い
	// （syncMarkerPair と同じ理由。落とさないと need が永久に消えない）
	const revertedToTranslatedSource = existingMarker.getOldHashFromNeed() === sourceHash;
	if (revertedToTranslatedSource) {
		existingMarker.removeNeedTag();
	}

	// ソースが変更された場合: revise または translate（両方変更時も同様に処理）
	if (isSourceChanged) {
		const oldSourceHash = existingMarker.from;
		existingMarker.from = sourceHash;

		// 既存のrevise@{hash}がある場合、そのhashを保持する
		const existingReviseHash = revertedToTranslatedSource ? null : existingMarker.getOldHashFromNeed();
		if (existingReviseHash) {
			// すでにrevise待ち状態なので、スナップショットハッシュを保持
			existingMarker.setReviseNeed(existingReviseHash);
		} else if (existingMarker.need === "translate") {
			// まだ翻訳されていない場合はneed:translateのまま維持（fromのみ更新済み）
			existingMarker.setNeed("translate");
		} else if (oldSourceHash) {
			// 翻訳済みでソースが変更された場合は新規revise設定
			existingMarker.setReviseNeed(oldSourceHash);
		} else {
			existingMarker.setNeed("translate");
		}

		// ターゲットハッシュを常に最新に更新
		if (targetHash) {
			existingMarker.hash = targetHash;
		}

		return {
			marker: existingMarker,
			changed: true,
			changeType: "source-changed",
		};
	}

	// ターゲットのみ変更: ハッシュを更新
	if (isTargetChanged && targetHash) {
		existingMarker.hash = targetHash;
		return {
			marker: existingMarker,
			changed: true,
			changeType: "target-changed",
		};
	}

	// need を落としただけの回。書き戻さないと次の sync でまた同じ判断をする
	if (revertedToTranslatedSource) {
		return {
			marker: existingMarker,
			changed: true,
			changeType: "source-changed",
		};
	}

	// 変更なし
	return {
		marker: existingMarker,
		changed: false,
		changeType: "none",
	};
}

/**
 * ペア同期用の結果
 */
export interface PairSyncResult {
	/** ソース側マーカー */
	sourceMarker: MdaitMarker;
	/** ターゲット側マーカー */
	targetMarker: MdaitMarker;
	/** 変更があったかどうか */
	changed: boolean;
}

/**
 * ペア同期のオプション
 */
export interface PairSyncOptions {
	/**
	 * 採用（adopt）モード: マーカーなし・本文ありの既存訳文を翻訳済みとして採用する。
	 * from を新規確立するユニット（need 未設定）に need:translate の代わりに need:review を付与し、
	 * trans による既訳の上書きを防ぐ。呼び出し側は「ターゲット本文が空でない」ことを確認して渡すこと。
	 */
	adoptTarget?: boolean;
	/**
	 * isolate ペア（source が need:isolate）の凍結: hash / from は最新化するが、
	 * setNeed / setReviseNeed を一切呼ばず既存の need を変更しない
	 * （ペアのリンクは維持しつつ、新しい翻訳需要を下流に流さない）。
	 */
	suppressNeed?: boolean;
}

/**
 * ソース・ターゲットペアのマーカーを同期する
 *
 * @param sourceHash ソースコンテンツのハッシュ
 * @param targetHash ターゲットコンテンツのハッシュ
 * @param existingSourceMarker 既存のソースマーカー
 * @param existingTargetMarker 既存のターゲットマーカー
 * @param options ペア同期のオプション
 * @returns ペア同期結果
 */
export function syncMarkerPair(
	sourceHash: string,
	targetHash: string,
	existingSourceMarker: MdaitMarker | null,
	existingTargetMarker: MdaitMarker | null,
	options?: PairSyncOptions,
): PairSyncResult {
	// 新規作成かどうかを判定
	const isNewTarget = existingTargetMarker === null;

	// ソースマーカーを作成/更新
	const sourceMarker = existingSourceMarker ?? new MdaitMarker(sourceHash);
	const targetMarker =
		existingTargetMarker ?? new MdaitMarker(targetHash, sourceMarker.hash);

	const isSourceChanged = sourceMarker.hash !== sourceHash;
	const isTargetChanged = targetMarker.hash !== targetHash;

	// ソースハッシュを常に最新に更新
	sourceMarker.hash = sourceHash;

	// ターゲットハッシュを常に最新に更新
	targetMarker.hash = targetHash;

	// 新規ターゲットの場合は need:translate を設定（suppressNeed 時は need を触らない）
	if (isNewTarget) {
		if (!options?.suppressNeed) {
			targetMarker.setNeed("translate");
		}
		return {
			sourceMarker,
			targetMarker,
			changed: true,
		};
	}

	// ソースの変更をターゲットに反映（両方変更時も同様に処理）
	const oldSourceHash = targetMarker.from;
	// 原文が revise@ のスナップショットと同じところへ戻ったら、改訂すべき差分はもう無い。
	// 打ち間違いの取り消し・ブランチの切り替え・`git checkout --` で日常的に起きる。
	// 落とさないと「まだ N 件残っている」に永久に居座り（sync を何度回しても消えない）、
	// しかも trans がその章を patch ではなく全文で訳し直して手直しを消す
	const revertedToTranslatedSource =
		!options?.suppressNeed && targetMarker.getOldHashFromNeed() === sourceMarker.hash;
	if (revertedToTranslatedSource) {
		targetMarker.removeNeedTag();
	}
	if (oldSourceHash !== sourceMarker.hash) {
		targetMarker.from = sourceMarker.hash;

		if (!options?.suppressNeed && !revertedToTranslatedSource) {
			// 既存のrevise@{hash}がある場合、そのhashを保持する
			const existingReviseHash = targetMarker.getOldHashFromNeed();
			if (existingReviseHash) {
				// すでにrevise待ち状態なので、スナップショットハッシュを保持
				targetMarker.setReviseNeed(existingReviseHash);
			} else if (targetMarker.need === "translate") {
				// まだ翻訳されていない場合はneed:translateのまま維持（fromのみ更新済み）
				targetMarker.setNeed("translate");
			} else if (oldSourceHash) {
				// 翻訳済みでソースが変更された場合は新規revise設定
				targetMarker.setReviseNeed(oldSourceHash);
			} else if (options?.adoptTarget) {
				// adopt: from新規確立＋本文ありの既存訳文はレビューに倒す（既訳のtrans上書きを防ぐ）
				targetMarker.setNeed("review");
			} else {
				targetMarker.setNeed("translate");
			}
		}
	}

	return {
		sourceMarker,
		targetMarker,
		changed:
			isSourceChanged ||
			isTargetChanged ||
			oldSourceHash !== sourceMarker.hash ||
			revertedToTranslatedSource,
	};
}
