// syncコマンド E2Eテスト
// テストガイドラインに従いテスト実装します。

import assert from "node:assert";
import { execSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

suite("syncコマンドE2E", () => {
	const tmpDir = join(__dirname, "tmp");
	const sampleDir = join(__dirname, "../../../../sample/content");
	const en1 = join(sampleDir, "en/test.md");
	const ja1 = join(sampleDir, "ja/test.md");
	const tmpEn = join(tmpDir, "en_test.md");
	const tmpJa = join(tmpDir, "ja_test.md");

	function resetFiles() {
		copyFileSync(en1, tmpEn);
		copyFileSync(ja1, tmpJa);
	}

	function cleanupFiles() {
		try {
			unlinkSync(tmpEn);
		} catch {}
		try {
			unlinkSync(tmpJa);
		} catch {}
	}

	setup(() => {
		if (!existsSync(tmpDir)) {
			mkdirSync(tmpDir, { recursive: true });
		}
		resetFiles();
	});
	teardown(() => {
		cleanupFiles();
	});

	test("mdait管理下にない既存Markdownを同期するとmdaitヘッダーが付与されること", async () => {
		// no_header.mdをtmpにコピー
		const enNoHeader = join(sampleDir, "en/no_header.md");
		const jaNoHeader = join(sampleDir, "ja/no_header.md");
		const tmpEnNoHeader = join(tmpDir, "en_no_header.md");
		const tmpJaNoHeader = join(tmpDir, "ja_no_header.md");
		copyFileSync(enNoHeader, tmpEnNoHeader);
		copyFileSync(jaNoHeader, tmpJaNoHeader);

		// VSCode拡張コマンドとしてsyncを実行
		const vscode = require("vscode");
		const commandId = "mdait.sync";
		const result = await vscode.commands.executeCommand(
			commandId,
			tmpEnNoHeader,
			tmpJaNoHeader,
		);

		const enText = readFileSync(tmpEnNoHeader, "utf8");
		const jaText = readFileSync(tmpJaNoHeader, "utf8");

		// 1. en, ja両方にmdaitヘッダーが付与されていること
		assert.match(enText, /^<!--\s*mdait [^\s]+/m);
		assert.match(jaText, /^<!--\s*mdait [^\s]+/m);

		// 2. enのmdaitヘッダーにjaの対応するヘッダーのハッシュがsrc:として書き込まれていること
		const jaHeader = jaText.match(/<!--\s*mdait ([^\s]+)/); // jaのハッシュ
		const enHeader = enText.match(/<!--\s*mdait ([^\s]+) src:([^\s]+)/); // enのsrc:xxx
		assert.ok(jaHeader && enHeader);
		assert.strictEqual(enHeader[2], jaHeader[1]);

		// 3. セクション分割が行われていること（複数ヘッダーが存在する）
		const enHeaders = enText.match(/<!--\s*mdait [^\s]+/g) || [];
		const jaHeaders = jaText.match(/<!--\s*mdait [^\s]+/g) || [];
		assert.ok(enHeaders.length > 1);
		assert.ok(jaHeaders.length > 1);

		// コマンドの戻り値も検証（エラーでないこと）
		assert.notStrictEqual(result, false);
	});

	// 	test("新規セクションが追加されること", () => {
	// 		// source(md)にだけ存在するセクションを一時的に追加
	// 		const newSection = `
	// ## 新規セクション
	// 新しい内容です。
	// `;
	// 		const srcText = readFileSync(tmpEn, "utf8");
	// 		writeFileSync(tmpEn, srcText + newSection, "utf8");

	// 		// syncコマンド実行（仮: コマンド名はmdait-syncとする）
	// 		execSync(
	// 			`node ../../../../dist/commands/sync/sync-command.js "${tmpEn}" "${tmpJa}"`,
	// 			{ cwd: __dirname },
	// 		);

	// 		const jaText = readFileSync(tmpJa, "utf8");
	// 		// 新規セクションタイトルが含まれ、need:translateが付与されていること
	// 		assert.match(jaText, /新規セクション/);
	// 		assert.match(jaText, /need:translate/);
	// 	});

	// 	test("src重複時に全てのtargetセクションが同期されること", () => {
	// 		// target(md)に同じsrcを持つセクションを2つ用意
	// 		const jaText = readFileSync(tmpJa, "utf8");
	// 		const lines = jaText.split(/\r?\n/);
	// 		// 1つ目のセクションのmdaitHeaderを探して複製
	// 		const headerIdx = lines.findIndex((l) => l.includes("mdait"));
	// 		const section = lines.slice(headerIdx, headerIdx + 4).join("\n");
	// 		const newSection = `\n${section}\n`;
	// 		writeFileSync(tmpJa, jaText + newSection, "utf8");

	// 		// syncコマンド実行
	// 		execSync(
	// 			`node ../../../../dist/commands/sync/sync-command.js "${tmpEn}" "${tmpJa}"`,
	// 			{ cwd: __dirname },
	// 		);

	// 		const jaTextAfter = readFileSync(tmpJa, "utf8");
	// 		// 同じsrcを持つ2つのセクションが両方とも同期されていること（例: need:translateが両方消えている等）
	// 		const matches = jaTextAfter.match(/mdait [^\s]+ src:[^\s]+/g) || [];
	// 		assert.ok(matches.length >= 2);
	// 	});

	// 	// 他のケースも順次追加予定
});
