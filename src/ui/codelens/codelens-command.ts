/**
 * @file codelens-command.ts
 * @description
 *   CodeLensから呼び出される翻訳コマンドを提供するモジュール。
 *   - エディタ上の特定位置（Range）から該当ユニットを特定し、既存の翻訳機能を呼び出す
 *   - 既存のtransUnitCommandとの連携により、コア機能を再利用する
 * @module ui/codelens/codelens-command
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { getFileHandler } from "../../commands/file-handler/file-handler-factory";
import type { DeclareIsolateResult } from "../../commands/markers/declare-isolate";
import type { DeleteUnitResult } from "../../commands/markers/delete-unit";
import { ALL_RESOLVABLE_NEEDS } from "../../commands/markers/resolve-need";
import { transCommand, transUnitCommand } from "../../commands/trans/trans-command";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
import { parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { markdownParser } from "../../core/markdown/parser";
import { findUnitAtLine } from "../../core/markdown/unit-locator";
import { StatusManager } from "../../core/status/status-manager";
import { UnitRegistryManager } from "../../core/unit-registry/unit-registry-manager";
import { Configuration } from "../../infra/config/configuration";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { FileExplorer } from "../../infra/workspace/file-explorer";

/**
 * 指定行のマーカーを取得する。
 * - embedded: その行のテキストから直接パース
 * - external: ドキュメント全体をパースし、行を含むユニットのマーカーを返す
 */
function getMarkerAtLine(document: vscode.TextDocument, line: number): MdaitMarker | null {
	const config = Configuration.getInstance();
	if (config.isExternalMarkers()) {
		const explorer = new FileExplorer();
		const role = explorer.isSourceFile(document.uri.fsPath, config) ? "source" : "target";
		const io = resolveMarkerIO(config, document.uri.fsPath, role);
		const parsed = markdownParser.parse(document.getText(), config, io.provider, io.ctx);
		return findUnitAtLine(parsed.units, line)?.marker ?? null;
	}
	return MdaitMarker.parse(document.lineAt(line).text);
}

/**
 * need 解決の結果をユーザーへ伝える。解決0件のときだけ警告を出す。
 */
function reportResolveOutcome(resolved: number): void {
	if (resolved === 0) {
		vscode.window.showWarningMessage(vscode.l10n.t("No need marker found to clear."));
	}
}

/**
 * CodeLensから翻訳を実行するコマンド
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensTranslateCommand(range: vscode.Range): Promise<void> {
	try {
		// アクティブなエディタを取得
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		const document = activeEditor.document;
		const targetPath = document.uri.fsPath;

		// マーカーからunitHashを抽出（external では本文ではなくユニット行範囲から特定）
		const marker = getMarkerAtLine(document, range.start.line);
		const unitHash = marker?.hash;
		if (!unitHash) {
			vscode.window.showErrorMessage(vscode.l10n.t("Could not extract unit hash from marker."));
			return;
		}

		// 既存のtransUnitCommandを呼び出し
		await transUnitCommand(targetPath, unitHash);

		vscode.window.showInformationMessage(vscode.l10n.t("Translation completed for unit: {0}", unitHash));
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Translation failed: {0}", errorMessage));
	}
}

/**
 * CodeLensからneedマーカーをクリアするコマンド
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensClearNeedCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		const document = activeEditor.document;
		const marker = getMarkerAtLine(document, range.start.line);
		if (!marker?.hash) {
			vscode.window.showWarningMessage(vscode.l10n.t("No need marker found to clear."));
			return;
		}

		const result = await getFileHandler(document.uri.fsPath).resolveNeed(document.uri.fsPath, {
			targets: [{ kind: "unit", hash: marker.hash }],
			needs: ALL_RESOLVABLE_NEEDS,
		});
		reportResolveOutcome(result.resolved.length);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to clear need marker: {0}", errorMessage));
	}
}

/** ユニット削除の失敗理由を人間可読なメッセージに変換する */
function describeDeleteFailure(reason: DeleteUnitResult["reason"]): string {
	if (reason === "not-verify-deletion") {
		return vscode.l10n.t(
			"This unit does not have need:verify-deletion. Only units flagged for deletion review can be deleted this way.",
		);
	}
	return vscode.l10n.t("Unit not found.");
}

/** 凍結宣言の失敗理由を人間可読なメッセージに変換する */
function describeIsolateFailure(reason: DeclareIsolateResult["reason"]): string {
	if (reason === "need-already-set") {
		return vscode.l10n.t("This unit already has a pending need. Resolve it first, then retry.");
	}
	return vscode.l10n.t("Unit not found.");
}

