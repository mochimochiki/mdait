import * as assert from "node:assert";
import { buildTmCommitUnitResolution, prepareTmCommitUnit } from "../../../commands/tm/command-commit";
import type { TmCommitResolvedUnit } from "../../../commands/tm/commit-processor";
import type { MdaitUnit } from "../../../core/markdown/mdait-unit";

function createUnit(overrides?: Partial<TmCommitResolvedUnit>): TmCommitResolvedUnit {
	return {
		content: overrides?.content ?? "content",
		lang: overrides?.lang ?? "ja",
		unitPath: overrides?.unitPath ?? "docs/guide.ja.md",
		unitHash: overrides?.unitHash ?? "hash-ja-1",
	};
}

suite("buildTmCommitUnitResolution", () => {
	test("非 primary pair から primaryUnit を遡及解決できる", async () => {
		const currentUnit = createUnit({ lang: "zh-hans", unitPath: "docs/guide.zh.md", unitHash: "hash-zh-1" });
		const sourceUnit = createUnit({ lang: "ja", unitPath: "docs/guide.ja.md", unitHash: "hash-ja-1" });
		const primaryAncestor = createUnit({ lang: "en", unitPath: "docs/guide.md", unitHash: "hash-en-1" });

		const result = await buildTmCommitUnitResolution(currentUnit, sourceUnit, "en", async (unit) => {
			if (unit.unitHash === "hash-zh-1" || unit.unitHash === "hash-ja-1") {
				return primaryAncestor;
			}
			return null;
		});

		assert.ok(result);
		assert.strictEqual(result?.primaryUnit.unitHash, "hash-en-1");
		assert.strictEqual(result?.localUnit.unitHash, "hash-zh-1");
	});

	test("lineage 不一致時は null を返す", async () => {
		const currentUnit = createUnit({ lang: "zh-hans", unitHash: "hash-zh-1" });
		const sourceUnit = createUnit({ lang: "ja", unitHash: "hash-ja-1" });

		const result = await buildTmCommitUnitResolution(currentUnit, sourceUnit, "en", async (unit) => {
			if (unit.unitHash === "hash-zh-1") {
				return createUnit({ lang: "en", unitPath: "docs/a.md", unitHash: "hash-en-a" });
			}
			return createUnit({ lang: "en", unitPath: "docs/b.md", unitHash: "hash-en-b" });
		});

		assert.strictEqual(result, null);
	});

	test("prepareTmCommitUnit は marker.hash の有無に関係なく lineage 解決を実行する", async () => {
		let resolveCallCount = 0;
		const resolvedUnit = {
			primaryUnit: createUnit({ lang: "en", unitPath: "docs/guide.md", unitHash: "hash-en-1" }),
			localUnit: createUnit(),
		};
		const prepared = await prepareTmCommitUnit(
			{ marker: { hash: "already-committed" } } as Pick<MdaitUnit, "marker">,
			async () => {
				resolveCallCount++;
				return resolvedUnit;
			},
		);

		assert.strictEqual(prepared.shouldSkip, false);
		assert.ok(prepared.resolution);
		assert.strictEqual(resolveCallCount, 1);
	});
});
