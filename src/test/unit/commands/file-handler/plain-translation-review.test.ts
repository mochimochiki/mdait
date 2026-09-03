/**
 * @file plain-translation-review.test.ts
 * @description
 *   非Markdownファイルの翻訳で `need:review` を立てる条件のテスト。
 *
 *   非MD経路は `TranslationChecker` を通らないため、翻訳結果の異常はここでしか拾えない。
 *   ただし「警告があること」を条件にすると、JSON 混入検出（AI が応答のエンベロープを
 *   漏らしたことを捕まえる道具）が .json ファイルや JSON の例を含む .txt で
 *   定義上つねに発火し、訳すたびに review が立つ。need を乱発すると確認という仕組みが
 *   信用されなくなるので、条件は「コードブロックが戻せなかった＝本文が失われた」に絞る。
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { PlainFileHandler } from "../../../../commands/file-handler/plain-file-handler";
import type { TranslationResult, Translator } from "../../../../commands/trans/translator";
import { UnitRegistryManager } from "../../../../core/unit-registry/unit-registry-manager";
import { UnitStateStore } from "../../../../core/unit-state/unit-state-store";
import { Configuration } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

const progress: vscode.Progress<{ message?: string; increment?: number }> = { report: () => {} };
const token: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => {} }),
};
const pair = { sourceDir: "source", targetDir: "target", sourceLang: "ja", targetLang: "en" };

/** 指定した TranslationResult を返すだけの Translator */
function stubTranslator(result: TranslationResult): Translator {
	return {
		translate: async () => result,
		translateRevisionPatch: async () => ({ targetPatch: "" }),
	} as unknown as Translator;
}

suite("非Markdown翻訳で need:review を立てる条件", () => {
	let tempDir: string;
	let handler: PlainFileHandler;
	let sourceFile: string;
	let targetFile: string;

	setup(() => {
		UnitStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-pfh-review-"));
		__vscodeMockWorkspaceRoot = tempDir;
		UnitStateStore.getInstance().load(tempDir);
		handler = new PlainFileHandler();

		sourceFile = path.join(tempDir, "source", "sample.json");
		targetFile = path.join(tempDir, "target", "sample.json");
		fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		fs.writeFileSync(sourceFile, '{\n  "name": "サンプル"\n}\n', "utf-8");
		fs.writeFileSync(targetFile, "", "utf-8");

		UnitStateStore.getInstance().setEntry({
			path: "target/sample.json",
			order: 0,
			level: 0,
			titleHash: "",
			hash: "",
			from: "",
			need: "translate",
		});
	});

	teardown(() => {
		UnitStateStore.dispose();
		UnitRegistryManager.resetInstance();
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function needAfterTranslate(): string {
		return UnitStateStore.getInstance().getEntry("target/sample.json", 0)?.need ?? "";
	}

	test("コードブロックが失われたら need:review を立てること", async () => {
		await handler.translate(
			targetFile,
			stubTranslator({ translatedText: "translated", warnings: ["dropped 1 code block"], droppedCodeBlocks: 1 }),
			pair,
			progress,
			token,
		);

		assert.strictEqual(needAfterTranslate(), "review");
	});

	test("JSON 混入の警告だけでは need を立てないこと（訳すたびの偽陽性を作らない）", async () => {
		await handler.translate(
			targetFile,
			stubTranslator({
				translatedText: '{\n  "name": "sample"\n}\n',
				warnings: ["Potential JSON structure detected in output"],
				droppedCodeBlocks: 0,
			}),
			pair,
			progress,
			token,
		);

		assert.strictEqual(needAfterTranslate(), "");
	});

	test("警告が無ければ need を立てないこと", async () => {
		await handler.translate(targetFile, stubTranslator({ translatedText: "translated" }), pair, progress, token);

		assert.strictEqual(needAfterTranslate(), "");
	});
});