/**
 * CodeLensから verify-deletion ユニットを削除するコマンド。
 * modal 確認の上、hash/from ではなくユニット本体をドキュメントから除去する。
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensDeleteUnitCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}
		const document = activeEditor.document;
		const marker = getMarkerAtLine(document, range.start.line);
		if (!marker?.hash) {
			vscode.window.showWarningMessage(vscode.l10n.t("Could not find a unit at this position."));
			return;
		}

		const confirmLabel = vscode.l10n.t("Delete");
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				"Delete this unit from the document? This removes its content — recover via git history if needed.",
			),
			{ modal: true },
			confirmLabel,
		);
		if (choice !== confirmLabel) {
			return;
		}

		const result = await getFileHandler(document.uri.fsPath).deleteUnit(document.uri.fsPath, {
			kind: "unit",
			hash: marker.hash,
		});
		if (!result.deleted) {
			vscode.window.showWarningMessage(describeDeleteFailure(result.reason));
			return;
		}
		vscode.window.showInformationMessage(vscode.l10n.t("Unit deleted."));
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to delete unit: {0}", errorMessage));
	}
}

/** 「その他」メニューで選べるアクション */
export type OtherAction = "isolate" | "note";

/** 「その他」メニューの項目 */
interface OtherActionItem extends vscode.QuickPickItem {
	action: OtherAction;
}

/**
 * 「その他」メニューに並べるアクションを決める（純関数）。
 * isolate は need が付いていないユニットにのみ出す — 宣言操作が
 * 他の判断待ち（review / verify-deletion など）を踏み潰さないための安全弁
 * （凍結宣言側の need-already-set スキップと対になる）。
 *
 * @param hasNeed 対象ユニットに need が付いているか
 */
export function buildOtherActions(hasNeed: boolean): OtherAction[] {
	return hasNeed ? ["note"] : ["isolate", "note"];
}

/**
 * CodeLens の「その他」メニュー（QuickPick）を開き、選択されたアクションを実行する。
 * 低頻度アクション（isolate 宣言・note 編集）を1つの CodeLens に集約し、
 * マーカー行のボタン列が長くなるのを防ぐ（ADR-260719-01）。
 * 原文・訳文の双方で同じメニューを提供する（原文側 isolate は sync の伝播停止・ADR-260706-02）。
 *
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensOtherActionsCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}
		const document = activeEditor.document;
		const marker = getMarkerAtLine(document, range.start.line);
		if (!marker?.hash) {
			vscode.window.showWarningMessage(vscode.l10n.t("Could not find a unit at this position."));
			return;
		}

		// isolate の意味は方向で異なる（訳文は原文更新に追従しない・原文は訳文へ伝播しない）ため文言を分ける
		const isSourceFile = isSourceDocument(document);

		const items: OtherActionItem[] = buildOtherActions(Boolean(marker.need)).map((action) =>
			action === "isolate"
				? {
						label: vscode.l10n.t("$(circle-slash) Mark as Isolated"),
						detail: isSourceFile
							? vscode.l10n.t("Freeze this unit and stop propagating it to the translations.")
							: vscode.l10n.t("Freeze this unit and stop following source updates."),
						action,
					}
				: {
						label: vscode.l10n.t("$(comment) Note"),
						detail: vscode.l10n.t("Add or edit a note for this unit (shown to the AI during audit)."),
						action,
					},
		);

		const picked = await vscode.window.showQuickPick(items, {
			title: vscode.l10n.t("Unit actions"),
			placeHolder: vscode.l10n.t("Select an action for this unit"),
		});
		if (!picked) {
			return;
		}

		if (picked.action === "isolate") {
			await declareIsolateAtMarker(document.uri.fsPath, marker.hash, isSourceFile);
			return;
		}
		await promptAndSaveNote(marker.hash, document.uri.fsPath);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to run the selected action: {0}", errorMessage));
	}
}

/**
 * ドキュメントが原文（ソース）側かどうかを判定する。ワークスペース未設定等では訳文扱い。
 */
function isSourceDocument(document: vscode.TextDocument): boolean {
	try {
		return new FileExplorer().isSourceFile(document.uri.fsPath, Configuration.getInstance());
	} catch {
		return false;
	}
}

/**
 * 指定ユニットに need:isolate を宣言し、結果を通知する（「その他」メニューから利用）。
 *
 * @param absPath 対象ファイルの絶対パス
 * @param unitHash 宣言対象ユニットの hash
 * @param isSourceFile 原文側かどうか（通知文言の出し分けに使う）
 */
