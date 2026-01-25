/**
 * @file codelens-provider.ts
 * @description
 *   Markdownファイル内のmdaitマーカーに対してCodeLensを表示するプロバイダー。
 *   - mdaitマーカー行を検出し、翻訳が必要なユニットに「翻訳」ボタンを表示する
 *   - frontmatter内のmdait.frontマーカーにもCodeLensを表示する
 *   - VS CodeのCodeLens機能を利用して、テスト実行ボタンのような直感的なUIを提供
 * @module ui/codelens/codelens-provider
 */
import * as vscode from "vscode";
import { FrontMatter } from "../../core/markdown/front-matter";
import { FRONTMATTER_MARKER_KEY, parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../core/markdown/mdait-marker";

/**
 * mdaitマーカーのCodeLensを提供するプロバイダー
 */
export class MdaitCodeLensProvider implements vscode.CodeLensProvider {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	/**
	 * CodeLensの変更を通知する
	 */
	public refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	/**
	 * ドキュメント内のCodeLensを提供する
	 * @param document 対象ドキュメント
	 * @param token キャンセレーショントークン
	 * @returns CodeLensの配列
	 */
	public provideCodeLenses(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.CodeLens[]> {
		// Markdownファイル以外は対象外
		if (document.languageId !== "markdown") {
			return [];
		}

		const codeLenses: vscode.CodeLens[] = [];

		// FrontMatterクラスを使って正確なfrontmatter範囲を取得
		const content = document.getText();
		const { frontMatter } = FrontMatter.parse(content);

		// frontmatter内のmdait.frontマーカーを検出（FrontMatterクラスの範囲情報を利用）
		if (frontMatter && !frontMatter.isEmpty() && frontMatter.has(FRONTMATTER_MARKER_KEY)) {
			const marker = parseFrontmatterMarker(frontMatter);
			if (marker) {
				// frontmatterの開始行（最初の---の行）にCodeLensを表示
				const frontmatterCodeLenses = this.createFrontmatterCodeLenses(marker, frontMatter.startLine, document);
				codeLenses.push(...frontmatterCodeLenses);
			}
		}

		// 各行をスキャンしてmdaitマーカーを検出
		for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
			if (token.isCancellationRequested) {
				return [];
			}

			const line = document.lineAt(lineIndex);

			// 通常のmdaitマーカーを検出
			const marker = MdaitMarker.parse(line.text);

			if (marker) {
				const range = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);
				const unitCodeLenses = this.createCodeLensesForMarker(
					marker,
					range,
					"mdait.codelens.jumpToSource",
					"mdait.codelens.translate",
					"mdait.codelens.clearNeed",
					[range],
				);
				codeLenses.push(...unitCodeLenses);
			}
		}

		return codeLenses;
	}

	/**
	 * パース済みのfrontmatterマーカーからCodeLensを作成
	 * @param marker パース済みのfrontmatterマーカー
	 * @param lineIndex 行番号
	 * @param document ドキュメント
	 * @returns CodeLensの配列
	 */
	private createFrontmatterCodeLenses(
		marker: MdaitMarker,
		lineIndex: number,
		document: vscode.TextDocument,
	): vscode.CodeLens[] {
		const line = document.lineAt(lineIndex);
		const range = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);

		return this.createCodeLensesForMarker(
			marker,
			range,
			"mdait.codelens.jumpToSourceFrontmatter",
			"mdait.translate.frontmatter",
			"mdait.codelens.clearFrontmatterNeed",
			[document.uri],
		);
	}

	/**
	 * マーカーからCodeLensを作成する共通ロジック
	 * @param marker mdaitマーカー
	 * @param range CodeLensの範囲
	 * @param jumpCommand ソースへジャンプするコマンド
	 * @param translateCommand 翻訳コマンド
	 * @param clearNeedCommand needクリアコマンド
	 * @param translateArgs 翻訳コマンドの引数
	 * @returns CodeLensの配列
	 */
	private createCodeLensesForMarker(
		marker: MdaitMarker,
		range: vscode.Range,
		jumpCommand: string,
		translateCommand: string,
		clearNeedCommand: string,
		translateArgs: (vscode.Range | vscode.Uri)[],
	): vscode.CodeLens[] {
		const codeLenses: vscode.CodeLens[] = [];

		// fromハッシュがある場合はソースへ移動ボタン
		if (marker.from) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(symbol-reference) Source"),
					tooltip: vscode.l10n.t("Tooltip: Jump to original source unit"),
					command: jumpCommand,
					arguments: [range],
				}),
			);
		}

		// 翻訳が必要な場合は翻訳ボタン
		if (marker.needsTranslation()) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(play) Translate"),
					tooltip: vscode.l10n.t("Tooltip: Translate this unit using AI"),
					command: translateCommand,
					arguments: translateArgs,
				}),
			);
		}

		// needマーカーがある場合は完了ボタン
		if (marker.need) {
			const { title, tooltip } = this.getCompletionButtonLabel(marker.need);
			codeLenses.push(
				new vscode.CodeLens(range, {
					title,
					tooltip,
					command: clearNeedCommand,
					arguments: [range],
				}),
			);
		}

		return codeLenses;
	}

	/**
	 * CodeLensにコマンドを設定する
	 * @param codeLens 対象のCodeLens
	 * @param token キャンセレーショントークン
	 * @returns コマンドが設定されたCodeLens
	 */
	public resolveCodeLens(
		codeLens: vscode.CodeLens,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.CodeLens> {
		// 既にprovideで設定済みなのでそのまま返す
		return codeLens;
	}

	/**
	 * needマーカーの種類に応じた完了ボタンのラベルとツールチップを取得
	 * @param need needマーカーの値
	 * @returns ボタンのtitleとtooltip
	 */
	private getCompletionButtonLabel(need: string): { title: string; tooltip: string } {
		if (need === "translate") {
			return {
				title: vscode.l10n.t("$(check) Mark as Translated"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit as manually translated"),
			};
		}
		if (need.startsWith("revise@")) {
			return {
				title: vscode.l10n.t("$(check) Mark as Revised"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit as manually revised"),
			};
		}
		if (need === "review") {
			return {
				title: vscode.l10n.t("$(check) Mark as Reviewed"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit as reviewed"),
			};
		}
		// デフォルト
		return {
			title: vscode.l10n.t("$(check) Mark as Completed"),
			tooltip: vscode.l10n.t("Tooltip: Mark this unit as completed"),
		};
	}
}
