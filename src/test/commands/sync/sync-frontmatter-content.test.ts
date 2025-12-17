// テストガイドラインに従いテスト実装します。
// syncコマンド実行時にフロントマター直後の本文が保持されることを確認するテスト

import { strict as assert } from "node:assert";
import { markdownParser } from "../../../core/markdown/parser";
import { SectionMatcher } from "../../../commands/sync/section-matcher";
import { calculateHash } from "../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import type { MdaitUnit } from "../../../core/markdown/mdait-unit";

// sync-command.tsのensureMdaitMarkerHashと同じ処理
function ensureMdaitMarkerHash(units: MdaitUnit[]) {
	for (const unit of units) {
		if (!unit.marker || !unit.marker.hash) {
			const hash = calculateHash(unit.content);
			unit.marker = new MdaitMarker(hash);
		}
	}
}

const testConfig = { sync: { autoMarkerLevel: 2 } } as unknown as import("../../../config/configuration").Configuration;

suite("Sync処理（フロントマター後の本文）", () => {
	test("初回sync時にフロントマター直後の本文が保持されること", () => {
		// ソースファイル: フロントマター + 本文 + 見出し
		const sourceMd = `---
title: Test Document
---

これはフロントマター直後の本文です。

この内容は保持されるべきです。

## 見出し1

見出し1の本文
`;

		const source = markdownParser.parse(sourceMd, testConfig);
		
		// 初回syncなのでtargetは存在しない想定
		assert.strictEqual(source.units.length, 2);
		assert.match(source.units[0].content, /これはフロントマター直後の本文です/);
		assert.match(source.units[1].content, /## 見出し1/);
	});

	test("既存targetファイルとのsync時にフロントマター直後の本文がマッチすること", () => {
		// ソースファイル
		const sourceMd = `---
title: Test Document
---

フロントマター直後の本文です。

## 見出し1

見出し1の本文
`;

		// ターゲットファイル（既に翻訳済み）
		const targetMd = `---
title: Test Document
---

<!-- mdait ${calculateHash("\nフロントマター直後の本文です。\n")} from:${calculateHash("\nフロントマター直後の本文です。\n")} -->

Content right after frontmatter.

<!-- mdait ${calculateHash("## 見出し1\n\n見出し1の本文\n")} from:${calculateHash("## 見出し1\n\n見出し1の本文\n")} -->
## Heading 1

Content of heading 1
`;

		const source = markdownParser.parse(sourceMd, testConfig);
		const target = markdownParser.parse(targetMd, testConfig);
		
		// sync-command.tsと同様にハッシュを付与
		ensureMdaitMarkerHash(source.units);
		ensureMdaitMarkerHash(target.units);

		const matcher = new SectionMatcher();
		const matchResult = matcher.match(source.units, target.units);

		// 2つのユニットがそれぞれマッチすること
		assert.strictEqual(matchResult.length, 2);
		assert.ok(matchResult[0].source);
		assert.ok(matchResult[0].target);
		assert.ok(matchResult[1].source);
		assert.ok(matchResult[1].target);
	});

	test("source側で本文が追加された場合、target側でも新規ユニットとして追加されること", () => {
		// 元のソース（見出しのみ）
		const originalSourceMd = `---
title: Test Document
---

## 見出し1

見出し1の本文
`;

		// 更新後のソース（本文を追加）
		const updatedSourceMd = `---
title: Test Document
---

新しく追加された本文です。

## 見出し1

見出し1の本文
`;

		// ターゲット（元のソースに対応）
		const targetMd = `---
title: Test Document
---

<!-- mdait ${calculateHash("## 見出し1\n\n見出し1の本文\n")} from:${calculateHash("## 見出し1\n\n見出し1の本文\n")} -->
## Heading 1

Content of heading 1
`;

		const updatedSource = markdownParser.parse(updatedSourceMd, testConfig);
		const target = markdownParser.parse(targetMd, testConfig);
		
		// sync-command.tsと同様にハッシュを付与
		ensureMdaitMarkerHash(updatedSource.units);
		ensureMdaitMarkerHash(target.units);

		const matcher = new SectionMatcher();
		const matchResult = matcher.match(updatedSource.units, target.units);

		// 新規ユニット + 既存ユニット = 2つのペア
		assert.strictEqual(matchResult.length, 2);
		
		// 最初のペアは新規追加（sourceのみ）
		assert.ok(matchResult[0].source);
		assert.strictEqual(matchResult[0].target, null);
		assert.match(matchResult[0].source.content, /新しく追加された本文です/);
		
		// 2番目のペアは既存マッチ
		assert.ok(matchResult[1].source);
		assert.ok(matchResult[1].target);
	});
});