async function declareIsolateAtMarker(absPath: string, unitHash: string, isSourceFile: boolean): Promise<void> {
	const result = await getFileHandler(absPath).declareIsolate(absPath, {
		kind: "unit",
		hash: unitHash,
	});
	if (!result.declared) {
		vscode.window.showWarningMessage(describeIsolateFailure(result.reason));
		return;
	}
	vscode.window.showInformationMessage(
		isSourceFile
			? vscode.l10n.t("Unit marked as isolated. It will no longer propagate to the translations.")
			: vscode.l10n.t("Unit marked as isolated. It will no longer follow source updates."),
	);
}

/**
 * ユニット hash に対する note 入力ダイアログを開き、保存する共通処理。
 * note は `.mdait/unit-registry` にユニットの hash キーで保存され、audit 実行時に
 * AI へ文脈として渡される。本文・マーカーは変更しない。空文字で削除。
 * @param hash 対象ユニットの hash
 * @param refreshFsPath 保存後に status/CodeLens を更新するファイルパス
 */
async function promptAndSaveNote(hash: string, refreshFsPath: string): Promise<void> {
	const registry = UnitRegistryManager.getInstance();
	const existing = await registry.loadNote(hash);
	const input = await vscode.window.showInputBox({
		title: vscode.l10n.t("Unit note"),
		prompt: vscode.l10n.t(
			"Leave a note about this unit. It is passed to the AI during audit — explain any intentional deviation here so the audit treats it as intended. Empty to remove.",
		),
		value: existing ?? "",
		placeHolder: vscode.l10n.t("e.g. This section is intentionally omitted from the source."),
	});
	// Escape（undefined）はキャンセル。空文字は削除。
	if (input === undefined) {
		return;
	}

	await registry.saveNote(hash, input.trim() === "" ? null : input);
	// hover は registry から note を直接読むため、status/CodeLens のリフレッシュのみ行う
	await StatusManager.getInstance().refreshFileStatus(refreshFsPath);

	vscode.window.showInformationMessage(
		input.trim() === ""
			? vscode.l10n.t("Note removed.")
			: vscode.l10n.t("Note saved. It will be shown to the AI during audit."),
	);
}

/**
 * ファイルパスとユニット hash から note 編集へジャンプするコマンド。
 * AIレビューのレポート（仮想ドキュメント）の CodeLens から呼ばれ、
 * 対象ファイルを開いて該当ユニットへスクロールし、note 入力を開く。
 * @param filePath 対象ターゲットファイルの絶対パス
 * @param unitHash 対象ユニットの hash
 */
export async function editNoteForUnitCommand(filePath: string, unitHash: string): Promise<void> {
	try {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		const editor = await vscode.window.showTextDocument(document, {
			preview: false,
		});

		// hash から該当ユニットの行を特定してスクロール（見つからなくても note 編集は続行）
		const line = findUnitLineByHash(document, unitHash);
		if (line !== null) {
			const position = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		}

		await promptAndSaveNote(unitHash, filePath);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to save note: {0}", errorMessage));
	}
}

/**
 * ドキュメント内で hash が一致するユニットの開始行を返す（埋め込み/外部いずれも対応）。
 */
function findUnitLineByHash(document: vscode.TextDocument, hash: string): number | null {
	const config = Configuration.getInstance();
	let role: "source" | "target" = "target";
	try {
		role = new FileExplorer().isSourceFile(document.uri.fsPath, config) ? "source" : "target";
	} catch {
		// ワークスペース未設定等は target 扱い
	}
	const io = resolveMarkerIO(config, document.uri.fsPath, role);
	const parsed = markdownParser.parse(document.getText(), config, io.provider, io.ctx);
	const unit = parsed.units.find((u) => u.marker?.hash === hash);
	return unit ? unit.startLine : null;
}

