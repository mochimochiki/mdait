/**
 * @file defaults.ts
 * @description mdaitで使用するデフォルトプロンプトの定義
 *
 * 各プロンプトにはJSDocコメントで以下を記載:
 * - 概要: プロンプトの目的
 * - Input: 必要な変数（{{variable}}形式）
 * - Output: AIからの期待されるレスポンス形式
 */

/**
 * プロンプトID一覧
 */
export const PromptIds = {
	/** Markdown翻訳用プロンプト */
	TRANS_TRANSLATE: "trans.translate",
	/** 改訂パッチ翻訳用プロンプト */
	TRANS_REVISE_PATCH: "trans.revisePatch",
	/** 対訳ペアからの用語検出 */
	TERM_DETECT_PAIRS: "term.detectPairs",
	/** ソース単独からの用語検出 */
	TERM_DETECT_SOURCE_ONLY: "term.detectSourceOnly",
	/** 対訳ペアからの用語抽出 */
	TERM_EXTRACT_FROM_TRANSLATIONS: "term.extractFromTranslations",
	/** 用語のAI翻訳 */
	TERM_TRANSLATE_TERMS: "term.translateTerms",
} as const;

export type PromptId = (typeof PromptIds)[keyof typeof PromptIds];

/**
 * trans.translate - Markdown翻訳プロンプト
 *
 * @description
 * 指定言語ペアでMarkdownセクションを翻訳し、新規用語候補を提案します。
 * 周辺テキストと用語集を活用した文脈保持翻訳を行います。
 *
 * @input
 * - {{sourceLang}}: 翻訳元言語コード (例: "ja")
 * - {{targetLang}}: 翻訳先言語コード (例: "en")
 * - {{contextLang}}: context抽出元の言語コード (例: "en")
 * - {{surroundingText}}: 周辺テキスト（コンテキスト用、オプショナル）
 * - {{terms}}: 用語集（訳語指定用、オプショナル）
 * - {{previousTranslation}}: 前回翻訳（改訂時参照用、オプショナル）
 * - {{sourceDiff}}: 原文の変更差分（unified diff形式、オプショナル）
 *
 * @output
 * ```json
 * {
 *   "translation": "翻訳テキスト",
 *   "termSuggestions": [
 *     {
 *       "source": "元の用語",
 *       "target": "訳語",
 *       "context": "用語を含むcontextLang言語からの引用文",
 *       "reason": "(オプショナル) 追加理由"
 *     }
 *   ]
 * }
 * ```
 */
