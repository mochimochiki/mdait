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
	changeType: "none" | "new" | "source-changed" | "target-changed" | "conflict";
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
export function syncSourceMarker(currentHash: string, existingMarker: MdaitMarker | null): MarkerSyncResult {
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
	const isTargetChanged = targetHash !== null && existingMarker.hash !== targetHash;

	// 競合: ソースとターゲット両方が変更された
	if (isSourceChanged && isTargetChanged) {
		existingMarker.setNeed("solve-conflict");
		// ハッシュは更新しない（競合状態を保持）
		return {
			marker: existingMarker,
			changed: true,
			changeType: "conflict",
		};
	}

	// ソースのみ変更: revise または translate
	if (isSourceChanged) {
		const oldSourceHash = existingMarker.from;
		existingMarker.from = sourceHash;

		if (oldSourceHash) {
			existingMarker.setReviseNeed(oldSourceHash);
		} else {
			existingMarker.setNeed("translate");
		}

		// ターゲットハッシュも更新
		if (isTargetChanged && targetHash) {
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
	/** 競合があるかどうか */
	hasConflict: boolean;
}

/**
 * ソース・ターゲットペアのマーカーを同期する
 *
 * @param sourceHash ソースコンテンツのハッシュ
 * @param targetHash ターゲットコンテンツのハッシュ
 * @param existingSourceMarker 既存のソースマーカー
 * @param existingTargetMarker 既存のターゲットマーカー
 * @returns ペア同期結果
 */
export function syncMarkerPair(
	sourceHash: string,
	targetHash: string,
	existingSourceMarker: MdaitMarker | null,
	existingTargetMarker: MdaitMarker | null,
): PairSyncResult {
	// 新規作成かどうかを判定
	const isNewTarget = existingTargetMarker === null;

	// ソースマーカーを作成/更新
	const sourceMarker = existingSourceMarker ?? new MdaitMarker(sourceHash);
	const targetMarker = existingTargetMarker ?? new MdaitMarker(targetHash, sourceMarker.hash);

	const isSourceChanged = sourceMarker.hash !== sourceHash;
	const isTargetChanged = targetMarker.hash !== targetHash;

	// 競合: 両方が変更された
	if (isSourceChanged && isTargetChanged) {
		sourceMarker.setNeed("solve-conflict");
		targetMarker.setNeed("solve-conflict");
		// ハッシュは更新しない
		return {
			sourceMarker,
			targetMarker,
			changed: true,
			hasConflict: true,
		};
	}

	// ソースハッシュを更新
	if (isSourceChanged) {
		sourceMarker.hash = sourceHash;
	}

	// ターゲットハッシュを更新
	if (isTargetChanged) {
		targetMarker.hash = targetHash;
	}

	// 新規ターゲットの場合は need:translate を設定
	if (isNewTarget) {
		targetMarker.setNeed("translate");
		return {
			sourceMarker,
			targetMarker,
			changed: true,
			hasConflict: false,
		};
	}

	// ソースの変更をターゲットに反映
	const oldSourceHash = targetMarker.from;
	if (oldSourceHash !== sourceMarker.hash) {
		targetMarker.from = sourceMarker.hash;
		if (oldSourceHash) {
			targetMarker.setReviseNeed(oldSourceHash);
		} else {
			targetMarker.setNeed("translate");
		}
	}

	return {
		sourceMarker,
		targetMarker,
		changed: isSourceChanged || isTargetChanged || oldSourceHash !== sourceMarker.hash,
		hasConflict: false,
	};
}
