/**
 * @file translation-run.ts
 * @description
 *   翻訳の進行制御 — 「どのユニットをどの順で処理し、中断・失敗・パッチ失敗をどう扱い、
 *   何を保存して何を数えるか」だけを持つ。VS Code 非依存で、単体テストで固定できる。
 *
 *   ここを切り出す前は、この判断が `trans-command.ts` の1本の for ループの中で
 *   進捗表示・ステータス更新・ファイル保存・通知と混ざっており、分岐（キャンセル・
 *   パッチ失敗によるスキップ・例外）が増えるたびに「旗を下ろし忘れる」「保存に到達しない」
 *   といった取りこぼしが生まれていた。テストが書けなかったことが、それが生き残った理由である。
 *
 * @module commands/trans/translation-run
 */
import type { PatchFailureReason } from "../../core/diff/diff-generator";
import { isOperationCancelled } from "../../infra/errors/operation-cancelled";

/** 1ユニットの翻訳結果 */
export interface UnitTranslationOutcome {
	/** パッチ適用で訳し直したか */
	patched: boolean;
	/** TM参照がヒットしたか */
	tmHit: boolean;
	/**
	 * パッチ適用に失敗したため、手修正を保って訳文を据え置いた理由。
	 * 設定されている場合、そのユニットは「翻訳していない」として数える。
	 */
	patchFailure?: PatchFailureReason;
}

/** 1ユニットの書き戻し結果 */
export interface UnitPersistOutcome {
	/** 実際にファイルへ書けたか */
	written: boolean;
	/** 書けなかった理由（利用者に見せる） */
	reason?: string;
}

/** 進行制御が外界へ触るための口 */
export interface UnitLoopPorts<T> {
	/** ユーザーが中断を要求しているか */
	isCancelled(): boolean;
	/** 進捗の報告（表示用。失敗しても進行を止めない） */
	onProgress(index: number, total: number, unit: T): void;
	/** 翻訳本体。例外を投げるとループは打ち切られる */
	translateUnit(unit: T, index: number): Promise<UnitTranslationOutcome>;
	/**
	 * 1ユニット分の書き戻し。
	 * 本文にマーカーを持たない保管方式では no-op にして、ループ後の一括保存に委ねる。
	 */
	persistUnit(unit: T, index: number): Promise<UnitPersistOutcome>;
}

/** パッチ適用に失敗して手修正を保ったユニット */
export interface PatchFailureRecord<T> {
	index: number;
	unit: T;
	reason: PatchFailureReason;
}

/** 書き戻せなかったユニット */
export interface WriteFailureRecord<T> {
	index: number;
	unit: T;
	reason?: string;
}

/** 進行制御の結果 */
export interface UnitLoopResult<T> {
	/** 着手したユニット数 */
	processed: number;
	/** 訳文を更新したユニット数 */
	translated: number;
	/** そのうちパッチ適用で更新した数 */
	patched: number;
	/** 中断・パッチ失敗で訳文を更新しなかった数 */
	skipped: number;
	/** TM参照がヒットした数 */
	tmHits: number;
	/** ユーザーが中断したか */
	cancelled: boolean;
	patchFailures: Array<PatchFailureRecord<T>>;
	writeFailures: Array<WriteFailureRecord<T>>;
	/** 打ち切りの原因となった例外（中断は含まない。中断は cancelled で表す） */
	error?: unknown;
	/** 例外が起きたユニット */
	errorUnit?: T;
}

/**
 * ユニット列を順に翻訳する。
 *
 * **例外を投げない。** 打ち切りの原因は結果に載せて返す。呼び出し側が
 * 「ここまでの成果を保存してから」失敗を報告できるようにするためであり、
 * 中断時に翻訳結果が消える不具合はこの一点に由来していた。
 *
 * 中断（`isCancelled` が true になる／翻訳が中断例外を投げる）は失敗ではなく
 * `cancelled` として返す。未着手のユニットは skipped に数える。
 *
 * @param units 翻訳対象
 * @param ports 外界へ触るための口
 */
export async function runUnitLoop<T>(
	units: readonly T[],
	ports: UnitLoopPorts<T>,
): Promise<UnitLoopResult<T>> {
	const result: UnitLoopResult<T> = {
		processed: 0,
		translated: 0,
		patched: 0,
		skipped: 0,
		tmHits: 0,
		cancelled: false,
		patchFailures: [],
		writeFailures: [],
	};

	for (let i = 0; i < units.length; i++) {
		if (ports.isCancelled()) {
			result.cancelled = true;
			result.skipped += units.length - i;
			return result;
		}

		const unit = units[i];
		// 進捗表示の失敗で翻訳を止めない
		try {
			ports.onProgress(i, units.length, unit);
		} catch {
			// 表示だけの処理なので握り潰す
		}

		let outcome: UnitTranslationOutcome;
		try {
			outcome = await ports.translateUnit(unit, i);
		} catch (error) {
			// 中断は失敗ではない。ここまでの成果は呼び出し側が保存する
			if (isOperationCancelled(error)) {
				result.cancelled = true;
				result.skipped += units.length - i;
				return result;
			}
			result.error = error;
			result.errorUnit = unit;
			result.skipped += units.length - i;
			return result;
		}

		result.processed++;
		if (outcome.tmHit) {
			result.tmHits++;
		}

		if (outcome.patchFailure) {
			// 訳文は据え置き（手修正を保つ）。理由は呼び出し側が排他区間の外で報告する
			result.skipped++;
			result.patchFailures.push({ index: i, unit, reason: outcome.patchFailure });
			continue;
		}

		result.translated++;
		if (outcome.patched) {
			result.patched++;
		}

		// 書き戻しの失敗も例外にせず結果へ載せる（この関数は例外を投げない契約）。
		// 権限エラーやディスクフルでここが投げると、呼び出し側が「ここまでの成果を
		// 保存してから報告する」流れに入れない
		let persisted: UnitPersistOutcome;
		try {
			persisted = await ports.persistUnit(unit, i);
		} catch (error) {
			persisted = {
				written: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		if (!persisted.written) {
			result.writeFailures.push({ index: i, unit, reason: persisted.reason });
		}
	}

	return result;
}
