/*
 * 改訂ベンチのケース集合。
 *
 * 1件が「原文の旧版・新版・その旧版に対応する訳文」の3つ組。改訂（revise）は
 * この3つから「訳文へのパッチ」を作らせる仕事なので、これが最小の材料になる。
 *
 * 難度は**モデルの賢さではなく、要求の重さ**で刻む（`docs/roadmaps/roadmap-v03_revise-prompt-optimization.md`）。
 * 重くする軸は4つで、どのケースがどれを踏んでいるかは `stress` に書いてある。
 *
 *   markdown-prefix … `-` や `+` で始まる行がある（プレフィックス方式の弱点を突く）
 *   code-block      … コードブロックがある（原文側は目印に畳まれ、訳文側は実物のまま。
 *                     この非対称は「原文が変わった」ではないと分かっている必要がある）
 *   long-context    … 文脈行が長い（逐語で写す負荷が高い）
 *   multi-hunk      … 離れた場所が2つ以上変わる（チャンクを分ける判断が要る）
 *
 * `maxChangedLines` は「訳文のうち、変わってよい行数の上限」。改訂は差分の周りだけを
 * 触るのが仕事なので、これを超えたら**当たったとしても仕事をしていない**（全文を書き直した）。
 * 質問4で決めた「当たったが壊れた」を捕まえる判定に使う。数え方は bench-revise.mjs の
 * `countChangedLines`（行単位の対称差）で、余裕を持たせた値を入れてある。
 *
 * `allowCjk` は、訳文（英語）に日本語が残っていてよいかどうか。既定は false で、
 * 残っていれば「原文をそのまま貼った」と見なす。コードブロックの中は数えない。
 *
 * `expect` は「改訂の中身が入ったか」の目安。訳文の正解は一意でないので、これは
 * **合否には使わない**（質問4の決定どおり、測るのは適用の成否と健全性まで）。
 * 数字や固有の綴りなど、訳し方が変わっても残るものだけを並べ、結果の脇に添える。
 */

/** @typedef {"markdown-prefix"|"code-block"|"long-context"|"multi-hunk"} Stress */

/**
 * @typedef {object} ReviseCase
 * @property {string} id            見出し用の短い名前（C1 など）
 * @property {string} genre         見本の出どころ（sample-content のどれに倣ったか）
 * @property {"easy"|"medium"|"hard"} difficulty
 * @property {Stress[]} stress      何で重くしているか
 * @property {string} sourceLang
 * @property {string} targetLang
 * @property {string} fileExtension コードブロックの畳み方が変わる（.md かどうか）
 * @property {string} sourceOld     原文の旧版
 * @property {string} sourceNew     原文の新版（これが改訂の要求）
 * @property {string} previousTranslation 旧版に対応する訳文（パッチを当てる相手）
 * @property {number} maxChangedLines 訳文のうち変わってよい行数の上限
 * @property {string} intent        何が変わったのかを人の言葉で（レポートに出す）
 * @property {boolean} [allowCjk]
 * @property {{present?:string[], absent?:string[]}} [expect] 改訂が入ったかの目安（合否には使わない）
 */

