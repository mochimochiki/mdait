import { calculateHash } from "../hash/hash-calculator";
import { MdaitHeader } from "./mdait-header";

/**
 * Markdownセクションクラス
 * Markdownドキュメントのセクション（見出しから次の見出しまで）を表現する
 * @important このクラスはドメインオブジェクトです。変更時は理由を明示し、承認なしに編集しないでください。
 */
export class MdaitSection {
	/**
	 * コンストラクタ
	 * @param mdaitHeader mdaitヘッダー
	 * @param title セクションのタイトル（見出し）
	 * @param headingLevel 見出しのレベル（1=h1, 2=h2, ...）
	 * @param content 元のMarkdownコンテンツ（見出しと本文を含む原文）
	 */
	constructor(
		public mdaitHeader: MdaitHeader,
		public title: string,
		public headingLevel: number,
		public content: string, // 元のMarkdownコンテンツを保持
	) {}

	/**
	 * セクションをMarkdown形式の文字列として出力
	 * 元の形式をそのまま保持するため、contentを返す
	 */
	toString(): string {
		let result = "";

		if (this.mdaitHeader) {
			result += `${this.mdaitHeader.toString()}\n`;
		}

		result += this.content;
		return result;
	}

	/**
	 * セクションが翻訳が必要かどうか
	 */
	needsTranslation(): boolean {
		return this.mdaitHeader ? this.mdaitHeader.needsTranslation() : false;
	}

	/**
	 * 翻訳元セクションのハッシュを取得
	 */
	getSourceHash(): string | null {
		return this.mdaitHeader ? this.mdaitHeader.srcHash : null;
	}

	/**
	 * 翻訳が完了したマークをする（needタグの除去）
	 */
	markAsTranslated(): void {
		if (this.mdaitHeader) {
			this.mdaitHeader.removeNeedTag();
		}
	}

	/**
	 * 空のターゲットセクションを作成する
	 * @param sourceSection ソースセクション
	 * @param sourceHash ソースハッシュ
	 * @returns 空のターゲットセクション
	 */
	static createEmptyTargetSection(
		sourceSection: MdaitSection,
		sourceHash: string,
	): MdaitSection {
		// ソースセクションのハッシュを新しく計算
		const newHash = calculateHash(sourceSection.content);
		// 新しいヘッダーを作成（needタグ付き）
		const newHeader = new MdaitHeader(newHash, sourceHash, "need");
		// 新しいセクションを作成して返す
		return new MdaitSection(
			newHeader,
			sourceSection.title,
			sourceSection.headingLevel,
			sourceSection.content,
		);
	}
}
