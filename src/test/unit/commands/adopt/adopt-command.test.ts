import * as assert from "node:assert";
import { buildAdoptConfirmDetail, buildAdoptStepList } from "../../../../commands/adopt/adopt-command";

suite("buildAdoptConfirmDetail", () => {
	test("実行段を1行1項目の「• 」付き箇条書きで列挙すること", () => {
		const steps = buildAdoptStepList({ buildGlossary: true, buildTm: true }, true);
		const detail = buildAdoptConfirmDetail(steps, true);
		const lines = detail.split("\n");
		for (const [index, step] of steps.entries()) {
			assert.strictEqual(lines[index], `• ${step}`);
		}
	});

	test("末尾にマーカー更新の説明とgit推奨を1行ずつ出すこと", () => {
		const steps = buildAdoptStepList({ buildGlossary: false, buildTm: false }, false);
		const detail = buildAdoptConfirmDetail(steps, false);
		const lines = detail.split("\n");
		assert.strictEqual(lines[steps.length], "");
		assert.strictEqual(lines[steps.length + 1], "This updates translation markers.");
		assert.strictEqual(lines[steps.length + 2], "Committing your workspace to git beforehand is recommended.");
	});

	test("用語集/TM構築ありのときはマーカー更新の行に書き込み先を追記すること", () => {
		const steps = buildAdoptStepList({ buildGlossary: true, buildTm: false }, false);
		const detail = buildAdoptConfirmDetail(steps, true);
		assert.ok(detail.includes("This updates translation markers and writes to the glossary/TM."));
	});
});
