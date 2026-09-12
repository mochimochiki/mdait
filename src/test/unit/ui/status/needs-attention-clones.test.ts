// 要対応（Needs Attention）ノード配下のクローンが、本文ユニットだけでなく frontmatter と
// 非MD（ファイル＝1ユニット）にも作られ、ツリー項目として成立することの検証。
// id が本体と衝突しない・クリックで対訳を開く（行 0）・親が要対応ノード・副題で種類が読める、
// の4点を固定する。集約（何を並べるか）は StatusItemTree 側のテストが担う。

import * as assert from "node:assert";
import * as path from "node:path";
import type * as vscode from "vscode";
import { SelectionState } from "../../../../core/status/selection-state";
import {
	type FileStatusItem,
	type FrontmatterStatusItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";
import { StatusManager } from "../../../../core/status/status-manager";
import { Configuration, type TransPair } from "../../../../infra/config/configuration";
import { StatusTreeProvider, toNeedsAttentionClone } from "../../../../ui/status/status-tree-provider";

declare let __vscodeMockWorkspaceRoot: string;

const workspace = "/mock-workspace";
const jaDir = path.resolve(workspace, "docs/ja");
const mdPath = path.join(jaDir, "guide.md");
const txtPath = path.join(jaDir, "notes.txt");

function unitItem(overrides: Partial<UnitStatusItem> = {}): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: "Introduction",
		filePath: mdPath,
		unitHash: "u1",
		needFlag: "review",
		status: Status.NeedsTranslation,
		startLine: 12,
		...overrides,
	};
}

function frontmatterItem(overrides: Partial<FrontmatterStatusItem> = {}): FrontmatterStatusItem {
	return {
		type: StatusItemType.Frontmatter,
		label: "Frontmatter",
		filePath: mdPath,
		fileName: "guide.md",
		fromHash: "src1",
		needFlag: "review",
		status: Status.NeedsTranslation,
		contextValue: "mdaitFrontmatterTargetAttention",
		...overrides,
	};
}

function plainFileItem(overrides: Partial<FileStatusItem> = {}): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: "notes.txt",
		filePath: txtPath,
		fileName: "notes.txt",
		translatedUnits: 0,
		totalUnits: 1,
		status: Status.NeedsTranslation,
		children: [],
		needFlag: "review",
		contextValue: "mdaitPlainFileTargetAttention",
		...overrides,
	};
}

suite("toNeedsAttentionClone（要対応ノード配下のクローン）", () => {
	setup(() => {
		__vscodeMockWorkspaceRoot = workspace;
	});

	test("本文ユニットは isVirtualCopy が立ち、副題に「ファイル名 · 種類」が出ること", () => {
		const clone = toNeedsAttentionClone(unitItem(), path.resolve(workspace));

		assert.strictEqual(clone.isVirtualCopy, true);
		assert.strictEqual(clone.description, "guide.md · Review");
		assert.strictEqual(clone.tooltip, `${path.join("docs", "ja", "guide.md")}\nReview`);
	});

	test("frontmatter は本文ユニットと同じ作法で副題にファイル名と種類が出ること", () => {
		const clone = toNeedsAttentionClone(frontmatterItem(), path.resolve(workspace));

		assert.strictEqual(clone.type, StatusItemType.Frontmatter);
		assert.strictEqual(clone.isVirtualCopy, true);
		assert.strictEqual(clone.description, "guide.md · Review");
	});

	test("非MD ファイルはラベルがファイル名なので、副題は種類だけになること（同じ名前を2度出さない）", () => {
		const clone = toNeedsAttentionClone(plainFileItem(), path.resolve(workspace));

		assert.strictEqual(clone.type, StatusItemType.File);
		assert.strictEqual(clone.isVirtualCopy, true);
		assert.strictEqual(clone.label, "notes.txt");
		assert.strictEqual(clone.description, "Review");
		assert.strictEqual(clone.tooltip, `${path.join("docs", "ja", "notes.txt")}\nReview`);
	});

	test("verify-deletion は「Deletion check」と示されること", () => {
		const clone = toNeedsAttentionClone(unitItem({ needFlag: "verify-deletion" }), undefined);

		assert.strictEqual(clone.description, "guide.md · Deletion check");
		assert.strictEqual(clone.tooltip, `${mdPath}\nDeletion check`, "基準が無ければ絶対パス");
	});

	test("元の項目は書き換えないこと（実ファイル配下の本体と共有しているため）", () => {
		const original = frontmatterItem();
		toNeedsAttentionClone(original, undefined);

		assert.strictEqual(original.isVirtualCopy, undefined);
		assert.strictEqual(original.description, undefined);
	});
});

