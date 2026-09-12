// 「次の要対応へ」の移動先決定ロジックの検証（UX-R4 / ADR-260724-01）。
// 要対応キューは「次へ」があって初めてキューとして機能するため、
// 前進・末尾からの折り返し・起点が無い場合の3つを固定する。
// 併せて、第1引数にツリー項目が来ても落ちないこと（実測された TypeError）と、
// frontmatter・非MD が行 0 の項目としてキューに混ざることを固定する。
// CodeLens「レビュー完了」の直後に自動で次へ進む条件（review を外したときだけ。
// ADR-260912-03）と、片づけた項目が消えたキューで次の項目が選ばれることもここで固定する。

import * as assert from "node:assert";
import * as path from "node:path";
import {
	findNextIndex,
	isReviewResolution,
	readOriginLine,
} from "../../../../commands/markers/needs-attention-next";
import {
	type FileStatusItem,
	type FrontmatterStatusItem,
	type NeedsAttentionItem,
	Status,
	StatusItemType,
	type UnitStatusItem,
} from "../../../../core/status/status-item";
import { StatusItemTree, getNeedsAttentionLine } from "../../../../core/status/status-item-tree";

declare let __vscodeMockWorkspaceRoot: string;

const jaDir = path.resolve("/mock-workspace/ja");
const aPath = path.join(jaDir, "a.md");
const bPath = path.join(jaDir, "b.md");

function makeUnit(
	filePath: string,
	unitHash: string,
	startLine: number,
): UnitStatusItem {
	return {
		type: StatusItemType.Unit,
		label: unitHash,
		filePath,
		unitHash,
		needFlag: "review",
		status: Status.NeedsTranslation,
		startLine,
	};
}

function makeFrontmatter(filePath: string): FrontmatterStatusItem {
	return {
		type: StatusItemType.Frontmatter,
		label: "Frontmatter",
		filePath,
		fileName: path.basename(filePath),
		fromHash: "src1",
		needFlag: "review",
		status: Status.NeedsTranslation,
	};
}

function makeFile(
	filePath: string,
	children: UnitStatusItem[],
	extra?: Partial<FileStatusItem>,
): FileStatusItem {
	return {
		type: StatusItemType.File,
		label: path.basename(filePath),
		filePath,
		fileName: path.basename(filePath),
		translatedUnits: 0,
		totalUnits: children.length,
		status: Status.NeedsTranslation,
		children,
		...extra,
	};
}

/** 要対応項目を見分ける鍵（ユニットは hash、frontmatter と非MD は種類とファイル名） */
function keyOf(item: NeedsAttentionItem): string {
	switch (item.type) {
		case StatusItemType.Unit:
			return item.unitHash;
		case StatusItemType.Frontmatter:
			return `frontmatter:${item.fileName}`;
		case StatusItemType.File:
			return `file:${item.fileName}`;
	}
}

/** ツリーが返すのと同じ順序（compareNeedsAttentionUnits 適用済み）のキューを作る */
function buildQueue(files: FileStatusItem[]): NeedsAttentionItem[] {
	const tree = new StatusItemTree();
	try {
		tree.buildTree(files, ["ja"]);
		return tree.getNeedsAttentionUnits();
	} finally {
		tree.dispose();
	}
}

suite("findNextIndex（次の要対応へ）", () => {
	let units: NeedsAttentionItem[];

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		units = buildQueue([
			makeFile(aPath, [makeUnit(aPath, "a5", 5), makeUnit(aPath, "a80", 80)]),
			makeFile(bPath, [makeUnit(bPath, "b10", 10)]),
		]);
	});

	test("キューの順序がファイルパス昇順→開始行昇順であること（前提の確認）", () => {
		assert.deepStrictEqual(units.map(keyOf), ["a5", "a80", "b10"]);
	});

	test("起点が無ければ先頭を返すこと", () => {
		assert.strictEqual(findNextIndex(units, undefined), 0);
	});

	test("同一ファイル内で現在行より後ろの項目へ進むこと", () => {
		assert.strictEqual(findNextIndex(units, { filePath: aPath, line: 5 }), 1);
	});

	test("スクロール先の行を起点にすると、その次の項目へ進むこと（前へ戻らないこと）", () => {
		// エディタ上のボタンはカーソルを動かさないため、押した行を起点に渡す必要がある。
		// 80行目を起点にしたら、先頭(5行目)ではなく次のファイルの項目へ進む。
		assert.strictEqual(findNextIndex(units, { filePath: aPath, line: 80 }), 2);
	});

	test("ファイル内に後続が無ければ次のファイルの項目へ進むこと", () => {
		assert.strictEqual(findNextIndex(units, { filePath: aPath, line: 100 }), 2);
	});

	test("末尾まで来たら先頭へ回ること（行き止まりにしない）", () => {
		assert.strictEqual(findNextIndex(units, { filePath: bPath, line: 10 }), 0);
	});

	test("要対応と無関係なファイルを開いている場合もパス順で次の項目を選ぶこと", () => {
		const otherPath = path.join(jaDir, "0-other.md"); // a.md より前
		assert.strictEqual(
			findNextIndex(units, { filePath: otherPath, line: 0 }),
			0,
		);
		const laterPath = path.join(jaDir, "z-other.md"); // b.md より後
		assert.strictEqual(
			findNextIndex(units, { filePath: laterPath, line: 0 }),
			0,
			"以降に項目が無ければ先頭へ回ること",
		);
	});
});

