// セットアップ診断（setup-doctor）の単体テスト
// 初心者の落とし穴を「実際に発生させて」検出されることを検証する

import { strict as assert } from "node:assert";
import {
	type Diagnostic,
	type DoctorConfigSnapshot,
	type DoctorProbe,
	hasBlockingError,
	isLiteralApiKey,
	runStaticChecks,
} from "../../../../core/diagnostics/setup-doctor";

/** 既定では「全ディレクトリ存在・Markdownあり・マーカーあり」の健全なプローブ */
function makeProbe(overrides: Partial<DoctorProbe> = {}): DoctorProbe {
	return {
		dirExists: () => true,
		countMarkdownFiles: () => 3,
		countFilesWithMarkers: () => 3,
		...overrides,
	};
}

function makeConfig(
	overrides: Partial<DoctorConfigSnapshot> = {},
): DoctorConfigSnapshot {
	return {
		transPairs: [
			{
				sourceDir: "docs/ja",
				targetDir: "docs/en",
				sourceLang: "ja",
				targetLang: "en",
			},
		],
		primaryLang: "ja",
		aiProvider: "vscode-lm",
		...overrides,
	};
}

function ids(diags: Diagnostic[]): string[] {
	return diags.map((d) => d.id);
}

suite("setup-doctor 静的診断", () => {
	test("健全な設定では error/warn を返さない", () => {
		const diags = runStaticChecks(makeConfig(), makeProbe());
		assert.equal(hasBlockingError(diags), false, "blocking error が無いこと");
		assert.equal(
			diags.some((d) => d.level === "warn"),
			false,
			"warn が無いこと",
		);
	});

	test("P1: primaryLang 欠落を error として検出する", () => {
		const diags = runStaticChecks(
			makeConfig({ primaryLang: "" }),
			makeProbe(),
		);
		assert.ok(
			ids(diags).includes("config.noPrimaryLang"),
			"config.noPrimaryLang が含まれること",
		);
		assert.equal(hasBlockingError(diags), true);
	});

	test("P1関連: primaryLang がペアの言語と不一致なら warn", () => {
		const diags = runStaticChecks(
			makeConfig({ primaryLang: "fr" }),
			makeProbe(),
		);
		const mismatch = diags.find((d) => d.id === "config.primaryLangMismatch");
		assert.ok(mismatch, "primaryLangMismatch が含まれること");
		assert.equal(mismatch?.level, "warn");
	});

	test("transPairs が空なら error", () => {
		const diags = runStaticChecks(
			makeConfig({ transPairs: [] }),
			makeProbe(),
		);
		assert.ok(ids(diags).includes("config.noTransPairs"));
		assert.equal(hasBlockingError(diags), true);
	});

	test("sourceDir が存在しなければ error", () => {
		const diags = runStaticChecks(
			makeConfig(),
			makeProbe({ dirExists: (d) => d !== "docs/ja" }),
		);
		const missing = diags.find((d) => d.id === "pair.sourceMissing");
		assert.ok(missing, "pair.sourceMissing が含まれること");
		assert.equal(missing?.params?.dir, "docs/ja");
		assert.equal(hasBlockingError(diags), true);
	});

	test("sourceDir === targetDir なら error", () => {
		const diags = runStaticChecks(
			makeConfig({
				transPairs: [
					{
						sourceDir: "docs",
						targetDir: "docs/",
						sourceLang: "ja",
						targetLang: "en",
					},
				],
			}),
			makeProbe(),
		);
		assert.ok(ids(diags).includes("pair.sourceEqualsTarget"));
		assert.equal(hasBlockingError(diags), true);
	});

	test("targetDir が sourceDir の入れ子なら warn", () => {
		const diags = runStaticChecks(
			makeConfig({
				transPairs: [
					{
						sourceDir: "docs",
						targetDir: "docs/en",
						sourceLang: "ja",
						targetLang: "en",
					},
				],
			}),
			makeProbe(),
		);
		const nested = diags.find((d) => d.id === "pair.nestedDirs");
		assert.ok(nested, "pair.nestedDirs が含まれること");
		assert.equal(nested?.level, "warn");
	});

	test("P2/P3: Markdown はあるがマーカーが無ければ『まず Sync』を info で促す", () => {
		const diags = runStaticChecks(
			makeConfig(),
			makeProbe({ countFilesWithMarkers: () => 0 }),
		);
		const hint = diags.find((d) => d.id === "pair.noMarkersRunSync");
		assert.ok(hint, "pair.noMarkersRunSync が含まれること");
		assert.equal(hint?.level, "info");
		assert.equal(hasBlockingError(diags), false, "info なので blocking ではない");
	});

	test("targetDir 不在は info（Sync で生成され得るため）", () => {
		const diags = runStaticChecks(
			makeConfig(),
			makeProbe({ dirExists: (d) => d !== "docs/en" }),
		);
		const missing = diags.find((d) => d.id === "pair.targetMissing");
		assert.ok(missing, "pair.targetMissing が含まれること");
		assert.equal(missing?.level, "info");
	});

	test("P5: openai で apiKey 直書きなら漏洩 warn", () => {
		const diags = runStaticChecks(
			makeConfig({ aiProvider: "openai", openaiApiKey: "sk-abcdef1234567890" }),
			makeProbe(),
		);
		const leak = diags.find((d) => d.id === "ai.apiKeyLiteral");
		assert.ok(leak, "ai.apiKeyLiteral が含まれること");
		assert.equal(leak?.level, "warn");
	});

	test("P5: openai でも ${env:} 参照なら警告しない", () => {
		const diags = runStaticChecks(
			makeConfig({
				aiProvider: "openai",
				openaiApiKey: "${env:OPENAI_API_KEY}",
			}),
			makeProbe(),
		);
		assert.equal(
			ids(diags).includes("ai.apiKeyLiteral"),
			false,
			"環境変数参照は安全",
		);
	});

	test("vscode-lm では apiKey 直書きでも openai 警告は出ない", () => {
		const diags = runStaticChecks(
			makeConfig({ aiProvider: "vscode-lm", openaiApiKey: "sk-xxx" }),
			makeProbe(),
		);
		assert.equal(ids(diags).includes("ai.apiKeyLiteral"), false);
	});
});

suite("isLiteralApiKey", () => {
	test("実キー文字列は true", () => {
		assert.equal(isLiteralApiKey("sk-1234567890"), true);
	});
	test("${env:...} 参照は false", () => {
		assert.equal(isLiteralApiKey("${env:OPENAI_API_KEY}"), false);
	});
	test("空・未設定は false", () => {
		assert.equal(isLiteralApiKey(""), false);
		assert.equal(isLiteralApiKey(undefined), false);
		assert.equal(isLiteralApiKey("   "), false);
	});
});