suite("StatusTreeProvider getTreeItem（frontmatter・非MD のクローン）", () => {
	let provider: StatusTreeProvider;
	const root = path.resolve(workspace);

	setup(() => {
		__vscodeMockWorkspaceRoot = workspace;
		provider = new StatusTreeProvider();
	});

	test("frontmatter のクローンは id に接尾辞が付き、本体と衝突しないこと", () => {
		const real = provider.getTreeItem(frontmatterItem());
		const clone = provider.getTreeItem(toNeedsAttentionClone(frontmatterItem(), root));

		assert.ok(real.id, "本体にも id があること");
		assert.strictEqual(clone.id, `${real.id}::needs-attention`);
	});

	test("非MD ファイルのクローンは id に接尾辞が付き、本体と衝突しないこと", () => {
		const real = provider.getTreeItem(plainFileItem());
		const clone = provider.getTreeItem(toNeedsAttentionClone(plainFileItem(), root));

		assert.ok(real.id, "本体にも id があること");
		assert.strictEqual(clone.id, `${real.id}::needs-attention`);
	});

	test("本文ユニットのクローンの id は従来どおり接尾辞付きであること", () => {
		const real = provider.getTreeItem(unitItem());
		const clone = provider.getTreeItem(toNeedsAttentionClone(unitItem(), root));

		assert.strictEqual(clone.id, `${real.id}::needs-attention`);
	});

	test("frontmatter のクローンはクリックで対訳を開く（mdait.openPair、行 0）こと", () => {
		const clone = provider.getTreeItem(toNeedsAttentionClone(frontmatterItem(), root));

		assert.strictEqual(clone.command?.command, "mdait.openPair");
		assert.deepStrictEqual(clone.command?.arguments, [mdPath, 0]);
	});

	test("非MD ファイルのクローンはクリックで対訳を開く（mdait.openPair、行 0）こと", () => {
		const clone = provider.getTreeItem(toNeedsAttentionClone(plainFileItem(), root));

		assert.strictEqual(clone.command?.command, "mdait.openPair");
		assert.deepStrictEqual(clone.command?.arguments, [txtPath, 0]);
	});

	test("本文ユニットのクローンは開始行で対訳を開くこと", () => {
		const clone = provider.getTreeItem(toNeedsAttentionClone(unitItem(), root));

		assert.strictEqual(clone.command?.command, "mdait.openPair");
		assert.deepStrictEqual(clone.command?.arguments, [mdPath, 12]);
	});

	test("実ファイル配下の frontmatter・非MD 行は従来どおり訳文だけを開く（mdait.jumpToUnit）こと", () => {
		assert.strictEqual(provider.getTreeItem(frontmatterItem()).command?.command, "mdait.jumpToUnit");
		assert.strictEqual(provider.getTreeItem(plainFileItem()).command?.command, "mdait.jumpToUnit");
	});

	test("クローンの contextValue は本体と同じで、ツリーのボタン（レビュー済みにする）が同じ条件で出ること", () => {
		assert.strictEqual(
			provider.getTreeItem(toNeedsAttentionClone(frontmatterItem(), root)).contextValue,
			"mdaitFrontmatterTargetAttention",
		);
		assert.strictEqual(
			provider.getTreeItem(toNeedsAttentionClone(plainFileItem(), root)).contextValue,
			"mdaitPlainFileTargetAttention",
		);
	});

	test("クローンは子を持たない（葉）こと", () => {
		const clone = provider.getTreeItem(toNeedsAttentionClone(plainFileItem(), root));

		assert.strictEqual(clone.collapsibleState, 0 /* TreeItemCollapsibleState.None */);
	});

	test("確認待ちの frontmatter と非MD 行は、本体でも tooltip が「Review required」になること", () => {
		// Hover が「翻訳が必要」と語ると、何を求められているか読めない
		assert.strictEqual(provider.getTreeItem(frontmatterItem()).tooltip, "Review required");
		assert.strictEqual(provider.getTreeItem(plainFileItem()).tooltip, "Review required");
	});

	test("確認待ちの frontmatter と非MD 行は、本文ユニットと同じ黄で示されること", () => {
		const fm = provider.getTreeItem(frontmatterItem()).iconPath as vscode.ThemeIcon & { color?: { id: string } };
		const txt = provider.getTreeItem(plainFileItem()).iconPath as vscode.ThemeIcon & { color?: { id: string } };

		assert.strictEqual(fm.id, "book");
		assert.strictEqual(fm.color?.id, "charts.yellow");
		assert.strictEqual(txt.id, "circle");
		assert.strictEqual(txt.color?.id, "charts.yellow");
	});

	test("非MD 行は本体でも状態を文字で読めること（副題「Needs review」）", () => {
		assert.strictEqual(provider.getTreeItem(plainFileItem()).description, "Needs review");
	});
});

