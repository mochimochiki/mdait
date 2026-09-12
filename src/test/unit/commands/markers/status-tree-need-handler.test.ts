// ツリーの「レビュー済みにする」が本文ユニット・frontmatter・非MD ファイルの3種類を受け、
// どれも `getFileHandler().resolveNeed` に正しい宛先（NeedTarget）で渡すことの検証。
// 書き換えそのものはハンドラ側の責務なので、ここでは呼び出しの引数だけを見る
// （サーフェス側で書き換えを実装しない — AGENTS.md の不変条件）。
// 外せたあとは CodeLens「レビュー完了」と同じく次の要対応へ進む（ADR-260912-08）ので、
// 起点の行（宛先の `line`）と、次の項目が対訳表示（mdait.openPair）で開かれることも固定する。

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { MdFileHandler } from "../../../../commands/file-handler/md-file-handler";
import { PlainFileHandler, determinePlainFileContextValue } from "../../../../commands/file-handler/plain-file-handler";
import type { NeedResolutionOptions, ResolveNeedFileResult } from "../../../../commands/markers/resolve-need";
import { StatusTreeNeedHandler, toReviewTarget } from "../../../../commands/markers/status-tree-need-handler";
import { SelectionState } from "../../../../core/status/selection-state";
import {
	type DirectoryStatusItem,
	type FileStatusItem,
	type FrontmatterStatusItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";
import { StatusManager } from "../../../../core/status/status-manager";
import { Configuration, type TransPair } from "../../../../infra/config/configuration";

declare let __vscodeMockWorkspaceRoot: string;
declare let __vscodeMockShownMessages: { level: string; message: string }[] | undefined;
declare let __vscodeMockExecutedCommands: { command: string; args: unknown[] }[] | undefined;

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
	test("本文ユニットは hash 付きの unit 宛先になり、起点の行は開始行になること", () => {
		assert.deepStrictEqual(toReviewTarget(unitItem({ startLine: 12 })), {
			filePath: mdPath,
			target: { kind: "unit", hash: "u1" },
			line: 12,
		});
	});

	test("開始行の無い本文ユニットは行 0 を起点にすること（キューの並びと同じ読み方）", () => {
		assert.strictEqual(toReviewTarget(unitItem())?.line, 0);
	});

	test("frontmatter は frontmatter 宛先になり、起点の行は 0 になること", () => {
		assert.deepStrictEqual(toReviewTarget(frontmatterItem()), {
			filePath: mdPath,
			target: { kind: "frontmatter" },
			line: 0,
		});
	});

	test("非MD のファイル行は file 宛先（ファイル＝1ユニット）になり、起点の行は 0 になること", () => {
		assert.deepStrictEqual(toReviewTarget(fileItem(txtPath, { needFlag: "review" })), {
			filePath: txtPath,
			target: { kind: "file" },
			line: 0,
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

suite("StatusTreeNeedHandler.markReviewed（外せたら次の要対応へ進む。ADR-260912-08）", () => {
	const originalMd = MdFileHandler.prototype.resolveNeed;
	let savedPairs: TransPair[];
	let targetDir: string;
	let guidePath: string;
	let resolvedNeed: string;

	/** 要対応キューに残っている本文ユニットを1件、ステータスツリーへ載せる */
	function seedRemaining(filePath: string, unitHash: string, startLine: number): void {
		StatusManager.getInstance()
			.getStatusItemTree()
			.addOrUpdateFile(
				fileItem(filePath, {
					totalUnits: 1,
					children: [unitItem({ filePath, unitHash, startLine })],
				}),
			);
	}

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		__vscodeMockShownMessages = [];
		__vscodeMockExecutedCommands = [];
		resolvedNeed = "review";
		// 要対応は選択中の transPair の範囲で集めるので、設定と選択を用意する
		// （基準ディレクトリは他のテストが差し替えている可能性があるため、実際の値から組む）
		const config = Configuration.getInstance();
		savedPairs = config.transPairs;
		const pair: TransPair = { sourceDir: "docs/en", targetDir: "docs/ja", sourceLang: "en", targetLang: "ja" };
		config.transPairs = [pair];
		SelectionState.getInstance().reconcileWith([pair]);
		targetDir = path.resolve(config.getConfigBaseDir(), pair.targetDir);
		guidePath = path.join(targetDir, "guide.md");
		// 書き換えは本物を呼ばず、「review を外せた」結果だけ返す。片づけた項目は本物なら
		// ステータス更新でキューから消えるので、ここでは最初から残りの項目だけを載せる
		MdFileHandler.prototype.resolveNeed = async () => ({
			resolved: [{ hash: "u1", need: resolvedNeed }],
			skipped: [],
			changed: true,
			remainingNeedFlags: [],
		});
	});

	teardown(() => {
		MdFileHandler.prototype.resolveNeed = originalMd;
		Configuration.getInstance().transPairs = savedPairs;
		StatusManager.getInstance().dispose();
		__vscodeMockShownMessages = undefined;
		__vscodeMockExecutedCommands = undefined;
	});

	test("同じファイルに次の確認待ちが残っていれば、その行を対訳表示で開くこと", async () => {
		seedRemaining(guidePath, "u2", 40);

		await new StatusTreeNeedHandler().markReviewed(unitItem({ filePath: guidePath, startLine: 5 }));

		assert.deepStrictEqual(__vscodeMockExecutedCommands, [{ command: "mdait.openPair", args: [guidePath, 40] }]);
		assert.deepStrictEqual(__vscodeMockShownMessages, [], "移動はトーストで知らせないこと");
	});

	test("片づけた項目より前にしか残っていなければ、先頭へ回ること（行き止まりにしない）", async () => {
		seedRemaining(guidePath, "u0", 2);

		await new StatusTreeNeedHandler().markReviewed(unitItem({ filePath: guidePath, startLine: 5 }));

		assert.deepStrictEqual(__vscodeMockExecutedCommands, [{ command: "mdait.openPair", args: [guidePath, 2] }]);
	});

	test("frontmatter を片づけたら、同じファイルの本文ユニットへ進むこと（起点は行 0）", async () => {
		seedRemaining(guidePath, "u2", 40);

		await new StatusTreeNeedHandler().markReviewed(frontmatterItem({ filePath: guidePath }));

		assert.deepStrictEqual(__vscodeMockExecutedCommands, [{ command: "mdait.openPair", args: [guidePath, 40] }]);
	});

	test("残りが無ければ画面を動かさず、トーストも出さないこと", async () => {
		await new StatusTreeNeedHandler().markReviewed(unitItem({ filePath: guidePath, startLine: 5 }));

		assert.deepStrictEqual(__vscodeMockExecutedCommands, []);
		assert.deepStrictEqual(__vscodeMockShownMessages, []);
	});

	test("外せたのが review 以外なら進まないこと", async () => {
		resolvedNeed = "translate";
		seedRemaining(guidePath, "u2", 40);

		await new StatusTreeNeedHandler().markReviewed(unitItem({ filePath: guidePath, startLine: 5 }));

		assert.deepStrictEqual(__vscodeMockExecutedCommands, []);
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
