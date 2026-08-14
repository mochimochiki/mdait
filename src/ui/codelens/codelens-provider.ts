/**
 * @file codelens-provider.ts
 * @description
 *   Markdownファイル内のmdaitマーカーに対してCodeLensを表示するプロバイダー。
 *   - mdaitマーカー行を検出し、翻訳が必要なユニットに「翻訳」ボタンを表示する
 *   - frontmatter内のmdait.frontマーカーにもCodeLensを表示する
 *   - ソースファイルのマーカーには「Target」ボタンを表示し、訳文へのジャンプを提供
 *   - VS CodeのCodeLens機能を利用して、テスト実行ボタンのような直感的なUIを提供
 * @module ui/codelens/codelens-provider
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import { Configuration } from "../../infra/config/configuration";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
import { FrontMatter } from "../../core/markdown/front-matter";
import { FRONTMATTER_MARKER_KEY, parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { MdaitMarker } from "../../core/markdown/mdait-marker";
import { markdownParser } from "../../core/markdown/parser";
import { resolveMarkerIO } from "../../infra/config/marker-io";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";

/**
 * 「その他」メニュー（isolate 宣言・note 編集）を出すユニットかどうかを判定する（純関数）。
 * 訳文は対訳ユニット（from あり）、原文はマーカー hash を持つユニットが対象。
 * 原文側も isolate 宣言・note 編集の対象である（ADR-260706-02・audit は from 経由で原文 note も読む）。
 * from なしの訳文ユニット（独立ユニット）は対象外 — isolate は伝播停止の宣言であり、
 * 対訳を持たないユニットには意味がなく、note も audit（対訳ペア単位）で読まれないため。
 *
 * @param marker 対象ユニットのマーカー
 * @param isSourceFile 原文ファイルかどうか
 */
