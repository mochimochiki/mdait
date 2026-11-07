/**
 * @file batch-failures.ts
 * @description
 *   仕事をいくつかに分けて AI へ投げる処理（用語を拾う・訳語を埋める）で、失敗したバッチを
 *   数える。数え方と結果の形はここにしか置かない。
 *
 *   **失敗は理由を問わず全部数える。** 以前は「答えは届いたが使えなかった」ものだけを
 *   数えており、1つでも成功したバッチがあると、通信の失敗・429・歯止めによる打ち切りは
 *   完了通知に一言も出なかった。
 *
 *   歯止め（`infra/llm/ai-call-guard.ts`）が AI 呼び出しを止めたら、残りのバッチは投げない。
 *   止まった相手に投げ続けても、同じ例外が返るだけである。
 *
 * @module commands/shared/batch-failures
 */

import { isAiCallsStopped } from "../../infra/llm/ai-call-guard";
import { type UnusableResponseReason, isUnusableAIResponse } from "../../infra/llm/unusable-response";

/** バッチの失敗の数え。検出・展開・更新の結果はどれもこの形を持つ */
export interface BatchFailures {
	/** 試したバッチの数（AI へ投げたもの。打ち切りで投げなかった分は含まない） */
	totalBatches: number;
	/** 失敗したバッチの数（理由を問わない） */
	failedBatches: number;
	/** そのうち、答えは届いたが使えなかったバッチの数 */
	unusableBatches: number;
	/** 最初に使えなかった理由。利用者向けの文はここから組む（`describeResponseFailure`） */
	unusableReason?: UnusableResponseReason;
	/** 歯止めが AI 呼び出しを止めたときの、利用者向けの文。止まっていなければ無い */
	stoppedMessage?: string;
}

/** バッチを1つも投げなかったことを表す */
export const NO_BATCHES: BatchFailures = Object.freeze({ totalBatches: 0, failedBatches: 0, unusableBatches: 0 });

/** バッチの成否を数える。1回の検出・展開ごとに1つ作る */
export class BatchFailureTally {
	private attempted = 0;
	private failed = 0;
	private unusable = 0;
	private reason: UnusableResponseReason | undefined;
	private stopped: string | undefined;
	private firstError: unknown;

	/** バッチを1つ投げる直前に呼ぶ */
	attempt(): void {
		this.attempted++;
	}

	/**
	 * 失敗したバッチを数える（キャンセルは失敗ではないので、呼ぶ前に除くこと）。
	 *
	 * @returns 続けてよければ true。歯止めが AI 呼び出しを止めていたら false（残りは投げない）
	 */
	recordFailure(error: unknown): boolean {
		this.failed++;
		if (this.firstError === undefined) {
			this.firstError = error;
		}
		if (isUnusableAIResponse(error)) {
			this.unusable++;
			this.reason ??= error.reason;
		}
		if (isAiCallsStopped(error)) {
			this.stopped = error.message;
			return false;
		}
		return true;
	}

	/**
	 * 投げたバッチがすべて失敗していたら、最初の失敗を投げ直す。
	 * 「0件の成功」と読み違えさせず、AI 未接続などを呼び出し側のエラー通知で見せるため
	 */
	throwIfAllFailed(): void {
		if (this.attempted > 0 && this.failed === this.attempted) {
			throw this.firstError instanceof Error ? this.firstError : new Error(String(this.firstError));
		}
	}

	/** ここまでの数え */
	summary(): BatchFailures {
		return {
			totalBatches: this.attempted,
			failedBatches: this.failed,
			unusableBatches: this.unusable,
			unusableReason: this.reason,
			stoppedMessage: this.stopped,
		};
	}
}
