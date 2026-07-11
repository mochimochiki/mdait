import * as assert from "node:assert";
import { buildNextActions } from "../../../lm-tools/next-actions";
import type { NeedBreakdown } from "../../../lm-tools/status-data";

function needs(overrides: Partial<NeedBreakdown> = {}): NeedBreakdown {
	return {
		translate: 0,
		revise: 0,
		review: 0,
		verifyDeletion: 0,
		isolate: 0,
		other: 0,
		...overrides,
	};
}

suite("buildNextActions（状態→推奨アクション対応表）", () => {
	test("need:translateが残っていればmdait_translateを提案する", () => {
		const actions = buildNextActions(needs({ translate: 3 }));
		assert.ok(actions.some((a) => a.includes("mdait_translate")));
	});

	test("need:reviseが残っていればmdait_translateを提案する", () => {
		const actions = buildNextActions(needs({ revise: 2 }));
		assert.ok(actions.some((a) => a.includes("mdait_translate")));
	});

	test("need:reviewが残っていればレビュー解消を提案する", () => {
		const actions = buildNextActions(needs({ review: 1 }));
		assert.ok(actions.some((a) => a.includes("need:review")));
	});

	test("need:verify-deletionが残っていれば削除確認を提案する", () => {
		const actions = buildNextActions(needs({ verifyDeletion: 1 }));
		assert.ok(actions.some((a) => a.includes("need:verify-deletion")));
	});

	test("エラーユニットがあれば診断を提案する", () => {
		const actions = buildNextActions(needs(), 2);
		assert.ok(actions.some((a) => a.includes("error state")));
	});

	test("needもエラーもなければ定常状態の案内を返す（提案が空にならない）", () => {
		const actions = buildNextActions(needs());
		assert.strictEqual(actions.length, 1);
		assert.ok(actions[0].includes("All units are translated"));
	});

	test("isolateのみのユニットは定常状態とみなす（アクションなし）", () => {
		const actions = buildNextActions(needs({ isolate: 5 }));
		assert.ok(actions[0].includes("All units are translated"));
	});
});
