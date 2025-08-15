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
				// need:translateフラグがある場合のみCodeLensを表示
				if (marker.need === "translate") {
					const range = new vscode.Range(lineIndex, 0, lineIndex, line.text.length);
					const codeLens = new vscode.CodeLens(range);

					// コマンドを設定（resolveCodeLensで設定される）
					codeLenses.push(codeLens);
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
		if (token.isCancellationRequested) {
			return codeLens;
		}

		// コマンドを設定
		codeLens.command = {
			title: vscode.l10n.t("$(play) Translate"),
			command: "mdait.codelens.translate",
			arguments: [codeLens.range],
		};

		return codeLens;
	}
}
