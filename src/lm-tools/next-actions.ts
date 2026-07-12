/**
 * @file next-actions.ts
 * @description
 *   状態カウント → 推奨次アクションの対応表。
 *   エンベロープの `nextActions` に入れる英語固定文言（エージェント向け語彙）を生成する。
 *   ビジネスロジックではなく案内文の生成であり、lm-tools 層に閉じる
 *   （薄いラッパー原則の明示的例外。docs/design/agent-orchestration.md 参照）。
 *   提案するツールは登録済みのものに限る。VS Code API 非依存。
 * @module lm-tools/next-actions
 */
import type { NeedBreakdown } from "./status-data";

/**
 * 現在の need 内訳から推奨アクションを生成する。
 * @param needs need 内訳
 * @param errorUnits エラーユニット数
 */
export function buildNextActions(needs: NeedBreakdown, errorUnits = 0): string[] {
	const actions: string[] = [];

	if (needs.translate > 0 || needs.revise > 0) {
		actions.push(
			`Run mdait_translate to translate ${needs.translate} unit(s) flagged need:translate and revise ${needs.revise} unit(s) flagged need:revise.`,
		);
	}
	if (needs.review > 0) {
		actions.push(
			`${needs.review} unit(s) are flagged need:review. Review the translated content; if acceptable, run mdait_resolve to remove the need flags (or ask the user to approve), then run mdait_sync.`,
		);
	}
	if (needs.verifyDeletion > 0) {
		actions.push(
			`${needs.verifyDeletion} unit(s) are flagged need:verify-deletion (their source unit was deleted). Verify each target unit: delete the unit's section from the document to accept the deletion, or run mdait_resolve to remove the flag and keep the unit.`,
		);
	}
	if (errorUnits > 0) {
		actions.push(
			`${errorUnits} unit(s) are in error state. Inspect the error details via mdait_getStatus (detail:true) and retry mdait_translate after fixing the cause.`,
		);
	}
	if (actions.length === 0) {
		actions.push(
			"All units are translated. Run mdait_sync after any source edits to keep markers up to date.",
		);
	}
	return actions;
}