suite("findNextIndex（frontmatter・非MD を含むキュー）", () => {
	const txtPath = path.join(jaDir, "0-notes.txt"); // a.md より前
	let queue: NeedsAttentionItem[];

	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
		queue = buildQueue([
			makeFile(aPath, [makeUnit(aPath, "a5", 5)], { frontmatter: makeFrontmatter(aPath) }),
			makeFile(txtPath, [], { needFlag: "review" }),
		]);
	});

	test("frontmatter と非MD は行 0 の項目として、そのファイルの先頭に並ぶこと", () => {
		assert.deepStrictEqual(queue.map(keyOf), ["file:0-notes.txt", "frontmatter:a.md", "a5"]);
		assert.deepStrictEqual(queue.map(getNeedsAttentionLine), [0, 0, 5]);
	});

	test("非MD ファイルを開いているとき（行 0）は、次のファイルの frontmatter へ進むこと", () => {
		assert.strictEqual(findNextIndex(queue, { filePath: txtPath, line: 0 }), 1);
	});

	test("frontmatter のファイル先頭（行 0）に居るときは、同じファイルの本文ユニットへ進むこと", () => {
		// frontmatter は行 0 扱いなので「もう通り過ぎた」として次へ進む（同じ項目で足踏みしない）
		assert.strictEqual(findNextIndex(queue, { filePath: aPath, line: 0 }), 2);
	});

	test("直前のファイルの末尾から進むと、次のファイルの frontmatter（行 0）が選ばれること", () => {
		assert.strictEqual(findNextIndex(queue, { filePath: txtPath, line: 99 }), 1);
	});
});

suite("isReviewResolution（「レビュー完了」の直後だけ次の要対応へ進む）", () => {
	test("need:review を外した結果なら進むこと", () => {
		assert.strictEqual(isReviewResolution([{ need: "review" }]), true);
	});

	test("翻訳済み・改訂済み・isolate 解除・verify-deletion は要対応キューの外の操作なので進まないこと", () => {
		for (const need of ["translate", "revise@old", "isolate", "verify-deletion"]) {
			assert.strictEqual(isReviewResolution([{ need }]), false, `need=${need}`);
		}
	});

	test("何も外せなかった（解決 0 件）なら進まないこと", () => {
		assert.strictEqual(isReviewResolution([]), false);
	});
});

suite("findNextIndex（「レビュー完了」で片づけた項目が消えたキュー）", () => {
	setup(() => {
		__vscodeMockWorkspaceRoot = "/mock-workspace";
	});

	test("片づけた行を起点にすると、同じファイルの次の項目へ進むこと", () => {
		// a5 を片づけた直後のキュー（a5 は resolveNeed のステータス更新で既に消えている）
		const queue = buildQueue([
			makeFile(aPath, [makeUnit(aPath, "a80", 80)]),
			makeFile(bPath, [makeUnit(bPath, "b10", 10)]),
		]);
		assert.strictEqual(keyOf(queue[findNextIndex(queue, { filePath: aPath, line: 5 })]), "a80");
	});

	test("最後の項目を片づけたら、残っている先頭の項目へ回ること", () => {
		// b10 を片づけた直後。手前に残した a5 がまだあるので、そこへ回る
		const queue = buildQueue([makeFile(aPath, [makeUnit(aPath, "a5", 5)])]);
		assert.strictEqual(keyOf(queue[findNextIndex(queue, { filePath: bPath, line: 10 })]), "a5");
	});

	test("frontmatter（行 0）を片づけたら、同じファイルの本文ユニットへ進むこと", () => {
		const queue = buildQueue([makeFile(aPath, [makeUnit(aPath, "a5", 5)])]);
		assert.strictEqual(keyOf(queue[findNextIndex(queue, { filePath: aPath, line: 0 })]), "a5");
	});

	test("非MD ファイル（行 0）を片づけたら、パス順で次のファイルの項目へ進むこと", () => {
		const txtPath = path.join(jaDir, "0-notes.txt"); // a.md より前
		const queue = buildQueue([makeFile(aPath, [makeUnit(aPath, "a5", 5)])]);
		assert.strictEqual(keyOf(queue[findNextIndex(queue, { filePath: txtPath, line: 0 })]), "a5");
	});
});

suite("readOriginLine（第1引数の読み取り）", () => {
	test("Range 相当（start.line が数値）ならその行を起点にすること", () => {
		assert.strictEqual(readOriginLine({ start: { line: 42 }, end: { line: 42 } }), 42);
	});

	test("ツリー項目（StatusItem）が渡されても落ちず、起点にしないこと", () => {
		// ツリーのインライン／右クリックから呼ばれると VS Code はツリー項目を第1引数に渡す。
		// これを Range と決めて start.line を読むと TypeError で落ちる（実測）
		const treeItem = { type: StatusItemType.Directory, label: "Needs Attention (3)", directoryPath: "mdait:needs-attention" };
		assert.strictEqual(readOriginLine(treeItem), undefined);
	});

	test("undefined・null・数値以外の start.line は無視すること", () => {
		assert.strictEqual(readOriginLine(undefined), undefined);
		assert.strictEqual(readOriginLine(null), undefined);
		assert.strictEqual(readOriginLine({ start: { line: "7" } }), undefined);
		assert.strictEqual(readOriginLine({ start: null }), undefined);
		assert.strictEqual(readOriginLine("mdait:needs-attention"), undefined);
	});
});
