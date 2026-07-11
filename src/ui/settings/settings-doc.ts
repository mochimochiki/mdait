/**
 * 設定エディタ用の解説文。
 * スキーマの description（英語・簡潔）とは別に、設定画面ではより丁寧な解説を
 * vscode.l10n 経由で日英提供する。ここに無い設定はスキーマ description に
 * フォールバックするため、スキーマへ設定を追加しただけでも UI は壊れない。
 */
import * as vscode from "vscode";

export interface CategoryDoc {
	label: string;
	description: string;
}

/** カテゴリの表示名と概要 */
export function getCategoryDoc(id: string): CategoryDoc {
	switch (id) {
		case "general":
			return {
				label: vscode.l10n.t("General"),
				description: vscode.l10n.t(
					"Translation pairs, primary language and exclusions — the settings every workspace needs first.",
				),
			};
		case "sync":
			return {
				label: vscode.l10n.t("Sync"),
				description: vscode.l10n.t(
					"How documents are split into translation units and how markers are kept up to date. Sync is deterministic and never calls AI.",
				),
			};
		case "markers":
			return {
				label: vscode.l10n.t("Markers"),
				description: vscode.l10n.t("Where mdait unit markers are stored."),
			};
		case "ai":
			return {
				label: vscode.l10n.t("AI Provider"),
				description: vscode.l10n.t(
					"Which AI backend is used for translation and terminology, plus provider-specific options.",
				),
			};
		case "trans":
			return {
				label: vscode.l10n.t("Translation"),
				description: vscode.l10n.t(
					"How units are translated: context size, retries, parallelism and additional file types.",
				),
			};
		case "terms":
			return {
				label: vscode.l10n.t("Glossary"),
				description: vscode.l10n.t(
					"Terminology management. The glossary is injected into translation prompts so established terms are used consistently.",
				),
			};
		case "tm":
			return {
				label: vscode.l10n.t("Translation Memory"),
				description: vscode.l10n.t(
					"Reuse of confirmed past translations stored in .mdait/translations.tmx.",
				),
			};
		case "aiSync":
			return {
				label: vscode.l10n.t("AI Sync"),
				description: vscode.l10n.t(
					"AI-assisted onboarding and audits: pairing verification (review) and mapping correction (align).",
				),
			};
		case "prompts":
			return {
				label: vscode.l10n.t("Prompts"),
				description: vscode.l10n.t(
					"Override any built-in AI prompt with your own prompt file. Paths are relative to the workspace root; leave a field empty to use the built-in prompt.",
				),
			};
		default:
			return { label: id, description: "" };
	}
}

/**
 * 設定 ID から表示ラベルを導出する（VS Code 設定画面と同様の Title Case）。
 * 例: "ai.ollama.endpoint" → "Ollama › Endpoint"
 */
export function deriveSettingLabel(id: string, category: string): string {
	const withoutCategory =
		category !== "general" && id.startsWith(`${category}.`)
			? id.slice(category.length + 1)
			: id;
	return withoutCategory
		.split(".")
		.map((segment) =>
			segment
				.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
				.replace(/^./, (c) => c.toUpperCase()),
		)
		.join(" › ");
}

/**
 * 設定 ID ごとの丁寧な解説。未定義の ID は undefined を返し、
 * 呼び出し側がスキーマ description へフォールバックする。
 */
export function getSettingDescription(id: string): string | undefined {
	const provider = SETTING_DESCRIPTIONS[id];
	return provider ? provider() : undefined;
}

