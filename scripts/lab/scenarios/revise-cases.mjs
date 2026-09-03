/*
 * 改訂ベンチのケース集合。
 *
 * 1件が「原文の旧版・新版・その旧版に対応する訳文」の3つ組。改訂（revise）は
 * この3つから「訳文へのパッチ」を作らせる仕事なので、これが最小の材料になる。
 *
 * 難度は**モデルの賢さではなく、要求の重さ**で刻む（`docs/roadmaps/roadmap-v03_revise-prompt-optimization.md`）。
 * 重くする軸は4つで、どのケースがどれを踏んでいるかは `stress` に書いてある。
 *
 *   markdown-prefix … `-` `+` `|` `=` で始まる行がある（プレフィックス方式の弱点を突く）
 *   code-block      … コードブロックがある（原文側は目印に畳まれ、訳文側は実物のまま。
 *                     この非対称は「原文が変わった」ではないと分かっている必要がある）
 *   long-context    … 文脈行が長い（逐語で写す負荷が高い）
 *   multi-hunk      … 離れた場所が2つ以上変わる（チャンクを分ける判断が要る）
 *   near-duplicate  … よく似た行が並ぶ（目印が一意にならない。表や繰り返しの箇条書き）
 *   escaping        … 引用符・バックスラッシュを含む（JSON の封筒に詰めるとき効いてくる）
 *   volume          … ユニットが長い（出力量が増え、打ち切りと写し間違いが起きやすくなる）
 *
 * `tier` は難度の段。**易しい段（easy）は残したまま重い段（hard）を足す** — 片方だけだと
 * 天井か床のどちらかに張り付いたときに何も言えないが、両方あれば「崖がどこにあるか」が勾配で読める。
 * 一次選抜（2026-09-01・haiku）で easy は 35/36 が成立し、天井に張り付いた。hard はその上の段。
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

/** @typedef {"markdown-prefix"|"code-block"|"long-context"|"multi-hunk"|"near-duplicate"|"escaping"|"volume"} Stress */