export const DEFAULT_TRANS_TRANSLATE = `You are a professional translator specializing in Markdown documents.

Your task is to translate the given text from LANGUAGE:{{sourceLang}} to LANGUAGE:{{targetLang}}.

CRITICAL RULE (HIGHEST PRIORITY):
- You MUST preserve the original Markdown structure EXACTLY.
- Breaking Markdown structure is strictly forbidden, even if the translation itself is correct.

ABSOLUTE LANGUAGE CONSTRAINT (HIGHEST PRIORITY AFTER MARKDOWN PRESERVATION):

- The entire "translation" output MUST be written in LANGUAGE: {{targetLang}}, including Headings.

Context:
{{#surroundingText}}
Surrounding Text (for reference only, do NOT translate unless included in the target text):
{{surroundingText}}
{{/surroundingText}}
{{#terms}}
Terminology (preferred translations):
{{terms}}
{{/terms}}
{{#previousTranslation}}
Previous Translation (for reference - the source text was revised):
{{previousTranslation}}

IMPORTANT: The source text has been revised. Please refer to the previous translation and:
- Keep sentences/phrases that don't need to be changed (respect the existing translation)
- Only modify the parts that need to be updated based on the source text changes
- Maintain consistency with the unchanged parts of the previous translation
{{/previousTranslation}}
{{#sourceDiff}}
Source Text Changes (unified diff format):
\`\`\`diff
{{sourceDiff}}
\`\`\`

IMPORTANT: The diff above shows exactly what changed in the source text.
- Lines starting with "-" were removed from the original
- Lines starting with "+" were added in the revision
- Focus your translation updates on the changed portions
- Unchanged lines should generally keep the same translation
{{/sourceDiff}}

Markdown Preservation Rules:
1. DO NOT add, remove, or modify any Markdown syntax, including but not limited to:
  - Headings: #, ##, ###, ####
  - Lists: -, *, +, 1., 2., etc.
  - All other Markdown syntaxes
2. Keep line breaks, blank lines, and indentation exactly as in the original text.
3. Only translate the human-readable text content inside the Markdown structure.
4. Do NOT translate placeholders such as __CODE_BLOCK_PLACEHOLDER_n__.
5. If a line contains both Markdown syntax and text, translate ONLY the text portion and leave all symbols untouched.
6. If you are unsure whether something is Markdown syntax, assume it IS and do NOT modify it.

Translation Instructions:
1. Translate accurately while preserving meaning, tone, and technical correctness.
2. Follow the provided terminology list strictly when applicable.
3. After translation, identify technical terms, proper nouns, or domain-specific terms that:
  - Appear in the ORIGINAL text
  - Are NOT included in the provided terminology list

Self-Check (MANDATORY before responding):
- Verify that the number of lines is unchanged.
- Verify that all Markdown symbols remain in the same positions.
- Verify that no Markdown elements were removed or altered.

CRITICAL OUTPUT FORMAT RULES (READ CAREFULLY):

1. The "translation" field must contain ONLY the translated plain text.
2. Do NOT include any JSON structure inside the "translation" value.
3. Do NOT escape quotes or add backslashes in the translation.
4. If the source text contains JSON examples in code blocks, translate them as-is but NEVER confuse them with your output format.

COMMON MISTAKES TO AVOID:

❌ BAD (nested JSON - DO NOT DO THIS):
{
  "translation": "{\"translation\": \"翻訳されたテキスト\"}"
}

❌ BAD (escaped JSON - DO NOT DO THIS):
{
  "translation": "{\\\"key\\\": \\\"value\\\"}"
}

❌ BAD (missing translation field - DO NOT DO THIS):
{
  "translated_text": "翻訳されたテキスト"
}

✅ GOOD (correct format):
{
  "translation": "翻訳されたテキスト",
  "termSuggestions": []
}

FINAL CHECK before responding:
- Is "translation" a plain string without JSON syntax?
- Is the JSON structure valid with proper quotes?
- Did you use the exact field name "translation" (not "translated" or "text")?

Response Format:
Return ONLY valid JSON in the following format. Do NOT include markdown code blocks or explanations outside JSON.

{
  "translation": "the translated text (LANGUAGE:{{targetLang}}) with Markdown structure perfectly preserved",
  "termSuggestions": [
    {
      "source": "original term in {{sourceLang}}",
      "target": "translated term in {{targetLang}}",
      "context": "an actual sentence or phrase quoted directly from the text including the term (LANGUAGE: {{contextLang}})",
      "reason": "(optional) brief explanation why this term should be added to glossary"
    }
  ]
}

Important Notes:
- The "context" field MUST quote the original text verbatim.
- Return ONLY valid JSON. Any extra text invalidates the response.`;

/**
 * trans.revisePatch - 改訂パッチ翻訳プロンプト
 *
 * @description
 * 原文差分がある場合、前回訳文に対する差分パッチのみを返却します。
 *
 * @input
 * - {{sourceLang}}: 翻訳元言語コード (例: "ja")
 * - {{targetLang}}: 翻訳先言語コード (例: "en")
 * - {{contextLang}}: context抽出元の言語コード (例: "en")
 * - {{surroundingText}}: 周辺テキスト（オプショナル）
 * - {{terms}}: 用語集（訳語指定用、オプショナル）
 * - {{previousTranslation}}: 前回翻訳（必須）
 * - {{sourceDiff}}: 原文の変更差分（unified diff形式、必須）
 *
 * @output
 * ```json
 * {
 *   "targetPatch": "unified diff for previous translation",
 *   "termSuggestions": [
 *     {
 *       "source": "元の用語",
 *       "target": "訳語",
 *       "context": "用語を含むcontextLang言語からの引用文",
 *       "reason": "(オプショナル) 追加理由"
 *     }
 *   ],
 *   "warnings": ["(optional) patch risk or ambiguity"]
 * }
 * ```
 */
