import type * as vscode from "vscode";
import { type PatchFailureReason, type PatchFormat, numberLinesForPatch } from "../../core/diff/diff-generator";
import { getCodeBlockLineSet } from "../../core/markdown/code-block-lines";
import { OperationCancelledError } from "../../infra/errors/operation-cancelled";
import type { AIMessage, AIService } from "../../infra/llm/ai-service";
import { UnusableAIResponseError } from "../../infra/llm/unusable-response";
import { Logger, formatError } from "../../infra/logging/logger";
import { PromptIds } from "../../prompts/defaults";
import type { PromptId } from "../../prompts/defaults";
import type { PromptParts, PromptVariables } from "../../prompts/prompt-provider";
import { buildUserMessage } from "../../prompts/prompt-provider";
import { resolveFileTypeFromExtension } from "../file-handler/file-type";
import { sanitizeTranslationOutput } from "./output-sanitizer";
import {
	type ParsedRevisionPatchResponse,
	type ParsedTranslationResponse,
	type ValidationError,
	type ValidationResult,
	validateBatchTranslationResponse,
	validateRevisionBatchResponse,
	validateRevisionPatchPlainResponse,
	validateRevisionPatchResponse,
	validateTranslationResponse,
} from "./response-validator";
import type { TranslationContext } from "./translation-context";
import { NO_CHANGE_ANSWER, joinBatchSource, splitBatchResponse, unitSeparator } from "./unit-batch";

/** コードブロックを退避した結果 */
export interface ProtectedCodeBlocks {
	/** コードブロックをプレースホルダへ置き換えたテキスト（AI へ渡す形） */
	text: string;
	/** 退避したコードブロック（行まるごと。字下げや引用記号を含む） */
	codeBlocks: string[];
	/** プレースホルダ（codeBlocks と同じ並び） */
	placeholders: string[];
}

/** コードブロックを戻した結果 */
export interface RestoredCodeBlocks {
	/** コードブロックを復元したテキスト */
	text: string;
	/** AI の応答から消えていて戻せなかったプレースホルダ */
	missing: string[];
}

/** `protectCodeBlocks` のオプション */
export interface ProtectCodeBlocksOptions {
	/**
	 * 本文を Markdown として読むか。既定は true。
	 *
	 * false（`trans.extensions` の .txt など Markdown でないファイル）では
	 * 「行頭の字下げ＝コードブロック」という Markdown 固有の規則を当てず、
	 * 閉じたフェンス（```／~~~）だけを退避する。
	 */
	markdown?: boolean;
}

/**
 * Markdown として読む拡張子か（未指定は Markdown 経路とみなす）。
 *
 * 判定は持たず `resolveFileTypeFromExtension`（拡張子から種別を決める唯一の定義）へ委ねる。
 * ここで独自に拡張子を並べると、`PlainFileHandler` が plain として扱うファイルに
 * 退避だけ Markdown の規則が当たり、字下げした本文が翻訳から外れる
 * （＝ADR-260804-02 で直した症状が別経路で復活する）。
 */
export function isMarkdownExtension(fileExtension?: string): boolean {
	// 拡張子を持ち回らないのは Markdown 経路だけ。非Markdown経路は必ず
	// `path.extname()` の結果を入れる（拡張子なしのファイルは空文字＝plain）。
	if (fileExtension === undefined) {
		return true;
	}
	return resolveFileTypeFromExtension(fileExtension) === "md";
}

/**
 * フェンスで囲まれたブロックが閉じているか（最後の行が閉じフェンスか）。
 * Markdown でないファイルでのみ使う保険。閉じていないフェンスは、
 * markdown-it の規則ではファイル末尾までコードブロックになるが、
 * Markdown でない文書では「たまたま ``` で始まる行があった」だけの可能性が高い。
 * その場合に末尾まで丸ごと翻訳から外すと、本文が原文のまま残って誰も気づけない。
 */