/**
 * @typedef {object} ReviseCase
 * @property {string} id            見出し用の短い名前（C1 など）
 * @property {string} genre         見本の出どころ（sample-content のどれに倣ったか）
 * @property {"easy"|"medium"|"hard"} difficulty
 * @property {Stress[]} stress      何で重くしているか
 * @property {"easy"|"hard"} tier   難度の段（easy: 一次で天井に当たった段 / hard: その上）
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
		tier: "easy",
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
		tier: "easy",
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
		tier: "easy",
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
		tier: "easy",
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
		tier: "easy",
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
		tier: "easy",
		genre: "legal",
		difficulty: "hard",
		stress: ["long-context", "markdown-prefix", "multi-hunk"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "引用の但し書きが変わり、入れ子の番号リストに1項目足された",
		maxChangedLines: 4,
		expect: {
			present: ["contract period|contract term|duration", "rganized crime|ntisocial|nti-social|rganised crime"],
			absent: [],
		},
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

	// ---------------------------------------------------------------------
	// 重い段（hard）。易しい段が天井に張り付いたので、一次で見えた3つの壊れ方
	// （逐語コピー・プレフィックス規律・JSON エスケープ）を狙って重くしてある。
	// 当て推量で重くすると今度は床に張り付くので、**壊れ方ごとに1ケースずつ**当てる。
	// ---------------------------------------------------------------------

	{
		id: "C7",
		genre: "business",
		tier: "hard",
		difficulty: "hard",
		stress: ["near-duplicate", "markdown-prefix"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "表の離れた2セルが変わった。行の形がそっくりなので目印が一意にならない",
		maxChangedLines: 3,
		expect: { present: ["5-10", "mmediate|nstant|eal-time"], absent: ["6-12"] },
		sourceOld: `### 競合比較

| 種別 | 品質 | 納期 | 単価 |
| --- | --- | --- | --- |
| 従来型翻訳会社 | 高い | 長い | 15-30円 |
| 機械翻訳サービス | 不安定 | 短い | 1-5円 |
| クラウドソーシング型 | ばらつく | 中程度 | 8-15円 |
| 弊社 | 高い | 短い | 6-12円 |`,
		sourceNew: `### 競合比較

| 種別 | 品質 | 納期 | 単価 |
| --- | --- | --- | --- |
| 従来型翻訳会社 | 高い | 長い | 15-30円 |
| 機械翻訳サービス | 不安定 | 即時 | 1-5円 |
| クラウドソーシング型 | ばらつく | 中程度 | 8-15円 |
| 弊社 | 高い | 短い | 5-10円 |`,
		previousTranslation: `### Competitor Comparison

| Type | Quality | Turnaround | Unit price |
| --- | --- | --- | --- |
| Traditional agencies | High | Long | 15-30 yen |
| Machine translation services | Unstable | Short | 1-5 yen |
| Crowdsourcing platforms | Variable | Medium | 8-15 yen |
| Us | High | Short | 6-12 yen |`,
	},

	{
		id: "C8",
		genre: "legal",
		tier: "hard",
		difficulty: "hard",
		stress: ["volume", "long-context", "near-duplicate"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "長い禁止事項リストの、真ん中の1項目だけが変わった（写す文脈が遠い）",
		maxChangedLines: 2,
		expect: { present: ["utomated|utomatic|bot|crawl|scrap"], absent: ["excessive load|過度"] },
		sourceOld: `## 第5条（禁止事項）

利用者は、本サービスの利用にあたり、以下の行為を行ってはならない。

1. 法令または公序良俗に違反する行為
2. 犯罪行為に関連する行為
3. 当社のサーバーまたはネットワークの機能を破壊し、または妨害する行為
4. 当社のサービスの運営を妨害するおそれのある行為
5. 他の利用者に関する個人情報等を収集または蓄積する行為
6. 不正アクセスをし、またはこれを試みる行為
7. 本サービスに過度の負荷をかける行為
8. 他の利用者に成りすます行為
9. 当社が許諾しない本サービス上での宣伝、広告、勧誘、または営業行為
10. 面識のない異性との出会いを目的とした行為
11. 当社のサービスに関連して、反社会的勢力に対して直接または間接に利益を供与する行為
12. その他、当社が不適切と判断する行為

当社は、利用者が前項各号のいずれかに該当すると判断した場合、事前の通知なく本サービスの
利用を制限し、または利用者としての登録を抹消することができる。`,
		sourceNew: `## 第5条（禁止事項）

利用者は、本サービスの利用にあたり、以下の行為を行ってはならない。

1. 法令または公序良俗に違反する行為
2. 犯罪行為に関連する行為
3. 当社のサーバーまたはネットワークの機能を破壊し、または妨害する行為
4. 当社のサービスの運営を妨害するおそれのある行為
5. 他の利用者に関する個人情報等を収集または蓄積する行為
6. 不正アクセスをし、またはこれを試みる行為
7. 自動化された手段により本サービスへ大量に接続し、または内容を機械的に収集する行為
8. 他の利用者に成りすます行為
9. 当社が許諾しない本サービス上での宣伝、広告、勧誘、または営業行為
10. 面識のない異性との出会いを目的とした行為
11. 当社のサービスに関連して、反社会的勢力に対して直接または間接に利益を供与する行為
12. その他、当社が不適切と判断する行為

当社は、利用者が前項各号のいずれかに該当すると判断した場合、事前の通知なく本サービスの
利用を制限し、または利用者としての登録を抹消することができる。`,
		previousTranslation: `## Article 5 (Prohibited Conduct)

In using the Service, the User must not engage in any of the following conduct.

1. Conduct that violates laws or public order and morals
2. Conduct related to criminal activity
3. Conduct that destroys or interferes with the functions of the Company's servers or network
4. Conduct that may interfere with the operation of the Company's services
5. Collecting or accumulating personal information relating to other Users
6. Gaining or attempting to gain unauthorized access
7. Placing an excessive load on the Service
8. Impersonating another User
9. Advertising, promotion, solicitation, or commercial activity on the Service without the Company's permission
10. Conduct intended to meet strangers of the opposite sex
11. Providing benefits, directly or indirectly, to antisocial forces in connection with the Company's services
12. Any other conduct that the Company deems inappropriate

If the Company determines that a User falls under any item of the preceding paragraph, it may
restrict use of the Service or cancel the User's registration without prior notice.`,
	},

	{
		id: "C9",
		genre: "technical",
		tier: "hard",
		difficulty: "hard",
		stress: ["escaping", "markdown-prefix"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "引用符とバックスラッシュだらけの行が1つ変わり、1つ増えた（封筒に詰めると効く）",
		maxChangedLines: 4,
		expect: { present: ["trace", "WARN"], absent: [] },
		sourceOld: `### ログ抽出パターン

ログの抽出には次の正規表現を使う。設定ファイルの \`patterns\` に書く。

- エラー行: \`^\\[ERROR\\]\\s+"(?<msg>[^"]+)"\`
- Windows のパス: \`C:\\\\logs\\\\mdait\\\\*.log\`
- 除外条件: \`(?!.*"level"\\s*:\\s*"debug")\`

パターンは \`--pattern\` オプションで上書きできる。`,
		sourceNew: `### ログ抽出パターン

ログの抽出には次の正規表現を使う。設定ファイルの \`patterns\` に書く。

- エラー行: \`^\\[ERROR\\]\\s+"(?<msg>[^"]+)"\`
- 警告行: \`^\\[WARN\\]\\s+"(?<msg>[^"]+)"\`
- Windows のパス: \`C:\\\\logs\\\\mdait\\\\*.log\`
- 除外条件: \`(?!.*"level"\\s*:\\s*"(debug|trace)")\`

パターンは \`--pattern\` オプションで上書きできる。`,
		previousTranslation: `### Log Extraction Patterns

The following regular expressions are used to extract log entries. Write them under \`patterns\` in the configuration file.

- Error lines: \`^\\[ERROR\\]\\s+"(?<msg>[^"]+)"\`
- Windows paths: \`C:\\\\logs\\\\mdait\\\\*.log\`
- Exclusion: \`(?!.*"level"\\s*:\\s*"debug")\`

Patterns can be overridden with the \`--pattern\` option.`,
	},

	{
		id: "C10",
		genre: "chemistry",
		tier: "hard",
		difficulty: "hard",
		stress: ["multi-hunk", "near-duplicate", "volume"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "離れた4か所が変わった（手順2・4・6・8）。塊を分ける判断が要る",
		maxChangedLines: 8,
		expect: { present: ["15 mmol", "110", "8 hours", "8:2|8/2"], absent: ["12 mmol", "24 hours"] },
		sourceOld: `## 詳細手順

1. 三口フラスコを窒素置換する
2. 臭化アリール（12 mmol）を秤量して加える
3. 撹拌子を入れ、フラスコを氷浴に浸す
4. フェニルボロン酸（12 mmol）を少量ずつ加える
5. 炭酸カリウム（20 mmol）を加える
6. DMF（40 mL）を加え、80°Cまで昇温する
7. Pd(PPh₃)₄（0.05 mmol）を加える
8. 24時間撹拌し、TLC（ヘキサン/酢酸エチル = 9:1）で追跡する
9. 室温まで冷却し、セライト濾過する
10. 減圧濃縮し、シリカゲルカラムで精製する`,
		sourceNew: `## 詳細手順

1. 三口フラスコを窒素置換する
2. 臭化アリール（15 mmol）を秤量して加える
3. 撹拌子を入れ、フラスコを氷浴に浸す
4. フェニルボロン酸（18 mmol）を少量ずつ加える
5. 炭酸カリウム（20 mmol）を加える
6. DMF（40 mL）を加え、110°Cまで昇温する
7. Pd(PPh₃)₄（0.05 mmol）を加える
8. 8時間撹拌し、TLC（ヘキサン/酢酸エチル = 8:2）で追跡する
9. 室温まで冷却し、セライト濾過する
10. 減圧濃縮し、シリカゲルカラムで精製する`,
		previousTranslation: `## Detailed Procedure

1. Purge the three-necked flask with nitrogen
2. Weigh out and add the aryl bromide (12 mmol)
3. Add a stir bar and immerse the flask in an ice bath
4. Add phenylboronic acid (12 mmol) in small portions
5. Add potassium carbonate (20 mmol)
6. Add DMF (40 mL) and raise the temperature to 80°C
7. Add Pd(PPh₃)₄ (0.05 mmol)
8. Stir for 24 hours and follow by TLC (hexane/ethyl acetate = 9:1)
9. Cool to room temperature and filter through Celite
10. Concentrate under reduced pressure and purify by silica gel column chromatography`,
	},

	{
		id: "C11",
		genre: "technical",
		tier: "hard",
		difficulty: "hard",
		stress: ["markdown-prefix", "long-context"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "入れ子の箇条書きに1項目増え、`+` 始まりの項目が1つ変わった（水平線もある）",
		maxChangedLines: 4,
		expect: { present: ["nvironment variable|\\.env", "shared folder|internal distribut|in-house"], absent: [] },
		sourceOld: `## 導入手順

1. 拡張機能をインストールする
   - Marketplace から \`mdait\` を検索する
   - または VSIX を直接インストールする
2. 設定ファイルを作る
   - \`.mdait/mdait.json\` を置く

---

### 注意事項

+ 既存の訳文は上書きされない
+ \`.mdait/\` はバージョン管理に含める
+ API キーは設定ファイルに直接書く`,
		sourceNew: `## 導入手順

1. 拡張機能をインストールする
   - Marketplace から \`mdait\` を検索する
   - または VSIX を直接インストールする
   - 社内配布の場合は VSIX を共有フォルダから入れる
2. 設定ファイルを作る
   - \`.mdait/mdait.json\` を置く

---

### 注意事項

+ 既存の訳文は上書きされない
+ \`.mdait/\` はバージョン管理に含める
+ API キーは環境変数から読む（設定ファイルに直接書かない）`,
		previousTranslation: `## Setup

1. Install the extension
   - Search for \`mdait\` in the Marketplace
   - Or install the VSIX directly
2. Create the configuration file
   - Place \`.mdait/mdait.json\`

---

### Notes

+ Existing translations are never overwritten
+ Keep \`.mdait/\` under version control
+ Write the API key directly in the configuration file`,
	},

	{
		id: "C12",
		genre: "technical",
		tier: "hard",
		difficulty: "hard",
		stress: ["code-block", "multi-hunk", "volume"],
		sourceLang: "ja",
		targetLang: "en",
		fileExtension: ".md",
		intent: "コードブロックが2つあり、その前後の説明文が両方とも変わった（コードは不変）",
		maxChangedLines: 4,
		expect: { present: ["504|timeout|Timeout", "PATCH|patch"], absent: [] },
		sourceOld: `## リクエストとレスポンス

翻訳の依頼は次の形で送る。

\`\`\`json
{
  "source": "ja",
  "target": "en",
  "units": ["..."]
}
\`\`\`

メソッドは POST を使う。

応答は次の形で返る。

\`\`\`json
{
  "translations": ["..."],
  "usage": { "input": 0, "output": 0 }
}
\`\`\`

エラー時は 4xx または 5xx が返る。`,
		sourceNew: `## リクエストとレスポンス

翻訳の依頼は次の形で送る。

\`\`\`json
{
  "source": "ja",
  "target": "en",
  "units": ["..."]
}
\`\`\`

メソッドは POST を使う。既存の訳文を更新する場合は PATCH を使う。

応答は次の形で返る。

\`\`\`json
{
  "translations": ["..."],
  "usage": { "input": 0, "output": 0 }
}
\`\`\`

エラー時は 4xx または 5xx が返る。処理が長引いた場合は 504 が返ることがある。`,
		previousTranslation: `## Requests and Responses

Send a translation request in the following form.

\`\`\`json
{
  "source": "ja",
  "target": "en",
  "units": ["..."]
}
\`\`\`

Use the POST method.

The response is returned in the following form.

\`\`\`json
{
  "translations": ["..."],
  "usage": { "input": 0, "output": 0 }
}
\`\`\`

On error, a 4xx or 5xx status is returned.`,
	},
];

/**
 * 名前で絞る（`--cases C1,C4`）。段の名前（`easy` / `hard`）も受ける。
 * 指定が無ければ全部返す。
 */
export function selectCases(only) {
	if (!only) return CASES;
	const wanted = new Set(
		String(only)
			.split(",")
			.map((s) => s.trim().toUpperCase())
			.filter(Boolean),
	);
	// 段でまとめて選べるようにする。`--cases hard` は重い段だけ
	const tiers = ["EASY", "HARD"].filter((t) => wanted.has(t));
	if (tiers.length > 0) {
		const picked = CASES.filter((c) => tiers.includes(String(c.tier).toUpperCase()));
		if (picked.length > 0) return picked;
	}
	const picked = CASES.filter((c) => wanted.has(c.id.toUpperCase()));
	if (picked.length === 0) {
		throw new Error(
			`--cases に知らない名前が入っています: ${only}（使えるのは ${CASES.map((c) => c.id).join(" / ")}）`,
		);
	}
	return picked;
}