suite("StatusTreeProvider getParent（クローンの親は要対応ノード）", () => {
	let savedPairs: TransPair[];

	setup(() => {
		__vscodeMockWorkspaceRoot = workspace;
		const config = Configuration.getInstance();
		savedPairs = config.transPairs;
	});

	teardown(() => {
		Configuration.getInstance().transPairs = savedPairs;
		StatusManager.getInstance().dispose();
	});

	test("frontmatter・非MD のクローンの親が要対応ノードになること", () => {
		// 要対応ノードは選択中の transPair の範囲で集めるので、設定と選択を用意する。
		// 設定の基準ディレクトリは他のテストが差し替えている可能性があるため、実際の値から組む
		const config = Configuration.getInstance();
		const pair: TransPair = { sourceDir: "docs/en", targetDir: "docs/ja", sourceLang: "en", targetLang: "ja" };
		config.transPairs = [pair];
		SelectionState.getInstance().reconcileWith([pair]);
		const targetDir = path.resolve(config.getConfigBaseDir(), pair.targetDir);
		const md = path.join(targetDir, "guide.md");
		const txt = path.join(targetDir, "notes.txt");

		const tree = StatusManager.getInstance().getStatusItemTree();
		tree.addOrUpdateFile({
			type: StatusItemType.File,
			label: "guide.md",
			filePath: md,
			fileName: "guide.md",
			translatedUnits: 0,
			totalUnits: 0,
			status: Status.NeedsTranslation,
			children: [],
			frontmatter: frontmatterItem({ filePath: md }),
		});
		tree.addOrUpdateFile(plainFileItem({ filePath: txt }));

		const provider = new StatusTreeProvider();
		const fmParent = provider.getParent(toNeedsAttentionClone(frontmatterItem({ filePath: md }), undefined));
		const txtParent = provider.getParent(toNeedsAttentionClone(plainFileItem({ filePath: txt }), undefined));

		assert.strictEqual(fmParent?.type, StatusItemType.Directory);
		assert.strictEqual((fmParent as { directoryPath?: string }).directoryPath, "mdait:needs-attention");
		assert.strictEqual(txtParent, fmParent, "同じ要対応ノードの実体を返すこと（reveal の安定）");
		assert.strictEqual(fmParent?.label, "Needs Attention (2)", "件数は frontmatter と非MD を含むこと");
	});
});
