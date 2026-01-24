// syncFrontmatterMarkersロジックのコアロジックのみをテストする
// vscodeモジュールを使わず、純粋な関数のテストとして実装

import { strict as assert } from "node:assert";
import { FrontMatter } from "../../../core/markdown/front-matter";
import {
	calculateFrontmatterHash,
	parseFrontmatterMarker,
	setFrontmatterMarker,
} from "../../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";

suite("Frontmatter同期ロジック（コアロジック）", () => {
	test("翻訳後に原文を変更した場合、need:reviseが設定されるべき", () => {
		const keys = ["title", "description"];

		// 1. 初回sync: source → target（need:translate）
		const sourceFrontMatter = FrontMatter.fromData({
			title: "Original Title",
			description: "Original description",
		});
		const sourceHash = calculateFrontmatterHash(sourceFrontMatter, keys);
		assert.ok(sourceHash, "sourceハッシュが計算されること");

		// source側にマーカーを設定
		const sourceMarker = new MdaitMarker(sourceHash);
		setFrontmatterMarker(sourceFrontMatter, sourceMarker);

		// target側にマーカーを設定
		const targetFrontMatter = sourceFrontMatter.clone();
		const targetHash = sourceHash;
		const targetMarker = new MdaitMarker(targetHash, sourceHash, "translate");
		setFrontmatterMarker(targetFrontMatter, targetMarker);

		// 2. 翻訳実行（シミュレート）
		targetFrontMatter.set("title", "翻訳されたタイトル");
		targetFrontMatter.set("description", "翻訳された説明");
		const newTargetHash = calculateFrontmatterHash(targetFrontMatter, keys, { allowEmpty: true });
		assert.ok(newTargetHash, "翻訳後のtargetハッシュが計算されること");

		targetMarker.hash = newTargetHash;
		targetMarker.removeNeedTag();
		setFrontmatterMarker(targetFrontMatter, targetMarker);

		// 3. 原文を変更
		sourceFrontMatter.set("title", "Updated Title");
		sourceFrontMatter.set("description", "Updated description");
		const updatedSourceHash = calculateFrontmatterHash(sourceFrontMatter, keys);
		assert.ok(updatedSourceHash, "更新後のsourceハッシュが計算されること");
		assert.notStrictEqual(updatedSourceHash, sourceHash, "sourceハッシュが変更されていること");

		// 4. 再sync時のロジック（syncFrontmatterMarkersの動作をシミュレート）
		const existingTargetMarker = parseFrontmatterMarker(targetFrontMatter);
		assert.ok(existingTargetMarker, "既存のtargetマーカーが存在すること");

		const isSourceChanged = existingTargetMarker.from !== updatedSourceHash;
		const currentTargetHash = calculateFrontmatterHash(targetFrontMatter, keys, { allowEmpty: true });
		const isTargetChanged = existingTargetMarker.hash !== currentTargetHash;

		// 検証ポイント: sourceが変更され、targetが変更されていない場合
		assert.strictEqual(isSourceChanged, true, "sourceが変更されたと判定されること");
		assert.strictEqual(isTargetChanged, false, "targetは変更されていないと判定されること");

		// need:reviseの設定ロジック
		if (isSourceChanged && !isTargetChanged) {
			const oldSourceHash = existingTargetMarker.from;
			existingTargetMarker.from = updatedSourceHash;
			if (oldSourceHash) {
				existingTargetMarker.setReviseNeed(oldSourceHash);
			} else {
				existingTargetMarker.setNeed("translate");
			}
		}

		// 検証: need:revise@{oldhash}が設定されていること
		assert.ok(existingTargetMarker.need, "needフラグが設定されていること");
		assert.ok(existingTargetMarker.need.startsWith("revise@"), "need:revise形式であること");
		assert.strictEqual(existingTargetMarker.getOldHashFromNeed(), sourceHash, "oldhashが正しく設定されていること");
	});

	test("mdait.frontマーカーが引用符で囲われて出力されること", () => {
		const frontMatter = FrontMatter.fromData({
			title: "Test",
			description: "Test description",
		});

		const marker = new MdaitMarker("abc123", "def456", "translate");
		setFrontmatterMarker(frontMatter, marker);

		const raw = frontMatter.stringify();
		console.log("Frontmatter output:\n", raw);

		// mdait.frontの値が引用符で囲われているか確認
		const lines = raw.split("\n");
		const mdaitLine = lines.find((line) => line.trim().startsWith("mdait.front:"));
		assert.ok(mdaitLine, "mdait.front行が存在すること");

		// 引用符で囲われているかチェック（YAMLの仕様上、スペースを含む値は引用符が必要）
		const hasQuotes = mdaitLine.includes('"') || mdaitLine.includes("'");
		assert.ok(hasQuotes, `mdait.frontの値が引用符で囲われていること: ${mdaitLine}`);
	});
});
