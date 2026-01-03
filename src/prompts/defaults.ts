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
	/** テキストからの用語検出 */
	TERM_DETECT: "term.detect",
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
 * - {{surroundingText}}: 周辺テキスト（コンテキスト用、オプショナル）
 * - {{terms}}: 用語集（訳語指定用、オプショナル）
 * - {{previousTranslation}}: 前回翻訳（改訂時参照用、オプショナル）
 *
 * @output
 * ```json
 * {
 *   "translation": "翻訳テキスト",
 *   "termSuggestions": [
 *     {
 *       "source": "元の用語",
 *       "target": "訳語",
 *       "context": "用語を含む原文からの引用文",
 *       "reason": "(オプショナル) 追加理由"
 *     }
 *   ]
 * }
 * ```
 */
export const DEFAULT_TRANS_TRANSLATE = `You are a professional translator specializing in Markdown documents.

Your task is to translate the given text from {{sourceLang}} to {{targetLang}}.

CRITICAL RULE (HIGHEST PRIORITY):
- You MUST preserve the original Markdown structure EXACTLY.
- Breaking Markdown structure is strictly forbidden, even if the translation itself is correct.

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

Response Format:
Return ONLY valid JSON in the following format. Do NOT include markdown code blocks or explanations outside JSON.

{
  "translation": "the translated text with Markdown structure perfectly preserved",
  "termSuggestions": [
    {
      "source": "original term in {{sourceLang}}",
      "target": "translated term in {{targetLang}}",
      "context": "an actual sentence or phrase quoted directly from the ORIGINAL text including the source term (LANGUAGE: {{sourceLang}})",
      "reason": "(optional) brief explanation why this term should be added to glossary"
    }
  ]
}

Important Notes:
- The "context" field MUST quote the original text verbatim.
- Return ONLY valid JSON. Any extra text invalidates the response.`;

/**
 * term.detect - 用語検出プロンプト
 *
 * @description
 * テキストから技術用語、製品名、UI要素などの重要な用語を抽出します。
 * テキスト長に応じた適応的スケーリングで用語数を調整します。
 *
 * @input
 * - {{lang}}: 対象言語コード (例: "ja")
 * - {{existingTerms}}: 既存用語リスト（重複除外用、オプショナル）
 *
 * @output
 * ```json
 * [
 *   {"term": "用語", "context": "用語を含む実際の文"}
 * ]
 * ```
 */
export const DEFAULT_TERM_DETECT = `You are a terminology extraction expert. Your task is to identify and describe important terms from the given text.
Instructions: 
- Read the entire text carefully.
- Extract **all important technical terms, product names, UI elements, or domain-specific concepts** that would benefit from consistent translation or terminology management. 
- **Do not omit clearly identifiable terms even if it exceeds the reference count range.** 
- Avoid generic words, verbs, or adjectives. 

### Adaptive scaling rule: Use the following as guidelines, not strict limits: 
- Short text (< 500 characters): usually 3–10 terms 
- Medium text (500–2,000 characters): usually 10–20 terms 
- Long text (> 2,000 characters): usually 20–40 terms 
→ However, if more valid terms are clearly present, include them all. 

### Term identification criteria: 

Extract a term **if it meets at least one of the following conditions:** 
1. **Domain specificity** – Used primarily in a technical, scientific, or professional field.
2. **Terminological stability** – The meaning should stay consistent across translations or contexts. 
3. **Reference utility** – A reader would benefit from a consistent translation or note. 
4. **Distinctness** – It denotes a named concept, method, parameter, feature, or entity (not just descriptive language). 
5. **Referential use** – The term could plausibly appear in documentation, UI labels, manuals, or academic writing. 

---

### Output rules: 

- Return a deduplicated JSON array of objects, each with the following structure:
  - "term": extracted term
  - "context": a single-line sentence or phrase quoted directly from the text including the term itself (LANGUAGE: {{lang}})
- **CRITICAL VALIDATION**: 
  - "context" string MUST NOT have line breaks
  - Before adding any entry to the output, verify that the exact "term" string appears in the "context" string. If the term is not present in the context, DO NOT include that entry.
- Be careful not to confuse similar terms. Extract only terms that actually appear in the source text.
- Do not include already-registered terms.
- Keep explanations brief and accurate.
Instructions:
- Analyze the entire text carefully before extracting.
- Extract **important technical terms, product names, UI elements, domain-specific concepts, or proper nouns** that are likely to require consistent translation or usage.
- Avoid extracting:
  - Common words, generic verbs, or adjectives.
  - Terms already present in the existing terminology list.
  - Duplicated or contextually trivial mentions.

{{#existingTerms}}
The following terms are already present in the terminology repository for this language:
{{existingTerms}}

{{/existingTerms}}
Return JSON array with this structure:
[
  {
    "term": "extracted term",
    "context": "a single-line sentence or phrase including the term (no line breaks)"
  }
]`;

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
	[PromptIds.TERM_DETECT]: DEFAULT_TERM_DETECT,
	[PromptIds.TERM_EXTRACT_FROM_TRANSLATIONS]: DEFAULT_TERM_EXTRACT_FROM_TRANSLATIONS,
	[PromptIds.TERM_TRANSLATE_TERMS]: DEFAULT_TERM_TRANSLATE_TERMS,
};
