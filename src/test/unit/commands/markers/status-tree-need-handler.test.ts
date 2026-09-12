// ツリーの「レビュー済みにする」が本文ユニット・frontmatter・非MD ファイルの3種類を受け、
// どれも `getFileHandler().resolveNeed` に正しい宛先（NeedTarget）で渡すことの検証。
// 書き換えそのものはハンドラ側の責務なので、ここでは呼び出しの引数だけを見る
// （サーフェス側で書き換えを実装しない — AGENTS.md の不変条件）。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { MdFileHandler } from "../../../../commands/file-handler/md-file-handler";
import { PlainFileHandler, determinePlainFileContextValue } from "../../../../commands/file-handler/plain-file-handler";
import type { NeedResolutionOptions, ResolveNeedFileResult } from "../../../../commands/markers/resolve-need";
import { StatusTreeNeedHandler, toReviewTarget } from "../../../../commands/markers/status-tree-need-handler";
import {
	type DirectoryStatusItem,
	type FileStatusItem,
	type FrontmatterStatusItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";

declare let __vscodeMockWorkspaceRoot: string;
declare let __vscodeMockShownMessages: { level: string; message: string }[] | undefined;

const jaDir = path.resolve("/mock-workspace/ja");
const mdPath = path.join(jaDir, "a.md");
const txtPath = path.join(jaDir, "notes.txt");

function unitItem(overrides: Partial<UnitStatusItem> = {}): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: "Intro",
		filePath: mdPath,
		unitHash: "u1",
		needFlag: "review",
		status: Status.NeedsTranslation,
		...overrides,
	};
}

function frontmatterItem(overrides: Partial<FrontmatterStatusItem> = {}): FrontmatterStatusItem {
	return {
		type: StatusItemType.Frontmatter,
		label: "Frontmatter",
		filePath: mdPath,
		fileName: "a.md",
		fromHash: "src1",
		needFlag: "review",
		status: Status.NeedsTranslation,
		...overrides,
	};
}

function fileItem(filePath: string, overrides: Partial<FileStatusItem> = {}): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		translatedUnits: 0,
		totalUnits: 1,
		status: Status.NeedsTranslation,
		children: [],
		...overrides,
	};
}

function directoryItem(): DirectoryStatusItem {
	return { type: StatusItemType.Directory, label: "ja", directoryPath: jaDir, status: Status.NeedsTranslation };
}

suite("toReviewTarget（ツリー項目 → review 裁定の宛先）", () => {
	test("本文ユニットは hash 付きの unit 宛先になること", () => {
		assert.deepStrictEqual(toReviewTarget(unitItem()), {
			filePath: mdPath,
			target: { kind: "unit", hash: "u1" },
		});
	});

	test("frontmatter は frontmatter 宛先になること", () => {
		assert.deepStrictEqual(toReviewTarget(frontmatterItem()), {
			filePath: mdPath,
			target: { kind: "frontmatter" },
		});
	});

	test("非MD のファイル行は file 宛先（ファイル＝1ユニット）になること", () => {
		assert.deepStrictEqual(toReviewTarget(fileItem(txtPath, { needFlag: "review" })), {
			filePath: txtPath,
			target: { kind: "file" },
		});
	});

	test("Markdown のファイル行は宛先にならないこと（ファイル全体を1つの need として外す単位が無い）", () => {
		assert.strictEqual(toReviewTarget(fileItem(mdPath)), undefined);
	});

	test("ディレクトリ・undefined・hash の無いユニットは宛先にならないこと", () => {
		assert.strictEqual(toReviewTarget(directoryItem()), undefined);
		assert.strictEqual(toReviewTarget(undefined), undefined);
		assert.strictEqual(toReviewTarget(unitItem({ unitHash: "" })), undefined);
	});
});