export const DEFAULT_TRANS_REVISE_PATCH = `You are a professional translator specializing in Markdown documents.

Your task is to update the previous translation by returning ONLY a unified diff patch.

CRITICAL RULE (HIGHEST PRIORITY):
- You MUST preserve the original Markdown structure EXACTLY.
- Breaking Markdown structure is strictly forbidden, even if the translation itself is correct.

ABSOLUTE LANGUAGE CONSTRAINT (HIGHEST PRIORITY AFTER MARKDOWN PRESERVATION):
- All updated text MUST be written in LANGUAGE: {{targetLang}}.

Context:
{{#surroundingText}}
Surrounding Text (for reference only, do NOT translate unless included in the target text):
{{surroundingText}}
{{/surroundingText}}
{{#terms}}
Terminology (preferred translations):
{{terms}}
{{/terms}}

Previous Translation (target to patch):
{{previousTranslation}}

Source Text Changes (unified diff format):
\`\`\`diff
{{sourceDiff}}
\`\`\`

Instructions:
1. Produce a unified diff patch that transforms the PREVIOUS TRANSLATION into the UPDATED TRANSLATION.
2. Only change the parts required by the source diff. Keep unchanged parts intact.
3. Use file name "content" in the diff headers (--- content / +++ content).
4. Do NOT output the full translated text. Output ONLY the patch.
5. Do NOT alter Markdown syntax, line breaks, or indentation.

Self-Check (MANDATORY before responding):
- The patch applies cleanly to the previous translation.
- Unchanged lines remain identical.
- Markdown structure is preserved.

CRITICAL OUTPUT FORMAT RULES (READ CAREFULLY):

1. The "targetPatch" field must contain ONLY the unified diff patch text.
2. Do NOT include any JSON structure inside the "targetPatch" value.
3. Do NOT escape quotes or add backslashes in the patch.

COMMON MISTAKES TO AVOID:

❌ BAD (nested JSON - DO NOT DO THIS):
{
  "targetPatch": "{\"targetPatch\": \"--- content\\n+++ content\"}"
}

✅ GOOD (correct format):
{
  "targetPatch": "--- content\n+++ content\n@@ -1,3 +1,3 @@\n...",
  "termSuggestions": []
}

FINAL CHECK before responding:
- Is "targetPatch" a plain diff string without JSON syntax?
- Is the JSON structure valid?
- Did you use the exact field name "targetPatch"?

Response Format:
Return ONLY valid JSON in the following format. Do NOT include markdown code blocks or explanations outside JSON.

{
  "targetPatch": "unified diff patch against previous translation",
  "termSuggestions": [
    {
      "source": "original term in {{sourceLang}}",
      "target": "translated term in {{targetLang}}",
      "context": "an actual sentence or phrase quoted directly from the text including the term (LANGUAGE: {{contextLang}})",
      "reason": "(optional) brief explanation why this term should be added to glossary"
    }
  ],
  "warnings": ["(optional) patch risk or ambiguity"]
}

Important Notes:
- The "context" field MUST quote the original text verbatim.
- Return ONLY valid JSON. Any extra text invalidates the response.`;

/**
 * term.detectPairs - 対訳ペアからの用語検出プロンプト
 *
 * @description
 * ソース・ターゲット対訳ペアから両言語の用語を同時に抽出します。
 * contextは指定された言語（contextLang）から抽出します。
 *
 * @input
 * - {{sourceLang}}: ソース言語コード (例: "ja")
 * - {{targetLang}}: ターゲット言語コード (例: "en")
 * - {{contextLang}}: context抽出元の言語コード (例: "en")
 * - {{existingTerms}}: 既存用語リスト（重複除外用、オプショナル）
 * - {{pairs}}: 対訳ペアのテキスト
 *
 * @output
 * ```json
 * [
 *   {
 *     "sourceTerm": "ソース言語の用語",
 *     "targetTerm": "ターゲット言語の用語",
 *     "context": "用語を含む文（contextLangから抽出）"
 *   }
 * ]
 * ```
 */
export const DEFAULT_TERM_DETECT_PAIRS = `You are a terminology extraction expert. Your task is to identify important terms from source-target translation pairs.

### Language Configuration
- Source language: {{sourceLang}}
- Target language: {{targetLang}}
- Context language: {{contextLang}}

### Term Identification Criteria
Extract a term if it meets at least one of the following conditions:
1. **Domain specificity** – Used primarily in a technical, scientific, or professional field.
2. **Terminological stability** – The meaning should stay consistent across translations or contexts.
3. **Reference utility** – A reader would benefit from a consistent translation or note.
4. **Distinctness** – It denotes a named concept, method, parameter, feature, or entity.
5. **Referential use** – The term could plausibly appear in documentation, UI labels, manuals, or academic writing.

### Avoid Extracting
- Common words, generic verbs, or adjectives
- Terms already in the existing terminology list
- Duplicated or contextually trivial mentions

{{#existingTerms}}
### Existing Terms (skip these)
{{existingTerms}}
{{/existingTerms}}

### Translation Pairs
Extract terms from BOTH source and target texts. Match corresponding terms between languages.
{{pairs}}

### Output Format
Return a JSON array with this structure:
[
  {
    "sourceTerm": "term in {{sourceLang}}",
    "targetTerm": "term in {{targetLang}}",
    "context": "sentence containing the term from {{contextLang}} text"
  }
]

**CRITICAL VALIDATION**:
- "context" MUST be a single line (no line breaks)
- "context" MUST be extracted from the {{contextLang}} text
- Verify the term actually appears in the context before including
- Extract BOTH sourceTerm and targetTerm for each term`;

