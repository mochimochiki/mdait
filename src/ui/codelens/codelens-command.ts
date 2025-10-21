/**
 * @file codelens-command.ts
 * @description
 *   CodeLensから呼び出される翻訳コマンドを提供するモジュール。
 *   - エディタ上の特定位置（Range）から該当ユニットを特定し、既存の翻訳機能を呼び出す
 *   - 既存のtransUnitCommandとの連携により、コア機能を再利用する
 * @module ui/codelens/codelens-command
 */
import * as vscode from "vscode";
import { transUnitCommand } from "../../commands/trans/trans-command";
import { Configuration } from "../../config/configuration";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { StatusManager } from "../../core/status/status-manager";
import { FileExplorer } from "../../utils/file-explorer";

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

		// 指定された行のテキストを取得
		const lineText = document.lineAt(range.start.line).text;

		// マーカーからunitHashを抽出
		const marker = MdaitMarker.parse(lineText);
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
		const lineText = document.lineAt(range.start.line).text;
		const marker = MdaitMarker.parse(lineText);
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

		// 左→右の継続スクロール同期を開始
		startOneWayScrollSync(activeEditor, editor, clickedPos.line, jumpLine);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Jump to source failed: {0}", errorMessage));
	}
}

// 左右エディタのスクロール同期（左→右の一方向）に使用するディスポーザブル
let _scrollSyncDisposable: vscode.Disposable | undefined;

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
		_scrollSyncDisposable?.dispose();
		_scrollSyncDisposable = undefined;
	});

	// どちらかが不可視になった/閉じたら同期解除
	const visibleEditorsSub = vscode.window.onDidChangeVisibleTextEditors(() => {
		const vis = vscode.window.visibleTextEditors;
		if (!vis.includes(left) || !vis.includes(right)) {
			_scrollSyncDisposable?.dispose();
			_scrollSyncDisposable = undefined;
		}
	});

	_scrollSyncDisposable = vscode.Disposable.from(
		visibleRangeSub,
		rightVisibleRangeSub,
		activeEditorSub,
		visibleEditorsSub,
	);
}
