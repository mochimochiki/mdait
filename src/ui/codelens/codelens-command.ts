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
import { FRONTMATTER_MARKER_KEY, parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { markdownParser } from "../../core/markdown/parser";
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
		const lineText = document.lineAt(range.start.line).text;

		// マーカーをパースしてneedを削除
		const marker = MdaitMarker.parse(lineText);
		if (!marker || !marker.need) {
			vscode.window.showWarningMessage(vscode.l10n.t("No need marker found to clear."));
			return;
		}

		// needをnullに設定して文字列化
		marker.need = null;
		const newLineText = marker.toString();

		// 行全体を置換
		await activeEditor.edit((editBuilder) => {
			const lineRange = new vscode.Range(
				range.start.line,
				0,
				range.start.line,
				document.lineAt(range.start.line).text.length,
			);
			editBuilder.replace(lineRange, newLineText);
		});

		// ドキュメントを保存
		await document.save();
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to clear need marker: {0}", errorMessage));
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
 * @param document 対象ドキュメント
 * @param startLine ユニットの開始行
 * @returns ユニットの終了行
 */
function findUnitEndLine(document: vscode.TextDocument, startLine: number): number {
	// 次の行から次のマーカーを探す
	for (let i = startLine + 1; i < document.lineCount; i++) {
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
export async function codeLensClearFrontmatterNeedCommand(range: vscode.Range): Promise<void> {
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
			return;
		}

		// frontmatterマーカーを取得してneedをクリア
		const marker = parseFrontmatterMarker(markdown.frontMatter);
		if (!marker || !marker.need) {
			vscode.window.showWarningMessage(vscode.l10n.t("No need marker found to clear."));
			return;
		}

		marker.removeNeedTag();
		// コメント形式ではなく、マーカーの内容のみを構築して格納
		let markerContent = marker.hash;
		if (marker.from) {
			markerContent += ` from:${marker.from}`;
		}
		if (marker.need) {
			markerContent += ` need:${marker.need}`;
		}
		markdown.frontMatter.set(FRONTMATTER_MARKER_KEY, markerContent);

		// ファイルを保存
		const updatedContent = markdownParser.stringify(markdown);
		await activeEditor.edit((editBuilder) => {
			const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
			editBuilder.replace(fullRange, updatedContent);
		});

		await document.save();
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
