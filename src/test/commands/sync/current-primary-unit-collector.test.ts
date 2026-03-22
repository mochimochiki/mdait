import * as assert from "node:assert";
import {
	collectCurrentPrimaryUnits,
	collectPrimarySourceFilePathsForCleanup,
} from "../../../commands/sync/current-primary-unit-collector";
import type { TransPair } from "../../../config/configuration";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../core/markdown/mdait-unit";

suite("collectCurrentPrimaryUnits", () => {
	test("marker hash を持つユニットだけを収集する", () => {
		const units = [
			new MdaitUnit(new MdaitMarker("hash-1"), "Title 1", 1, "First content"),
			new MdaitUnit(new MdaitMarker(""), "Title 2", 1, "Second content"),
			new MdaitUnit(new MdaitMarker("hash-3"), "Title 3", 1, "Third content"),
		];

		const result = collectCurrentPrimaryUnits(units, "docs/source.md");

		assert.deepStrictEqual(result, [
			{
				unitPath: "docs/source.md",
				unitHash: "hash-1",
				content: "First content",
			},
			{
				unitPath: "docs/source.md",
				unitHash: "hash-3",
				content: "Third content",
			},
		]);
	});

	test("primaryLang が target 側の pair では cleanup 入力元を収集しない", () => {
		const pair: TransPair = {
			sourceDir: "docs/ja",
			targetDir: "docs/en",
			sourceLang: "ja",
			targetLang: "en",
		};

		const result = collectPrimarySourceFilePathsForCleanup(
			["c:/repo/docs/ja/guide.md"],
			pair,
			"en",
			new Set(),
		);

		assert.deepStrictEqual(result, []);
	});

	test("primaryLang が source 側の pair では未収集の source path だけを返す", () => {
		const pair: TransPair = {
			sourceDir: "docs/en",
			targetDir: "docs/ja",
			sourceLang: "en",
			targetLang: "ja",
		};

		const result = collectPrimarySourceFilePathsForCleanup(
			["c:/repo/docs/en/guide.md", "c:/repo/docs/en/api.md"],
			pair,
			"en",
			new Set(["c:/repo/docs/en/guide.md"]),
		);

		assert.deepStrictEqual(result, ["c:/repo/docs/en/api.md"]);
	});
});
