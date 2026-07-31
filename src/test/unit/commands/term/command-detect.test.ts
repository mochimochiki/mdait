/**
 * @file command-detect.test.ts
 * @description detectTerm_CoreProc のエラー伝播と件数返却のテスト
 * AI呼び出しが失敗した場合に「0件検出の成功」と誤認させないことを検証する。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectTerm_CoreProc } from "../../../../commands/term/command-detect";
import { LangTerm, TermEntry } from "../../../../commands/term/term-entry";
import type { TermDetector } from "../../../../commands/term/term-detector";
import { UnitPair } from "../../../../commands/term/unit-pair";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";
import { Configuration, type TransPair } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;

/** 常に失敗する用語検出サービス（AI未接続などを模擬） */
class FailingTermDetector implements TermDetector {
	async detectTerms(): Promise<readonly TermEntry[]> {
		throw new Error("Language model is not available. Please ensure GitHub Copilot is enabled.");
	}
}

/** 固定の用語を返す用語検出サービス */
class FixedTermDetector implements TermDetector {
	async detectTerms(): Promise<readonly TermEntry[]> {
		return [
			TermEntry.create("API endpoint context", {
				en: LangTerm.create("API endpoint"),
				ja: LangTerm.create("APIエンドポイント"),
			}),
		];
	}
}

function createPair(): UnitPair {
	const sourceUnit = new MdaitUnit(new MdaitMarker("abc123"), "Section", 1, "# Section\n\nAPI endpoint content", 0, 2);
	return UnitPair.create(sourceUnit, undefined);
}

const transPair: TransPair = {
	sourceDir: "docs/en",
	targetDir: "docs/ja",
	sourceLang: "en",
	targetLang: "ja",
};

const progressStub = { report: () => {} };

suite("detectTerm_CoreProc", () => {
	let tempDir: string;

	setup(() => {
		Configuration.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-term-detect-"));
		__vscodeMockWorkspaceRoot = tempDir;
	});

	teardown(() => {
		Configuration.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("全バッチのAI呼び出しが失敗した場合は成功扱いにせずエラーを伝播する", async () => {
		await assert.rejects(
			detectTerm_CoreProc([createPair()], transPair, progressStub, undefined, new FailingTermDetector()),
			/Language model is not available/,
		);
	});

	test("用語が検出された場合は件数を返し用語集ファイルへ保存する", async () => {
		const result = await detectTerm_CoreProc(
			[createPair()],
			transPair,
			progressStub,
			undefined,
			new FixedTermDetector(),
		);

		assert.equal(result.length, 1);
		assert.equal(TermEntry.getTerm(result[0], "en"), "API endpoint");

		const termsPath = path.join(tempDir, ".mdait", "terms.csv");
		assert.ok(fs.existsSync(termsPath), "用語集ファイルが保存されていること");
		assert.ok(fs.readFileSync(termsPath, "utf8").includes("API endpoint"));
	});

	test("用語が検出されなかった場合（AIは成功）は空配列を返しエラーにしない", async () => {
		class EmptyTermDetector implements TermDetector {
			async detectTerms(): Promise<readonly TermEntry[]> {
				return [];
			}
		}

		const result = await detectTerm_CoreProc(
			[createPair()],
			transPair,
			progressStub,
			undefined,
			new EmptyTermDetector(),
		);

		assert.equal(result.length, 0);
	});
});