/** @type {ReviseCase[]} */
export const CASES = [
	{
		id: "C1",
		genre: "business",
		difficulty: "easy",
		stress: [],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "市場規模と成長率の数字だけが更新された（1行）",
		maxChangedLines: 2,
		expect: { present: ["62", "9\\s*%"], absent: ["50 billion", "\\b7\\s*%"] },
		sourceOld: `## 市場分析

### 対象市場

グローバル展開を目指す中小企業・スタートアップをターゲットとする。国内翻訳市場は約3,000億円（うちビジネス文書40%）、グローバル市場は500億ドル規模で年間成長率約7%と予測されている。`,
		sourceNew: `## 市場分析

### 対象市場

グローバル展開を目指す中小企業・スタートアップをターゲットとする。国内翻訳市場は約3,000億円（うちビジネス文書40%）、グローバル市場は620億ドル規模で年間成長率約9%と予測されている。`,
		previousTranslation: `## Market Analysis

### Target Market

We target small and medium-sized enterprises and startups seeking global expansion. The domestic translation market is worth approximately 300 billion yen (of which business documents account for 40%), while the global market is projected at 50 billion dollars with an annual growth rate of about 7%.`,
	},

	{
		id: "C2",
		genre: "chemistry",
		difficulty: "medium",
		stress: ["markdown-prefix"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "触媒の量が 0.5→1.0 mol% に変わり、試薬が1つ増えた（`-` で始まる箇条書き）",
		maxChangedLines: 4,
		expect: { present: ["1\\.0 mol", "ammonium"], absent: ["0\\.5 mol"] },
		sourceOld: `### 使用試薬

- 臭化アリール（10 mmol、純度98%以上）
- フェニルボロン酸（12 mmol、1.2当量）
- Pd(PPh₃)₄（0.5 mol%）
- 炭酸カリウム（20 mmol、2当量）
- 溶媒：DMF（脱水品）`,
		sourceNew: `### 使用試薬

- 臭化アリール（10 mmol、純度98%以上）
- フェニルボロン酸（12 mmol、1.2当量）
- Pd(PPh₃)₄（1.0 mol%）
- 炭酸カリウム（20 mmol、2当量）
- テトラブチルアンモニウムブロミド（1 mmol、相間移動触媒）
- 溶媒：DMF（脱水品）`,
		previousTranslation: `### Reagents Used

- Aryl bromide (10 mmol, purity 98% or higher)
- Phenylboronic acid (12 mmol, 1.2 equivalents)
- Pd(PPh₃)₄ (0.5 mol%)
- Potassium carbonate (20 mmol, 2 equivalents)
- Solvent: DMF (dehydrated grade)`,
	},

	{
		id: "C3",
		genre: "legal",
		difficulty: "medium",
		stress: ["markdown-prefix", "long-context"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "定義の第3号が言い換えられ、第5号が末尾に足された（太字＋番号付き箇条書き）",
		maxChangedLines: 4,
		expect: { present: ["image", "onfidential"], absent: [] },
		sourceOld: `## 第1条（定義）

本規約において、以下の用語は次の意味で使用する。

1. **「本サービス」**: 当社が提供するAI翻訳プラットフォームおよび付随する一切のサービス
2. **「利用者」**: 本規約に同意のうえ本サービスを利用する法人または個人
3. **「コンテンツ」**: 利用者が本サービスを通じて送信・翻訳する文書、データその他の情報
4. **「知的財産権」**: 特許権、実用新案権、商標権、著作権その他の知的財産に関する権利`,
		sourceNew: `## 第1条（定義）

本規約において、以下の用語は次の意味で使用する。

1. **「本サービス」**: 当社が提供するAI翻訳プラットフォームおよび付随する一切のサービス
2. **「利用者」**: 本規約に同意のうえ本サービスを利用する法人または個人
3. **「コンテンツ」**: 利用者が本サービスを通じて送信、保存または翻訳する文書、データ、画像その他一切の情報
4. **「知的財産権」**: 特許権、実用新案権、商標権、著作権その他の知的財産に関する権利
5. **「機密情報」**: 本サービスの利用に際して相手方に開示される、秘密である旨を明示した情報`,
		previousTranslation: `## Article 1 (Definitions)

In these Terms, the following terms have the meanings set out below.

1. **"the Service"**: the AI translation platform provided by the Company and all associated services
2. **"the User"**: the corporation or individual that uses the Service after agreeing to these Terms
3. **"Content"**: documents, data, and other information that the User transmits or translates through the Service
4. **"Intellectual Property Rights"**: patent rights, utility model rights, trademark rights, copyrights, and other rights relating to intellectual property`,
	},

	{
		id: "C4",
		genre: "technical",
		difficulty: "hard",
		stress: ["code-block", "long-context"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "コードブロックの後ろの説明文だけが変わった（コード自体は不変）",
		maxChangedLines: 3,
		expect: { present: ["503", "ackoff|ack-off"], absent: [] },
		sourceOld: `## エラーレスポンス

APIはエラー時に次の形式で応答する。

\`\`\`json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests",
    "retryAfter": 30
  }
}
\`\`\`

クライアントは429を受け取った場合、retryAfterの秒数だけ待機してから再試行すること。`,
		sourceNew: `## エラーレスポンス

APIはエラー時に次の形式で応答する。

\`\`\`json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests",
    "retryAfter": 30
  }
}
\`\`\`

クライアントは429または503を受け取った場合、retryAfterの秒数だけ待機してから再試行すること。retryAfterが無い場合は指数バックオフ（初回2秒、最大3回）を用いる。`,
		previousTranslation: `## Error Responses

On error, the API responds in the following format.

\`\`\`json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests",
    "retryAfter": 30
  }
}
\`\`\`

When a client receives a 429, it must wait for the number of seconds given in retryAfter before retrying.`,
	},

	{
		id: "C5",
		genre: "chemistry",
		difficulty: "hard",
		stress: ["multi-hunk", "long-context"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "離れた2か所が変わった（目標収率と、手順4の温度・時間）",
		maxChangedLines: 4,
		expect: { present: ["92", "100\\s*°?C", "12 hours"], absent: ["85%", "24 hours"] },
		sourceOld: `## 実験概要

パラジウム触媒を用いた鈴木・宮浦カップリング反応の収率向上を目的に条件検討を行った。従来法の収率60-70%に対し、85%以上の達成を目標とした。

## 実験手順

1. 三口フラスコに臭化アリール（10 mmol）を秤量
2. フェニルボロン酸（12 mmol）と炭酸カリウム（20 mmol）を追加
3. DMF（40 mL）を加え、窒素置換を3回繰り返す
4. Pd(PPh₃)₄（0.05 mmol）を加え、80°Cで24時間撹拌
5. TLC（ヘキサン/酢酸エチル = 9:1）で反応追跡`,
		sourceNew: `## 実験概要

パラジウム触媒を用いた鈴木・宮浦カップリング反応の収率向上を目的に条件検討を行った。従来法の収率60-70%に対し、92%以上の達成を目標とした。

## 実験手順

1. 三口フラスコに臭化アリール（10 mmol）を秤量
2. フェニルボロン酸（12 mmol）と炭酸カリウム（20 mmol）を追加
3. DMF（40 mL）を加え、窒素置換を3回繰り返す
4. Pd(PPh₃)₄（0.05 mmol）を加え、100°Cで12時間撹拌
5. TLC（ヘキサン/酢酸エチル = 9:1）で反応追跡`,
		previousTranslation: `## Experimental Overview

Reaction conditions were investigated to improve the yield of the Suzuki-Miyaura coupling reaction using a palladium catalyst. Against the 60-70% yield of the conventional method, the target was set at 85% or higher.

## Experimental Procedure

1. Weigh the aryl bromide (10 mmol) into a three-necked flask
2. Add phenylboronic acid (12 mmol) and potassium carbonate (20 mmol)
3. Add DMF (40 mL) and repeat nitrogen purging three times
4. Add Pd(PPh₃)₄ (0.05 mmol) and stir at 80°C for 24 hours
5. Follow the reaction by TLC (hexane/ethyl acetate = 9:1)`,
	},

	{
		id: "C6",
		genre: "legal",
		difficulty: "hard",
		stress: ["long-context", "markdown-prefix", "multi-hunk"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "引用の但し書きが変わり、入れ子の番号リストに1項目足された",
		maxChangedLines: 4,
		expect: { present: ["period|term", "rganized crime|ntisocial|nti-social|rganised crime"], absent: [] },
		sourceOld: `## 第2条（利用契約の成立）

1. 利用契約は、利用者が本規約に同意し所定の手続きを完了した時点で成立する。
2. 当社は、以下の場合に利用申込を拒否できるものとする。
   1. 申込内容に虚偽があった場合
   2. 過去に本規約違反により契約を解除されたことがある場合
   3. その他当社が不適当と判断した場合

## 第3条（サービス内容）

> 当社は、利用者に対し、以下のサービスを提供する。ただし、サービスの具体的内容は利用プランにより異なるものとする。

1. AI翻訳エンジンによる自動翻訳機能
2. 翻訳メモリの蓄積・活用機能
3. 用語集の管理・適用機能`,
		sourceNew: `## 第2条（利用契約の成立）

1. 利用契約は、利用者が本規約に同意し所定の手続きを完了した時点で成立する。
2. 当社は、以下の場合に利用申込を拒否できるものとする。
   1. 申込内容に虚偽があった場合
   2. 過去に本規約違反により契約を解除されたことがある場合
   3. 反社会的勢力に該当すると当社が判断した場合
   4. その他当社が不適当と判断した場合

## 第3条（サービス内容）

> 当社は、利用者に対し、以下のサービスを提供する。ただし、サービスの具体的内容は利用プランおよび契約期間により異なるものとする。

1. AI翻訳エンジンによる自動翻訳機能
2. 翻訳メモリの蓄積・活用機能
3. 用語集の管理・適用機能`,
		previousTranslation: `## Article 2 (Formation of the Use Agreement)

1. The use agreement is formed when the User agrees to these Terms and completes the prescribed procedure.
2. The Company may refuse an application for use in the following cases.
   1. Where the application contains false information
   2. Where the applicant has previously had an agreement terminated for breach of these Terms
   3. Where the Company otherwise deems the applicant unsuitable

## Article 3 (Content of the Service)

> The Company provides the User with the following services. However, the specific content of the services varies depending on the plan.

1. Automatic translation by the AI translation engine
2. Accumulation and use of translation memory
3. Management and application of glossaries`,
	},
];

/** 名前で絞る（`--cases C1,C4`）。指定が無ければ全部返す */
export function selectCases(only) {
	if (!only) return CASES;
	const wanted = new Set(
		String(only)
			.split(",")
			.map((s) => s.trim().toUpperCase())
			.filter(Boolean),
	);
	const picked = CASES.filter((c) => wanted.has(c.id.toUpperCase()));
	if (picked.length === 0) {
		throw new Error(
			`--cases に知らない名前が入っています: ${only}（使えるのは ${CASES.map((c) => c.id).join(" / ")}）`,
		);
	}
	return picked;
}