/**
 * CodeLensからターゲットユニット（訳文）へジャンプするコマンド
 *
 * ソースファイルのマーカー（特に hash 情報）から対応するターゲットファイルの訳文ユニットを特定し、
 * 対応するターゲットユニットの位置へエディタをジャンプさせる。
 *
 * 複数のターゲットユニットが存在する場合は、設定で定義されたターゲットの優先順位に従い、
 * 「設定順で最初に一致したターゲットユニット」を自動的に選択してジャンプする。
 * ユーザーに選択肢を提示するダイアログ等は表示せず、最初に一致したもののみを対象とする。
 *
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensJumpToTargetCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		// クリック位置および左側の可視範囲から相対オフセットを取得
		const clickedPos = new vscode.Position(range.start.line, 0);
		const leftVisible = activeEditor.visibleRanges[0];
		const document = activeEditor.document;
		const marker = getMarkerAtLine(document, range.start.line);
		if (!marker?.hash) {
			vscode.window.showWarningMessage(vscode.l10n.t("No hash found in marker."));
			return;
		}

		const statusManager = StatusManager.getInstance();
		const config = Configuration.getInstance();
		const explorer = new FileExplorer();

		// ソースファイルから対応するTransPair配列を取得（設定順）
		const sourceFilePath = document.uri.fsPath;
		const transPairs = explorer.getTransPairsFromSource(sourceFilePath, config);

		// 優先ターゲットファイルパス配列を構築（設定順）
		const preferredTargetPaths: string[] = [];
		for (const pair of transPairs) {
			const targetPath = explorer.getTargetPath(sourceFilePath, pair);
			if (targetPath) {
				preferredTargetPaths.push(targetPath);
			}
		}

		// from属性がソースハッシュと一致するターゲットユニットを検索
		const tree = statusManager.getStatusItemTree();
		const targetUnit = tree.getTargetUnitByFromHash(marker.hash, preferredTargetPaths);
		if (!targetUnit || !targetUnit.filePath) {
			vscode.window.showWarningMessage(vscode.l10n.t("Target unit not found for hash: {0}", marker.hash));
			return;
		}

		const targetDoc = await vscode.workspace.openTextDocument(targetUnit.filePath);
		const jumpLine = targetUnit.startLine ?? 0;
		const position = new vscode.Position(jumpLine, 0);
		const selection = new vscode.Selection(position, position);

		// 右側（Beside）に分割して開き、カーソルをジャンプ位置へ
		const editor = await vscode.window.showTextDocument(targetDoc, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true,
			preserveFocus: true,
			selection,
		});

		// 左側の相対位置に同期するように右側のスクロール位置を調整
		if (leftVisible) {
			const offset = Math.max(0, clickedPos.line - leftVisible.start.line);
			const desiredTop = Math.max(0, Math.min(jumpLine - offset, targetDoc.lineCount - 1));
			const topPos = new vscode.Position(desiredTop, 0);
			editor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
		} else {
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		}

		// ソースユニット（左側）とターゲットユニット（右側）の両方をハイライト
		const sourceStartLine = range.start.line;
		const sourceEndLine = findUnitEndLine(document, sourceStartLine);
		const targetStartLine = targetUnit.startLine ?? 0;
		const targetEndLine = targetUnit.endLine ?? 0;

		highlightUnit(activeEditor, sourceStartLine, sourceEndLine, "target");
		highlightUnit(editor, targetStartLine, targetEndLine, "source");

		// ハイライト範囲を保存
		_highlightInfo = {
			leftEditor: activeEditor,
			rightEditor: editor,
			leftRange: new vscode.Range(sourceStartLine, 0, sourceEndLine, Number.MAX_SAFE_INTEGER),
			rightRange: new vscode.Range(targetStartLine, 0, targetEndLine, Number.MAX_SAFE_INTEGER),
		};

		// 左→右の継続スクロール同期を開始
		startOneWayScrollSync(activeEditor, editor, clickedPos.line, jumpLine);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Jump to target failed: {0}", errorMessage));
	}
}

/**
 * CodeLensからソースユニットへジャンプするコマンド
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensJumpToSourceCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		// クリック位置および左側の可視範囲から相対オフセットを取得（左側は変更しない）
		const clickedPos = new vscode.Position(range.start.line, 0);
		const leftVisible = activeEditor.visibleRanges[0];
		const document = activeEditor.document;
		const marker = getMarkerAtLine(document, range.start.line);
		if (!marker?.from) {
			vscode.window.showWarningMessage(vscode.l10n.t("No source hash found in marker."));
			return;
		}

		const statusManager = StatusManager.getInstance();
		// 現在のターゲットファイルから対応するソースファイルパスをFileExplorerで推定
		const targetFilePath = document.uri.fsPath;
		const config = Configuration.getInstance();
		const explorer = new FileExplorer();
		const pair = explorer.getTransPairFromTarget(targetFilePath, config);
		const preferredSourcePath = pair ? (explorer.getSourcePath(targetFilePath, pair) ?? undefined) : undefined;

		// 優先パスでユニットを検索し、見つからなければ全体検索
		const tree = statusManager.getStatusItemTree();
		const sourceUnit = preferredSourcePath
			? (tree.getUnit(marker.from, preferredSourcePath) ?? tree.getUnitByHash(marker.from))
			: tree.getUnitByHash(marker.from);
		if (!sourceUnit || !sourceUnit.filePath) {
			vscode.window.showWarningMessage(vscode.l10n.t("Source unit not found for hash: {0}", marker.from));
			return;
		}

		const targetDoc = await vscode.workspace.openTextDocument(sourceUnit.filePath);
		const jumpLine = sourceUnit.startLine ?? 0;
		const position = new vscode.Position(jumpLine, 0);
		const selection = new vscode.Selection(position, position);

		// 右側（Beside）に分割して開き、カーソルをジャンプ位置へ
		const editor = await vscode.window.showTextDocument(targetDoc, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true,
			preserveFocus: true,
			selection,
		});

		// 左側の相対位置に同期するように右側のスクロール位置を調整
		if (leftVisible) {
			const offset = Math.max(0, clickedPos.line - leftVisible.start.line);
			const desiredTop = Math.max(0, Math.min(jumpLine - offset, targetDoc.lineCount - 1));
			const topPos = new vscode.Position(desiredTop, 0);
			editor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
		} else {
			// 可視範囲が取れない場合は中央表示にフォールバック
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		}

		// ターゲットユニット（左側）と原文ユニット（右側）の両方をハイライト
		const targetStartLine = range.start.line;
		const targetEndLine = findUnitEndLine(document, targetStartLine);
		const sourceStartLine = sourceUnit.startLine ?? 0;
		const sourceEndLine = sourceUnit.endLine ?? 0;

		highlightUnit(activeEditor, targetStartLine, targetEndLine, "target");
		highlightUnit(editor, sourceStartLine, sourceEndLine, "source");

		// ハイライト範囲を保存
		_highlightInfo = {
			leftEditor: activeEditor,
			rightEditor: editor,
			leftRange: new vscode.Range(targetStartLine, 0, targetEndLine, Number.MAX_SAFE_INTEGER),
			rightRange: new vscode.Range(sourceStartLine, 0, sourceEndLine, Number.MAX_SAFE_INTEGER),
		};

		// 左→右の継続スクロール同期を開始
		startOneWayScrollSync(activeEditor, editor, clickedPos.line, jumpLine);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Jump to source failed: {0}", errorMessage));
	}
}

// 左右エディタのスクロール同期（左→右の一方向）に使用するディスポーザブル
let _scrollSyncDisposable: vscode.Disposable | undefined;

// 左側（ターゲット）ハイライト用のデコレーションタイプ
let _targetHighlightDecorationType: vscode.TextEditorDecorationType | undefined;
// 右側（原文）ハイライト用のデコレーションタイプ
let _sourceHighlightDecorationType: vscode.TextEditorDecorationType | undefined;

// ハイライト範囲とエディタの情報を保持
let _highlightInfo:
	| {
			leftEditor: vscode.TextEditor;
			rightEditor: vscode.TextEditor;
			leftRange: vscode.Range;
			rightRange: vscode.Range;
	  }
	| undefined;

/**
 * ユニットの終了行を見つける（次のマーカーまたはファイル末尾）
 * コードブロック内のマーカーは無視する。
 * @param document 対象ドキュメント
 * @param startLine ユニットの開始行
 * @returns ユニットの終了行
 */