suite("StatusTreeNeedHandler.markReviewed（3種類の項目を resolveNeed へ渡す）", () => {
	const originalMd = MdFileHandler.prototype.resolveNeed;
	const originalPlain = PlainFileHandler.prototype.resolveNeed;
	/** どのハンドラが、どのファイルに、どんな指定で呼ばれたか */
	let calls: { handler: "md" | "plain"; filePath: string; options: NeedResolutionOptions | undefined }[];
	let resolvedCount: number;

	const fakeResult = (): ResolveNeedFileResult => ({
		resolved: Array.from({ length: resolvedCount }, () => ({ hash: "x", need: "review" })),
		skipped: [],
		changed: resolvedCount > 0,
		remainingNeedFlags: [],
	});

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		__vscodeMockShownMessages = [];
		calls = [];
		resolvedCount = 1;
		// getFileHandler は毎回 new するので、prototype を差し替えれば経路を変えずに引数を控えられる
		MdFileHandler.prototype.resolveNeed = async (filePath, options) => {
			calls.push({ handler: "md", filePath, options });
			return fakeResult();
		};
		PlainFileHandler.prototype.resolveNeed = async (filePath, options) => {
			calls.push({ handler: "plain", filePath, options });
			return fakeResult();
		};
	});

	teardown(() => {
		MdFileHandler.prototype.resolveNeed = originalMd;
		PlainFileHandler.prototype.resolveNeed = originalPlain;
		__vscodeMockShownMessages = undefined;
	});

	test("本文ユニットは MdFileHandler に unit 宛先・needs:[review] で渡すこと", async () => {
		await new StatusTreeNeedHandler().markReviewed(unitItem());

		assert.deepStrictEqual(calls, [
			{
				handler: "md",
				filePath: mdPath,
				options: { targets: [{ kind: "unit", hash: "u1" }], needs: ["review"] },
			},
		]);
		assert.deepStrictEqual(__vscodeMockShownMessages, [], "解決できたら何も出さないこと");
	});

	test("frontmatter は MdFileHandler に frontmatter 宛先で渡すこと", async () => {
		await new StatusTreeNeedHandler().markReviewed(frontmatterItem());

		assert.deepStrictEqual(calls, [
			{
				handler: "md",
				filePath: mdPath,
				options: { targets: [{ kind: "frontmatter" }], needs: ["review"] },
			},
		]);
	});

	test("非MD のファイル行は PlainFileHandler に file 宛先で渡すこと", async () => {
		await new StatusTreeNeedHandler().markReviewed(fileItem(txtPath, { needFlag: "review" }));

		assert.deepStrictEqual(calls, [
			{
				handler: "plain",
				filePath: txtPath,
				options: { targets: [{ kind: "file" }], needs: ["review"] },
			},
		]);
	});

	test("要対応ノード配下のクローン（isVirtualCopy）でも同じ宛先で渡すこと", async () => {
		await new StatusTreeNeedHandler().markReviewed(
			frontmatterItem({ isVirtualCopy: true, description: "a.md · Review" }),
		);

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].options?.targets, [{ kind: "frontmatter" }]);
	});

	test("解決が 0 件なら警告を出すこと", async () => {
		resolvedCount = 0;
		await new StatusTreeNeedHandler().markReviewed(fileItem(txtPath, { needFlag: "review" }));

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(
			__vscodeMockShownMessages?.map((m) => m.level),
			["warning"],
		);
	});

	test("宛先にならない項目（Markdown のファイル行・ディレクトリ）はハンドラを呼ばずエラーを出すこと", async () => {
		const handler = new StatusTreeNeedHandler();
		await handler.markReviewed(fileItem(mdPath));
		await handler.markReviewed(directoryItem());
		await handler.markReviewed(undefined);

		assert.deepStrictEqual(calls, [], "書き換えの経路に入らないこと");
		assert.deepStrictEqual(
			__vscodeMockShownMessages?.map((m) => m.level),
			["error", "error", "error"],
		);
	});
});

suite("「レビュー済みにする」の配線（package.json の when ⇔ contextValue ⇔ ハンドラ）", () => {
	/** リポジトリのルート（out/test/unit/commands/markers から5つ上） */
	const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");

	/** package.json の view/item/context から mdait.unit.markReviewed の when 句を集める */
	function markReviewedWhenClauses(): string[] {
		const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
			contributes?: { menus?: { "view/item/context"?: Array<{ command: string; when: string; group?: string }> } };
		};
		return (pkg.contributes?.menus?.["view/item/context"] ?? [])
			.filter((entry) => entry.command === "mdait.unit.markReviewed")
			.map((entry) => entry.when);
	}

	test("ボタンが出る contextValue は、ハンドラが受ける3種類（ユニット・frontmatter・非MD）に対応していること", () => {
		// when 句に無い種類はボタンが出ず要対応から裁定できない。when 句にあるのにハンドラが
		// 受けない種類は「Invalid unit item」で終わる。両方を同じテストで見張る
		const clauses = markReviewedWhenClauses();
		assert.ok(clauses.length >= 2, "インラインと右クリックの両方に出ること");
		for (const when of clauses) {
			for (const contextValue of [
				"mdaitUnitTargetAttention",
				"mdaitFrontmatterTargetAttention",
				"mdaitPlainFileTargetAttention",
			]) {
				assert.ok(when.includes(`viewItem == ${contextValue}`), `${contextValue} が when 句に無い: ${when}`);
			}
		}
	});

	test("非MD の contextValue は need で決まり、review のときだけボタンの出る値になること", () => {
		// Status ではなく need で決める（集計都合で Status の付け方が変わってもボタンが消えない）。
		// review に ✨翻訳（mdaitPlainFileTarget）を出すと、trans は review を処理しないので
		// 押しても「翻訳不要」で終わる — 押せないものをボタンにしない（ux.md §3.3）
		assert.strictEqual(determinePlainFileContextValue("review"), "mdaitPlainFileTargetAttention");
		assert.strictEqual(determinePlainFileContextValue("translate"), "mdaitPlainFileTarget");
		assert.strictEqual(determinePlainFileContextValue("revise@abcd1234"), "mdaitPlainFileTarget");
		assert.strictEqual(determinePlainFileContextValue(""), "mdaitPlainFileTargetComplete");
		assert.strictEqual(determinePlainFileContextValue(undefined), "mdaitPlainFileTargetComplete");
	});
});
