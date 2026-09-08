import { strict as assert } from "node:assert";
import { removeConfigValue, setConfigValue } from "../../../../infra/config/config-json-editor";

/** 人が手で書いた形（インライン配列・インラインオブジェクト混じり） */
const HANDWRITTEN = `{
  "transPairs": [
    { "sourceLang": "ja", "sourceDir": "docs/ja", "targetLang": "en", "targetDir": "docs/en" },
    { "sourceLang": "ja", "sourceDir": "docs/ja", "targetLang": "fr", "targetDir": "docs/fr" }
  ],
  "primaryLang": "en",
  "trans": { "frontmatter": { "keys": ["title", "description"] } },
  "ignoredPatterns": ["**/node_modules/**", "**/.git/**"],
  "sync": {
    "level": 3,
    "autoDelete": true
  }
}
`;

/** 2つのテキストで、どちらか片方にしか無い行の数（＝git が差分として出す行数の目安） */
function changedLineCount(before: string, after: string): number {
	const remaining = new Map<string, number>();
	for (const line of before.split("\n")) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1);
	}
	let added = 0;
	for (const line of after.split("\n")) {
		const count = remaining.get(line) ?? 0;
		if (count > 0) {
			remaining.set(line, count - 1);
		} else {
			added++;
		}
	}
	let removed = 0;
	for (const count of remaining.values()) {
		removed += count;
	}
	return added + removed;
}

/**
 * mdait.json の書き換えが、触ったキーの行だけに収まること。
 *
 * 組み直し（`JSON.stringify`）で書き戻していた頃は、1項目の変更でインライン配列が展開され、
 * **15行の設定が57行に膨らみ、git の差分が 52 追加 / 10 削除**になった（実測）。設定ファイルは
 * git 管理下にあるので、その差分はそのまま他人の変更とぶつかる（docs/design/merge-resilience.md）。
 */
suite("config-json-editor: 書き換えを触ったキーだけに収める", () => {
	test("値の差し替えで動くのはその1行だけ", () => {
		const updated = setConfigValue(HANDWRITTEN, ["sync", "level"], 2);
		assert.equal(changedLineCount(HANDWRITTEN, updated), 2, "1行の書き換え（-1 +1）に収まっていない");
		assert.equal(JSON.parse(updated).sync.level, 2);
	});

	test("インライン配列は、他のキーを変えても展開されない", () => {
		const updated = setConfigValue(HANDWRITTEN, ["primaryLang"], "ja");
		assert.ok(
			updated.includes('"ignoredPatterns": ["**/node_modules/**", "**/.git/**"]'),
			"無関係なインライン配列が展開された",
		);
		assert.ok(
			updated.includes('"trans": { "frontmatter": { "keys": ["title", "description"] } }'),
			"無関係なインラインオブジェクトが展開された",
		);
	});

	test("インライン配列そのものを差し替えても1行のまま", () => {
		const updated = setConfigValue(HANDWRITTEN, ["ignoredPatterns"], ["**/dist/**"]);
		assert.ok(updated.includes('"ignoredPatterns": ["**/dist/**"]'), "1行に収まっていない");
		assert.equal(changedLineCount(HANDWRITTEN, updated), 2);
	});

	test("入れ子の奥のキーを差し替えても、その1行だけが動く", () => {
		const updated = setConfigValue(HANDWRITTEN, ["trans", "frontmatter", "keys"], ["title"]);
		assert.equal(changedLineCount(HANDWRITTEN, updated), 2);
		assert.deepEqual(JSON.parse(updated).trans.frontmatter.keys, ["title"]);
	});

	test("新しいキーの追加は、末尾に足すぶんだけが動く", () => {
		const updated = setConfigValue(HANDWRITTEN, ["markers", "mode"], "external");
		assert.equal(JSON.parse(updated).markers.mode, "external");
		// 足した2行と、閉じ括弧に `,` が付いた1行だけ
		assert.equal(changedLineCount(HANDWRITTEN, updated), 3, "追加なのに無関係な行まで動いた");
		assert.ok(updated.includes('"ignoredPatterns": ["**/node_modules/**", "**/.git/**"]'));
	});

	test("キーの削除でも、他の行は1バイトも動かない", () => {
		const updated = removeConfigValue(HANDWRITTEN, ["sync", "autoDelete"]);
		assert.equal(JSON.parse(updated).sync.autoDelete, undefined);
		assert.equal(JSON.parse(updated).sync.level, 3);
		assert.ok(updated.includes('"trans": { "frontmatter": { "keys": ["title", "description"] } }'));
	});

	test("最後のキーを削除すると、親ごと畳まれる（値だけが残らない）", () => {
		const updated = removeConfigValue(HANDWRITTEN, ["trans", "frontmatter", "keys"]);
		assert.equal(JSON.parse(updated).trans, undefined);
		assert.ok(!updated.includes('"trans"'), "空になった親が残っている");
		assert.ok(updated.includes('"ignoredPatterns": ["**/node_modules/**", "**/.git/**"]'));
	});

	test("先頭のキーを削除しても JSON として壊れない", () => {
		const updated = removeConfigValue(HANDWRITTEN, ["transPairs"]);
		const parsed = JSON.parse(updated);
		assert.equal(parsed.transPairs, undefined);
		assert.equal(parsed.primaryLang, "en");
	});

	test("唯一のキーを削除すると空のオブジェクトになる", () => {
		const updated = removeConfigValue('{\n  "primaryLang": "en"\n}\n', ["primaryLang"]);
		assert.deepEqual(JSON.parse(updated), {});
	});

	test("1行で書かれた設定に足しても1行のまま", () => {
		const updated = setConfigValue('{ "primaryLang": "en" }\n', ["sync", "level"], 3);
		assert.equal(updated.split("\n").length, 2, "1行のはずが行が増えた");
		assert.deepEqual(JSON.parse(updated), { primaryLang: "en", sync: { level: 3 } });
	});

	test("CRLF の設定に新しいキーを足しても LF が混ざらない", () => {
		const original = '{\r\n  "primaryLang": "en"\r\n}\r\n';
		const updated = setConfigValue(original, ["markers", "mode"], "external");
		assert.ok(!/[^\r]\n/.test(updated), "LF だけの行が混ざっている");
		assert.equal(JSON.parse(updated).markers.mode, "external");
	});

	test("途中のキーがオブジェクトでなければ、組み直しへ落ちて正しい JSON を書く", () => {
		const original = '{\n  "sync": 3\n}\n';
		const updated = setConfigValue(original, ["sync", "level"], 2);
		assert.deepEqual(JSON.parse(updated), { sync: { level: 2 } });
	});
});
