/**
 * AIサービスとのやり取りで使用するメッセージコンテンツの型定義。
 * 現状はテキストのみを想定していますが、将来的には画像などのマルチモーダルコンテンツにも対応できるよう拡張性を考慮しています。
 */
export type AIMessageContent = string; // 将来的には { type: 'text', text: string } | { type: 'image', source: { type: 'base64', media_type: string, data: string } } なども許容

/**
 * AIサービスとのやり取りで使用するメッセージの構造を定義するインターフェース。
 * role にはメッセージの送信者（system, user, assistant）を指定します。
 * content にはメッセージの内容を AIMessageContent 型またはその配列で指定します。
 */
export interface AIMessage {
	role: "system" | "user" | "assistant";
	content: AIMessageContent | AIMessageContent[];
}

/**
 * AIサービスからのストリーミング応答を表す型定義。
 * テキストチャンクが非同期に連続して返されることを想定しています。
 */
export type MessageStream = AsyncIterable<string>;

/**
 * AI機能を提供するサービスの汎用インターフェース。
 * 様々なAIプロバイダ（OpenAI, Anthropic, Geminiなど）の実装を抽象化します。
 */
export interface AIService {
	/**
	 * AIモデルに対してメッセージを送信し、ストリーミング応答を受け取ります。
	 *
	 * @param systemPrompt システムプロンプト。AIモデルの振る舞いや応答形式を指示します。
	 * @param messages AIモデルに送信するメッセージの配列。AIMessage形式で指定します。
	 * @returns AIモデルからの応答をストリーミングで返す MessageStream。
	 */
	sendMessage(systemPrompt: string, messages: AIMessage[]): MessageStream;
}
