/**
 * frontmatter マーカーがモードの往復で失われないことのテスト（roadmap-v01 の P05）。
 *
 * frontmatter マーカーは長らく「YAML キーなので HTML コメントの変換対象ではない」として
 * 移行の経路から外れていた。外部化するとファイル側に痕跡が1つも残らなくなるため、
 * 運ばないと embedded へ戻したときに翻訳の状態（まだ確認していない、という事実）が消える。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { embedFileMarkers, externalizeFileMarkers, reconcileMarkerModeForFile } from "../../../../commands/markers/markers-migration";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../../../core/markdown/marker-provider";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import type { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

function makeConfig(mode: "embedded" | "external"): Configuration {
	return {
		sync: { level: 2 },
		isExternalMarkers: () => mode === "external",
		getMarkerProvider: () => (mode === "external" ? externalMarkerProvider : embeddedMarkerProvider),
	} as unknown as Configuration;
}

/** frontmatter マーカーを持つ embedded の訳文 */
const EMBEDDED_DOC = [
	"---",
	"title: Guide",
	"draft: false",
	"mdait:",
	"  front: 2a51183a from:6ba728ae need:review",
	"---",
	"",
	"# Guide",
	"",
	"Intro body.",
	"",
].join("\n");

suite("frontmatter マーカーはモードの往復で失われない", () => {
	let tempDir: string;
	let absPath: string;
	let relPath: string;
	let store: UnitStateStore;

	setup(() => {
		UnitStateStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-front-mig-"));
		__vscodeMockWorkspaceRoot = tempDir;
		fs.mkdirSync(path.join(tempDir, "en"), { recursive: true });
		absPath = path.join(tempDir, "en", "guide.md");
		relPath = "en/guide.md";
		store = UnitStateStore.getInstance();
		store.load(tempDir);
	});

	teardown(() => {
		UnitStateStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("externalize でファイルからマーカーが消え、行に移ること", () => {
		fs.writeFileSync(absPath, EMBEDDED_DOC, "utf-8");

		externalizeFileMarkers(absPath, "target", makeConfig("external"));

		assert.ok(!fs.readFileSync(absPath, "utf-8").includes("front:"), "ファイルから frontmatter マーカーが消えること");
		const entry = store.getFrontMatterEntry(relPath);
		assert.ok(entry, "frontmatter の行ができていること");
		assert.strictEqual(entry?.hash, "2a51183a");
		assert.strictEqual(entry?.from, "6ba728ae");
		assert.strictEqual(entry?.need, "review", "確認待ちであることが保たれること");
	});

	test("externalize で frontmatter の他のキーが1バイトも動かないこと", () => {
		fs.writeFileSync(absPath, EMBEDDED_DOC, "utf-8");

		externalizeFileMarkers(absPath, "target", makeConfig("external"));

		const after = fs.readFileSync(absPath, "utf-8");
		assert.ok(after.startsWith("---\ntitle: Guide\ndraft: false\n---\n"), `他のキーの書式が保たれること: ${JSON.stringify(after.slice(0, 60))}`);
	});

	test("embed でマーカーがファイルへ戻り、行が消えること（往復で無損失）", () => {
		fs.writeFileSync(absPath, EMBEDDED_DOC, "utf-8");
		externalizeFileMarkers(absPath, "target", makeConfig("external"));

		embedFileMarkers(absPath, "target", makeConfig("embedded"), store);

		const after = fs.readFileSync(absPath, "utf-8");
		// `:` を含む値は YAML の作法でクォートされる
		assert.match(after, /front: '?2a51183a from:6ba728ae need:review'?/, "確認待ちのままファイルへ戻ること");
		assert.strictEqual(store.getFrontMatterEntry(relPath), undefined, "戻したら行は残さないこと");
	});

	test("frontmatter を持たないファイルへは書き戻さず、行を残すこと", () => {
		fs.writeFileSync(absPath, ["# Guide", "", "Intro body.", ""].join("\n"), "utf-8");
		store.setFrontMatterEntry(relPath, { hash: "2a51183a", from: "6ba728ae", need: "review" });

		embedFileMarkers(absPath, "target", makeConfig("embedded"), store);

		assert.ok(store.getFrontMatterEntry(relPath), "書き戻す先が無いなら行を消さないこと（消す側の失敗は取り返しがつかない）");
	});

	test("mdait.sync.level だけを持つファイルは自己修復が触らないこと", () => {
		// `mdait:` の字面だけで先へ進めると、見出しレベルを指定しただけのファイルが
		// 毎 sync で markdown-it の全解析に入る。frontmatter マーカーは必ず `front:` を伴う
		const doc = ["---", "title: Guide", "mdait:", "  sync:", "    level: 2", "---", "", "# Guide", "", "Body.", ""].join("\n");
		fs.writeFileSync(absPath, doc, "utf-8");

		const changed = reconcileMarkerModeForFile(absPath, "target", makeConfig("external"), store);

		assert.strictEqual(changed, false, "書き換えないこと");
		assert.strictEqual(fs.readFileSync(absPath, "utf-8"), doc, "内容が変わらないこと");
	});

	test("frontmatter の行が本文ユニットの並びに混ざらないこと", () => {
		fs.writeFileSync(absPath, EMBEDDED_DOC, "utf-8");

		externalizeFileMarkers(absPath, "target", makeConfig("external"));

		const bodyRows = store.getEntriesByPath(relPath);
		assert.ok(
			bodyRows.every((entry) => entry.kind === "unit"),
			"本文の行として frontmatter が返らないこと",
		);
	});
});
