// テストガイドラインに従いテスト実装します。
// syncコマンド実行時にsource側とtarget側の両方にmdait.frontマーカーが付与されることを確認するテスト

import { strict as assert } from "node:assert";
import { syncFrontmatterMarkers } from "../../../commands/sync/sync-command";
import type { Configuration } from "../../../config/configuration";
import { FrontMatter } from "../../../core/markdown/front-matter";
import {
	calculateFrontmatterHash,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { markdownParser } from "../../../core/markdown/parser";

const testConfig = {
	sync: { level: 2 },
	trans: {
		frontmatter: {
			keys: ["title", "description"],
		},
	},
} as unknown as Configuration;

suite("Sync処理（frontmatterマーカー付与）", () => {
	test("新規sync時にsource側にもmdait.frontマーカーが付与されること", () => {
		// Source側のfrontmatterを作成（マーカーなし）
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Test Document",
			description: "This is a test",
		});

		// syncFrontmatterMarkersを実行
		const result = syncFrontmatterMarkers(sourceFrontMatter, undefined, ["title", "description"]);

		// Source側にマーカーが付与されていることを確認
		assert.ok(result.processed, "frontmatter同期が処理されること");
		assert.ok(result.sourceFrontMatter, "source側のfrontmatterが存在すること");

		const sourceMarker = parseFrontmatterMarker(result.sourceFrontMatter);
		assert.ok(sourceMarker, "source側にmdait.frontマーカーが付与されていること");
		assert.ok(sourceMarker.hash, "sourceマーカーにhashが存在すること");
		assert.strictEqual(sourceMarker.from, null, "sourceマーカーにfromは存在しないこと");
		assert.strictEqual(sourceMarker.need, null, "sourceマーカーにneedは存在しないこと");

		// Target側にもマーカーが付与されていることを確認
		assert.ok(result.targetFrontMatter, "target側のfrontmatterが存在すること");
		const targetMarker = parseFrontmatterMarker(result.targetFrontMatter);
		assert.ok(targetMarker, "target側にmdait.frontマーカーが付与されていること");
		assert.ok(targetMarker.from, "targetマーカーにfromが存在すること");
		assert.strictEqual(targetMarker.need, "translate", "targetマーカーにneed:translateが設定されていること");
	});

	test("既存sync時にsource側ハッシュが更新され、target側にneed:reviseが設定されること", () => {
		const keys = ["title", "description"];

		// 既存のマーカー付きSource frontmatter
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Updated Title",
			description: "Updated description",
		});
		const oldSourceMarker = new MdaitMarker("oldhash");
		setFrontmatterMarker(sourceFrontMatter, oldSourceMarker);

		// 既存のTarget frontmatter（翻訳済み）
		const targetFrontMatter = FrontMatter.fromData({
			title: "翻訳済みタイトル",
			description: "翻訳済み説明",
		});

		// targetHashを事前に計算してマーカーに設定（targetは変更されていない状態をシミュレート）
		const targetHash = calculateFrontmatterHash(targetFrontMatter, keys, { allowEmpty: true });
		assert.ok(targetHash, "targetのハッシュが計算できること");

		// targetマーカー: hash=targetHash（現在のtargetと一致）、from=oldhash（古いsourceハッシュ）
		const oldTargetMarker = new MdaitMarker(targetHash, "oldhash");
		setFrontmatterMarker(targetFrontMatter, oldTargetMarker);

		// 事前検証: targetマーカーのfromが正しく設定されているか
		const targetMarkerBefore = parseFrontmatterMarker(targetFrontMatter);
		assert.ok(targetMarkerBefore, "target側のマーカーが事前に存在すること");
		assert.strictEqual(targetMarkerBefore.from, "oldhash", "targetマーカーのfromがoldhashであること");

		// syncFrontmatterMarkersを実行
		const result = syncFrontmatterMarkers(sourceFrontMatter, targetFrontMatter, keys);

		assert.ok(result.processed, "frontmatter同期が処理されること");
		assert.ok(result.sourceFrontMatter, "source側のfrontmatterが存在すること");
		assert.ok(result.targetFrontMatter, "target側のfrontmatterが存在すること");

		// Source側のハッシュが更新されていることを確認
		const sourceMarker = parseFrontmatterMarker(result.sourceFrontMatter);
		assert.ok(sourceMarker, "source側にマーカーが存在すること");
		const newSourceHash = sourceMarker.hash;
		assert.notStrictEqual(newSourceHash, "oldhash", "sourceハッシュが更新されていること");

		// Target側の検証
		const targetMarker = parseFrontmatterMarker(result.targetFrontMatter);
		assert.ok(targetMarker, `target側にマーカーが存在すること (raw: ${result.targetFrontMatter?.get("mdait.front")})`);

		// fromが新しいsourceHashに更新されているはず
		assert.strictEqual(targetMarker.from, newSourceHash, `targetのfromが新sourceHashに更新されていること`);

		// needにrevise@oldhashが設定されているはず
		assert.ok(
			targetMarker.need,
			`targetにneedフラグが設定されていること (from: ${targetMarker.from}, hash: ${targetMarker.hash}, need: ${targetMarker.need})`,
		);
		assert.ok(targetMarker.need.startsWith("revise@"), `needがrevise@形式であること (actual: ${targetMarker.need})`);
	});

	test("既存マーカーの読み込みと維持ができること", () => {
		const targetMd = `---
title: Test Document
description: This is a test
mdait.front: abc123 from:def456 need:translate
---

## Heading 1

Content of heading 1
`;

		const target = markdownParser.parse(targetMd, testConfig);
		assert.ok(target.frontMatter);

		const targetMarker = parseFrontmatterMarker(target.frontMatter);
		assert.ok(targetMarker);
		assert.strictEqual(targetMarker.hash, "abc123");
		assert.strictEqual(targetMarker.from, "def456");
		assert.strictEqual(targetMarker.need, "translate");
	});

	test("翻訳対象キーが空の場合はfrontmatter同期がスキップされること", () => {
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Test Document",
		});

		const result = syncFrontmatterMarkers(sourceFrontMatter, undefined, []);

		assert.strictEqual(result.processed, false, "空のキーリストでは処理されないこと");
	});
});