function findUnitEndLine(document: vscode.TextDocument, startLine: number): number {
	const codeBlockLines = getCodeBlockLineSet(document.getText());

	// 次の行から次のマーカーを探す
	for (let i = startLine + 1; i < document.lineCount; i++) {
		if (codeBlockLines.has(i)) {
			continue;
		}
		const lineText = document.lineAt(i).text;
		if (MdaitMarker.parse(lineText)) {
			return i - 1; // マーカーの前の行がユニットの終了
		}
	}
	return document.lineCount - 1; // ファイル末尾まで
}

/**
 * ユニットをハイライトする
 * @param editor ハイライトを適用するエディタ
 * @param startLine ユニットの開始行
 * @param endLine ユニットの終了行
 * @param side 'target'（左側）または'source'（右側）
 */
function highlightUnit(editor: vscode.TextEditor, startLine: number, endLine: number, side: "target" | "source"): void {
	const decorationType = side === "target" ? _targetHighlightDecorationType : _sourceHighlightDecorationType;

	// 既存のデコレーションを破棄
	if (side === "target") {
		_targetHighlightDecorationType?.dispose();
	} else {
		_sourceHighlightDecorationType?.dispose();
	}

	// ハイライト用のデコレーションタイプを作成（マイルドな色）
	const newDecorationType = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
		isWholeLine: true,
	});

	if (side === "target") {
		_targetHighlightDecorationType = newDecorationType;
	} else {
		_sourceHighlightDecorationType = newDecorationType;
	}

	// ユニット全体の範囲を作成
	const range = new vscode.Range(
		new vscode.Position(startLine, 0),
		new vscode.Position(endLine, Number.MAX_SAFE_INTEGER),
	);

	// ハイライトを適用
	editor.setDecorations(newDecorationType, [range]);
}

/**
 * すべてのハイライトを解除する
 */
function clearAllHighlights(): void {
	_targetHighlightDecorationType?.dispose();
	_targetHighlightDecorationType = undefined;
	_sourceHighlightDecorationType?.dispose();
	_sourceHighlightDecorationType = undefined;
	_highlightInfo = undefined;
}

