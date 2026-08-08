import * as assert from "node:assert";
import { type OrphanTargetProbe, isOrphanTarget } from "../../../../core/unit-state/orphan-target";

/**
 * 実在するファイルの集合と、訳文→原文の対応表からテスト用の probe を作る。
 * 対応表に無いパスは「訳文ではない」（原文側・管理対象外）を表す。
 */
function probeOf(existing: string[], mapping: Record<string, string>): OrphanTargetProbe {
	const present = new Set(existing);
	return {
		deriveSourcePath: (targetPath) => mapping[targetPath] ?? null,
		exists: (filePath) => present.has(filePath),
	};
}

suite("孤立訳文の判定", () => {
	test("訳文が実在し、導出した原文が実在しなければ孤立とみなすこと", () => {
		const probe = probeOf(["en/guide.md"], { "en/guide.md": "ja/guide.md" });
		assert.strictEqual(isOrphanTarget("en/guide.md", probe), true);
	});

	test("導出した原文が実在すれば孤立ではないこと", () => {
		const probe = probeOf(["en/guide.md", "ja/guide.md"], { "en/guide.md": "ja/guide.md" });
		assert.strictEqual(isOrphanTarget("en/guide.md", probe), false);
	});

	test("訳文の実体が無ければ孤立ではないこと（見せる相手がいないため）", () => {
		const probe = probeOf([], { "en/guide.md": "ja/guide.md" });
		assert.strictEqual(isOrphanTarget("en/guide.md", probe), false);
	});

	test("どの訳文ディレクトリの配下でもなければ孤立ではないこと（原文側・管理対象外）", () => {
		const probe = probeOf(["ja/guide.md"], {});
		assert.strictEqual(isOrphanTarget("ja/guide.md", probe), false);
	});

	test("そのファイル自身が別ペアの原文なら孤立としないこと（ja→en, en→fr のピボット構成）", () => {
		// `ja` を消すと `en/x.md` は「原文の無い訳文」に見えるが、それは `fr` の現役の原文。
		// 破棄を勧めれば `fr/x.md` を新たに孤立させることになる。
		// probe 側が「原文でもあるパス」に null を返す契約になっている（orphan-probe.ts）
		const probe = probeOf(["en/guide.md", "fr/guide.md"], {});
		assert.strictEqual(isOrphanTarget("en/guide.md", probe), false);
	});

	test("原文が戻れば孤立でなくなること（記録を持たないので状態が残らない）", () => {
		const present = new Set(["en/guide.md"]);
		const probe: OrphanTargetProbe = {
			deriveSourcePath: () => "ja/guide.md",
			exists: (filePath) => present.has(filePath),
		};
		assert.strictEqual(isOrphanTarget("en/guide.md", probe), true);
		present.add("ja/guide.md");
		assert.strictEqual(isOrphanTarget("en/guide.md", probe), false, "再計算するだけで孤立が解消すること");
	});
});
