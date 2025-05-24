import { calculateHash } from "../hash/hash-calculator";
import { MdaitMarker } from "./mdait-marker";

/**
 * Markdownセクションクラス
 * Markdownドキュメントのセクション（見出しから次の見出しまで）を表現する
 * @important このクラスはドメインオブジェクトです。変更時は理由を明示し、承認なしに編集しないでください。
 */
export class MdaitUnit {
	/**
	 * コンストラクタ
	 * @param marker mdaitMarker（セクションのメタデータ）
	 * @param title セクションのタイトル（見出し）
	 * @param headingLevel 見出しのレベル（1=h1, 2=h2, ...）
	 * @param content 元のMarkdownコンテンツ（見出しと本文を含む原文）
	 */
	constructor(
		public marker: MdaitMarker,
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

		if (this.marker) {
			result += `${this.marker.toString()}\n`;
		}

		result += this.content;
		return result;
	}

	/**
	 * セクションが翻訳が必要かどうか
	 */
	needsTranslation(): boolean {
		return this.marker ? this.marker.needsTranslation() : false;
	}
	/**
	 * 翻訳元セクションのハッシュを取得
	 */
	getSourceHash(): string | null {
		return this.marker ? this.marker.from : null;
	}

	/**
	 * 翻訳が完了したマークをする（needタグの除去）
	 */
	markAsTranslated(): void {
		if (this.marker) {
			this.marker.removeNeedTag();
		}
	}

	/**
	 * 空のターゲットセクションを作成する
	 * @param sourceUnit ソースユニット
	 * @param sourceHash ソースハッシュ
	 * @returns 空のターゲットユニット
	 */
	static createEmptyTargetUnit(
		sourceUnit: MdaitUnit,
		sourceHash: string,
	): MdaitUnit {
		// ソースセクションのハッシュを新しく計算
		const newHash = calculateHash(sourceUnit.content);
		// 新しいヘッダーを作成（needタグ付き）
		const newMarker = new MdaitMarker(newHash, sourceHash, "need");
		// 新しいセクションを作成して返す
		return new MdaitUnit(
			newMarker,
			sourceUnit.title,
			sourceUnit.headingLevel,
			sourceUnit.content,
		);
	}
}