/**
 * 左エディタのスクロールに右エディタを追従させる一方向同期を開始する
 * @param left 左側のエディタ（基準）
 * @param right 右側のエディタ（追従）
 * @param anchorLeftLine 左側の基準行（クリック行）
 * @param anchorRightLine 右側の基準行（ジャンプ行）
 */
function startOneWayScrollSync(
	left: vscode.TextEditor,
	right: vscode.TextEditor,
	anchorLeftLine: number,
	anchorRightLine: number,
): void {
	// 既存の同期を解除
	_scrollSyncDisposable?.dispose();

	let updating = false;

	const visibleRangeSub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
		if (e.textEditor !== left) return;
		if (updating) return;

		const leftVisible = left.visibleRanges[0];
		if (!leftVisible) return;

		const offset = anchorLeftLine - leftVisible.start.line;
		const desiredTop = Math.max(0, Math.min(anchorRightLine - offset, right.document.lineCount - 1));
		const topPos = new vscode.Position(desiredTop, 0);

		updating = true;
		try {
			right.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
		} finally {
			// 微小遅延で解除（イベントループ1tick後）
			setTimeout(() => {
				updating = false;
			}, 0);
		}
	});

	// 右側がアクティブになった後のスクロールで同期解除
	let rightActive = vscode.window.activeTextEditor === right;
	const activeEditorSub = vscode.window.onDidChangeActiveTextEditor((ed) => {
		rightActive = ed === right;
	});
	const rightVisibleRangeSub = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
		if (e.textEditor !== right) return;
		if (updating) return; // 自動追従中は無視
		if (!rightActive) return; // 右がアクティブでなければ解除しない
		clearAllHighlights(); // ハイライト解除
		_scrollSyncDisposable?.dispose();
		_scrollSyncDisposable = undefined;
	});

	// どちらかが不可視になった/閉じたら同期解除
	const visibleEditorsSub = vscode.window.onDidChangeVisibleTextEditors(() => {
		const vis = vscode.window.visibleTextEditors;
		if (!vis.includes(left) || !vis.includes(right)) {
			clearAllHighlights(); // ハイライト解除
			_scrollSyncDisposable?.dispose();
			_scrollSyncDisposable = undefined;
		}
	});

	// カーソル位置が変わった時、ハイライト範囲外に移動したら解除
	const selectionChangeSub = vscode.window.onDidChangeTextEditorSelection((e) => {
		if (!_highlightInfo) return;

		const { leftEditor, rightEditor, leftRange, rightRange } = _highlightInfo;

		// 左側または右側のエディタでカーソルが移動した場合
		if (e.textEditor === leftEditor || e.textEditor === rightEditor) {
			const selection = e.selections[0];
			if (!selection) return;

			const cursorLine = selection.active.line;
			const isInLeftRange =
				e.textEditor === leftEditor && cursorLine >= leftRange.start.line && cursorLine <= leftRange.end.line;
			const isInRightRange =
				e.textEditor === rightEditor && cursorLine >= rightRange.start.line && cursorLine <= rightRange.end.line;

			// ハイライト範囲外に移動した場合
			if (!isInLeftRange && !isInRightRange) {
				clearAllHighlights();
				_scrollSyncDisposable?.dispose();
				_scrollSyncDisposable = undefined;
			}
		}
	});

	_scrollSyncDisposable = vscode.Disposable.from(
		visibleRangeSub,
		rightVisibleRangeSub,
		activeEditorSub,
		visibleEditorsSub,
		selectionChangeSub,
	);
}

/**
 * CodeLensからfrontmatterのneedマーカーをクリアするコマンド
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensClearFrontmatterNeedCommand(_range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		const filePath = activeEditor.document.uri.fsPath;
		const result = await getFileHandler(filePath).resolveNeed(filePath, {
			targets: [{ kind: "frontmatter" }],
			needs: ALL_RESOLVABLE_NEEDS,
		});
		reportResolveOutcome(result.resolved.length);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to clear frontmatter need marker: {0}", errorMessage));
	}
}

/**
 * CodeLensからソースfrontmatterへジャンプするコマンド
 * frontmatter領域を比較ビューで表示する
 * @param range CodeLensが表示されている行の範囲
 */