const SETTING_DESCRIPTIONS: Record<string, () => string> = {
	// --- general ---
	transPairs: () =>
		vscode.l10n.t(
			"Translation pairs are the heart of mdait: each pair maps a source directory to a target directory. Files under the source directory are translated to the same relative path under the target directory. Language codes are ISO 639-1, optionally with a region (e.g. 'ja', 'en', 'zh-CN'). Add one pair per target language. A per-pair 'copyAssets' override can be added directly in mdait.json.",
		),
	primaryLang: () =>
		vscode.l10n.t(
			"The pivot language shared by the glossary and the translation memory. Set it to the language your terminology is authored in — usually the source language of your documentation. Required.",
		),
	ignoredPatterns: () =>
		vscode.l10n.t(
			"Glob patterns for files and folders mdait must never touch during sync or translation (e.g. '**/node_modules/**', '**/drafts/**'). One pattern per row.",
		),
	// --- sync ---
	"sync.level": () =>
		vscode.l10n.t(
			"Heading level at which documents are split into translation units. The default 3 starts a new unit at every '###' or shallower heading. Smaller values make larger units, larger values make finer units. 0 disables automatic marker insertion so you place '<!-- mdait -->' markers by hand. Can be overridden per document in its frontmatter.",
		),
	"sync.autoDelete": () =>
		vscode.l10n.t(
			"Legacy switch for target units whose source unit was deleted. Prefer 'Orphan Target Policy', which supersedes it (true behaves like 'delete', false like 'verify'). Ignored when Orphan Target Policy is set.",
		),
	"sync.orphanTargetPolicy": () =>
		vscode.l10n.t(
			"What sync does with orphan target units — translated sections whose source section no longer exists. 'delete': remove them automatically. 'verify': keep them flagged need:verify-deletion so a human confirms each removal. 'keep': keep them permanently as target-only content that sync and translation never touch. 'backfill': create a placeholder in the source document and reverse-translate the target content into it. Takes precedence over Auto Delete.",
		),
	"sync.autoSyncOnSave": () =>
		vscode.l10n.t(
			"Automatically sync a file when it is saved. Only files that already contain mdait markers are synced, so unrelated files are never modified. Sync is deterministic and never calls AI.",
		),
	"sync.copyAssets": () =>
		vscode.l10n.t(
			"Whether sync copies non-translated files (images and other assets) from source to target directories. true copies everything that is not a translation target, false disables copying, or provide an extension whitelist such as [\".png\", \".jpg\"]. Because the value can be a boolean or a list, edit this key directly in mdait.json.",
		),
	// --- markers ---
	"markers.mode": () =>
		vscode.l10n.t(
			"Where unit markers live. 'embedded' (default) keeps them as invisible HTML comments inside each document — self-contained and robust when files are copied or moved. 'external' stores them in .mdait/unit-state so documents stay completely clean; convert existing documents with the 'mdait: Externalize markers' / 'Embed markers' commands.",
		),
	// --- ai ---
	"ai.provider": () =>
		vscode.l10n.t(
			"The AI backend used for translation and terminology. 'vscode-lm' (default) uses the VS Code Language Model API — your GitHub Copilot subscription, no API key needed. 'openai' calls an OpenAI-compatible API configured below. 'ollama' uses a local Ollama server configured below. 'default' behaves like 'vscode-lm'.",
		),
	"ai.vendor": () =>
		vscode.l10n.t(
			"Vendor identifier for the VS Code Language Model API, used with the 'vscode-lm'/'default' provider. Normally leave this as 'copilot'.",
		),
	"ai.model": () =>
		vscode.l10n.t(
			"Model name used with the selected provider. With 'vscode-lm' it must match a model your Copilot plan offers (e.g. 'gpt-4.1'); with 'openai' it is passed to the API as-is.",
		),
	"ai.ollama.endpoint": () =>
		vscode.l10n.t(
			"URL of your Ollama server. The default 'http://localhost:11434' works for a local installation. Only used when the provider is 'ollama'.",
		),
	"ai.ollama.model": () =>
		vscode.l10n.t(
			"Ollama model used for translation (e.g. 'llama3', 'mistral'). Pull it first with 'ollama pull <model>'. Only used when the provider is 'ollama'.",
		),
	"ai.ollama.timeoutSec": () =>
		vscode.l10n.t(
			"Seconds to wait for the first response and between streaming chunks before giving up. Increase for large models that load slowly. Only used when the provider is 'ollama'.",
		),
	"ai.ollama.keepAlive": () =>
		vscode.l10n.t(
			"How long the model stays loaded in Ollama's memory after a request, e.g. '10m' or '1h' (a plain number means seconds). Longer values avoid reload delays during a translation session. Leave empty to use the Ollama server default (5 minutes).",
		),
	"ai.openai.apiKey": () =>
		vscode.l10n.t(
			"API key for the OpenAI-compatible endpoint. Strongly recommended: reference an environment variable with ${env:OPENAI_API_KEY} instead of pasting the key here — mdait.json is usually committed to git. Only used when the provider is 'openai'.",
		),
	"ai.openai.baseURL": () =>
		vscode.l10n.t(
			"Base URL of the OpenAI-compatible API. Change it to use a proxy or a compatible service. Only used when the provider is 'openai'.",
		),
	"ai.openai.maxTokens": () =>
		vscode.l10n.t(
			"Maximum tokens the model may generate per response. Raise it if long units get truncated; lower it to cap cost. Only used when the provider is 'openai'.",
		),
	"ai.openai.timeoutSec": () =>
		vscode.l10n.t(
			"Seconds to wait for an API response before the request fails. Only used when the provider is 'openai'.",
		),
	"ai.debug.enableStatsLogging": () =>
		vscode.l10n.t(
			"Write AI call statistics (duration, token counts) to .mdait/logs/ai-stats.log. Useful for tracking cost and performance; contains no document content.",
		),
	"ai.debug.logPromptAndResponse": () =>
		vscode.l10n.t(
			"Write full prompts and responses to .mdait/logs/ai-detailed.log. Helpful when investigating translation quality, but the log contains your document text — keep it off otherwise.",
		),
	// --- trans ---
	"trans.markdown.skipCodeBlocks": () =>
		vscode.l10n.t(
			"Keep fenced code blocks untouched during translation. Turn this off only if you want comments and strings inside code examples translated too.",
		),
	"trans.frontmatter.keys": () =>
		vscode.l10n.t(
			"Frontmatter keys to translate (e.g. 'title', 'description'). All other keys are copied verbatim. An empty list disables frontmatter translation.",
		),
	"trans.contextSize": () =>
		vscode.l10n.t(
			"How many neighboring units (before and after) are sent to the AI as reading context. More context improves consistency across section boundaries but increases token usage. 0 sends the unit alone.",
		),
	"trans.retryLimit": () =>
		vscode.l10n.t(
			"How many times a failed unit translation is retried before it is reported as an error (1-5).",
		),
	"trans.maxFileSize": () =>
		vscode.l10n.t(
			"Size limit in bytes for translating non-Markdown files. Larger files are skipped with a warning so a single huge file cannot cause runaway AI cost.",
		),
	"trans.concurrency": () =>
		vscode.l10n.t(
			"How many files are translated in parallel during a directory translation (1-8; 1 = one at a time). Lower it if your AI provider rate-limits you; with 'vscode-lm' throughput depends on your Copilot quota.",
		),
	"trans.extensions": () =>
		vscode.l10n.t(
			"Additional file extensions to translate besides Markdown, e.g. '.txt' or '.csv'. These files are translated as a whole (no unit splitting) and tracked in .mdait/unit-state.",
		),
	// --- terms ---
	"terms.filename": () =>
		vscode.l10n.t(
			"File name of the glossary inside the .mdait folder. The extension decides the format: .csv or .yaml/.yml.",
		),
	// --- tm ---
	"tm.enabled": () =>
		vscode.l10n.t(
			"Master switch for the translation memory. When enabled, confirmed translations can be committed to .mdait/translations.tmx and similar past translations are shown to the AI as reference while translating.",
		),
	"tm.maxReferences": () =>
		vscode.l10n.t(
			"Maximum number of similar past translations attached to a translation prompt. More references can improve consistency but increase token usage.",
		),
	"tm.retryLimit": () =>
		vscode.l10n.t(
			"How many focused retries are attempted when a TM commit fails its alignment guard (1-5).",
		),
	"tm.minQueryLength": () =>
		vscode.l10n.t(
			"Minimum number of characters (after normalization) a line needs to be used as a TM search query. Filters out noise from short fragments such as table cells.",
		),
	// --- prompts ---
	"prompts.trans.translate": () =>
		vscode.l10n.t("Custom prompt file for initial unit translation."),
	"prompts.trans.revisePatch": () =>
		vscode.l10n.t(
			"Custom prompt file for diff-aware revision — updating an existing translation from a source diff while preserving manual edits.",
		),
	"prompts.term.detect": () =>
		vscode.l10n.t("Custom prompt file for glossary term detection."),
	"prompts.term.extractFromTranslations": () =>
		vscode.l10n.t(
			"Custom prompt file for extracting term translations from already-translated documents.",
		),
	"prompts.term.translateTerms": () =>
		vscode.l10n.t("Custom prompt file for translating glossary terms."),
	"prompts.tm.splitSentences": () =>
		vscode.l10n.t("Custom prompt file for TM sentence alignment."),
	"prompts.aiSync.verifyPairing": () =>
		vscode.l10n.t(
			"Custom prompt file for single-pair AI pairing verification (used when the review batch size is 1).",
		),
	"prompts.aiSync.verifyPairingBatch": () =>
		vscode.l10n.t(
			"Custom prompt file for batched AI pairing verification (used when the review batch size is 2 or more).",
		),
	"prompts.aiSync.align": () =>
		vscode.l10n.t(
			"Custom prompt file for the AI align step (differential review of the unit mapping during adopt).",
		),
	// --- aiSync ---
	"aiSync.review.autoApprove": () =>
		vscode.l10n.t(
			"Let the AI review clear need:review automatically for pairs it judges to be faithful, complete translations with high confidence. Turn off for report-only mode where no markers are changed.",
		),
	"aiSync.review.autoApproveThreshold": () =>
		vscode.l10n.t(
			"Minimum AI confidence (0-1) required before need:review is cleared automatically. Higher values are safer but leave more pairs for manual review.",
		),
	"aiSync.review.maxUnitsPerRun": () =>
		vscode.l10n.t(
			"Cost guard: maximum number of units verified in one review run. Remaining units keep need:review and are picked up by the next run.",
		),
	"aiSync.review.batchSize": () =>
		vscode.l10n.t(
			"How many pairs are verified per AI call. 1 uses the single-pair prompt; larger batches reduce the number of calls and the cost of a run.",
		),
	"aiSync.align.minConfidence": () =>
		vscode.l10n.t(
			"Minimum AI confidence (0-1) for a pairing correction to be accepted during adopt. Corrections below this keep the deterministic position-based pairing.",
		),
	"aiSync.align.maxUnitsPerFile": () =>
		vscode.l10n.t(
			"Cost guard: files with more units than this skip AI align and keep the position-based mapping.",
		),
	"aiSync.align.maxNeedBodies": () =>
		vscode.l10n.t(
			"Maximum number of unit bodies the AI may request in the second triage round when it needs more evidence.",
		),
	"aiSync.align.maxRounds": () =>
		vscode.l10n.t(
			"Maximum triage rounds for AI align. 1 disables the second round where the AI can request unit bodies.",
		),
};

/** Webview クライアントへ渡す UI 文言 */
export function getUiStrings(): Record<string, string> {
	return {
		searchPlaceholder: vscode.l10n.t("Search settings"),
		resetToDefault: vscode.l10n.t("Reset to default"),
		defaultLabel: vscode.l10n.t("Default"),
		openJson: vscode.l10n.t("Open mdait.json"),
		editInJson: vscode.l10n.t("Edit in mdait.json"),
		add: vscode.l10n.t("Add"),
		addPair: vscode.l10n.t("Add translation pair"),
		remove: vscode.l10n.t("Remove"),
		noResults: vscode.l10n.t("No settings matched your search."),
		requiredBadge: vscode.l10n.t("Required"),
		invalidValue: vscode.l10n.t("Invalid value"),
		incompletePairHint: vscode.l10n.t(
			"Rows with empty fields are not saved until all fields are filled.",
		),
	};
}