function isClosedFence(blockLines: string[]): boolean {
	if (blockLines.length < 2) {
		return false;
	}
	const open = /^\s*(`{3,}|~{3,})/.exec(blockLines[0]);
	if (!open) {
		return false;
	}
	const marker = open[1][0];
	const length = open[1].length;
	const close = new RegExp(`^\\s*\\${marker}{${length},}\\s*$`);
	return close.test(blockLines[blockLines.length - 1]);
}

/**
 * コードブロックを AI へ渡さないように退避する。
 *
 * 「どこがコードブロックか」はパーサーと同じ `getCodeBlockLineSet`（markdown-it）に問う。
 * 独自の正規表現で探すと、```` ``` ```` しか拾えない・`~~~`・字下げコードブロック・4連
 * バッククォートを取りこぼす／誤分割する。同じ問いに2つの答えを持たない（design.md P9）。
 *
 * 退避は**行まるごと**で行う。リスト項目の中や引用の中のコードブロックは行頭に字下げや
 * `> ` が付くため、バッククォートの位置から切り出すと前置きがプレースホルダの手前に残り、
 * 戻すときに行の途中と誤判定される。行ごと退避すれば前置きもブロックに含まれ、
 * 元どおりに戻る。
 *
 * コードブロックでない行に残った行内の ```` ```...``` ````（インラインのコード）も、
 * 従来どおり翻訳させずに退避する。こちらは1行内で完結するので改行の補いは要らない。
 *
 * Markdown でないファイルでは Markdown 固有の規則を当てない（`markdown: false`）。
 *
 * @param text 退避対象のテキスト
 * @param options 判定オプション
 * @returns 退避結果
 */
export function protectCodeBlocks(text: string, options?: ProtectCodeBlocksOptions): ProtectedCodeBlocks {
	const markdown = options?.markdown ?? true;
	const lines = text.split("\n");
	const codeBlockLines = getCodeBlockLineSet(text, { includeIndented: markdown });
	const out: string[] = [];
	const codeBlocks: string[] = [];
	const placeholders: string[] = [];

	const take = (block: string): string => {
		const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
		codeBlocks.push(block);
		placeholders.push(placeholder);
		return placeholder;
	};

	// 行内で完結する ```...```（インラインのコード）。改行をまたがせないことで、
	// 離れた場所にある無関係なバッククォート同士を1つの塊にしてしまう事故を防ぐ。
	const inlineCodeRegex = /```[^\n]*?```/g;
	const protectInline = (line: string): string => line.replace(inlineCodeRegex, (match) => take(match));

	let i = 0;
	while (i < lines.length) {
		if (!codeBlockLines.has(i)) {
			out.push(protectInline(lines[i]));
			i++;
			continue;
		}
		// 連続するコードブロック行をひとまとまりとして退避する
		let end = i;
		while (end < lines.length && codeBlockLines.has(end)) {
			end++;
		}
		const blockLines = lines.slice(i, end);
		if (!markdown && !isClosedFence(blockLines)) {
			// 閉じていないフェンスは退避せず、ふつうの本文として翻訳させる（安全側）
			for (const line of blockLines) {
				out.push(protectInline(line));
			}
		} else {
			out.push(take(blockLines.join("\n")));
		}
		i = end;
	}

	return { text: out.join("\n"), codeBlocks, placeholders };
}

/**
 * 参考として添える文の中でコードブロックを伏せるときの目印。
 *
 * 番号を持たないのは、戻す相手がいないから。`restoreCodeBlocks` は
 * `__CODE_BLOCK_PLACEHOLDER_<番号>__` を厳密一致で探すので、この目印が
 * 混ざっても取り違えない。
 */
export const CODE_BLOCK_OMITTED_MARK = "__CODE_BLOCK_OMITTED__";

/**
 * 参考として添える文（周辺テキスト・参考用の前回訳文）からコードブロックの中身を伏せる。
 *
 * 訳す本文には `protectCodeBlocks` で `__CODE_BLOCK_PLACEHOLDER_n__` を置いているのに、
 * 参考の側には生のコードがそのまま乗っていると、AI からは**同じ内容が二つの姿で現れる**。
 * 「参考の側にはコードがあるのに本文では消えている」＝そこが変更点だ、と読める。
 * 実際、初回同期直後の訳文ユニットでは原文と参考文が一字一句同じで、
 * 唯一違うのがコードブロックの姿だけ、という状態が起きていた。
 *
 * 参考文は文脈が分かればよく、コードの中身は要らないので、目印1つに畳む。
 * 「どこがコードブロックか」の判定は `protectCodeBlocks` に委ねる
 * （同じ問いに2つの答えを持たない。design.md P9）。
 *
 * **パッチの土台には使わない。** `need:revise` の差分パッチでは前回訳文と1行ずつ
 * 突き合わせるため、そこへ渡す前回訳文は生のままでなければならない。
 *
 * @param text 参考として添える文（undefined はそのまま返す）
 * @param options 判定オプション（`protectCodeBlocks` と同じ）
 * @returns コードブロックを目印に畳んだ文
 */
export function elideCodeBlocks(text: string | undefined, options?: ProtectCodeBlocksOptions): string | undefined {
	if (text === undefined) {
		return undefined;
	}
	const { text: replaced, placeholders } = protectCodeBlocks(text, options);
	let result = replaced;
	for (const placeholder of placeholders) {
		result = result.split(placeholder).join(CODE_BLOCK_OMITTED_MARK);
	}
	return result;
}

/**
 * コードブロックのプレースホルダを元のコードブロックへ戻す。
 *
 * `protectCodeBlocks` はプレースホルダを必ず1行として置くので、AI が形を保っていれば
 * そのまま行が入れ替わり原文どおりに戻る。ただし AI がプレースホルダを前後の文と
 * つなげて1行にまとめることは実際に起きる。そのとき複数行のブロックが行の途中に戻ると
 * 開始フェンスが行頭に来ず Markdown としてコードブロックでなくなり、中身（サンプルの
 * 見出しや mdait マーカー風の文字列）が本文として読まれてユニット境界を誤る
 * （design.md P9）。そのため行頭・行末へ来るよう改行を補う。
 *
 * @param text プレースホルダを含むテキスト
 * @param placeholders プレースホルダ文字列（codeBlocks と同じ並び）
 * @param codeBlocks 元のコードブロック文字列
 * @returns 復元したテキストと、戻せなかったプレースホルダ
 */
export function restoreCodeBlocks(text: string, placeholders: string[], codeBlocks: string[]): RestoredCodeBlocks {
	let result = text;
	const missing: string[] = [];

	for (let i = 0; i < placeholders.length; i++) {
		const placeholder = placeholders[i];
		const block = codeBlocks[i];
		const isMultiline = block.includes("\n");
		let searchFrom = 0;
		let found = false;
		while (true) {
			const idx = result.indexOf(placeholder, searchFrom);
			if (idx === -1) {
				break;
			}
			found = true;
			const before = result.slice(0, idx);
			const after = result.slice(idx + placeholder.length);
			const leading = isMultiline && before !== "" && !before.endsWith("\n") ? "\n" : "";
			const trailing = isMultiline && after !== "" && !after.startsWith("\n") ? "\n" : "";
			const replacement = `${leading}${block}${trailing}`;
			result = before + replacement + after;
			searchFrom = before.length + replacement.length;
		}
		if (!found) {
			missing.push(placeholder);
		}
	}

	return { text: result, missing };
}

/**
 * まとめて頼むユニットのコードブロックを、ユニットごとに退避する。目印の番号はまとまりの中で通しにする
 * （同じ番号が別のユニットに出ると、AI が取り違えやすい）。
 */
export function protectUnitsWithSharedNumbering(texts: readonly string[], markdown: boolean): ProtectedCodeBlocks[] {
	let offset = 0;
	return texts.map((text) => {
		const own = protectCodeBlocks(text, { markdown });
		if (offset === 0 || own.placeholders.length === 0) {
			offset += own.placeholders.length;
			return own;
		}
		const renamed = own.placeholders.map((_, k) => `__CODE_BLOCK_PLACEHOLDER_${offset + k}__`);
		let renamedText = own.text;
		// 番号の大きい方から置き換える（_1__ と _10__ は別の文字列だが、念のため衝突を避ける順にする）
		for (let k = own.placeholders.length - 1; k >= 0; k--) {
			renamedText = renamedText.split(own.placeholders[k]).join(renamed[k]);
		}
		offset += own.placeholders.length;
		return { text: renamedText, codeBlocks: own.codeBlocks, placeholders: renamed };
	});
}

/**
 * 検証に落ちた応答を「使えない答え」の例外に変える。
 *
 * **生の応答をここから外へ出さない。** 以前はこの位置に「最後の生応答をそのまま
 * 訳文として返す」後始末があり、途中で切れた JSON（`{"translation": "…途中`）や
 * 空文字がそのまま本文になっていた。しかも need フラグまで外れるため、
 * 壊れた訳文が誰にも回されずに残った。生応答は記録（ログ）にだけ残す。
 *
 * @param rawResponse 最後に受け取った生応答
 * @param error 最後の検証エラー
 * @param attempts 送り直しを含めて何回試したか
 */
function buildUnusableResponseError(
	rawResponse: string,
	error: ValidationError | undefined,
	attempts: number,
): UnusableAIResponseError {
	// 空の答えは「形が違う」ではなく「何も返ってこなかった」。区別しないと、
	// 利用者に出る説明が「JSON の形が違います」になり、実態と食い違う
	const reason = rawResponse.trim() === "" ? "empty" : "invalid-format";
	const message =
		reason === "empty"
			? `AI returned an empty response after ${attempts} attempt(s)`
			: `AI response did not match the expected format after ${attempts} attempt(s): ${error?.message ?? "unknown error"}`;
	return new UnusableAIResponseError(
		reason,
		message,
		`code=${error?.code ?? "UNKNOWN"} rawChars=${rawResponse.length}`,
	);
}

/** 戻せなかったコードブロックがあれば警告文にする（黙って消さない） */
function codeBlockLossWarnings(missing: string[]): string[] {
	if (missing.length === 0) {
		return [];
	}
	return [`AI response dropped ${missing.length} code block(s); they could not be restored: ${missing.join(", ")}`];
}

/**
 * 用語候補情報
 */
export interface TermSuggestion {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** 用語が使用されている実際の文脈（contextLang言語からの引用） */
	context: string;
	/** 用語集に追加すべき理由（オプショナル） */
	reason?: string;
}

/**
 * 翻訳結果
 * 翻訳されたテキストと追加のメタデータを含む
 */
export interface TranslationResult {
	/** 翻訳されたテキスト */
	translatedText: string;
	/** AIが提案する用語候補のリスト */
	termSuggestions?: TermSuggestion[];
	/** 警告メッセージ */
	warnings?: string[];
	/**
	 * AI の応答から消えていて戻せなかったコードブロックの数。
	 * `warnings` は JSON 混入検出など別種の指摘も混ざるため、
	 * 「本文が失われた」ことだけを見たい呼び出し側はこちらを使う。
	 */
	droppedCodeBlocks?: number;
	/** 統計情報（将来の拡張用） */
	stats?: {
		/** 推定使用トークン数 */
		estimatedTokens?: number;
	};
}

/**
 * 改訂パッチ翻訳結果
 */
export interface RevisionPatchResult {
	/** 前回訳文に対するunified diffパッチ */
	targetPatch: string;
	/**
	 * このパッチをどの形式として読むか。**中身から推測させないために結果へ同梱する**
	 * （ADR-260903-01）。当てはめは `applyRevisionPatch(prev, targetPatch, format)` を通す。
	 */
	format: PatchFormat;
	/** AIが提案する用語候補のリスト */
	termSuggestions?: TermSuggestion[];
	/** 警告メッセージ */
	warnings?: string[];
	/** AI の応答から消えていて戻せなかったコードブロックの数（TranslationResult と同義） */
	droppedCodeBlocks?: number;
	/**
	 * 当てはめる前にパッチの失敗と分かったときの理由。あれば `targetPatch` は空で、当ててはいけない。
	 * いまは「送り直しても渡した行番号を本文へ書き戻し続けた」（`line-number-residue`）だけ。
	 */
	patchFailure?: PatchFailureReason;
	/** 統計情報（将来の拡張用） */
	stats?: {
		/** 推定使用トークン数 */
		estimatedTokens?: number;
	};
}

/**
 * まとめて頼む改訂の1ユニット分の材料（ADR-261110-01）
 */
export interface RevisionBatchItem {
	/** 改訂後の原文 */
	source: string;
	/** パッチを当てる前の訳文 */
	previousTranslation: string;
	/** 原文の変更差分（unified diff） */
	sourceDiff: string;
	/** このユニットに当たった TM の参考（整形済み） */
	tmReferences?: string;
}

/**
 * まとめて頼んだ改訂の1ユニット分の答え。
 * `noChange` は「原文の変更は訳を変えなくてよい」と AI が答えたことを表す。
 */
export type RevisionBatchResult = { noChange: true } | (RevisionPatchResult & { noChange?: false });

/**
 * 翻訳サービスのインターフェース
 */
export interface Translator {
	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @param unitContext ログ用ユニット情報
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult>;

	/**
	 * 改訂時のパッチ翻訳を実行する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @param unitContext ログ用ユニット情報
	 * @returns 改訂パッチ翻訳結果
	 */
	translateRevisionPatch(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionPatchResult>;

	/**
	 * 連続する新規翻訳のユニットを、まとめて1回で訳す（ADR-261109-01）。
	 *
	 * 実装しない翻訳サービスもある（呼び出し側は1件ずつの `translate` へ戻る）。
	 * 答えをユニットへ分けられなければ、送り直しのあとで `UnusableAIResponseError` を投げる。
	 *
	 * @param texts まとめるユニットの原文（ファイルの中の順）
	 * @param context まとまり全体の参考（前後のユニット・用語・TM）
	 * @returns `texts` と同じ順の訳。用語候補は含まない
	 */
	translateBatch?(
		texts: readonly string[],
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult[]>;

	/**
	 * まとめて頼む経路を使えるか。`trans.translate` の指示文だけを利用者が上書きしている
	 * ときは使わない — 上書きは1件ずつ JSON で答える形に向けて書かれており、まとめて頼むと
	 * 利用者の指示が効かなくなる。
	 */
	canTranslateBatch?(): boolean;

	/**
	 * 同じファイルの改訂を、まとめて1回で頼む（ADR-261110-01）。
	 *
	 * 答えをユニットへ分けられなければ、送り直しのあとで `UnusableAIResponseError` を投げる
	 * （呼び出し側は1件ずつの `translateRevisionPatch` へ戻る）。
	 *
	 * @param items ユニットごとの材料
	 * @param context まとまり全体の参考（用語）
	 * @returns `items` と同じ順の答え
	 */
	translateRevisionBatch?(
		items: readonly RevisionBatchItem[],
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionBatchResult[]>;

	/**
	 * まとめて改訂を頼む経路を使えるか。`trans.revisePatch` だけを利用者が上書きしているときは
	 * 使わない（上書きが効かなくなるため）。
	 */
	canTranslateRevisionBatch?(): boolean;
}

/**
 * Translatorが使用するプロンプトIDの設定
 * デフォルトはMarkdown用プロンプト
 */
export interface TranslatorPromptConfig {
	translatePromptId: PromptId;
	revisePatchPromptId: PromptId;
}

/** Markdown用のデフォルトプロンプト設定 */
const DEFAULT_MD_PROMPT_CONFIG: TranslatorPromptConfig = {
	translatePromptId: PromptIds.TRANS_TRANSLATE,
	revisePatchPromptId: PromptIds.TRANS_REVISE_PATCH,
};

/** 非MDファイル用のプロンプト設定 */
export const PLAIN_PROMPT_CONFIG: TranslatorPromptConfig = {
	translatePromptId: PromptIds.TRANS_TRANSLATE_PLAIN,
	revisePatchPromptId: PromptIds.TRANS_REVISE_PATCH_PLAIN,
};

/**
 * AI翻訳サービス実装
 */
export class AITranslator implements Translator {
	private readonly aiService: AIService;
	private readonly primaryLang: string;
	private readonly getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts;
	private readonly promptConfig: TranslatorPromptConfig;
	/** 最大リトライ回数。通常は `TranslatorBuilder` が `trans.retryLimit` を渡す（コンストラクタ引数省略時のみ 2） */
	private readonly maxRetries: number;
	/** その指示文が利用者に上書きされているか（改訂パッチの形式の決定に使う） */
	private readonly hasCustomPrompt: (id: PromptId) => boolean;

	constructor(
		aiService: AIService,
		primaryLang: string,
		getPromptParts: (id: PromptId, variables?: PromptVariables) => PromptParts,
		promptConfig?: TranslatorPromptConfig,
		retryLimit?: number,
		hasCustomPrompt?: (id: PromptId) => boolean,
	) {
		this.aiService = aiService;
		this.primaryLang = primaryLang;
		this.getPromptParts = getPromptParts;
		this.promptConfig = promptConfig ?? DEFAULT_MD_PROMPT_CONFIG;
		this.maxRetries = retryLimit ?? 2;
		this.hasCustomPrompt = hasCustomPrompt ?? (() => false);
	}

	/**
	 * 改訂パッチをどの形式で読むかを決める。
	 *
	 * 組み込みの指示文は行番号方式（ADR-260903-01）。**利用者が指示文を上書きしている
	 * ときだけ旧来の `=`/`-`/`+` として読む** — 既存の上書きはその形式に向けて書かれており、
	 * 新形式として読むと必ず失敗するため（`docs/design/prompt.md`）。
	 */
	private resolvePatchFormat(): PatchFormat {
		return this.hasCustomPrompt(this.promptConfig.revisePatchPromptId) ? "prefixed" : "linenum";
	}

	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 * @param sourceLang 翻訳元の言語コード
	 * @param targetLang 翻訳先の言語コード
	 * @param context 翻訳コンテキスト
	 * @param cancellationToken キャンセル処理用トークン
	 * @param unitContext ログ用ユニット情報
	 * @returns 翻訳結果（翻訳テキストと追加メタデータ）
	 */
	async translate(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult> {
		// コードブロックは翻訳させずに退避する（判定はパーサーと同じ getCodeBlockLineSet）。
		// Markdown でないファイル（trans.extensions）には Markdown 固有の規則を当てない
		const {
			text: textWithoutCodeBlocks,
			codeBlocks,
			placeholders,
		} = protectCodeBlocks(text, {
			markdown: isMarkdownExtension(context.fileExtension),
		});

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const primaryLang = this.primaryLang;
		const contextLang = primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

		// systemPrompt（静的）と user message（可変コンテキスト＋本文）の構築。
		// 参考として添える文（周辺テキスト・前回訳文）は、本文と同じくコードブロックを
		// 伏せてから渡す。ここは参考にしかならないので中身は要らず、生のまま乗せると
		// 本文側のプレースホルダとの食い違いが「変更点」に見える（elideCodeBlocks 参照）
		const markdown = isMarkdownExtension(context.fileExtension);
		const promptParts = this.getPromptParts(this.promptConfig.translatePromptId, {
			sourceLang,
			targetLang,
			contextLang,
			surroundingText: elideCodeBlocks(context.surroundingText, { markdown }),
			terms: context.terms,
			previousTranslation: elideCodeBlocks(context.previousTranslation, { markdown }),
			sourceDiff: context.sourceDiff,
			tmReferences: context.tmReferences,
			fileExtension: context.fileExtension,
		});

		const messages: AIMessage[] = [
			{
				role: "user",
				content: buildUserMessage(promptParts, textWithoutCodeBlocks),
			},
		];

		// リトライ付きでAI呼び出し
		return await this.executeTranslationWithRetry(
			promptParts.system,
			messages,
			codeBlocks,
			placeholders,
			markdown,
			cancellationToken,
			unitContext,
		);
	}

	/**
	 * 改訂パッチ翻訳を実行する
	 */
	async translateRevisionPatch(
		text: string,
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionPatchResult> {
		// コードブロックは翻訳させずに退避する（判定はパーサーと同じ getCodeBlockLineSet）。
		// Markdown でないファイル（trans.extensions）には Markdown 固有の規則を当てない
		const {
			text: textWithoutCodeBlocks,
			codeBlocks,
			placeholders,
		} = protectCodeBlocks(text, {
			markdown: isMarkdownExtension(context.fileExtension),
		});

		// contextLangを決定: primaryLangがsourceLangかtargetLangなら使用、そうでなければsourceLang
		const primaryLang = this.primaryLang;
		const contextLang = primaryLang === sourceLang || primaryLang === targetLang ? primaryLang : sourceLang;

		// 周辺テキストは参考にしかならないのでコードブロックを伏せる。
		// **前回訳文だけは生のまま渡す** — 差分パッチはこの文と1行ずつ突き合わせて
		// 当てはめる（`applySimplePatch`）ので、目印に畳むと "=" の文脈行が
		// 実物と一致しなくなり、パッチが必ず外れる
		const markdown = isMarkdownExtension(context.fileExtension);
		const promptParts = this.getPromptParts(this.promptConfig.revisePatchPromptId, {
			sourceLang,
			targetLang,
			contextLang,
			surroundingText: elideCodeBlocks(context.surroundingText, { markdown }),
			terms: context.terms,
			previousTranslation: context.previousTranslation,
			// 行番号方式の指示文はこちらを使う。両方渡しておき、使う側（テンプレート）が選ぶ
			numberedPreviousTranslation: context.previousTranslation
				? numberLinesForPatch(context.previousTranslation)
				: undefined,
			sourceDiff: context.sourceDiff,
			tmReferences: context.tmReferences,
			fileExtension: context.fileExtension,
		});

		const messages: AIMessage[] = [
			{
				role: "user",
				content: buildUserMessage(promptParts, textWithoutCodeBlocks),
			},
		];

		// リトライ付きでAI呼び出し
		return await this.executeRevisionPatchWithRetry(
			promptParts.system,
			messages,
			codeBlocks,
			placeholders,
			markdown,
			this.resolvePatchFormat(),
			cancellationToken,
			unitContext,
		);
	}

	canTranslateBatch(): boolean {
		// 非MDファイル用の構成ではまとめない（ユニットが1つしかない）
		if (this.promptConfig.translatePromptId !== PromptIds.TRANS_TRANSLATE) {
			return false;
		}
		return !this.hasCustomPrompt(PromptIds.TRANS_TRANSLATE) || this.hasCustomPrompt(PromptIds.TRANS_TRANSLATE_BATCH);
	}

	async translateBatch(
		texts: readonly string[],
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult[]> {
		const markdown = isMarkdownExtension(context.fileExtension);
		// コードブロックは **ユニットごとに** 退避する。つないでから退避すると、区切りの直後の
		// インデントのコードがコードと見なされない（段落の続きになる）。目印の番号はまとまりの
		// 中で通しにし、答えはユニットに分けてから、そのユニットの目印だけを戻す。戻してから
		// 分けると、コードの中にある区切りに似た行まで区切りとして数えてしまう
		const protectedUnits = protectUnitsWithSharedNumbering(texts, markdown);
		const protectedText = joinBatchSource(protectedUnits.map((u) => u.text));
		const promptParts = this.getPromptParts(PromptIds.TRANS_TRANSLATE_BATCH, {
			sourceLang,
			targetLang,
			surroundingText: elideCodeBlocks(context.surroundingText, { markdown }),
			terms: context.terms,
			tmReferences: context.tmReferences,
		});
		const messages: AIMessage[] = [{ role: "user", content: buildUserMessage(promptParts, protectedText) }];
		const logger = Logger.getInstance();

		let lastError: ValidationError | undefined;
		let lastRawResponse = "";
		let attemptsMade = 0;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (cancellationToken?.isCancellationRequested) {
				throw new OperationCancelledError("Translation cancelled");
			}
			const suffix = attempt > 0 && lastError ? this.buildBatchRetryPromptSuffix(lastError, attempt, texts.length) : "";
			const attemptMessages = suffix ? this.appendToLastUserMessage(messages, suffix) : messages;
			attemptsMade++;
			lastRawResponse = await this.aiService.sendMessage(promptParts.system, attemptMessages, cancellationToken);
			const validation = validateBatchTranslationResponse(lastRawResponse, texts.length);
			const parts =
				validation.valid && validation.parsed !== undefined
					? splitBatchResponse(validation.parsed, texts.length)
					: undefined;
			if (parts) {
				const restored = parts.map((part, i) =>
					restoreCodeBlocks(part, protectedUnits[i].placeholders, protectedUnits[i].codeBlocks),
				);
				const missing = restored.flatMap((r) => r.missing);
				// **コードブロックを1つでも落とした答えは採らない。** 1件ずつの経路は落とした数を
				// 警告に残して採るが、まとめた答えを部分的に採ると、どこが欠けたかが見えにくい。
				// 送り直し、それでも落とすなら呼び出し側が1件ずつの経路へ戻る
				if (missing.length === 0) {
					return restored.map((r) => {
						const sanitized = sanitizeTranslationOutput(r.text);
						return {
							translatedText: sanitized.text,
							termSuggestions: [],
							warnings: sanitized.warnings,
							droppedCodeBlocks: 0,
						};
					});
				}
				lastError = {
					code: "UNIT_SEPARATOR_MISMATCH",
					message: `The answer dropped ${missing.length} code block placeholder(s): ${missing.join(", ")}`,
					retryable: true,
				};
			} else {
				lastError = validation.error;
			}
			if (!lastError?.retryable) {
				break;
			}
			if (attempt > 0) {
				logger.warn("trans", "Translation retry (batch)", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					units: texts.length,
					reason: lastError.message,
					unitHash: unitContext?.unitHash,
				});
			}
		}
		logger.warn("trans", "Batch translation failed after all retry attempts", {
			totalAttempts: attemptsMade,
			units: texts.length,
			lastError: lastError ? formatError(lastError) : "No error details available",
			unitHash: unitContext?.unitHash,
			title: unitContext?.title,
		});
		throw buildUnusableResponseError(lastRawResponse, lastError, attemptsMade);
	}

	canTranslateRevisionBatch(): boolean {
		if (this.promptConfig.revisePatchPromptId !== PromptIds.TRANS_REVISE_PATCH) {
			return false;
		}
		// 旧来の形式（=/-/+）で読む上書きがあるときは、まとめた答えの形と合わない
		if (this.resolvePatchFormat() !== "linenum") {
			return this.hasCustomPrompt(PromptIds.TRANS_REVISE_PATCH_BATCH);
		}
		return true;
	}

	async translateRevisionBatch(
		items: readonly RevisionBatchItem[],
		sourceLang: string,
		targetLang: string,
		context: TranslationContext,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionBatchResult[]> {
		const markdown = isMarkdownExtension(context.fileExtension);
		// コードブロックは改訂後の原文の側だけ目印にする。**前の訳文は生のまま渡す**
		// （パッチはこの文の行番号を指すので、畳むと行がずれる）。目印の番号はユニットごとに
		// 0 から振り、答えもユニットごとに戻す
		const protectedSources = items.map((item) => protectCodeBlocks(item.source, { markdown }));
		const blocks = items.map((item, i) => {
			const lines = [
				unitSeparator(i + 1),
				"Previous Translation (target to patch), with a line number and a tab before each line:",
				numberLinesForPatch(item.previousTranslation),
				"",
				"Source Text Changes:",
				"```diff",
				item.sourceDiff.replace(/\n+$/, ""),
				"```",
				"",
				"Revised Source:",
				protectedSources[i].text,
			];
			if (item.tmReferences) {
				lines.push("", "Translation Memory Reference (past translations of similar sentences):", item.tmReferences);
			}
			return lines.join("\n");
		});
		const promptParts = this.getPromptParts(PromptIds.TRANS_REVISE_PATCH_BATCH, {
			sourceLang,
			targetLang,
			terms: context.terms,
		});
		const messages: AIMessage[] = [{ role: "user", content: buildUserMessage(promptParts, blocks.join("\n\n")) }];
		const logger = Logger.getInstance();

		let lastError: ValidationError | undefined;
		let lastRawResponse = "";
		let attemptsMade = 0;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			if (cancellationToken?.isCancellationRequested) {
				throw new OperationCancelledError("Translation cancelled");
			}
			const suffix =
				attempt > 0 && lastError ? this.buildRevisionBatchRetryPromptSuffix(lastError, attempt, items.length) : "";
			const attemptMessages = suffix ? this.appendToLastUserMessage(messages, suffix) : messages;
			attemptsMade++;
			lastRawResponse = await this.aiService.sendMessage(promptParts.system, attemptMessages, cancellationToken);
			const validation = validateRevisionBatchResponse(lastRawResponse, items.length);
			if (validation.valid && validation.parsed) {
				return validation.parsed.map((part, i): RevisionBatchResult => {
					if (part.trim() === NO_CHANGE_ANSWER) {
						return { noChange: true };
					}
					const restored = restoreCodeBlocks(part, protectedSources[i].placeholders, protectedSources[i].codeBlocks);
					const sanitized = sanitizeTranslationOutput(restored.text);
					return {
						targetPatch: sanitized.text,
						format: "linenum",
						termSuggestions: [],
						warnings: sanitized.warnings,
						droppedCodeBlocks: 0,
					};
				});
			}
			lastError = validation.error;
			if (!lastError?.retryable) {
				break;
			}
			if (attempt > 0) {
				logger.warn("trans", "Translation retry (revision batch)", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					units: items.length,
					reason: lastError.message,
					unitHash: unitContext?.unitHash,
				});
			}
		}
		logger.warn("trans", "Revision batch failed after all retry attempts", {
			totalAttempts: attemptsMade,
			units: items.length,
			lastError: lastError ? formatError(lastError) : "No error details available",
			unitHash: unitContext?.unitHash,
			title: unitContext?.title,
		});
		throw buildUnusableResponseError(lastRawResponse, lastError, attemptsMade);
	}

	/** まとめて頼んだ改訂のやり直しの補足 */
	private buildRevisionBatchRetryPromptSuffix(error: ValidationError, attemptNumber: number, count: number): string {
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Answer in PLAIN TEXT. Do NOT output JSON. Do NOT wrap the answer in a code block.
- Output every separator line from @@@ UNIT 1 @@@ to @@@ UNIT ${count} @@@, in order.
- After each separator, write that unit's edit blocks (REPLACE / INSERT AFTER / DELETE, each closed by END), or the single line NO CHANGE.
- Never repeat the line numbers inside an edit block.`;
	}

	/** まとめて頼んだ翻訳のやり直しの補足（素のテキストで、区切りをそろえるよう念を押す） */
	private buildBatchRetryPromptSuffix(error: ValidationError, attemptNumber: number, count: number): string {
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
- Answer in PLAIN TEXT (Markdown). Do NOT output JSON. Do NOT wrap the answer in a code block.
- Start with the line @@@ UNIT 1 @@@ and output every separator line from @@@ UNIT 1 @@@ to @@@ UNIT ${count} @@@, in order, each followed by the translation of that unit.
- Reproduce every __CODE_BLOCK_PLACEHOLDER_n__ marker verbatim.`;
	}

	/**
	 * リトライ付き翻訳実行
	 */
	private async executeTranslationWithRetry(
		systemPrompt: string,
		messages: AIMessage[],
		codeBlocks: string[],
		placeholders: string[],
		/** 本文への JSON 混入を検出するか（Markdown 以外では偽陽性になるので見ない） */
		detectJsonInContent: boolean,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<TranslationResult> {
		let lastError: ValidationError | undefined;
		let lastRawResponse = "";
		// 実際に送った回数。上限に達する前に打ち切ることがあるので、上限をそのまま
		// 「試した回数」として報告しない（記録が実態と食い違う）
		let attemptsMade = 0;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				throw new OperationCancelledError("Translation cancelled");
			}

			// リトライ時は補足プロンプトを user message 側に追加する
			// （system prompt を不変に保ち、プレフィックスキャッシュを維持するため）
			const retryPromptSuffix = attempt > 0 && lastError ? this.buildRetryPromptSuffix(lastError, attempt) : "";
			const attemptMessages = retryPromptSuffix ? this.appendToLastUserMessage(messages, retryPromptSuffix) : messages;

			attemptsMade++;
			lastRawResponse = await this.aiService.sendMessage(systemPrompt, attemptMessages, cancellationToken);
			const validation = validateTranslationResponse(lastRawResponse, {
				detectJsonInContent,
			});

			if (validation.valid && validation.parsed) {
				// バリデーション成功 → サニタイズ処理
				return this.processValidTranslationResponse(validation.parsed, codeBlocks, placeholders);
			}

			lastError = validation.error;

			// リトライ不可能なエラーは即座にフォールバック
			if (!lastError?.retryable) {
				break;
			}

			// リトライ発生時のログ（初回実行の失敗はログ出力しない）
			if (attempt > 0) {
				const logger = Logger.getInstance();
				logger.warn("trans", "Translation retry", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					retryable: lastError.retryable,
					unitHash: unitContext?.unitHash,
					title: unitContext?.title,
				});
			}
		}

		// リトライ上限到達後のエラーログ
		const logger = Logger.getInstance();
		logger.error("trans", "Translation failed after all retry attempts", {
			totalAttempts: attemptsMade,
			lastError: lastError ? formatError(lastError) : "No error details available",
			unitHash: unitContext?.unitHash,
			title: unitContext?.title,
		});

		// 検証に落ちた答えは**使わない**。ここで断ち切る
		throw buildUnusableResponseError(lastRawResponse, lastError, attemptsMade);
	}

	/**
	 * リトライ付き改訂パッチ翻訳実行
	 */
	private async executeRevisionPatchWithRetry(
		systemPrompt: string,
		messages: AIMessage[],
		codeBlocks: string[],
		placeholders: string[],
		/** 本文への JSON 混入を検出するか（Markdown 以外では偽陽性になるので見ない） */
		detectJsonInContent: boolean,
		/** どの形式で読むか。**推測しない**（ADR-260903-01） */
		format: PatchFormat,
		cancellationToken?: vscode.CancellationToken,
		unitContext?: { unitHash?: string; title?: string },
	): Promise<RevisionPatchResult> {
		let lastError: ValidationError | undefined;
		let lastRawResponse = "";
		// 実際に送った回数。上限に達する前に打ち切ることがあるので、上限をそのまま
		// 「試した回数」として報告しない（記録が実態と食い違う）
		let attemptsMade = 0;

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			// キャンセルチェック
			if (cancellationToken?.isCancellationRequested) {
				throw new OperationCancelledError("Translation cancelled");
			}

			// リトライ時は補足プロンプトを user message 側に追加する
			// （system prompt を不変に保ち、プレフィックスキャッシュを維持するため）
			const retryPromptSuffix = attempt > 0 && lastError ? this.buildRetryPromptSuffix(lastError, attempt, format) : "";
			const attemptMessages = retryPromptSuffix ? this.appendToLastUserMessage(messages, retryPromptSuffix) : messages;

			attemptsMade++;
			lastRawResponse = await this.aiService.sendMessage(systemPrompt, attemptMessages, cancellationToken);
			// 行番号方式は素のテキストで返る。JSON の封筒を前提にした検証は当てられない
			const validation =
				format === "linenum"
					? validateRevisionPatchPlainResponse(lastRawResponse)
					: validateRevisionPatchResponse(lastRawResponse, { detectJsonInContent });

			if (validation.valid && validation.parsed) {
				// バリデーション成功 → サニタイズ処理
				return this.processValidRevisionPatchResponse(validation.parsed, codeBlocks, placeholders, format);
			}

			lastError = validation.error;

			// リトライ不可能なエラーは即座にフォールバック
			if (!lastError?.retryable) {
				break;
			}

			// リトライ発生時のログ（初回実行の失敗はログ出力しない）
			if (attempt > 0) {
				const logger = Logger.getInstance();
				logger.warn("trans", "Translation retry (revision patch)", {
					attempt: attempt + 1,
					maxRetries: this.maxRetries + 1,
					reason: lastError.message,
					retryable: lastError.retryable,
					unitHash: unitContext?.unitHash,
					title: unitContext?.title,
				});
			}
		}

		// リトライ上限到達後のエラーログ
		const logger = Logger.getInstance();
		logger.error("trans", "Translation failed after all retry attempts (revision patch)", {
			totalAttempts: attemptsMade,
			lastError: lastError ? formatError(lastError) : "No error details available",
			unitHash: unitContext?.unitHash,
			title: unitContext?.title,
		});

		// 行番号の書き戻しは、形は合っているパッチの失敗である。「使えない答え」にすると
		// 「期待した形で答えなかった」という別の説明になるので、パッチの失敗として返し、
		// 当てはめの失敗と同じ扱い（訳文を据え置き、書き戻しに向けた案内を出す）に乗せる
		if (lastError?.code === "LINE_NUMBER_ECHO") {
			return { targetPatch: "", format, patchFailure: "line-number-residue" };
		}

		// 検証に落ちた答えは**使わない**。ここで断ち切る
		throw buildUnusableResponseError(lastRawResponse, lastError, attemptsMade);
	}

	/**
	 * 有効な翻訳レスポンスを処理
	 */
	private processValidTranslationResponse(
		parsed: ParsedTranslationResponse,
		codeBlocks: string[],
		placeholders: string[],
	): TranslationResult {
		// プレースホルダー復元
		const restored = restoreCodeBlocks(parsed.translation, placeholders, codeBlocks);

		// サニタイズ処理
		const sanitized = sanitizeTranslationOutput(restored.text);

		return {
			translatedText: sanitized.text,
			termSuggestions: parsed.termSuggestions ?? [],
			warnings: [...codeBlockLossWarnings(restored.missing), ...sanitized.warnings, ...(parsed.warnings ?? [])],
			droppedCodeBlocks: restored.missing.length,
		};
	}

	/**
	 * 有効な改訂パッチレスポンスを処理
	 */
	private processValidRevisionPatchResponse(
		parsed: ParsedRevisionPatchResponse,
		codeBlocks: string[],
		placeholders: string[],
		format: PatchFormat,
	): RevisionPatchResult {
		// プレースホルダー復元
		const restored = restoreCodeBlocks(parsed.targetPatch, placeholders, codeBlocks);

		// サニタイズ処理
		const sanitized = sanitizeTranslationOutput(restored.text);

		return {
			targetPatch: sanitized.text,
			format,
			termSuggestions: parsed.termSuggestions ?? [],
			warnings: [...codeBlockLossWarnings(restored.missing), ...sanitized.warnings, ...(parsed.warnings ?? [])],
			droppedCodeBlocks: restored.missing.length,
		};
	}

	/**
	 * 末尾のuserメッセージにリトライ補足を連結した新しいメッセージ配列を返す
	 */
	private appendToLastUserMessage(messages: AIMessage[], suffix: string): AIMessage[] {
		if (messages.length === 0) {
			return messages;
		}
		const last = messages[messages.length - 1];
		const content = Array.isArray(last.content) ? last.content.join("") : last.content;
		return [...messages.slice(0, -1), { ...last, content: content + suffix }];
	}

	/**
	 * リトライ用補足プロンプト生成
	 */
	private buildRetryPromptSuffix(error: ValidationError, attemptNumber: number, format?: PatchFormat): string {
		// **やり直しの補足は、求めている形式と揃っていなければならない。**
		// 行番号方式（素のテキスト）で失敗した直後に「JSON を返せ」と言うと、
		// 2回目以降がかえって失敗しやすくなる（レビュー指摘・実バグだった）
		const reminder =
			format === "linenum"
				? `- Answer with edit blocks in PLAIN TEXT. Do NOT output JSON.
- Each block starts with REPLACE <from>-<to>, INSERT AFTER <n>, or DELETE <from>-<to>, and ends with a line containing only END.
- Do NOT wrap the answer in a Markdown code block.`
				: `- Return ONLY a valid JSON object with the required fields.
- The "translation" or "targetPatch" field must contain PLAIN TEXT, not JSON.
- Do NOT nest JSON inside the translation or targetPatch field.`;
		return `

RETRY INSTRUCTION (Attempt ${attemptNumber}):
The previous response was invalid: ${error.message}

CRITICAL REMINDER:
${reminder}`;
	}
}