export async function codeLensJumpToSourceFrontmatterCommand(range: vscode.Range): Promise<void> {
	try {
		const activeEditor = vscode.window.activeTextEditor;
		if (!activeEditor) {
			vscode.window.showErrorMessage(vscode.l10n.t("No active editor found."));
			return;
		}

		const document = activeEditor.document;
		const config = Configuration.getInstance();

		// Markdownファイルを読み込み＆パース
		const content = document.getText();
		const markdown = markdownParser.parse(content, config);

		if (!markdown.frontMatter) {
			vscode.window.showWarningMessage(vscode.l10n.t("No frontmatter found."));
			return;
		}

		// frontmatterマーカーを取得
		const marker = parseFrontmatterMarker(markdown.frontMatter);
		if (!marker?.from) {
			vscode.window.showWarningMessage(vscode.l10n.t("No source hash found in frontmatter marker."));
			return;
		}

		// クリック位置と可視範囲の取得
		const clickedPos = new vscode.Position(range.start.line, 0);
		const leftVisible = activeEditor.visibleRanges[0];

		// ソースファイルパスを取得
		const targetFilePath = document.uri.fsPath;
		const explorer = new FileExplorer();
		const pair = explorer.getTransPairFromTarget(targetFilePath, config);
		const sourceFilePath = pair ? explorer.getSourcePath(targetFilePath, pair) : null;

		if (!sourceFilePath) {
			vscode.window.showWarningMessage(vscode.l10n.t("Source file not found."));
			return;
		}

		// ソースファイルを開く（frontmatter領域は0行目から開始）
		const sourceDoc = await vscode.workspace.openTextDocument(sourceFilePath);
		const sourceContent = sourceDoc.getText();
		const sourceMarkdown = markdownParser.parse(sourceContent, config);

		if (!sourceMarkdown.frontMatter) {
			vscode.window.showWarningMessage(vscode.l10n.t("Source frontmatter not found."));
			return;
		}

		// frontmatter領域の行範囲を取得
		const targetStartLine = markdown.frontMatter.startLine;
		const targetEndLine = markdown.frontMatter.endLine;
		const sourceStartLine = sourceMarkdown.frontMatter.startLine;
		const sourceEndLine = sourceMarkdown.frontMatter.endLine;

		// 右側（Beside）に分割して開く
		const position = new vscode.Position(sourceStartLine, 0);
		const selection = new vscode.Selection(position, position);

		const editor = await vscode.window.showTextDocument(sourceDoc, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true,
			preserveFocus: true,
			selection,
		});

		// スクロール位置を調整
		if (leftVisible) {
			const offset = Math.max(0, clickedPos.line - leftVisible.start.line);
			const desiredTop = Math.max(0, Math.min(sourceStartLine - offset, sourceDoc.lineCount - 1));
			const topPos = new vscode.Position(desiredTop, 0);
			editor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
		} else {
			editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
		}

		// frontmatter領域をハイライト（endLine-1まで、閉じ---まで）
		const actualTargetEndLine = Math.max(targetStartLine, targetEndLine - 1);
		const actualSourceEndLine = Math.max(sourceStartLine, sourceEndLine - 1);
		highlightUnit(activeEditor, targetStartLine, actualTargetEndLine, "target");
		highlightUnit(editor, sourceStartLine, actualSourceEndLine, "source");

		// ハイライト範囲を保存
		const targetLineLength = document.lineAt(actualTargetEndLine).text.length;
		const sourceLineLength = sourceDoc.lineAt(actualSourceEndLine).text.length;
		_highlightInfo = {
			leftEditor: activeEditor,
			rightEditor: editor,
			leftRange: new vscode.Range(targetStartLine, 0, actualTargetEndLine, targetLineLength),
			rightRange: new vscode.Range(sourceStartLine, 0, actualSourceEndLine, sourceLineLength),
		};

		// 左→右の継続スクロール同期を開始
		startOneWayScrollSync(activeEditor, editor, clickedPos.line, sourceStartLine);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Jump to source frontmatter failed: {0}", errorMessage));
	}
}

/** 絶対パスをワークスペース相対パス（/区切り）に変換 */
function toWorkspaceRelativePath(absolutePath: string): string | null {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspaceRoot) {
		return null;
	}
	return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}

/**
 * 非Markdownファイル全体を翻訳するCodeLensコマンド。
 * 既存の transCommand に委譲し、PlainFileHandler に自動ディスパッチされる。
 */
export async function codeLensTranslateFileCommand(uri: vscode.Uri): Promise<void> {
	try {
		await transCommand(uri);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Translation failed: {0}", errorMessage));
	}
}

/**
 * 非Markdownファイルの need マーカーをクリアするCodeLensコマンド。
 * 実際の書き換え・保存・ステータス更新はハンドラ側が行う。
 */
export async function codeLensClearFileNeedCommand(uri: vscode.Uri): Promise<void> {
	try {
		const result = await getFileHandler(uri.fsPath).resolveNeed(uri.fsPath, {
			targets: [{ kind: "file" }],
			needs: ALL_RESOLVABLE_NEEDS,
		});
		reportResolveOutcome(result.resolved.length);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to clear need marker: {0}", errorMessage));
	}
}

