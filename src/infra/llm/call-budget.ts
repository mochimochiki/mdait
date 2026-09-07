/**
 * @file call-budget.ts
 * @description
 *   **AI を呼び続けてしまったときの歯止め。1か所しかない。**
 *
 *   経路ごとの送り直しには、それぞれ上限が付いている（`trans.retryLimit`、
 *   `DEFAULT_RETRY_POLICY.maxRetries` など）。それでも足りなかった。上限は
 *   1回の呼び出しの中しか見ておらず、**外側で同じ操作が何度も繰り返される形**に
 *   なると誰も数えていなかったからである。
 *
 *   実測（意地悪シナリオ R1-N4）: 途中で切れた JSON を返す相手に 1 ファイルの翻訳を
 *   当てると、失敗の通知「全文で訳し直す」→ 同じ失敗 → 同じ通知、という輪ができ、
 *   5 分で 116,838 回 AI を呼んだ。輪そのものは塞いだが、塞ぎ忘れた輪が次に現れても
 *   請求が膨らむ前に止まるように、ここへ最後の歯止めを置く。
 *
 *   見るのは2つだけ。どちらも**進んでいないのに呼び続けている**ことの印である。
 *     1. 同じ内容を送った回数（{@link MAX_SAME_REQUEST}）
 *     2. 続けて失敗した回数（{@link MAX_CONSECUTIVE_FAILURES}）
 *
 *   ふつうの仕事では、どちらも増えない。ユニットごとに送る内容は違うし、成功すれば
 *   2 は 0 に戻る。大きなフォルダをまとめて翻訳しても引っ掛からない。逆に、鍵が違う・
 *   モデル名が違う・相手が壊れた答えしか返さない、といった**何をしても進まない状態**では、
 *   数十回で打ち切る。
 *
 *   打ち切ったあとは、しばらく呼ばずにいれば（{@link QUIET_RESET_MS}）数え直す。設定を
 *   直してすぐ叩き直せる余地を残すためで、輪の側は間を置かずに回り続けるので戻らない。
 *   打ち切っても済んだ分は書かれているので、直して叩き直せば続きから進む。
 *
 * @module infra/llm/call-budget
 */
import * as vscode from "vscode";
import { isOperationCancelled } from "../errors/operation-cancelled";
import { Logger } from "../logging/logger";
import type { AIMessage, AIService } from "./ai-service";

/** 同じ内容を何回まで送ってよいか */
export const MAX_SAME_REQUEST = 200;

/** 続けて失敗した答えを何回まで受けてよいか */
export const MAX_CONSECUTIVE_FAILURES = 50;

/** 覚えておく「送った内容」の種類の上限。超えたら覚え直す（際限なく溜めない） */
export const MAX_TRACKED_REQUESTS = 5000;

/** これだけの時間まったく呼ばなければ、数えていたものを捨てる */
export const QUIET_RESET_MS = 10_000;

/** 送った内容ごとの回数 */
let sentCounts = new Map<number, number>();
/** 続けて失敗した回数 */
let consecutiveFailures = 0;
/** 最後に呼ぼうとした時刻（打ち切られた分も含む） */
let lastAttemptAt = 0;

/** 数えていたものを捨てる（テスト用。ふつうは間が空いたときに自動で捨てる） */
export function resetAiCallGuard(): void {
	sentCounts = new Map();
	consecutiveFailures = 0;
	lastAttemptAt = 0;
}

/** いまの数え（テスト・診断用） */
export function aiCallGuardState(): {
	consecutiveFailures: number;
	trackedRequests: number;
} {
	return { consecutiveFailures, trackedRequests: sentCounts.size };
}

/**
 * 打ち切りを表す例外。
 *
 * 利用者へそのまま出せる文を持つ（AI を呼ぶコマンドはどれも `error.message` を通知に
 * 載せるため。`providers/openai-provider.ts` の鍵未設定と同じ作法）。
 */
export class AiCallsStoppedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiCallsStoppedError";
	}
}

/** 打ち切りで止まった失敗か */
export function isAiCallsStopped(error: unknown): error is AiCallsStoppedError {
	return error instanceof AiCallsStoppedError;
}

/**
 * AIService を「歯止め付き」に包む。
 *
 * **包むのは `AIServiceBuilder.build` の 1 か所だけ。** 個々のプロバイダやコマンドに
 * 数える処理を置くと、経路が増えたときに必ず取りこぼす（それが今回の原因だった）。
 */
export function withAiCallGuard(service: AIService): AIService {
	return new GuardedAIService(service);
}

/**
 * 包む前の相手（プロバイダ）を取り出す。
 *
 * 「どのプロバイダが選ばれたか」を確かめたい場所のためのもの（設定のテスト・診断）。
 * 呼び出しには使わない — 包みを外して呼ぶと歯止めが効かなくなる。
 */
export function unwrapAiCallGuard(service: AIService): AIService {
	return service instanceof GuardedAIService ? service.provider : service;
}

/** 歯止めが付いているか */
export function hasAiCallGuard(service: AIService): boolean {
	return service instanceof GuardedAIService;
}

/** 送った内容を短い数字にする（同じ内容かどうかを見るためだけのもの。FNV-1a） */
function fingerprint(systemPrompt: string, messages: AIMessage[]): number {
	const text = `${systemPrompt} ${JSON.stringify(messages)}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	// 長さも混ぜて、たまたま同じ数字になる組を減らす
	return (hash ^ text.length) >>> 0;
}

class GuardedAIService implements AIService {
	constructor(readonly provider: AIService) {}

	async sendMessage(
		systemPrompt: string,
		messages: AIMessage[],
		cancellationToken?: vscode.CancellationToken,
	): Promise<string> {
		const now = Date.now();
		// 間が空いていたら数え直す。輪は間を置かずに回るので、ここでは戻らない
		if (lastAttemptAt !== 0 && now - lastAttemptAt > QUIET_RESET_MS) {
			resetAiCallGuard();
		}
		lastAttemptAt = now;

		if (sentCounts.size >= MAX_TRACKED_REQUESTS) sentCounts = new Map();
		const key = fingerprint(systemPrompt, messages);
		const sameRequestCount = (sentCounts.get(key) ?? 0) + 1;
		sentCounts.set(key, sameRequestCount);

		if (sameRequestCount > MAX_SAME_REQUEST || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			Logger.getInstance().error("llm", "Stopped calling the AI: no progress was being made", {
				sameRequestCount,
				sameRequestLimit: MAX_SAME_REQUEST,
				consecutiveFailures,
				consecutiveFailureLimit: MAX_CONSECUTIVE_FAILURES,
			});
			throw new AiCallsStoppedError(
				vscode.l10n.t(
					"Stopped calling the AI: it was being called over and over without getting anywhere, so mdait stopped instead of spending more. Check the API key, model name and output limit in mdait.json, then run it again - the parts already done are kept.",
				),
			);
		}

		try {
			const answer = await this.provider.sendMessage(systemPrompt, messages, cancellationToken);
			consecutiveFailures = 0;
			return answer;
		} catch (error) {
			// 人が止めたのは失敗ではない。数に入れると、止めたあとの実行が身に覚えのない
			// 打ち切りに当たる
			if (!isOperationCancelled(error)) {
				consecutiveFailures += 1;
			}
			lastAttemptAt = Date.now();
			throw error;
		}
	}
}