export function shouldShowOtherActions(marker: Pick<MdaitMarker, "hash" | "from">, isSourceFile: boolean): boolean {
	return Boolean(marker.hash) && (isSourceFile || Boolean(marker.from));
}

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
		if (document.uri.scheme !== "file") {
			return [];
		}

		// Markdown以外は config.trans.extensions で管理されたファイル単位のCodeLensを返す
		if (document.languageId !== "markdown") {
			return this.providePlainFileCodeLenses(document);
		}

		const codeLenses: vscode.CodeLens[] = [];

		// ソースファイルかどうかを判定
		const config = Configuration.getInstance();
		let isSourceFile = false;
		try {
			const fileExplorer = new FileExplorer();
			isSourceFile = fileExplorer.isSourceFile(document.uri.fsPath, config);
		} catch {
			// ワークスペースがない場合などは無視
		}

		const content = document.getText();

		// frontmatter マーカーの置き場所はモードで変わる（external では .mdait/unit-state）。
		// 素の `FrontMatter.parse` は external でマーカーを見失い、CodeLens のボタンが
		// 黙って消える。管理下 Markdown は必ず resolveMarkerIO を通して読む（ADR-260801-01）。
		// embedded ではマーカーが本文にあるため、行スキャンで足りる従来どおりの経路を残す
		const io = resolveMarkerIO(config, document.uri.fsPath, isSourceFile ? "source" : "target");
		const parsed = config.isExternalMarkers() ? markdownParser.parse(content, config, io.provider, io.ctx) : undefined;
		const frontMatter = parsed ? parsed.frontMatter : FrontMatter.parse(content).frontMatter;

		// frontmatter内のmdait.frontマーカーを検出（FrontMatterクラスの範囲情報を利用）
		if (frontMatter && !frontMatter.isEmpty() && frontMatter.has(FRONTMATTER_MARKER_KEY)) {
			const marker = parseFrontmatterMarker(frontMatter);
			if (marker) {
				// frontmatterの開始行（最初の---の行）にCodeLensを表示
				const frontmatterCodeLenses = this.createFrontmatterCodeLenses(marker, frontMatter.startLine, document);
				codeLenses.push(...frontmatterCodeLenses);
			}
		}

		// external: 本文にマーカーが無いため、パースしてユニットの開始行に CodeLens を配置する
		if (parsed) {
			for (const unit of parsed.units) {
				if (token.isCancellationRequested) {
					return [];
				}
				// store 未登録（マーカー hash なし）のユニットは CodeLens 対象外
				if (!unit.marker?.hash) {
					continue;
				}
				const range = new vscode.Range(unit.startLine, 0, unit.startLine, 0);
				const unitCodeLenses = this.createCodeLensesForMarker(
					unit.marker,
					range,
					"mdait.codelens.jumpToSource",
					"mdait.codelens.jumpToTarget",
					"mdait.codelens.translate",
					"mdait.codelens.clearNeed",
					"mdait.codelens.deleteUnit",
					[range],
					isSourceFile,
				);
				codeLenses.push(...unitCodeLenses);
			}
			return codeLenses;
		}

		// コードブロック内の行はマーカー検出対象外
		const codeBlockLines = getCodeBlockLineSet(content);

		// 各行をスキャンしてmdaitマーカーを検出
		for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
			if (token.isCancellationRequested) {
				return [];
			}

			if (codeBlockLines.has(lineIndex)) {
				continue;
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
					"mdait.codelens.jumpToTarget",
					"mdait.codelens.translate",
					"mdait.codelens.clearNeed",
					"mdait.codelens.deleteUnit",
					[range],
					isSourceFile,
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
		const codeLenses: vscode.CodeLens[] = [];

		// frontmatter専用のCodeLens表示ロジック
		// 翻訳が必要な場合のみAI翻訳ボタンを表示
		if (marker.needsTranslation()) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("✨Translate"),
					tooltip: vscode.l10n.t("Tooltip: Translate this unit using AI"),
					command: "mdait.translate.frontmatter",
					arguments: [document.uri],
				}),
			);
		}

		// needマーカーがある場合は完了ボタンを表示
		if (marker.need) {
			const { title, tooltip } = this.getCompletionButtonLabel(marker.need);
			codeLenses.push(
				new vscode.CodeLens(range, {
					title,
					tooltip,
					command: "mdait.codelens.clearFrontmatterNeed",
					arguments: [range],
				}),
			);
		}

		// 翻訳済み（from && !need）の場合は何も表示しない
		// TM登録、確定、ソースジャンプは不要（理由：TM/Fix非対応、原文は同ファイル内）

		return codeLenses;
	}

	/**
	 * マーカーからCodeLensを作成する共通ロジック
	 * @param marker mdaitマーカー
	 * @param range CodeLensの範囲
	 * @param jumpToSourceCommand ソースへジャンプするコマンド
	 * @param jumpToTargetCommand ターゲットへジャンプするコマンド
	 * @param translateCommand 翻訳コマンド
	 * @param clearNeedCommand needクリアコマンド
	 * @param deleteUnitCommand ユニット削除コマンド
	 * @param translateArgs 翻訳コマンドの引数
	 * @param isSourceFile ソースファイルかどうか
	 * @returns CodeLensの配列
	 */
	private createCodeLensesForMarker(
		marker: MdaitMarker,
		range: vscode.Range,
		jumpToSourceCommand: string,
		jumpToTargetCommand: string,
		translateCommand: string,
		clearNeedCommand: string,
		deleteUnitCommand: string,
		translateArgs: (vscode.Range | vscode.Uri)[],
		isSourceFile: boolean,
	): vscode.CodeLens[] {
		const codeLenses: vscode.CodeLens[] = [];

		// fromハッシュがある場合はソースへ移動ボタン（ターゲットファイルのみ）
		if (marker.from) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(symbol-reference) Source"),
					tooltip: vscode.l10n.t("Tooltip: Jump to original source unit"),
					command: jumpToSourceCommand,
					arguments: [range],
				}),
			);
		}

		// ソースファイルでfromがない場合はターゲットへ移動ボタン
		if (isSourceFile && !marker.from && jumpToTargetCommand) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(symbol-reference) Target"),
					tooltip: vscode.l10n.t("Tooltip: Jump to target translation unit"),
					command: jumpToTargetCommand,
					arguments: [range],
				}),
			);
		}

		// 翻訳が必要な場合は翻訳ボタン
		if (marker.needsTranslation()) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("✨Translate"),
					tooltip: vscode.l10n.t("Tooltip: Translate this unit using AI"),
					command: translateCommand,
					arguments: translateArgs,
				}),
			);
		}

		// 裁定待ち（review / verify-deletion）には「次へ」を添え、裁定→次へ をその場で回せるようにする
		// （UX-R4: ツリーへ戻る往復をなくす）
		const isAwaitingDecision =
			marker.need === "review" || marker.need === "verify-deletion";

		// verify-deletion は Keep / Delete Unit の2択（UX-R1: 判断サーフェスの完成）。
		// Keep は need を外すだけでなく独立ユニット化する（恒久化。clearNeed だと次の sync で復活する）
		if (marker.need === "verify-deletion") {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(check) Keep"),
					tooltip: vscode.l10n.t(
						"Tooltip: Keep this unit as independent — it will no longer be matched against the source",
					),
					command: "mdait.codelens.keepUnit",
					arguments: [range],
				}),
			);
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(trash) Delete Unit"),
					tooltip: vscode.l10n.t("Tooltip: Delete this unit from the document"),
					command: deleteUnitCommand,
					arguments: [range],
				}),
			);
		} else if (marker.need) {
			// needマーカーがある場合は完了ボタン（isolate 解除もここで生値に応じたラベルになる）
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

		if (isAwaitingDecision) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(arrow-right) Next"),
					tooltip: vscode.l10n.t("Tooltip: Jump to the next unit needing attention"),
					command: "mdait.needsAttention.next",
					// CodeLens のクリックはカーソルを動かさないため、押した行を明示的に渡す。
					// 渡さないとカーソル位置（多くは先頭行）が起点になり、前へ戻ってしまう。
					arguments: [range],
				}),
			);
		}

		// 低頻度アクション（isolate 宣言・note 編集）は「その他」メニューへ集約する（ADR-260719-01）
		if (shouldShowOtherActions(marker, isSourceFile)) {
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(kebab-vertical) More"),
					tooltip: vscode.l10n.t("Tooltip: Other actions for this unit (isolate, note)"),
					command: "mdait.codelens.otherActions",
					arguments: [range],
				}),
			);
		}

		return codeLenses;
	}

	/**
	 * 非Markdownファイル（config.trans.extensions 対象）の1行目にCodeLensを提供する。
	 * - ターゲット側: Source（常時） + need があれば Translate / Mark as ...
	 * - ソース側: Target
	 */
	private providePlainFileCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const config = Configuration.getInstance();
		const ext = path.extname(document.uri.fsPath).toLowerCase();
		const allowedExtensions = new Set((config.trans.extensions ?? []).map((e) => e.toLowerCase()));
		if (!allowedExtensions.has(ext)) {
			return [];
		}

		// 1行目（空ファイルでも range は (0,0,0,0) で許容される）
		const firstLineLength = document.lineCount > 0 ? document.lineAt(0).text.length : 0;
		const range = new vscode.Range(0, 0, 0, firstLineLength);

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return [];
		}
		const targetRelPath = toWorkspaceRelativePath(document.uri.fsPath);

		const store = UnitStateStore.getInstance();
		const entry = store.getEntry(targetRelPath, 0);

		const codeLenses: vscode.CodeLens[] = [];

		if (entry) {
			// ターゲット側: Source は常に表示
			codeLenses.push(
				new vscode.CodeLens(range, {
					title: vscode.l10n.t("$(symbol-reference) Source"),
					tooltip: vscode.l10n.t("Tooltip: Jump to original source unit"),
					command: "mdait.codelens.jumpToSourceFile",
					arguments: [document.uri],
				}),
			);

			if (entry.need) {
				codeLenses.push(
					new vscode.CodeLens(range, {
						title: vscode.l10n.t("✨Translate"),
						tooltip: vscode.l10n.t("Tooltip: Translate this unit using AI"),
						command: "mdait.codelens.translateFile",
						arguments: [document.uri],
					}),
				);

				const { title, tooltip } = this.getCompletionButtonLabel(entry.need);
				codeLenses.push(
					new vscode.CodeLens(range, {
						title,
						tooltip,
						command: "mdait.codelens.clearFileNeed",
						arguments: [document.uri],
					}),
				);
			}
			return codeLenses;
		}

		// ソース側判定（UnitStateStoreにエントリが無く、設定上のソースディレクトリに含まれる）
		try {
			const explorer = new FileExplorer();
			if (explorer.isSourceFile(document.uri.fsPath, config)) {
				codeLenses.push(
					new vscode.CodeLens(range, {
						title: vscode.l10n.t("$(symbol-reference) Target"),
						tooltip: vscode.l10n.t("Tooltip: Jump to target translation unit"),
						command: "mdait.codelens.jumpToTargetFile",
						arguments: [document.uri],
					}),
				);
			}
		} catch {
			// ワークスペース未設定等は無視
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
	private getCompletionButtonLabel(need: string): { title: string; tooltip: string; plainTitle: string } {
		if (need === "translate") {
			return {
				title: vscode.l10n.t("$(check) Mark as Translated"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit as manually translated"),
				plainTitle: vscode.l10n.t("Mark as Translated"),
			};
		}
		if (need.startsWith("revise@")) {
			return {
				title: vscode.l10n.t("$(check) Mark as Revised"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit as manually revised"),
				plainTitle: vscode.l10n.t("Mark as Revised"),
			};
		}
		if (need === "review") {
			return {
				title: vscode.l10n.t("$(check) Mark as Reviewed"),
				tooltip: vscode.l10n.t("Tooltip: Mark this unit as reviewed"),
				plainTitle: vscode.l10n.t("Mark as Reviewed"),
			};
		}
		if (need === "isolate") {
			return {
				title: vscode.l10n.t("$(circle-slash) Un-isolate"),
				tooltip: vscode.l10n.t("Tooltip: Resume following source updates for this unit"),
				plainTitle: vscode.l10n.t("Un-isolate"),
			};
		}
		// デフォルト
		return {
			title: vscode.l10n.t("$(check) Mark as Completed"),
			tooltip: vscode.l10n.t("Tooltip: Mark this unit as completed"),
			plainTitle: vscode.l10n.t("Mark as Completed"),
		};
	}

}
