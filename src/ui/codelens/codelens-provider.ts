/**
 * @file codelens-provider.ts
 * @description
 *   Markdownファイル内のmdaitマーカーに対してCodeLensを表示するプロバイダー。
 *   - mdaitマーカー行を検出し、翻訳が必要なユニットに「翻訳」ボタンを表示する
 *   - VS CodeのCodeLens機能を利用して、テスト実行ボタンのような直感的なUIを提供
 * @module ui/codelens/codelens-provider
 */
import * as vscode from "vscode";
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

		// 各行をスキャンしてmdaitマーカーを検出
		for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
			if (token.isCancellationRequested) {
				return [];
			}

			const line = document.lineAt(lineIndex);
			const marker = MdaitMarker.parse(line.text);

			if (marker) {
				const range = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);

				// fromハッシュがある場合はソースへ移動ボタン
				if (marker.from) {
					codeLenses.push(
						new vscode.CodeLens(range, {
							title: vscode.l10n.t("$(symbol-reference) Source"),
							tooltip: vscode.l10n.t("Tooltip: Jump to original source unit"),
							command: "mdait.codelens.jumpToSource",
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
							command: "mdait.codelens.translate",
							arguments: [range],
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
							command: "mdait.codelens.clearNeed",
							arguments: [range],
						}),
					);
				}
			}
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
		if (need === "solve-conflict") {
			return {
				title: vscode.l10n.t("$(check) Mark as Conflict Resolved"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit's conflict as resolved"),
			};
		}
		// デフォルト
		return {
			title: vscode.l10n.t("$(check) Mark as Completed"),
			tooltip: vscode.l10n.t("Tooltip: Mark this unit as completed"),
		};
	}
}
