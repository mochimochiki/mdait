import { calculateHash } from "../hash/hash-calculator";
import { MdaitMarker } from "./mdait-marker";

/**
 * Markdownユニットクラス
 * Markdownドキュメントのユニット（見出しから次の見出しまで）を表現する
 * @important このクラスはドメインオブジェクトです。変更時は理由を明示し、承認なしに編集しないでください。
 */
export class MdaitUnit {
	/**
	 * コンストラクタ
	 * @param marker mdaitMarker（ユニットのメタデータ）
	 * @param title ユニットのタイトル（見出し）
	 * @param headingLevel 見出しのレベル（1=h1, 2=h2, ...）
	 * @param content 元のMarkdownコンテンツ（見出しと本文を含む原文）
	 * @param startLine 開始行番号（0ベース）
	 * @param endLine 終了行番号（0ベース）
	 */
	constructor(
		public marker: MdaitMarker,
		public title: string,
		public headingLevel: number,
		public content: string, // 元のMarkdownコンテンツを保持
		public startLine = 0,
		public endLine = 0,
	) {}

	/**
	 * ユニットをMarkdown形式の文字列として出力
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
	 * ユニットが翻訳が必要かどうか
	 */
	needsTranslation(): boolean {
		return this.marker ? this.marker.needsTranslation() : false;
	}
	/**
	 * 翻訳元ユニットのハッシュを取得
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
	 * 空のターゲットユニットを作成する
	 * @param sourceUnit ソースユニット
	 * @param sourceHash ソースハッシュ
	 * @returns 空のターゲットユニット
	 */
	static createEmptyTargetUnit(sourceUnit: MdaitUnit, sourceHash: string): MdaitUnit {
		// ソースユニットのハッシュを新しく計算
		const newHash = calculateHash(sourceUnit.content);
		// 新しいヘッダーを作成（needタグ付き）
		const newMarker = new MdaitMarker(newHash, sourceHash, "translate");
		// 新しいユニットを作成して返す
		return new MdaitUnit(
			newMarker,
			sourceUnit.title,
			sourceUnit.headingLevel,
			sourceUnit.content,
			sourceUnit.startLine,
			sourceUnit.endLine,
		);
	}
}
