/**
 * @file tm-result-content.ts
 * @description
 *   tm-commit 結果からプレビュー用テキストを生成する純粋関数。
 *   tm-result-provider.ts から抽出。vscode依存なし。
 * @module commands/tm/tm-result-content
 */
import type { TmResultItem } from "./commit-processor";

/** プレビューの見出し・定型文（VS Code 層から表示言語のものを注入する。既定は英語） */
export interface TmResultLabels {
	title: string;
	newHeading: string;
	updatedHeading: string;
	none: string;
}

/** ラベル未注入時の既定（英語） */
const DEFAULT_TM_RESULT_LABELS: TmResultLabels = {
	title: "TM Commit Results",
	newHeading: "New",
	updatedHeading: "Updated",
	none: "(none)",
};

/**
 * tm-commit 結果からプレビュー用テキストを生成する純粋関数。
 *
 * @param result 登録結果
 * @param labels 見出し・定型文のラベル（省略時は英語の既定）
 */
export function generateContent(
	result: { newItems: TmResultItem[]; updatedItems: TmResultItem[] },
	labels: TmResultLabels = DEFAULT_TM_RESULT_LABELS,
): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

	const lines: string[] = [];
	lines.push(`# ${labels.title} - ${timestamp}`);
	lines.push("");

	lines.push(`## ${labels.newHeading} (${result.newItems.length})`);
	if (result.newItems.length === 0) {
		lines.push(labels.none);
		lines.push("");
	} else {
		for (const item of result.newItems) {
			lines.push(`"${item.primary}"`);
			lines.push(`  \u2192 "${item.local}"`);
			lines.push("");
		}
	}

	lines.push(`## ${labels.updatedHeading} (${result.updatedItems.length})`);
	if (result.updatedItems.length === 0) {
		lines.push(labels.none);
		lines.push("");
	} else {
		for (const item of result.updatedItems) {
			lines.push(`"${item.primary}"`);
			lines.push(`  \u2192 "${item.local}"`);
			lines.push("");
		}
	}

	return lines.join("\n");
}