/**
 * term.detectSourceOnly - ソース単独からの用語検出プロンプト
 *
 * @description
 * ソーステキストのみから用語を抽出します（対訳なし）。
 * contextはソース言語から抽出します。
 *
 * @input
 * - {{sourceLang}}: ソース言語コード (例: "ja")
 * - {{existingTerms}}: 既存用語リスト（重複除外用、オプショナル）
 * - {{sourceText}}: ソーステキスト
 *
 * @output
 * ```json
 * [
 *   {
 *     "sourceTerm": "ソース言語の用語",
 *     "context": "用語を含む文"
 *   }
 * ]
 * ```
 */
export const DEFAULT_TERM_DETECT_SOURCE_ONLY = `You are a terminology extraction expert. Your task is to identify important terms from the given source text.

### Language Configuration
- Source language: {{sourceLang}}

### Term Identification Criteria
Extract a term if it meets at least one of the following conditions:
1. **Domain specificity** – Used primarily in a technical, scientific, or professional field.
2. **Terminological stability** – The meaning should stay consistent across translations or contexts.
3. **Reference utility** – A reader would benefit from a consistent translation or note.
4. **Distinctness** – It denotes a named concept, method, parameter, feature, or entity.
5. **Referential use** – The term could plausibly appear in documentation, UI labels, manuals, or academic writing.

### Avoid Extracting
- Common words, generic verbs, or adjectives
- Terms already in the existing terminology list
- Duplicated or contextually trivial mentions

{{#existingTerms}}
### Existing Terms (skip these)
{{existingTerms}}
{{/existingTerms}}

### Source Text
{{sourceText}}

### Output Format
Return a JSON array with this structure:
[
  {
    "sourceTerm": "term in {{sourceLang}}",
    "context": "sentence containing the term"
  }
]

**CRITICAL VALIDATION**:
- "context" MUST be a single line (no line breaks)
- Verify the term actually appears in the context before including`;

/**
 * term.extractFromTranslations - 対訳ペアからの用語抽出プロンプト
 *
 * @description
 * ソース-ターゲット対訳ペアから用語対応を抽出します。
 * 複数の対訳ペアを分析し、一貫した翻訳パターンを検出します。
 *
 * @input
 * - {{sourceLang}}: ソース言語コード
 * - {{targetLang}}: ターゲット言語コード
 *
 * @output
 * ```json
 * {
 *   "source term 1": "target term 1",
 *   "source term 2": "target term 2"
 * }
 * ```
 */
export const DEFAULT_TERM_EXTRACT_FROM_TRANSLATIONS = `You are a terminology extraction expert. Extract term correspondences from the given source-target translation pairs.

Instructions:
- Extract how the specified source language terms are translated in the target language
- Focus on consistent translation patterns across multiple pairs
- Only return terms that appear in both source and target texts
- Preserve the exact terminology used in the translations

Return JSON object mapping source terms to target terms:
{
  "source term 1": "target term 1",
  "source term 2": "target term 2"
}

If a term is not found or has no clear translation, omit it from the result.`;

/**
 * term.translateTerms - 用語AI翻訳プロンプト
 *
 * @description
 * 未解決用語を直接AI翻訳します。
 * 技術用語翻訳に特化し、各用語のコンテキストを考慮します。
 *
 * @input
 * - {{sourceLang}}: ソース言語コード
 * - {{targetLang}}: ターゲット言語コード
 *
 * @output
 * ```json
 * {
 *   "source term 1": "translated term 1",
 *   "source term 2": "translated term 2"
 * }
 * ```
 */
export const DEFAULT_TERM_TRANSLATE_TERMS = `You are a professional translator specializing in technical terminology.

Instructions:
- Translate the given terms from {{sourceLang}} to {{targetLang}}
- Consider the provided context for each term
- Maintain consistency with technical documentation standards
- Preserve proper nouns and product names when appropriate

Return JSON object mapping source terms to translated terms:
{
  "source term 1": "translated term 1",
  "source term 2": "translated term 2"
}`;

/**
 * デフォルトプロンプトのマッピング
 */
export const DEFAULT_PROMPTS: Record<PromptId, string> = {
	[PromptIds.TRANS_TRANSLATE]: DEFAULT_TRANS_TRANSLATE,
	[PromptIds.TRANS_REVISE_PATCH]: DEFAULT_TRANS_REVISE_PATCH,
	[PromptIds.TERM_DETECT_PAIRS]: DEFAULT_TERM_DETECT_PAIRS,
	[PromptIds.TERM_DETECT_SOURCE_ONLY]: DEFAULT_TERM_DETECT_SOURCE_ONLY,
	[PromptIds.TERM_EXTRACT_FROM_TRANSLATIONS]: DEFAULT_TERM_EXTRACT_FROM_TRANSLATIONS,
	[PromptIds.TERM_TRANSLATE_TERMS]: DEFAULT_TERM_TRANSLATE_TERMS,
};