/**
 * 非Markdownファイルからソースファイルへジャンプするコマンド。
 * Beside で開き、双方をハイライトしてスクロール同期する（.md と同等の挙動）。
 */
export async function codeLensJumpToSourceFileCommand(uri: vscode.Uri): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const explorer = new FileExplorer();

		const pair = explorer.getTransPairFromTarget(uri.fsPath, config);
		const sourceFilePath = pair ? explorer.getSourcePath(uri.fsPath, pair) : null;
		if (!sourceFilePath) {
			vscode.window.showWarningMessage(vscode.l10n.t("Source file not found."));
			return;
		}

		await openSideBySideAndSync(uri, vscode.Uri.file(sourceFilePath), "source");
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Jump to source failed: {0}", errorMessage));
	}
}

/**
 * 非Markdownファイルからターゲットファイルへジャンプするコマンド。
 * 設定順で最初に実在するターゲットを選択する（.md の jumpToTarget と同じポリシー）。
 */
export async function codeLensJumpToTargetFileCommand(uri: vscode.Uri): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const explorer = new FileExplorer();

		const pairs = explorer.getTransPairsFromSource(uri.fsPath, config);
		let targetFilePath: string | null = null;
		for (const pair of pairs) {
			const candidate = explorer.getTargetPath(uri.fsPath, pair);
			if (candidate) {
				try {
					const stat = await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
					if (stat.type === vscode.FileType.File) {
						targetFilePath = candidate;
						break;
					}
				} catch {
					// 存在しないターゲットはスキップ
				}
			}
		}

		if (!targetFilePath) {
			vscode.window.showWarningMessage(vscode.l10n.t("Target file not found."));
			return;
		}

		await openSideBySideAndSync(uri, vscode.Uri.file(targetFilePath), "target");
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Jump to target failed: {0}", errorMessage));
	}
}

/**
 * 左側エディタの隣に右側ファイルを開き、両方をハイライト＋スクロール同期する。
 * @param leftUri 現在開いているファイル
 * @param rightUri 隣に開くファイル
 * @param rightSide 右側のハイライト種別
 */
async function openSideBySideAndSync(
	leftUri: vscode.Uri,
	rightUri: vscode.Uri,
	rightSide: "source" | "target",
): Promise<void> {
	const activeEditor = vscode.window.activeTextEditor;
	if (!activeEditor || activeEditor.document.uri.fsPath !== leftUri.fsPath) {
		// アクティブでなければハイライト無しで開くだけ
		const doc = await vscode.workspace.openTextDocument(rightUri);
		await vscode.window.showTextDocument(doc, {
			viewColumn: vscode.ViewColumn.Beside,
			preview: true,
			preserveFocus: true,
		});
		return;
	}

	const leftVisible = activeEditor.visibleRanges[0];
	const rightDoc = await vscode.workspace.openTextDocument(rightUri);
	const jumpLine = 0;
	const position = new vscode.Position(jumpLine, 0);
	const selection = new vscode.Selection(position, position);

	const rightEditor = await vscode.window.showTextDocument(rightDoc, {
		viewColumn: vscode.ViewColumn.Beside,
		preview: true,
		preserveFocus: true,
		selection,
	});

	const clickedLine = 0;
	if (leftVisible) {
		const offset = Math.max(0, clickedLine - leftVisible.start.line);
		const desiredTop = Math.max(0, Math.min(jumpLine - offset, rightDoc.lineCount - 1));
		const topPos = new vscode.Position(desiredTop, 0);
		rightEditor.revealRange(new vscode.Range(topPos, topPos), vscode.TextEditorRevealType.AtTop);
	} else {
		rightEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
	}

	const leftSide: "source" | "target" = rightSide === "source" ? "target" : "source";
	const leftStart = 0;
	const leftEnd = Math.max(0, activeEditor.document.lineCount - 1);
	const rightStart = 0;
	const rightEnd = Math.max(0, rightDoc.lineCount - 1);

	highlightUnit(activeEditor, leftStart, leftEnd, leftSide);
	highlightUnit(rightEditor, rightStart, rightEnd, rightSide);

	_highlightInfo = {
		leftEditor: activeEditor,
		rightEditor,
		leftRange: new vscode.Range(leftStart, 0, leftEnd, Number.MAX_SAFE_INTEGER),
		rightRange: new vscode.Range(rightStart, 0, rightEnd, Number.MAX_SAFE_INTEGER),
	};

	startOneWayScrollSync(activeEditor, rightEditor, clickedLine, jumpLine);
}
