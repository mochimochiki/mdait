# ADR

新しいものを上に追加する。

---

## ADR-260711-03: ユニット数上限を trans.maxUnitsPerRun に一本化し、調整困難な aiSync 詳細設定を最適値で固定・廃止する

### 背景
`aiSync.review.maxUnitsPerRun`（既定200）と `aiSync.align.maxUnitsPerFile`（既定300）は本質的に同じ「1回の処理で扱うユニット数の上限（コストガード）」であり、翻訳（trans）にも同様に当てはまる概念だが、trans には上限が無く、設定も機能ごとに分散して分かりづらかった。また `aiSync.review.autoApproveThreshold` / `aiSync.align.minConfidence` / `maxNeedBodies` / `maxRounds` はユーザーが適切値を判断しづらく、露出する価値が低かった。

### 決定
1. ユニット数上限を全般設定 **`trans.maxUnitsPerRun`（既定300・`0`で上限なし）** に統合する。**ファイル単位で適用**され、trans・aiSync.review・aiSync.align が共通で参照する（旧 `aiSync.review.maxUnitsPerRun` も `executeAiReviewForFile` 内で1ファイル単位に適用されていたため挙動は不変。ディレクトリ実行ではファイル数ぶん積み上がる）。超過時の挙動は経路ごとに異なる: trans / review は超過ユニットの need フラグを保持し次回実行で処理（冪等）、align は該当ファイルの AI align をスキップして位置ベース対応付けを維持する。trans も新たにこの上限を適用する。
2. 調整困難な4設定を廃止し、コード内定数で最適値（＝従来の既定値）を固定する: `autoApproveThreshold`→0.9（`review-core.AUTO_APPROVE_THRESHOLD`）、`minConfidence`→0.6（`align-core.ALIGN_MIN_CONFIDENCE`）、`maxNeedBodies`→8・`maxRounds`→2（`section-aligner.DEFAULT_LIMITS`）。
3. `aiSync.align` は全項目が移動・廃止となるためスキーマ・型・ロードから丸ごと削除する。`aiSync.review` は `autoApprove` / `batchSize` のみ残す。

### 理由
「1回で扱うユニット数の上限」はコスト暴走を防ぐ普遍的なガードであり、機能ごとに別設定を持つ必然性が無い。単一の全般設定に集約することで設定の見通しが良くなり、trans にも一貫した上限が効く。閾値・ラウンド数などの微調整パラメータは最適値が定まっており、設定として露出するより固定した方が誤設定リスクを避けられる（`align-result.ts` の `CorrectionValidationContext.minConfidence` は関数引数として残し、呼び出し側が定数を渡す）。

### 備考
- `trans.maxUnitsPerRun = 0` は「上限なし」を表す。ロード時に0以下は0へ正規化し、trans/review/align の3経路で `> 0` のときのみ上限を適用する。
- 既存の `aiSync.review.autoApproveThreshold` / `aiSync.align.*` を書いた mdait.json は `additionalProperties: false` により検証エラーになるため、移行時は該当キーの削除が必要。

## ADR-260711-02: mdait.json を CustomTextEditorProvider のデフォルトエディタとし、JSON表示とのタブ内切り替えボタンを提供する

### 背景
ADR-260711-01 で導入した設定エディタ（SettingsPanel）は `mdait.settings.open` コマンド経由でのみ開けるWebviewPanelで、エディタから直接 `mdait.json` を開くと標準JSONエディタが表示されていた。設定UIの入口がステータスビューのギアアイコン／コマンドパレットに限られ、発見可能性が低かった。

### 決定
1. `mdait.json`（`**/.mdait/mdait.json`）を対象とする `customEditors` を `priority: "default"` で登録し、`vscode.CustomTextEditorProvider`（`SettingsEditorProvider`）が標準JSONエディタの代わりに設定UIをデフォルト表示する。
2. **既存の `SettingsPanel` はそのまま流用**: `resolveCustomTextEditor` から渡される `WebviewPanel` に `SettingsPanel.bind()` でロジックをバインドするだけで、検証・パス解決・ファイルI/Oの実装（ADR-260711-01）は変更しない。ドキュメントバッファ（`TextDocument`）は使わず、従来どおり `Configuration` 経由のファイルパスへ直接読み書きする（mdait.json は単一固定パスのため、CustomTextEditorProvider の枠組みに乗せる目的は「デフォルトエディタとして横取りする」ことのみ）。
3. **Markdownプレビュー同様のタブ内切り替え**: `mdait.settings.openAsJson` / `mdait.settings.openAsUi` の2コマンドを `editor/title` に `activeCustomEditorId` の真偽で排他配置し、`vscode.openWith` で同一タブのまま設定UI ⇔ 生JSONを切り替える（新規タブは開かない）。設定UI内の「JSONで編集」ボタンも `vscode.window.showTextDocument` から `vscode.openWith(uri, "default")` に変更し、同じタブ内切り替えに統一する。
4. `mdait.settings.open` コマンドは `vscode.open` で `mdait.json` を開くだけの薄いラッパーに変更し、既存の「未作成時は setup へ誘導」ガードは維持する（customEditor はドキュメントの存在を前提とするため、存在チェックはこのコマンド側にのみ残す）。

### 理由
CustomTextEditorProvider は本来「ドキュメントの内容を表示・編集するUI」を提供する仕組みだが、mdait.json は常に単一の既知パスであり、既存実装（fs直接読み書き・`Configuration.onConfigurationChanged` による外部編集反映）が既にこの用途に十分機能していたため、`TextDocument` 経由の編集モデル（`WorkspaceEdit`・dirty管理）へ移行する必要はない。「デフォルトエディタとして横取りする」薄い統合に留めることで、ADR-260711-01 のロジックを一切変更せずに発見可能性だけを改善できる。

### 備考
- `resourceFilename == mdait.json` という緩い条件のため、`.mdait/` 外に同名ファイルがあると切り替えボタンが誤表示される可能性があるが、実害は「押しても対象がその同名ファイルになるだけ」で軽微なため許容する。
- `supportsMultipleEditorsPerDocument: false` により同一ファイルの多重タブは発生しない。

## ADR-260711-01: mdait.json 設定エディタとして Webview を導入する（P6 の例外）

### 背景
mdait.json の編集は raw JSON のみで、50 項目超の設定の全体像・意味・既定値の把握が難しくオンボーディングの障壁だった。VS Code 標準の設定 GUI は `contributes.configuration`（ワークスペース設定）専用で、プロジェクトファイルである mdait.json には適用できない。

### 決定
1. `mdait.settings.open` で開く WebviewPanel の設定エディタを追加する。P6（独自 UI 最小化）の明示的な例外とする。
2. **スキーマ駆動**: UI は `assets/schemas/mdait-config.schema.json` から実行時に自動生成する。スキーマが唯一の真実源で、設定追加は原則スキーマ＋解説文（`settings-doc.ts`、l10n 日英）の追加のみ。生成器が未対応の形（boolean|array の oneOf 等）は「JSON で編集」フォールバック行として表示し、UI は壊れない。
3. **Webview は表示に徹する**: 検証・型変換・パス解決（`Configuration` 経由）・ファイル I/O はすべて拡張側（`settings-panel.ts`）。書き込みはキー単位の最小差分（`config-json-editor.ts`。キー順序・インデント・末尾改行を保持）、リセットはキー削除＋空親オブジェクトの刈り取り。
4. 見た目は `--vscode-*` CSS 変数でテーマ追従のネイティブ準拠。外部リソースなし、CSP は nonce 付き script のみ許可。

### 理由
設定の発見可能性を TreeView / QuickPick で提供するのは階層設定の規模的に無理があり、設定画面ライクな一覧・検索・型別ウィジェットが最適。スキーマ駆動生成により UI とスキーマの二重管理を避ける。P6 の趣旨（学習コスト低減・一貫した UX）は VS Code 設定画面の操作モデルと標準 CSS 変数の踏襲で維持する。

### 備考
- あわせてスキーマの欠落を修正: `sync.copyAssets` / `transPairs[].copyAssets`（実装に存在するが `additionalProperties: false` により検証エラーになっていた）
- 設定エディタは AI 不使用・決定的（ADR-260705-01 と整合）。外部編集は `Configuration` の変更通知で UI へ反映する

## ADR-260709-01: AIレビューをバッチ検証化し、用語集・TM を双方向マッチで注入して訳揺れを検知する

### 背景
AIペアリング検証（pending / audit）は1ユニット=1LLMコールの完全直列で、特に audit は確定済みペアを毎回全件検証するためコストが高い（バッチ検証は ADR-260706-03 でも将来増分とされていた）。また検証プロンプトには用語集・TM が渡らず、確立訳語と異なる訳や別訳語の混入（訳揺れ）を検知できなかった。

### 決定
1. **固定サイズバッチ検証**: `aiSync.review.batchSize`（既定 3、1..10）件のペアを1コールにまとめる。応答は `{"results": [{index, verdict, ...}]}`（index echo。`extractJsonFromResponse` がオブジェクトのみ抽出するため配列にしない）。全 index が揃わなければバッチ全体をリトライし、**枯渇時は部分受理**（有効エントリは採用、欠落分のみ uncertain/confidence 0 のフォールバック）。二段トリアージ（ファイル粗判定→個別精査）は採用しない — プロトコルが単純で、失敗の影響がペア粒度に留まるため。
2. **プロンプト ID 分離**: バッチは新 ID `aiSync.verifyPairingBatch`。**batchSize: 1 は従来の `verify()` ＋ 旧 ID `aiSync.verifyPairing` に完全後方互換**（既存の単ペアカスタムプロンプト利用者は batchSize: 1 を設定する。旧 ID カスタムの自動検出フォールバックは行わない — config 内省が verifier に漏れて複雑化するため）。
3. **用語集・TM は原文/訳文の双方向マッチで per-pair 注入**: 用語集は「原文に原語（＋variants）」**または**「訳文に訳語（＋variants）」がヒットしたエントリすべて（コード除去後に照合）。TM は既存の原文→TM 検索に加え言語を入れ替えた訳文→TM 検索を union（tuid dedup、`tm.maxReferences` で cap）。片側だけのヒットが訳揺れの兆候であり、判定はプロンプトルール（用語不整合は `partial` + issue、humanNote が説明する場合を除く）で AI に委ねる。バッチレベル union でなく per-pair 注入（帰属が曖昧になり偽 issue を誘発するため）。
4. **pending / audit 両モード共通に適用**する（同一パイプラインで mode 分岐を増やさない）。

### 理由
バッチ化はコール数を 1/batchSize に削減し、audit の常時再スキャンコストを直接下げる。部分受理により「1ペアの応答不備でバッチ全体を捨てる」無駄がない。訳揺れは片側テキストだけでは判定できない（原文だけ見ると訳語不使用が、訳文だけ見ると別訳語混入が見えない）ため、双方向マッチが要点。判定を決定論 lint でなく AI に委ねるのは、活用形・文脈依存の許容（term-lint より高精度な判断）を期待できるため。

### 備考
- pending モードでも用語/TM 不整合が `partial` → escalated になり得る（従来自動承認されたペアの承認率が下がる可能性）。これは訳揺れをレビューに乗せる機能目的そのもの。
- ペア本文は `<pair index>` ブロックにエスケープなしで埋め込む（単ペア版の `<sourceUnit>` と同じ既知リスクの拡大）。境界崩れによる誤マッピングは index echo 検証→retry→部分受理で概ね検出される。humanNote・terms・tmReferences は外部データ（note・terms.csv・TMX 由来）として山括弧をエスケープし、タグブレイクを防ぐ。
- TM の per-pair 上限は既存 `tm.maxReferences`（既定 5）を流用（batchSize 3 なら最大 15 参照/コール）。問題になれば review 専用 cap を将来追加。
- レガシー（マーカーなし）カスタムプロンプトでは単ペア経路に terms/TM が届かない既知の制限（従来から note のみコード側で添付）。バッチ経路はペアブロックを user 側に連結するため届く。

## ADR-260708-01: ユニット note を unit-registry に統合し、audit は note を AI へ渡して判定させる

### 背景
ADR-260706-03 で audit（確定済みペアの監査）は不備を `flagged`（報告のみ）とし、その代償として「意図的な単文/段落乖離」は毎回再報告される既知の限界が残った。当初この恒久解として「受理台帳（`(targetHash, fromHash)` キーで受理を永続化し、決定論的に audit をスキップする）」を実装したが、設計レビューの結果これを撤回した。理由:

1. **audit は本質的に AI が判定する処理**である。ならば「人間の説明（note）を verify プロンプトに文脈として渡し、AI に織り込ませて判定させる」方が、決定論的なスキップゲートより自然かつ安全。
2. 決定論ゲートは (a) 「note があれば抑止」だと汎用コメント（TODO 等）まで audit を黙らせる、(b) 受理を運ぶと訳文を書き換えても黙ったままになる stale vouch の穴、を生む。AI に現在の内容＋note を毎回読ませれば、AI が note と内容の整合を判断するのでこれらは消える。
3. 管理ファイルは少ないほど運用が楽。note は「hash キーのユニットメタ」であり、既存の `unit-registry`（hash→content のコンテンツアドレスストア）と**キー空間が一致する**ため、別ストアを新設せず統合できる。

### 決定
- **`unit-registry` を `hash → { content, note? }` に拡張する**（1ファイルに統合）。行フォーマットは `<hash> <encContent>[ <encNote>]` の後方互換拡張（3列目=note。旧2列ファイルはそのまま読める）。note は content と同じく encoded。
- **note の同一性はユニットに追従する**。content は content-addressed で不変（revise の旧内容 diff に必要なので旧 hash に残す）。**note だけ**、本文編集で hash が変わったとき sync が旧→新 hash へ**移送**する（`updateSectionHashes` が hash 差分を集め、`migrateNotes` で付け替え。決定的・AI 不使用・冪等）。ユニット削除で移送先が無ければ GC（`retainOnly`、全文書に現存する hash のみ保持）で消える。
- **note 編集 UI は CodeLens**（対訳ユニットに「Note」ボタン → `showInputBox`）。決定的な人間操作で、本文・マーカー・hash・from は不変。hover は registry から note を直接読んで表示する。
- **audit は note を verify プロンプトに `<humanNote>` として添える**。AI は「意図的な乖離の説明があり、観測した差分をそれが説明するなら match」と判断する（プロンプトに判定ルールを追加）。**決定論的な抑止は行わない**（audit は対象ペアに毎回 AI を呼ぶ）。churn は「AI が note を見て match/audited を返す＝そもそも flagged にならない」形で解消する。
- **TM 連携は変更しない**。note はメタ情報であり機械的な受理フラグではないため、TM 登録可否（need ベース）に影響させない。汎用 note と「受理」を区別する必要が出たら将来 typed フィールドで対応する。

### 理由
audit の判定主体は AI なので、人間の意図は「AI への文脈」として渡すのが最小で一貫する。決定論ゲートが抱える「汎用コメントの誤抑止」「stale vouch」「pair キーの冗長な失効」を、AI が現在の内容と note を毎回突き合わせることで一掃できる。note を content と同じ hash キーで持てば、content-addressed の自動失効（編集で hash が変われば lookup が外れる）をそのまま享受しつつ、移送で「編集を跨いで note が生き残る」恒久メタも実現できる。ファイルも増えない。

### 備考
- **これは「状態は文書内にあり sync で復帰可能」の例外**（人間が書いた note は sync で再構築できない）。unit-state 導入と同格。
- sync に増える「note 移送」ステップは hash 差分に基づく純粋なキー付け替えで、決定的・冪等（AGENTS.md の「定常 sync は AI 不使用・決定的・冪等」を維持）。
- 却下: 受理台帳（別ストア・pair キー・決定論スキップ）。→ audit が AI 判定である以上、決定論ゲートは過剰かつ穴が多い。
- ADR-260706-03 の既知の限界（毎回再報告）はこの note 機構で解消（[command_ai-sync.md](design/command_ai-sync.md) に反映）。
- スコープ外（将来増分）: note 以外の typed メタフィールド、ソース側ユニットへの note UI、note の TM 除外用途、sync migration の GUI 統合テスト。

## ADR-260706-03: AIレビュー拡張（対象拡張モード）は確定済みペアを「報告のみ」で監査する

### 背景
AIレビュー拡張ロードマップ（[command_ai-sync.md](design/command_ai-sync.md)）の第一項目「対象拡張モード」を実装するにあたり、対象を `need:review` 限定から確定済みペア（`from` あり・`need` なし）へ広げたとき、監査で不備を検出した確定済みペアをどう扱うかを決める必要があった。当初は `setNeed("review")` で need:review を付与する案だったが、以下の理由で「報告のみ」に決定した:

1. **原文改訂は既に hash-sync が決定的に検出**している（原文 hash 変化 → target の `from` 不一致 → `need:revise@{旧hash}` 付与）。しかも `need:revise` は in-flight として audit の列挙対象外。よって「原文改訂ドリフトの検出」は audit の非冗長価値ではない。audit の非冗長価値は「①採用（位置ベース adopt）コンテンツの意味的対応検証」「②原文不変のまま訳文が手修正で劣化したケースの検出」に限られる。
2. audit は確定済みペアを**毎回再スキャン**する。need:review を書き戻すと、意図的な単文/段落レベルの乖離（翻訳で意図的に省略・追記した箇所）を毎回 `partial` として蒸し返し、人間の「承認（need:review 解除）」判断を上書きしてしまう（churn）。これを抑制する「ペア単位の受理」を記録する語彙は現状無い。`need:isolate`（[orphan-model.md](design/orphan-model.md)）は**章＝ユニット単位**の孤立であり、**ペア内の単文乖離には粒度が合わず解決しない**。

### 決定
- **`mode: "audit"` を追加**する（既定は従来の `"pending"`）。audit は `from` あり ∧（`need:review` **または** `need` なし）を列挙対象にする。`translate`/`revise@`/`isolate`/`keep`/`backfill`/`verify-deletion` 等の in-flight 状態は対象外。
- **確定済みペア（need なし）の不備検出は「報告のみ」**。`partial`/`mismatch` は `flagged` として集計・レポート・hover に出すが、**マーカーは一切変更しない**。`match`/`uncertain` は `audited`（無変更）。
- **need:review だった既存ユニット（pending）の挙動は不変**（approve→removeNeedTag / escalate / keep）。すなわちマーカー変異は従来どおり pending 承認時の `removeNeedTag()` のみで、audit で新たな need 付与は行わない。
- 既訳本文・hash・from は不変。

### 理由
報告のみとすることで、churn（毎回の蒸し返し）と「人間の承認判断を上書きする」副作用を避けられる。監査の本質は「気づき（検出）」であり、確定済みの既訳マーカーを機械が書き換えるのは、受理を記憶する仕組みが無い現段階では過剰。need:review 付与を pending（adopt 直後の未確定）に限ることで、状態機械としても一貫する。

### 備考
- コマンド層は QuickPick（pending/audit 選択）を明示起動ゲートとし、LM tool（`mdait_aiReview` の `mode`）は確認UIで「確定済みペアは報告のみ」を明示する（ADR-260705-01 と整合）。
- **既知の限界**: 意図的な単文乖離を持つ確定済みペアは audit のたびに `flagged` として再報告される（マーカーは変わらないので害は無いが、レポートにノイズが残る）。恒久解は「受理台帳」= 人間の受理判断とコメントを hash キー（targetHash・fromHash）で永続化し、内容が変わらない限り audit が再報告しない仕組み（別ADR/別PRで設計）。isolate では解決しない。
- スコープ外（将来増分）: バッチ検証・定期実行・partial の修正提案化・非MD/frontmatter 対象化・穴あき isolate/漏れ分類（[orphan-model.md](design/orphan-model.md) #3）。`mdait_aiSync` 合成は pending のまま。
- 詳細: [command_ai-sync.md](design/command_ai-sync.md)。

## ADR-260706-02: 孤立ユニットの統合モデル（isolate 導入・判断サーフェス）

### 背景
原文・訳文どちらにも意図的な独自章（片方言語だけの補足・FAQ）が存在しうるが、現行は「訳文孤立→orphanTargetPolicy（デフォルト delete）」「原文孤立→表現手段なしで need:translate が付き翻訳される」と非対称かつ意図を反映できない。ピボット翻訳（ja→en→de）では孤立が「原文役割/訳文役割」で別々に立つため、単純な boolean 属性では表せない。

### 決定
- **孤立は「ユニット属性」でなく「ペア（方向）との関係」**と位置づける。役割は **(from の有無) ×（伝播停止フラグ）** の直交2軸で表す。`from` 無し＝上流起点なし（訳文役割の孤立）は構造で自明・語彙不要。`hash` があれば下流ペアが自動で拾う（＝訳文孤立でも下流には流せる）。
- **下流伝播を止める新語彙 `need:isolate` を導入する**（保持＋伝播停止）。sync は source 側の isolate ユニットに `need:translate` を生成しない＝原文役割の孤立（opt-out）を初めて表現可能にする。`need:keep` は「保持＋伝播ON（hash 任せ）」に意味を保つ。
- **穴あきは決めつけず二段処理**: AIアライン後の未対応ユニットはいったん `need:review`（決定的・AI不使用）にし、**レポートを人間の判断サーフェス**として「孤立(isolate)/不要(delete)/翻訳(translate)/採用」を選ばせ、その選択を決定的後処理でマーカー変異へマッピングする。AI は分類の提案までで確定しない。
- ロードマップ順: ①isolate 導入 → ②孤立ロール宣言UI → ③穴あきエスカレーション → ④判断サーフェス → ⑤ガイダンス強化。

### 理由
必要な新情報は「下流伝播を止めるか」の1ビットだけで、上流孤立は既存の `from` 無しで表せている＝最小の語彙拡張で原文/訳文/両方の孤立を一貫表現できる。孤立か訳漏れかはドキュメント意図を知る人間にしか判断できないため、機械が決めつけず「レポート＝判断の場」に集約するのが安全側かつ冪等（ADR-260705-01 と整合）。

### 備考
- 却下案: orphanTargetPolicy の値を増やして対応 → 方向・役割を表せず、原文側 opt-out も表現不能なため不採用。
- 守ること: `need:isolate` は `isTmCommitTarget`/`classifyTmSkipReason`（commit-filter.ts）の**列挙式除外に必ず追加**（未知 need は素通り＝TM 汚染。ADR-260704-07）。
- 影響: per-pair 粒度は marker（single-from）で表せないため v1 は「全下流一律」に割り切る。方向別は unit-state の将来拡張。
- 詳細: [orphan-model.md](design/orphan-model.md)。

## ADR-260706-01: AI同期は既存プリミティブを注入合成する薄いオーケストレーターとする

### 背景
AI同期ロードマップ（ADR-260705-02 で合成コマンドと決定）の実装にあたり、`sync(adopt+align) → AIレビュー → レポート` をどう束ねるか、どこまでを新規ロジックとし、テストをどの層で担保するかを決める必要があった。各段（AIアライン=ADR-260705-03、AIペアリング検証=ADR-260704-07）は独立機能・冪等として既に存在する。

### 決定
- **薄い合成に徹する**: `executeAiSync` は `syncCommand({adopt:true, align:true})` → 全ターゲット列挙 → `executeAiReviewForFiles` を順に呼ぶだけで、採用・アライン・検証・マーカー変異のロジックを一切再実装しない。合成側は新しい need 語彙・新しいマーカー変異を導入しない（ADR-260704-07 を維持）。
- **確認UIは冒頭に1回**（ADR-260705-01）: コマンド層／LM tool（`mdait_aiSync`）の入口で「AI を使う3段」を列挙したモーダル確認＋AIオンボーディングを1回だけ出す。sync の align 段は内部でオンボーディングを再確認するが冪等（受諾済みなら無ダイアログ）。
- **各段を注入可能にする**: `executeAiSync` は `AiSyncStages`（runSync / collectTargets / runReview）を引数で受け取り、既定は本番配線。AI に触れる段は各モジュールでスタブ AIService により検証済みのため、合成層のテストはスタブ各段で「順序・sync undefined フォールバック・段間キャンセル・dryRun 伝播・冪等 no-op」を純粋に検証する。
- **スコープは v1 ではワークスペース全体のみ**: sync がワークスペース全体で動くため、レビュー段も全 transPair のターゲットを対象にする。sync だけ全体・レビューだけ部分という不整合を避ける（path スコープは将来課題）。
- **集計・レポート・nextActions は純関数**に閉じる（`ai-sync-result.ts` / `review-result.ts` の `aggregateReviewResults`）。レビュー表描画・ターゲット解決は既存モジュールから共有関数を切り出して再利用（`generateReviewTableSection` / `review-targets.ts`）。

### 理由
「決定的な仕組みが提案し AI が審査する」パイプラインをそのまま合成に持ち上げることで、取り込み（adopt+align）と健全性監査（review）を1操作で回しつつ、各段の冪等性・フォールバック・キャンセル再開性がそのまま保たれる。管理済みサイトでは align が no-op・review のみとなり、同一機能が「サイトが健全か」の監査ボタンとして働く。注入合成はスタブ各段による単体テストを AIアライン／AIペアリング検証と同水準で可能にする。

### 備考
- 詳細は [command_ai-sync.md](design/command_ai-sync.md)。v1 では path スコープと段間の細粒度進捗集約は見送り。

## ADR-260705-03: AIアラインは sync_CoreProc に aligner を注入し matchResult を再配線する

### 背景
AIアライン（ADR-260705-02 で差分審査型に決定）を実装するにあたり、位置ベース対応付けの結果（`SectionMatcher.match()` の Phase 2）を AI が審査した修正提案を、既存の adopt 経路（from 確立・need:review 付与）を壊さずどこに差し込むか、AIService をどの層で構築・注入するかを決める必要があった。

### 決定
- **統合点**: `sync_CoreProc` の `match()` と `updateSectionHashes()` の間で `matchResult` を再配線する。from リンク書き込み前に再ペア化するため、以降の adopt 処理（`syncMarkerPair` の `adoptTarget`）がそのまま from 確立と `need:review` 付与を行う。align 自体は本文を書き換えず need も付けない。
- **aligner 注入**: AIService を内包する `SectionAligner` は `syncCommand` で AIOnboarding ゲート通過後に1回だけ構築し、ワーカー → `handler.sync(...)` → `sync_CoreProc(...)` の追加引数として渡す。`syncSingleFile`（autoSyncOnSave）は aligner を渡さないため、定常 sync は構造的に AI 非実行（ADR-260705-01 を実装で担保）。オンボーディング拒否時は aligner 未構築で決定的 adopt を継続する。
- **再配線の意味論**（`applyCorrections`）: 受理修正で `source[si]↔target[ti]` を再ペア化し、修正に消費されなかった元ペアは維持、消費で片側を失ったユニットは未対応化する（source→新規空ユニット、target→孤立ターゲット）。受理修正が空なら matchResult を恒等で返す（＝位置ベースへのフォールバック）。
- **審査対象と locked**: 審査対象は「both-present かつ target が from を持たない」位置ベースペアのみ。from 済み（Phase 1）ペアと need:keep ターゲットは locked とし、修正提案がそれらに触れる場合はバリデーションで棄却する。候補が0なら AI を呼ばず no-op（管理済みサイトで冪等）。
- **逐次化**: align 有効時はワーカー並列度を1に落とす（AI レート制限への配慮。review 経路と整合）。
- **設定**: `aiSync.align`（minConfidence / maxUnitsPerFile / maxNeedBodies=K / maxRounds）を追加。ユニット過多ファイルは審査せず位置ベースのままとする。

### 理由
matchResult の再配線という最小の介入で、既存の from 確立・need:review・孤立ターゲット処理・diff 検出のすべてが無改修で乗る。AIService を core（sync_CoreProc）で構築せず注入することで、スタブ AIService による単体テストが AIペアリング検証と同水準で可能になる。フォールバックが常に「現行の位置ベース挙動」であることは applyCorrections の恒等性で保証される。

### 備考
- 詳細は [command_ai-sync.md](design/command_ai-sync.md)。v1 ではユニット単位キャンセルの細粒度対応と align 結果の仮想ドキュメントレポートは見送り（誤りは後段の mdait_aiReview が mismatch として拾う）。

---

## ADR-260705-02: AIアラインは差分審査型とし、AI同期はプリミティブの合成コマンドとする

### 背景
既存対訳サイト取り込みの誤対応（位置ベースマッチングのズレ）を根本解決する AIアライン（[command_ai-sync.md](design/command_ai-sync.md)）の実現形として、「AI にマッピングを全面生成させる」案と「機械の結果を AI が審査する」案を比較した。

### 決定
- **差分審査型**: adopt 時の位置ベースマッチング結果（見出しスケルトン＋対応表）を AI に渡し、`{ok | corrections[] | needBodies[]}` で応答させる。AI の全面生成には委ねない。修正提案は1件ずつ独立にバリデーションし、不正な提案のみ棄却。フォールバックは常に現行の位置ベース挙動。
- **二段トリアージ**: AI は `needBodies` で特定ユニットの本文を要求できる（上限付き2ラウンド・本文は切り詰め）。この「安いパスで全体→怪しい所だけ深掘り」プロトコルはレビューのバッチ化にも流用する共有パターンとする。
- **AI同期は合成コマンド**: `sync(adopt) → AIアライン → AIレビュー呼び出し → レポート` を束ねる薄いオーケストレーター。各段は独立機能（冪等）のままで、合成側は AI を使う段を列挙した確認UIを冒頭に1回出す。レビューを同期に埋め込まない（バッチ検証・定期実行への発展性を保つ）。
- 管理済みサイトで合成コマンドを実行するとアラインは no-op（全ユニット from アンカー済み）となり、レビューのみが走る＝取り込みと健全性監査を同一機能で兼ねる。

### 理由
大半のページは構造一致であり、審査型は出力サイズと故障モードが「問題の数」に比例する（全生成型は1個の幻覚で全体が壊れる）。「決定的な仕組みが提案し、AI が審査する」形は adopt+aiReview と同じパターンで、sync の決定性・冪等性という不変条件（ADR-260705-01）とも整合する。追認バイアスは「1章の挿入・削除は以降を連鎖的にズラす」という位置ズレの署名をプロンプトで明示して緩和する。

### 備考
- 詳細設計・パターン別の解決対応は [command_ai-sync.md](design/command_ai-sync.md) のロードマップとパターンマトリクスを参照。

---

## ADR-260705-01: AI 利用は明示起動時のみ（定常 sync の AI 不使用を不変条件化）

### 背景
AIアライン・AIレビュー・AI同期の設計にあたり、「AI がユーザーの明示しないところで動く」ことを禁止する原則が事実上存在していた（全 AI 経路が確認UI＋AIOnboarding を通る）が、不変条件としては明文化されていなかった。

### 決定
- **定常 sync（autoSyncOnSave 含む）は AI 不使用・決定的・冪等を維持する。** これを破る変更は禁止（エージェントオーケストレーション全体がこの性質に依存）。
- **AI を使う処理は必ず明示的な起動＋確認UIを経由する。** AIアラインは adopt 時かつ明示指定でのみ発動し、定常 sync では動かない。定期実行系の将来機能も「ユーザーが明示的にスケジュール設定した」ことを起動要件とする。
- AGENTS.md の「固定された不変条件」に追記する。

### 理由
sync が「いつ何度実行しても安全・無料・同一結果」であることは、エージェントの計画可能性と冪等な再開の基盤。AI の暗黙起動はコスト・レイテンシ・非決定性の3点でこれを壊す。

### 備考
- 現行実装は全 AI 経路（trans / term / tm / aiReview）がこの原則を満たしていることを確認済み。

---

## ADR-260704-07: AIペアリング検証の verdict 語彙と need:review 自動解除ポリシー

### 背景
adopt（ADR-260704-02）の対応付けは位置ベースであり、誤対応・翻訳漏れの安全網が `need:review` の人手全件レビューしかない。大規模サイトの取り込みでは非現実的なため、LLM がペアの妥当性を判定してレビューをトリアージする「AIペアリング検証」を導入する（[command_ai-sync.md](design/command_ai-sync.md)）。

### 決定
- verdict は `{match, mismatch, partial, uncertain}` + `confidence(0..1)` + `issues[]` + `reason` の4値固定。
- **mismatch / partial に新しい need 語彙は導入しない**。理由: (a) `isTmCommitTarget`（commit-filter.ts）は列挙式除外で未知の need 値を登録対象として素通しするため、新語彙は TM 汚染の穴になる、(b) CodeLens / StatusTree / ドキュメントの語彙拡張コスト、(c) 人間ゲートを `need:review` 一本に保つ方が状態機械が単純。差別化はレポートと hover（`SummaryManager.reviewReasons`）で行う。
- 自動承認は `verdict === "match" && issues.length === 0 && confidence >= aiSync.review.autoApproveThreshold && aiSync.review.autoApprove` の場合のみ `removeNeedTag()` を実行する。マーカー変異はこの1種類だけで、`hash`・`from`・本文には触れない（CodeLens「Mark as Reviewed」と同じ結果状態）。
- 自動承認されたユニットは必ずレポートに列挙する（tm.commit 可能状態への昇格の可視化）。
- 応答のリトライ枯渇は `uncertain / confidence:0` 相当として扱い、自動承認されない安全側に倒す。

### 理由
「need:review の解除＝人間の承認行為」という既存セマンティクスを AI が代行する形にすることで、trans / tm.commit / StatusTree との相互作用が既存の枠組みだけで完結する。LLM の自己申告 confidence は校正されていないため、承認は三重条件（match ∧ issues空 ∧ 閾値以上）とし、TM 品質を最優先する運用向けに `autoApprove: false`（レポートのみ）を残す。

### 備考
- 誤承認 → tm.commit 昇格の残余リスクはレポート必須列挙とデフォルト閾値 0.9 で緩和。
- `isTmCommitTarget` の未知 need 素通しは本機能と独立の潜在バグとして別途修正候補（既知 need のみ通過へ反転）。
- 詳細: [.tasks の 260704-07〜09 チケット](../.tasks/)

---

## ADR-260704-06: ディレクトリ翻訳をファイル単位セマフォで並列化する

### 背景
architecture.md の意図的制約「並列実行: 順次実行」により、数百ファイル規模のサイト翻訳が実用時間で完走しない（ロードマップM6・G9）。順次実行の理由はキャンセル即応性とAI APIレート制限だった。

### 決定
- ディレクトリ翻訳（`mdait_translate` ツール・StatusTree ▶ の2経路）を**ファイル単位**のセマフォ方式で並列化する（`runWithConcurrency`、`src/commands/shared/concurrency.ts`）。ユニット単位の並列はマーカー書換の競合リスクに対して利得が薄いため行わない。
- 同時実行数は `trans.concurrency`（デフォルト3、1〜8にクランプ）。1で従来の逐次実行に戻る。レート制限はプロバイダー依存（vscode-lm は Copilot クォータ）のためユーザー調整に委ねる。
- キャンセルは「新規着手を止め、実行中ファイルは既存のユニット単位チェックで停止」。順序保証: 結果配列は入力順を保持。
- 同一ファイルの競合は既存 `FileMutex` が排他する（backfill はターゲット・ソース両ロック済み）。異なるファイルペアは独立で、設計上の書き込み競合はない。external モードの UnitStateStore はプロセス内シングルトンの全量書き出しで最終状態が一貫する。
- 用語集・TMのmtimeキャッシュ整合性は「知識構築→翻訳」の実行順序をプレイブック（`docs/guide/ja/agent-playbook.md`）で規定して回避する。

### 理由
翻訳の律速はAI応答待ちであり、ファイル単位の並列は既存の排他機構にそのまま乗る最小の変更で最大の効果を得る。デフォルト3は Copilot の実用的なクォータ内に収まる保守的な値。

### 備考
- 100ファイル規模の逐次比計測と debug-ipc E2E（P11/P12）はVS Code実環境での手動ゲート（チケット260704-06）。
- 詳細: [.tasks の 260704-06 チケット](../.tasks/)

---

## ADR-260704-05: backfill を「同一内容プレースホルダ＋即時fromリンク」でモデル化する

### 背景
訳文側にしかないセクションを原文側へ逆翻訳して対称化する backfill（ロードマップM5・G4残り/G6）。当初設計はプレースホルダに `from` 逆参照を持たせる案だったが、ソースユニットが from を持つのは既存の意味論（from=翻訳元）と衝突する。

### 決定
- `orphanTargetPolicy: "backfill"`: sync が孤立ターゲット T の**本文をそのまま**持つ原文側プレースホルダ S を生成する。内容が同一なので `S.hash == T.hash` となり、`T.from = T.hash` を設定するだけで通常の from リンクが即座に成立する（S は `<!-- mdait {hash} need:backfill -->` の正規ソースユニット。逆参照 from は不要）。
- 挿入位置は順序推定（直前の対応済みターゲットに対応するソースユニットの直後。先頭孤立は先頭）。同一ハッシュのソースユニットが既存ならスキップ（冪等）。
- trans はターゲットファイル翻訳時に対応ソースの `need:backfill` を検出し、言語逆転（targetLang→sourceLang）で T 本文を翻訳して S へ書き込む。S のハッシュを再計算し `T.from` を更新、S に **`need:review`** を残す（逆生成原文の品質確認）。ターゲット・ソース両ファイルをロックする（FileMutex は複数キー一括登録でデッドロックなし）。ソースは embedded/external 共通の全文書き戻し。
- 次の sync は `T.from == S.hash` で無変更（冪等な定常状態）。

### 理由
「同一内容→同一ハッシュ」により、中間状態（backfill待ち）も含めて全状態が既存の from マッチング・冪等性の枠組みに乗る。翻訳前の原文ファイルに訳文言語の本文が見える過渡状態は、プレースホルダの実体（未翻訳の原文相当）を正直に表現しており、`need:backfill` マーカーで機械的に識別できる。

### 備考
- keep と backfill のファイル単位・frontmatter単位ポリシー上書きはスコープ外（必要になった時点で別ADR）。
- backfillペアのTM登録: S の `need:review` 解消後は通常ペアとして tm.commit 対象。E2E 検証は M6。
- 詳細: [.tasks の 260704-05 チケット](../.tasks/)

---

## ADR-260704-04: 用語一貫性検証（term-lint）を core 層の機械照合として実装し mdait_validate で公開する

### 背景
用語集は翻訳プロンプトへの「Follow the provided terminology list strictly」というソフトな指示止まりで、逸脱の検出・レポート手段がなかった（ロードマップM4・G5）。またterm照合ロジックがcommands層にあり、VS Code非依存化されていなかった（G9）。

### 決定
- `src/core/term/` を新設: `term-matcher.ts`（部分一致＋variants照合、コードブロック行＋インラインコード除去 `stripCodeSegments`）と `term-lint.ts`（`lintUnitPair` 純関数）。core は commands の `TermEntry` に依存せず、独自の `TermLintTerm` 型へ呼び出し側でマップする（層構造の維持）。
- 保守的閾値: 「原文に用語（正規形＋variants）が出現し、かつ訳文に期待訳語（正規形＋variants）が全く出現しない」場合のみ違反。偽陽性が多い検証はエージェントに無視されるため。活用形による偽陽性は variants 追加で運用回避する（既知の限界）。
- `mdait_validate { path?, checks?: ["structure","terms"] }` を新設。既存 `TranslationChecker`（構造カウント比較）と term-lint を束ね、読取専用・AI不使用・確認UIなし。違反は `{ file, unitHash, check, term?, expected?, severity, message }` で返し、**自動修正しない**（revise / variants追加の判断はエージェントに委ねる）。
- `term-extractor.ts`（翻訳時の関連用語抽出）の照合を core の `anyTermVariantAppears` に共通化し、翻訳時とlint時の判定を一致させた。

### 理由
検証がAI不使用・読取専用であることで、エージェントの翻訳→検証→修正ループ内で何度呼んでもコスト・副作用ゼロになり、完成状態の定義2（`mdait_validate` 違反0件）を機械的に判定できる。core移設はMCP/CLI化（将来展望）の布石でもある。

### 備考
- 検証対象は「翻訳済み（fromあり・needなし）」ユニットのみ。need残りはスキップ件数として報告し、nextActionsで翻訳/レビュー先行を案内する。
- 詳細: [.tasks の 260704-04 チケット](../.tasks/)

---

## ADR-260704-03: 用語集・TMを LM Tools として公開しスキップ理由を構造化する

### 背景
エージェント主導のサイト全体翻訳（ロードマップM3・G1）では、既訳からの知識構築（用語集・TM）をチャットから駆動できる必要がある。また tm.commit は need フラグの残るユニットを黙ってスキップするため、エージェントが「なぜコミットされないか」を診断できなかった。

### 決定
- `mdait_term { action: detect|expand, path? }` / `mdait_tm { action: commit|optimize, path? }` を新設。既存 CoreProc（`detectTerm_CoreProc` / `expandTerm_CoreProc` / `executeTmCommitForFile` / `tmOptimizeCommand`）の薄いラップとし、path はソース/ターゲットどちらの側でも受理してスコープ解決する。
- CoreProc の戻り値を拡張（expand: 展開数/残数、optimize: エントリ数、commit: `skipReasons`）。呼び出し側互換の追加のみ。
- スキップ理由の分類は `commit-filter.ts` の純関数 `classifyTmSkipReason`（noFrom / needTranslate / needRevise / needReview / needKeep）とし、`isTmCommitTarget` との整合を単体テストで固定する。`nextActions` は理由に応じて「先に mdait_translate / review 解消」を案内し、M2 の順序依存（レビュー承認→tm.commit）をツール自身が誘導する。

### 理由
判断・反復はエージェントに委ね、mdait は冪等なプリミティブと診断可能な構造化出力を返すのが方針（agent-orchestration.md）。detect/expand/commit はいずれも既存実装が重複除外・未展開のみ処理・既存TU検出を持ち、2回目実行が差分0件になる冪等性を備えるため、そのまま定常状態判定（完成状態の定義3・4）に使える。

### 備考
- AI 依存経路の冪等性 E2E は M6 の debug-ipc シナリオで検証する。
- 詳細: [.tasks の 260704-03 チケット](../.tasks/)

---

## ADR-260704-02: 既存対訳の取り込みを adopt モード＋orphanTargetPolicy で安全化する

### 背景
既存の日英対訳サイト（マーカーなし既訳）を mdait 管理下に置くと、初回 sync で既訳に一律 `need:translate` が付き、trans 実行で既訳が AI 翻訳に上書きされる（G3）。また訳文側にしかないセクションは `autoDelete: true` で削除され、「意図的に保持する」状態を表現できない（G4）。

### 決定
- **adopt モード**: `syncCommand({ adopt: true })` / `mdait_sync (adopt: true)`。from 新規確立・need 未設定・本文ありのターゲットユニットに `need:translate` の代わりに **`need:review`** を付与する（`syncMarkerPair` のオプション）。既訳本文は不変で、trans の対象にもならない。adopt は sync の引数であり永続設定にしない（取り込みは一度きりの操作）。
- **`sync.orphanTargetPolicy: "delete" | "verify" | "keep"`**: `autoDelete` を置き換える孤立ターゲットポリシー（`true`→`delete`、`false`→`verify` の後方互換。両指定時は orphanTargetPolicy 優先）。`keep` は `need:keep`（from なし）を付与して恒久保持し、SectionMatcher の対応付けから除外・trans 対象外・status 分母除外（独自ユニット）・tm.commit 対象外とする。
- **need 語彙の追加**: `keep` を追加（`review` は既存語彙の用途拡張）。マーカー形式 `<!-- mdait hash from:xxx need:yyy -->` の範囲内であり互換性を壊さない。need 語彙×コマンド経路の期待動作はマトリクステスト（`need-command-matrix.test.ts`）で固定する。
- **バグ修正**: `MdaitMarker.MARKER_REGEX` の need 文字クラスを `[\w@]+`→`[\w@-]+` に修正。従来 `need:verify-deletion` がパース不能でマーカー往復消失していた（マトリクステストで発見）。受理範囲の拡大のみで既存マーカーの解釈は不変。

### 理由
adopt の誤対応リスク（順序ベース対応付けの限界）は「必ず `need:review` を経由する」ことを安全網とし、レビュー承認（need 除去）→sync→tm.commit の順序依存は commit-filter の `need:review` 除外により機械的に強制される。keep を「from を持たない独自ユニット」としてモデル化することで、status の分母除外・TM 対象外が既存の from ベース判定と自然に整合する。

### 備考
- 対応率閾値による adopt 保留（低品質対応の警告強化）は将来課題。
- 逆方向埋め戻し（`orphanTargetPolicy: "backfill"`）は M5 で追加予定。
- 詳細: [.tasks の 260704-02 チケット](../.tasks/)

---

## ADR-260704-01: LM Tools の出力を共通JSONエンベロープで構造化する

### 背景
エージェント主導のサイト全体翻訳（[agent-orchestration.md](design/agent-orchestration.md)）では、エージェントがツール出力から状態を観測して次アクションを計画する。現行の非構造化テキスト出力では、ファイル別need一覧・失敗原因・次アクションが機械的に取れない（G2）。また `mdait_translate` がファイル単位のみで、サイト規模では呼び出し回数が爆発する（G7）。

### 決定
- 全 LM Tools は `LanguageModelTextPart` に共通エンベロープ `{ schemaVersion, ok, summary, data, nextActions, error? }` の JSON 文字列を返す（`src/lm-tools/envelope.ts`）。`summary` は l10n 経由の人間向け1行サマリ、`nextActions` は英語固定文言のエージェント向け案内。エンベロープはエージェントとの契約であり、破壊的変更は `schemaVersion` インクリメント＋全ツール一斉更新を伴う。
- `nextActions` の生成（状態→推奨アクション対応表 `next-actions.ts`）は lm-tools 層に閉じる。「薄いラッパー」原則の明示的例外（ビジネスロジックではなく案内文の生成のため）。
- `mdait_translate` は `path` でファイル/ディレクトリ両対応。ディレクトリは配下のターゲットファイルを順次翻訳し、確認UIはスコープ単位1回（対象ユニット総数を提示）。キャンセル時は処理済み件数を返し、同一呼び出しの再実行で残りを処理できる（冪等な再開）。

### 理由
JSON化してもエンベロープに `summary` を必須で含めることで、JSONを解釈しない単純なエージェント/ユーザーへの可読性を現行同等に保てる。need内訳集計（`status-data.ts`）・nextActions は VS Code 非依存の純関数とし、スキーマを単体テストで検証可能にした。承認回数の削減はスコープの拡大（ディレクトリ単位1回）で実現し、承認の省略では実現しない（Tools層の確認UI原則は維持）。

### 備考
- 入力パラメータは `path` に統一しつつ旧 `filePath` も後方互換で受理する。
- need語彙の内訳は将来のM2以降の語彙（keep/backfill）も先行してカテゴリ化済み（存在しない間は0件）。
- 詳細: [.tasks の 260704-01 チケット](../.tasks/)

---

## ADR-260629-01: 初心者の落とし穴を「診断コマンド＋エラー導線＋破壊的操作ガード」で予防する

### 背景
初心者は予測可能な順序で同じ落とし穴に嵌まる（primaryLang 欠落、sync 後の空ファイルで混乱、原文/ターゲットの向き違い、Copilot 前提の誤解、API キー直書き漏洩、autoDelete による訳文消失）。コードトレースで再現を確認した。これらを「そもそも進ませない（最善）／早期検知して直せる（次善）」の2層で仕組み化したい。

### 決定
- **診断 core を VS Code 非依存に分離**: `src/core/diagnostics/setup-doctor.ts` の `runStaticChecks(snapshot, probe)` が設定・ディレクトリ・primaryLang 整合・API キー直書きを純粋関数で検査し、IO は `DoctorProbe` として注入する。UI（`mdait.setup.diagnose`）は静的診断＋AI 到達性を合成し、レポート文書とアクション付き通知で提示する。
- **エラーに次アクション導線**: `src/commands/shared/guidance.ts` の `showConfigError`/`showNeedSyncError`/`showTranslationError` で、設定エラー→診断/設定を開く、未 sync→Sync 実行、AI 不達→診断、へ誘導する。sync 完了時は翻訳待ちがあれば「今すぐ翻訳」を出す。
- **破壊的操作ガード**: `sync.autoDelete` を実際に設定値で尊重し（従来ハードコード `true` を是正）、孤立削除時は復旧導線を提示。API キー直書きはロード時に生値で検知して一度だけ警告する。

### 理由
診断ロジックを core に置くことで単体テストで各落とし穴を「実際に発生させて」検証でき（VS Code 非依存・プローブ注入）、メッセージの l10n は UI 層に閉じる。エラー導線は既存 `showErrorMessage` をヘルパー置換するだけで侵襲が小さい。autoDelete 是正はドキュメント記載の挙動（`false`→`verify-deletion`）に実装を一致させる純粋なバグ修正でもある。API キー検知は展開前の生値が必要なため、設定ファイルの再パース／ロード時フックで判定する。

### 備考
- 手動 sync での「削除前モーダル確認」と `sync.level` 変更検知は、並列ワーカー構造・状態保持の都合で本 ADR では後続課題とし、当面は autoDelete 設定尊重＋削除後の復旧導線で代替する。
- ドキュメント側は getting-started/README の primaryLang 欠落例を是正し、`docs/guide/ja/troubleshooting.md` を新設して根本原因（誤った例の丸写し）を断つ。
- 詳細: [.tasks の 260629-01 チケット](../.tasks/)

---

## ADR-260624-01: `.mdait/unit-state` の git 競合を union merge ＋ グループ区切りで最小化する

### 背景
external モードでは全ファイル・全ユニットの状態を単一 `.mdait/unit-state`（TSV）へ集約する。複数人が別ドキュメントを並行翻訳すると、この1ファイルへ全員が書き込み激しく競合する懸念がある。1ファイル構成（自己完結・git追跡）は維持しつつ競合を最小化したい。

### 決定
`.mdait/.gitattributes` に **`unit-state merge=union`** を自動生成し（`ensureMdaitDir()` が `.gitignore` と同じ冪等パターンで生成、利用者ワークスペース側）、別ファイル/別ユニットの並行編集を自動マージする。あわせて `save()` で **path 境界に空行アンカー**を挿入し、ファイルごとのブロックを分離する（ローダーは空行スキップ済みで読み込み不変）。

### 理由
`unit-state` は派生キャッシュであり、真のソースは Markdown 本文＋訳文（sync で再生成可）。ローダーは `(path, order)` を Map キーにし**重複行を後勝ちデデュープ**、`save()` は path→order で**正準ソート**して書き直す。この自己修復性により union merge が安全に成立する: 別ユニットの編集は両行が残って正しく、同一ユニット衝突も次 `load()` のデデュープ＋`save()` 正準化、最終的に `sync` のハッシュ再計算とストア欠落時の `need:review` 安全網（ADR-260620-01）で吸収される。空行アンカーは 3-way / union のファイル間分離を堅牢化し、`git diff` の可読性も高める。`union` は git 組込みドライバで gitconfig 不要。

### 備考
- スコープは `unit-state` に限定。`unit-registry`（全文スナップショット）等への union 適用は将来課題。
- 比較検討した代替: 1行/1ファイル集約（diff 可読性低下・同一ファイル必衝突）、order を安定IDへ置換（`order=index` attach の固定不変条件に抵触）はいずれも不採用。
- 詳細: [.tasks の 260624-01 チケット](../.tasks/)

---

## ADR-260620-01: マーカー外部化を `markers.mode` で live 配線し一括マイグレーションを提供する

### 背景
ADR-260618-01（足場）・フェーズ1（`UnitStateStore` と parser external 経路）でコアは揃ったが、実コマンド・UI は embedded 前提のままだった。ユーザーが external を実際に使えるよう、保管方式の切替手段と既存ドキュメントの変換手段が必要になった。

### 決定
保管方式は **グローバル設定 `markers.mode: "embedded"|"external"`（既定 embedded）** を `.mdait/mdait.json` に追加して切り替える。「管理下ファイルの読み書き」経路（sync/trans/status/CodeLens/Hover/Decorator/isInitialized/migration）にのみ `resolveMarkerIO(config, absPath, role)` で解決した provider/ctx を通す。external では本文にマーカーが無いため、trans は **全文 stringify で書き戻し**（`saveExternalDocument`）、UI は `findUnitAtLine` でユニット行範囲からマーカーを特定する。embedded は既定 provider で完全現状維持。embedded↔external の一括変換は **`mdait.markers.externalize` / `mdait.markers.embed`**（現モード provider で parse → 反対 provider で stringify、完了後に `markers.mode` を書き戻し）で提供する。

### 理由
モードを1つのグローバル設定に集約することで、source/target をまたいだ一貫した挙動と単純なメンタルモデルを保てる。provider/ctx 注入を「読み書き経路のみ」に限定することで TM/term など非対象を embedded 既定のまま据え置け、回帰面を最小化できる（既存テストは無改変で green）。external の store 喪失時は非MDと同じ `need:review` 安全網で既存訳文の上書きを防ぐ。`ExternalMarkerProvider` はストアを遅延解決（`getInstance()` を呼び出しごとに参照）し、シングルトン差し替えにも追従させて堅牢化した。

### 備考
- store キーは全経路で `toWorkspaceRelativePath`（ワークスペースルート相対・`/`区切り）に統一。full-sync の orphan クリーンアップは external の MD source/target パスを whitelist して保護する。
- frontmatter マーカーは両モードとも in-file（外部化対象外）。手動サブ境界マーカーは external 非対応（externalize 時に失われ得るため確認ダイアログで警告）。
- 詳細: [.tasks の 260620-02 チケット](../.tasks/)

---

## ADR-260618-01: 本文ヘッダマーカーの外部ファイル化をオプションとして導入する（足場）

### 背景
ユニット追跡用マーカー `<!-- mdait {hash} from:{hash} need:{flag} -->` の本文埋め込みは ADR-251214-02 で自己完結性・冪等性・git親和性を理由に意図的に選択された中核設計である。一方で「本文にコメントが残るのが煩わしい」「レンダリング以外のツールに見えてほしくない」というニーズがあり、マーカーを外部ファイルに退避する選択肢を後から安全に足せる余地が必要になった。

### 決定
マーカーの保管方式（永続化）を `MarkerProvider` Strategy として抽象化し、`parse`/`stringify` にオプション注入する。`EmbeddedMarkerProvider`（既定）は attach/detach が no-op で、埋め込みは従来どおり `MdaitUnit.toString()` が担う。今回のスコープはこの注入点（seam）の導入のみ（フェーズ0・振る舞い完全不変）。外部ストア本体（フェーズ1以降）は設計のみ記録する。外部ストアは**集約TSV1ファイル** `.mdait/unit-state` とし、`(path, order)` キー＋`titleHash` 補助で再対応付けする。**非MDファイルは「ファイル＝単一ユニット」= MDユニットの N=1 特殊形**と捉え、既存 `file-state` を名称ごと廃止して `unit-state`（`UnitStateStore`）に統合する（互換性は切る／旧痕跡を残さない）。`unit-registry` は全文スナップショットのため統合対象外。

### 理由
`parse`/`stringify` 内に external 分岐を直書きすると密結合が悪化する。Strategy 注入なら embedded を既定維持でき、呼び出し側（約20箇所）を一切変更せず既存テストが無改変で通る＝「振る舞い不変の足場」を最小コストで用意できる。external は P2 の自己完結原則からは逸脱するが、非MD file-state と同じ論法（sync 冪等再構築・git 追跡・rebuild 時 review）で正当化でき、非MDとMD外部ユニットを単一モデルで扱える。external では手動サブ境界マーカーを非対応とする割り切りを許容する。

### 備考
- フェーズ0で `src/core/markdown/marker-provider.ts` 追加、`parser.ts` に provider/ctx をオプション注入、`collectBoundaries` に `markersFormBoundaries` 引数を追加（external 分岐は TODO のみ）。
- 詳細・全フェーズ設計: [.tasks の 260618-01 チケット](../.tasks/)

---

## ADR-260613-02: vscode-lm の system prompt 送信ロールを Assistant から User に変更する

### 背景
VS Code LM API は system ロールをサポートしないため、system prompt を `LanguageModelChatMessage.Assistant` として先頭送信していた。これはモデルに指示を「自身の過去の発話」として読ませる形で意味論上不適切であり、指示追従が弱まるリスクがある。

### 決定
system prompt を先頭の `User` メッセージとして送信する（拡張開発の一般的慣行）。`modelOptions` は標準化されたキャッシュ制御が存在しないため空 `{}` のまま維持する。

### 理由
Userロールなら指示として自然に解釈される。Copilotバックエンドのキャッシュは制御不能だが、ADR-260613-01 による先頭メッセージのバイト安定化と合わせ、サーバー側キャッシュが効きやすい構造を保つ。ロール変更は出力に影響しうるため単独の変更とし、問題時は1行で戻せる。

### 備考
- 詳細: [.tasks の 260613-02 チケット](../.tasks/)

---

## ADR-260613-01: プロンプトを system / user-section に分割しプレフィックスキャッシュを有効化する

### 背景
翻訳系プロンプトは可変データ（用語集・TM参照・周辺テキスト・diff・前回訳文）を system prompt の中間に変数埋め込みし、さらに長い静的テール（出力フォーマット仕様等）がその後ろに続く構造だった。ユニットごとに system prompt 全体が変わるため、OpenAI の自動プロンプトキャッシュ・Ollama の kv-cache・Copilot バックエンドのキャッシュが一切効かず、毎ユニットで全トークンを再処理していた。リトライ補足も system 末尾連結でプレフィックスを壊していた。

### 決定
テンプレート内マーカー `<!-- mdait:user-section -->` で分割し、前半（静的指示）を system prompt、後半（可変条件ブロック）を user message 先頭の可変コンテキストとして送る。**system 部は変数を一切含まない完全静的テキスト**とし、言語・拡張子の指定（`{{sourceLang}}`/`{{targetLang}}`/`{{contextLang}}`/`{{fileExtension}}`）は user-section 先頭の `Translation Direction` セクションに置く。user message は「可変コンテキスト + 区切り行 `=== SOURCE TEXT ===` + 本文」で構成し、リトライ補足も user 側に付与する。マーカーのないテンプレート（既存カスタムプロンプト）はレガシーモードとして従来挙動を完全維持する。OpenAI には `prompt_cache_key`（system の CRC32）を付与し、usage（cached_tokens 含む）を ai-stats.log に記録して効果を実測可能にする。

### 理由
system prompt がプロンプト種別ごとに全ワークスペース共通の単一プレフィックスになり、言語ペア・翻訳方向・拡張子をまたいでキャッシュが共有される（1024トークン以上の共通プレフィックスに自動キャッシュが効き、コスト・レイテンシを削減）。代償は user message に増える Translation Direction 数行（20〜30トークン）のみ。単一テンプレート文字列＋マーカー方式なら、カスタムプロンプトのファイルパス設定・ロード・キャッシュの既存機構が一切変わらず、ユーザーはマーカー1行の追加で任意に移行できる。

### 備考
- 却下案: テンプレートを system/context の2ファイルに分割 → カスタム上書き設定の互換が壊れる
- Ollama は generate→chat API 化で system 分離（chatテンプレート適用の正道化）と keep_alive 設定追加も実施
- 詳細: [.tasks の 260613-01 チケット](../.tasks/)

---

## ADR-260531-02: パス相対化をドライブレター非依存にし、コマンド失敗を Logger 表出する

### 背景
debug-ipc 翻訳系シナリオ実機実行で `tm.commit` が `result=null`(No translation pair found)で失敗。原因は IPC が渡す大文字 `C:` と VS Code workspace の小文字 `c:` のドライブレター差で、`normalizePath` の `startsWith` 相対化が一致せず絶対パスのまま翻訳ペア検索に渡っていた。`translate` は別経路で耐性があり成功するため `tm.commit` だけ顕在化し、しかも失敗が `console.error`/`showErrorMessage` 止まりでログにも IPC 結果にも出ず観測困難だった。

### 決定
パス相対化を `path.relative` ベースに置換しドライブレター大小差・兄弟ディレクトリ誤一致(`/ws/ja`→`/ws/ja-backup`)を解消。あわせて `tm.commit`/`term.detect`/`term.expand` の握り潰しを `Logger.error/warn` に統一して IPC 結果・出力チャネルに表出させた。

### 理由
`startsWith` 文字列前方一致はドライブレター大小と区切り境界に脆弱で、`path.relative` なら OS 規約に従い堅牢。失敗を Logger に出すことで自律デバッグが result.json から異常を機械検出でき、今回のような「別経路は成功するため気づけない」バグの再発を観測可能にする。

### 備考
- 回帰テスト5件追加、634 passing。term 系は `Promise<void>` 設計で検出件数が機械可読でない点はフォローアップ課題として記録
- 詳細: [.agent/tasks/260531-01_自律デバッグ翻訳シナリオ検証.md](../.agent/tasks/260531-01_自律デバッグ翻訳シナリオ検証.md)

---

## ADR-260531-01: ステータス同期ズレ観測を fire 履歴タイムライン方式で行う

### 背景
「コマンドは成功するが UI が同期されない」事象を debug-ipc で観測したいが、コマンド前後の最終状態スナップショット差分だけでは「途中で更新されない/一瞬出て戻る/個別 fire が飛ばない」系を見逃す。観測のために本番の fire 経路を改変するのは厳禁（リグレッション・性能影響）という制約があった。

### 決定
`_onTreeChanged`/`_onDidChangeTreeData.fire()` の各箇所に `DebugFireRecorder.record()` を挟み、発火を seq 付きタイムラインとして記録する。コマンド前後の状態スナップショット差分と突合し「状態は変わったのに個別 fire が飛んでいない」ギャップを機械検出して result.json に埋め込む。recorder は `enable()`（DebugCommandHandler 構築時のみ）まで全操作 no-op とし本番経路を一切変えない。

### 理由
タイムラインがあれば最終状態では消える中間挙動を時系列で復元でき、自律デバッグが「いつ・何回・どの引数で」発火したかを根拠に判断できる。fire 箇所を `fireTreeChanged()` ヘルパに集約することで回数/引数/順序の等価性を保ちつつ記録点を一元化できる。enable ゲートにより本番は no-op で性能影響ゼロ。

### 備考
- 却下案: 最終状態スナップショット差分のみ → 中間の取りこぼし・スピナー残留を観測できない
- 却下案: VS Code イベントを外側で傍受 → 発火元の引数（どの item か）が取れず粒度が落ちる
- 詳細: [.agent/tasks/260531-01_自律デバッグ翻訳シナリオ検証.md](../.agent/tasks/260531-01_自律デバッグ翻訳シナリオ検証.md)



### 背景
`FileExplorer` の `workspaceRoot` フィールドがコンストラクタで固定されていたため、`new FileExplorer()` 後にカスタムコンフィグパスを設定しても `sourceDir`/`targetDir` の解決がワークスペースルート基準のままになる問題があった。`new FileExplorer()` が多数の場所で引数なしで呼ばれており、コンストラクタシグネチャを変更すると波及が大きかった。

### 決定
`workspaceRoot` フィールドをプライベートゲッター `configBaseDir` に変更し、毎回 `Configuration.getInstance().getConfigBaseDir()` を呼んで動的に解決する。

### 理由
`FileExplorer` はステートレスなユーティリティとして使われており、毎回の `getConfigBaseDir()` 呼び出しは軽量な計算のみ。コンストラクタシグネチャを変えずに全ての呼び出し箇所を変更できる。`Configuration` との循環依存も発生しない。

### 備考
- 却下案: コンストラクタに `configBaseDir?: string` を追加 → 多数の `new FileExplorer()` 呼び出し箇所を全て修正する必要がある
- 詳細: [.tasks/done/260421-02_transPairsパス解決基準をmdait.json相対に変更.md](.tasks/done/260421-02_transPairsパス解決基準をmdait.json相対に変更.md)

## ADR-260421-01: カスタムコンフィグパスの注入方式 — initialize(customPath?) を採用

### 背景
モノレポ対応でユーザーが指定したコンフィグパスを `Configuration` に渡す必要が生じた。`Configuration` は `ExtensionContext` を持たない設計のため、`workspaceState` に保存したパスをどう渡すか選択が必要だった。

### 決定
`Configuration.initialize(customPath?: string)` にオプション引数を追加する。`extension.ts` が `workspaceState` からパスを取り出して `initialize()` に渡す唯一の橋渡し役となる。

### 理由
`initialize()` が唯一のエントリポイントである現状を維持できる。`Configuration` が `ExtensionContext` に依存しないという既存設計を守れる。`extension.ts` が `workspaceState` と `Configuration` の境界を担うことで責務が明確になる。

### 備考
- 却下案: `setConfigFilePath(path)` 追加 → set後にinitialize()を呼ぶ2ステップ操作でエントリポイントが2つになる
- 却下案: `getInstance(context)` シグネチャ変更 → 全呼び出し箇所への波及が大きく設計コストが高い
- 詳細: [.tasks/done/260421-01_既存コンフィグをサブフォルダから選択.md](.tasks/done/260421-01_既存コンフィグをサブフォルダから選択.md)

## ADR-260404-01: infra層新設とservices層の見送り

### 背景
src/直下にconfig(1ファイル), utils(4), debug(1), llm(7)が散在し、新ファイルの配置基準が不明確だった。レイヤー浄化の議論でservices層(コマンド横断ロジック集約)とinfra層(プラットフォーム適応)の両方が候補に上がった。

### 決定
infra層を新設し、config/llm/utils/debugを統合する。services層は導入しない。lm-tools/とprompts/はトップレベルに据え置く。

### 理由
services/に入る候補（file-handler, status-collector, prompts, file-explorer）は4つしかなく、性質がバラバラ（戦略パターン、データ収集、定数セット、ユーティリティ）で統一的な配置基準が定義できない。将来ビジネスロジックが育ったタイミングで切り出す方が「分類不能の受け皿」化を防げる。lm-tools/はアーキテクチャ上commandsと並列のエントリポイント層であり、commands配下に入れると呼び出し側/呼ばれる側が混在する。

### 備考
- 却下案: services/層を同時に導入 → 責務が曖昧で「何を入れるか」の判断基準が不明確
- 却下案: lm-tools/をcommands/tools/に移動 → エントリポイント層の並列性が崩れる
- 却下案: infra/をフラット配置（サブフォルダなし）→ ユーザーの一貫性優先の判断でサブフォルダ化
- 詳細: [260404-01_src-directory-restructure.md](../.tasks/done/260404-01_src-directory-restructure.md)

---

## ADR-260329-04: FileHandler Strategyによる多フォーマット翻訳対応

### 背景
非MDファイル（.txt, .csv等）の翻訳サポートを追加するにあたり、sync-command、trans-command、status-collector、extension.tsの4箇所にMD/nonMD分岐が散在する問題がスパイク（260329-01）で判明した。ファイルタイプが増えるたびに全箇所に分岐追加が必要になるため、構造的に解決する必要がある。

### 決定
FileHandler Strategyパターンを採用し、ファイルタイプ別の処理をMdFileHandler / PlainFileHandlerに分離する。分岐はFileHandlerFactoryの1箇所に集約する。非MDファイルの翻訳状態はファイル内マーカーではなく`.mdait/file-state`（行ベースTSV）で管理する。MdFileHandlerは既存関数への薄いラッパーとし、既存コードへの影響を最小化する。

### 理由
Strategy+Factoryにより、新ファイルタイプ追加時の影響範囲がHandler新設+Factory登録の2箇所に限定される。MdFileHandlerを薄いラッパーにすることで既存317テストに影響を与えずに段階的に導入できる。file-stateを分離ストアとした理由は、テキストファイルにHTMLコメントマーカーを埋め込めないため。

### 備考
- 却下案: 各コマンドに直接if分岐 → 分岐が4箇所に散在しファイルタイプ追加時の保守コスト大
- 詳細: [260329-02_非MDファイル翻訳サポート](.tasks/do/260329-02_非MDファイル翻訳サポート.md)

## ADR-260329-03: vscode依存の切り離し方針 — 値DI + 関数DI

### 背景
test:unitで実行不可だったNG9テストの原因は、ビジネスロジックファイルが`Configuration.getInstance()`や`PromptProvider.getInstance()`を内部で呼び出し、そのモジュールロード時に`import * as vscode`が実行されることだった。

### 決定
Configuration依存は「必要な値（primaryLang, transPairs）だけを引数に渡す」方式、PromptProvider依存は「`getPrompt`関数を引数に渡す」方式で切り離す。純粋関数がvscode依存ファイルに同居しているケースは別ファイルに抽出する。元ファイルからはre-exportで後方互換を維持する。

### 理由
Configオブジェクト自体を渡すとConfigクラスへの型依存が残り、テストでConfig相当のモックが必要になる。値だけ渡せばテスト側は単純なリテラルで済む。PromptProviderは引数がランタイムで決まるため関数DIにしたが、インターフェースではなく関数型`(id, vars) => string`を採用して過度な抽象化を避けた。

### 備考
- 却下案: Configオブジェクトごと引数に渡す → テスト側でConfigモックが必要になり冗長
- 却下案: vscodeモジュールのstub → Node.jsのmodule cacheを汚染し不安定
- 詳細: [260329-07_vscode依存チェーン切り離し.md](.tasks/done/260329-07_vscode依存チェーン切り離し.md)

## ADR-260329-02: テスト層の3層分類とunit対象の切り分け基準

### 背景
`test:unit`はcore/**のみを対象としていたが、commands/**のテスト24個の大半はVS Code非依存のビジネスロジックテストであり、CIで常時実行できるはずだった。しかし全体をglobで含めるとimportチェーン経由でvscodeモジュール解決に失敗するファイルが混在していた。

### 決定
テスト層をunit/e2e/debugの3層に整理し、`test:unit`の対象をimportチェーンでvscodeモジュールに到達しないファイル（OK15個）に限定する。NG9個は`test:vscode`に残す。切り分けはmochaでの個別実行結果（MODULE_NOT_FOUND有無）を基準とする。

### 理由
テストコード自体のvscode依存有無ではなく、Node.jsモジュール解決の到達性が実際の実行可否を決める。24個全ファイルを個別実行して切り分けたため、偽陽性・偽陰性がない。glob除外パターンではなく明示的なファイル列挙により、将来のファイル追加で意図しない混入も防げる。

### 備考
- 却下案: commands/**全体をglobで含める → NG9個が混入して失敗
- 却下案: テストコードのimport文のみで判定 → 間接依存を見落とす
- 詳細: [260329_test層整理.md](.tasks/done/260329_test層整理.md)

## ADR-260329-01: パッチ形式を`=`/`-`/`+`プレフィックスに統一する

### 背景
patchMode（差分翻訳）のパッチ形式がunified diff風（コンテキスト行はスペースプレフィックス、`-`=削除、`+`=追加）だったが、Markdownのリスト項目（`- item`）や水平線（`---`）とパッチ削除プレフィックス`-`が衝突し、パーサーが正しく分類できない致命的な問題があった。

### 決定
コンテキスト行のプレフィックスを`=`とし、全行が`=`/`-`/`+`のいずれかで始まる形式に統一する。unified diff互換やスペースプレフィックスは廃止し、`applyUnifiedPatch`・legacy/heuristicフォールバックも削除する。

### 理由
Markdownの内容で`=`から始まる行は実質存在せず（Setext見出し下線の`===`のみで衝突しない）、衝突リスクがゼロ。LLMにとっても「全行が3文字のいずれかで始まる」というルールが明快でミス率が低い。実動作テストでリスト項目を含むパッチをLLMが正確に生成・適用できることを確認済み。

### 備考
- 却下案: スペースプレフィックス（unified diff準拠）→ インデントとの混同リスク・LLMが忘れやすい
- 却下案: heuristicフォールバック（baseContent照合で`-`行を判定）→ 複雑で偽陽性リスクあり
- 詳細: [.tasks/do/260328_自律デバッグ検証分析.md](../.tasks/do/260328_自律デバッグ検証分析.md)

---

## ADR-260328-02: patchMode失敗時にサイレントフォールバックではなくユーザー確認を挟む

### 背景
patchMode（差分翻訳）がLLMのパッチ形式揺れで失敗した場合、`logger.warn`のみでサイレントに全文再翻訳にフォールバックしていた。全文再翻訳はユーザーの手修正を完全に上書きするため、データ損失に直結する致命的問題だった。

### 決定
パッチ適用失敗時に`vscode.window.showWarningMessage`で確認ダイアログを表示し、ユーザーが「スキップ」を選べば既存翻訳を保持してmarker更新もスキップする。補完策として`applyUnifiedPatch`に`@@`ハンク行自動補完を追加し、LLMのパッチ形式揺れを事前に吸収する。

### 理由
手修正はユーザーの知的作業の成果であり、機械的なフォールバックで無言に消失させることは絶対に避けるべき。パッチ補完で成功率を上げつつ、最終防衛線としてユーザー判断を挟む二段構えとした。モーダルダイアログは翻訳のwithProgress内でUXが悪いため非モーダルを選択。

### 備考
- 却下案: 全文再翻訳前にバックアップファイルを作成 → ファイル管理の複雑さが増し、ユーザーが気付かないまま上書きが進む可能性が残る
- 詳細: [.tasks/done/260328_patchMode保護と可観測性改善.md](../.tasks/done/260328_patchMode保護と可観測性改善.md)

---

## ADR-260328-01: debug-ipcの結果報告に部分失敗ステータスと構造化ログを導入する

### 背景
debug-ipcのresult.jsonは`status: "done" | "error"`の2値だった。syncが部分的にファイルエラーを起こしても`status: "done"`で返り、エージェントが成功と誤判断する問題が発生した。またlogsがフォーマット済み文字列の配列で、機械的なアサーションにはパースが必要だった。

### 決定
`status`に`"done-with-errors"`を追加し、resultオブジェクトに`errorCount > 0`がある場合に設定する。ResultPayloadに`structuredLogs: StructuredLogEntry[]`フィールドを追加し、level/scope/message/context/timestampの構造化ログを既存の文字列ログと併存させる。

### 理由
エージェントの自律テストでは、statusの3値判定（成功/部分失敗/完全失敗）で分岐処理が書ける方が、全ログをパースして失敗を検出するより遥かに簡潔で堅牢。構造化ログは既存の文字列ログを壊さず追加できるため、後方互換性を維持しつつ新しいアサーションパターンを可能にする。

### 備考
- 却下案: statusを`"done"`のまま維持しエージェント側でresult.errorCountをチェック → コマンド種類ごとにフィールド名が異なる可能性があり、ステータスに集約する方がシンプル
- 詳細: [.tasks/done/260328_デバッグ可観測性改善.md](../.tasks/done/260328_デバッグ可観測性改善.md)

---

## ADR-260322-01: TM検索クエリを行単位分割し、既存API（findCandidatesByTrigram / rankTmEntries）を無変更で再利用する

### 背景
TMエントリは文単位だが、TM検索クエリはユニット全体テキストで行われており、長いユニットでJaccard類似度が希薄化していた。行単位分割を導入する際、P8原則（normalize処理はモジュール内部に閉じ込める）との整合性と、既存APIの変更範囲が設計課題となった。

### 決定
新モジュール `tm-line-search.ts` をcore/tm/内に配置し、内部で `normalizeForTm` → 行分割 → 各行をそのまま既存 `findCandidatesByTrigram` / `rankTmEntries` に渡す構成とする。`normalizeForTm` のべき等性（正規化済みテキストに再適用しても結果不変）を活用し、既存APIは一切変更しない。revise時の変更行検出はunified diff解析ではなく正規化テキスト同士の集合差分で行う。

### 理由
`normalizeForTm` = `stripMarkdown` + `toLowerCase` + `trim` は正規化済みプレーンテキストに再適用しても変化しない。この性質により、行単位検索のオーケストレータが正規化後の行を既存APIに渡しても二重正規化の実害がなく、`findCandidatesByTrigram` / `rankTmEntries` に `preNormalized` フラグや新メソッドを追加する必要がない。変更影響範囲を最小化しつつP8を維持できる。

### 備考
- 却下案: `findCandidatesByTrigramSet(trigrams)` の新メソッド追加 → べき等性で不要であり、APIの増殖を避けた
- 詳細: [.tasks/do/260322_TM検索行単位化revise対応.md](../.tasks/do/260322_TM検索行単位化revise対応.md)
- 守ること: P8（外部呼び出し元は生テキストを渡す）。`lookupTmReferences` は生テキストを `searchTmByLines` に渡すだけ
- 影響: 各行で `normalizeForTm` が重複実行される（markdown-itパース）。行数が極端に多い場合は軽微なオーバーヘッド

---

## ADR-260320-02: TM normalize 処理をモジュール内部に閉じ込める

### 背景
`stripMarkdown`（markdown-itパース）が trans-command・TmxStore・tm-ranker の3層に散らばっており、同一テキストに最大3回実行されていた。「誰がnormalizeするか」が不明確なため二重適用が構造的に起きやすかった。

### 決定
normalize処理（`normalizeForTm` 等）はそれを必要とするモジュール（`TmxStore`・`tm-ranker`）の内部実装として閉じ込める。呼び出し側は生テキストを渡すだけとし、trans-command 側での事前 `stripMarkdown` 呼び出しは禁止する。

### 理由
二重適用を構造的に防ぐには、normalize の発動権を「使う側」ではなく「そのデータを管理する側」に持たせるのが最も単純。trigramキャッシュも `TmxStore` がエントリ登録時に計算・保持することで、normalize変更の影響がモジュール境界を越えなくなる。

### 備考
- 却下案: normalize共通ユーティリティ化（呼び出し側が選択的に呼ぶ形）→ 呼び出し忘れ・二重呼びが防げない
- 詳細: [.tasks/done/260320_TM_normalize一元化.md](../.tasks/done/260320_TM_normalize一元化.md)
- 守ること: 呼び出し側は常に生テキストを渡す（※`commit-processor.ts`のLLMプロンプト用途`stripMarkdown`は本制約の対象外）

---

## ADR-260320-01: TM retrieval = trigram 転置インデックス + Jaccard + MMR の2段パイプライン

### 背景
exact matchのみでは原文が少し変わるとTM参照がほぼゼロになる問題があった。初期実装では trigram インデックスが primary のみで構築されており、ja→en 翻訳方向でほぼヒットしない重大バグが発生した経緯もある。

### 決定
粗い絞り込みに trigram 転置インデックス（TmxStore担当・lang別分離）、精密スコアリングに Jaccard 類似度（tm-ranker担当・純粋関数）、LLMに渡す候補の多様性確保に MMR（Maximum Marginal Relevance）の2段パイプラインを採用する。

### 理由
exact match から完全脱却すると diff-aware な文改訂でもTMが活用できるようになる。embedding-based retrieval はオフライン不可・外部APIコスト増のため将来の差し替えポイントとして保留し、まず説明可能で調整しやすい lexical 中心で構成する。lang別インデックスは初期バグの再発防止として必須。

### 備考
- 却下案: embedding先行方式 → 外部API依存・初期コスト・オフライン不可で却下
- 詳細: [.tasks/done/260320_tm-scorer.md](../.tasks/done/260320_tm-scorer.md)
- 守ること: インデックスはlang別に分離して構築する（初期バグの再発防止）
- 未決: embeddingによるrerank層の後段追加は未検討

---

## ADR-260315-03: TM commit の guarded upsert アーキテクチャ

### 背景
tm-commit が pair 相対の source/target 対称設計を残していたため、multi-hop commit で既存 primary sentence を再利用できず、同一概念が別 TUに分裂していた。LLM応答の欠落・余分プロパティへの対応も曖昧だった。

### 決定
Command 層で primaryUnit/localUnit を先に確定し、processor は guarded upsert に専念する。LLM には `tm.alignWithPrimaryAnchors` で既存 primary sentence の再利用を要求し、応答は要素欠落・余計なプロパティを含めて fail-closed（不正応答は書き込まない）で処理する。

### 理由
正本一意性（同一primary sentenceは1TUに集約）を保証するには、Command層で入力を正規化してからprocessorに渡す二段構えが必要。fail-closedにすることでTMXの整合性破壊を構造的に防ぐ。

### 備考
- 却下案: 応答をfail-open（不正でも書き込む）→ TMX整合性が保証できない
- 詳細: [.tasks/done/260315_TM多言語マージ再設計修正.md](../.tasks/done/260315_TM多言語マージ再設計修正.md)
- 守ること: `reuse`行は既存TUへ、`create`行のみ新規TU候補とする

---

## ADR-260315-02: TM 正本管理を primaryLang 基準の tuid 一意性に統一

### 背景
初期TM設計はsource/target対称（翻訳方向相対）だったため、多段翻訳（ja→en→zh）で同一概念が別TUに分裂し、identical primary sentence が複数tuidを持つ問題が発生した。

### 決定
`primaryLang` を mdait 全体のトップレベル基盤設定とする。TMの正本は `primaryLang` の sentence とし、`tuid = hash(norm(primary_sentence))` を唯一の保存キーとする。multi-hop commitでも同一primary sentenceは1TUに集約される。

### 理由
source-relative 設計では non-primary 言語からの commit 時にTU一意性が保証できない。`x-unit-path` ベースのキーは同一ファイルで複数文が混入するリスクがあり、sentence hash の方が意味的に正確。

### 備考
- 却下案: `x-unit-path`ベースのキー → 同一ファイルに複数文が混入するリスクあり
- 詳細: [.tasks/done/260315_TM正本管理と参照方式再設計.md](../.tasks/done/260315_TM正本管理と参照方式再設計.md)
- 守ること: `primaryLang`は必須設定（未設定はvalidation error）
- 影響: 旧TMX（x-primary propなし）はtuidからprimaryを逆引き復元する互換読み込みを維持。`terms.primaryLang`（nested設定）は廃止済み
- 未決: non-primary言語のみのTU（primaryが消えた場合）の扱い

---

## ADR-260315-01: TMX 保存から補助 prop を YAGNI で廃止

### 背景
`x-primary`・`x-source-hash`・`x-unit`・`x-unit-hash` といった補助propをTMXに保存していたが、「正確に更新し続けるコストがあるのに有用なユースケースが見つからない」という判断に至った。

### 決定
TMX保存契約は `tuid + tuv（各言語 variant）+ tuv provenance` を正本とし、補助propは新規保存から除去する。旧TMXは x-primary 不在時に tuid から primary を復元する互換読み込みのみ維持する。

### 理由
「あると便利そう」というだけでは正確に保てないフィールドを持ち続けるコストは正当化できない（YAGNI）。cleanup は tuid ベースの原文現存確認で実現可能であり、補助propに依存する必要がない。

### 備考
- 却下案: 補助propを維持してprovenance追跡を強化する → 正確に維持できないフィールドは設計の負債になる
- 詳細: [.tasks/done/260315_TMX補助prop廃止.md](../.tasks/done/260315_TMX補助prop廃止.md)
- 守ること: 互換読み込み（旧TMXのx-primary逆引き）は保持する

---

## ADR-260209-01: 文分割を Intl.Segmenter ベースに変更

### 背景
正規表現ベースの文分割では日英中の混合文・省略語（Dr., etc.）・括弧内の文末記号などで誤分割が発生し、TM参照の品質（ユニット対応の精度）を下げていた。

### 決定
`Intl.Segmenter({ granularity: "sentence" })` を採用し、言語ごとにキャッシュする。コードブロック・インラインコード保護と段落・リスト独立分割は既存ロジックを維持する。公開API `split(text, lang)` は変更なし。

### 理由
Node.js 18+（VS Code拡張の前提環境）でサポート済みのネイティブAPI。ICUベースで多言語の文境界を適切に検出でき、正規表現よりメンテナンスコストが低い。インターフェース互換を維持するため上位層への影響がない。

### 備考
- 却下案: 正規表現カスタム拡張 → 省略語・混合言語の例外処理が無限に増加する
- 詳細: [.tasks/done/260209_sentence-segmentation-intl.md](../.tasks/done/260209_sentence-segmentation-intl.md)
- 守ること: コードブロック内の文分割禁止・lang引数への依存

---

## ADR-260208-01: stripMarkdown で構造（見出し・段落区切り）を保持する

### 背景
TM登録・検索時のMarkdown正規化で見出しと本文が連結され（「結論 AI技術の進化…」のように）、LLMの文脈理解を損なう問題があった。正規表現の独自実装ではネスト構造の正確な検出が困難だった。

### 決定
markdown-itトークンツリー走査で、トップレベルの見出し・段落・引用・リスト・表の境界を `\n\n`、リスト項目・表セルを `\n` で保持する。インラインコードはバッククォート付きで保持。YAML frontmatterはpre-processingで先頭パターンマッチにより除去する（パーサー依存しない）。

### 理由
markdown-it は TM正規化・TMX処理・品質チェックでも使用済み（依存追加なし）。インラインコード保持でコードを含む文のTM検索精度が向上する。frontmatterはMarkdownパーサーが誤認識しやすいため手動パターンマッチの方が安全。

### 備考
- 却下案: 正規表現独自実装の継続 → ネスト・混合言語で誤検出が増え続ける
- 詳細: [.tasks/done/260208_stripMarkdown構造保持改善.md](../.tasks/done/260208_stripMarkdown構造保持改善.md)
- 守ること: frontmatterは先頭パターンマッチで除去（markdown-itに依存しない）

---

## ADR-260201-01: ロギング基盤を OutputChannel 唯一出口 + Logger クラスに集約

### 背景
`console.log` が各所に散在し、ログレベル制御・フォーマット統一・ユーザー通知との分離ができていなかった。拡張の出力チャネルが複数に分岐するリスクがあった。

### 決定
`OutputChannel` を唯一の正式ログ出口とし、`Logger` シングルトンクラスに集約する。ユーザー通知（`vscode.window.show*`）とは完全分離。ログメッセージは英語で統一（内部用途のため翻訳不要）。`AIStatsLogger` は別系統として独立維持する。

### 理由
拡張のデバッグ時に出力が散らばると問題の特定が困難になる。ユーザー通知とログを同一経路にすると、ユーザーに見せるべきでない内部情報が漏れるリスクがある。

### 備考
- 却下案: console.logのラッパー方式 → VS Code拡張ホストのログと混在する
- 詳細: [.tasks/done/260201_ログ戦略実装.md](../.tasks/done/260201_ログ戦略実装.md)
- 守ること: `console.log`の直接使用禁止（Logger経由のみ）。AIStatsLoggerのみ別系統（コスト追跡目的）
- 未決: unit-registry-manager.ts・configuration.ts・status-collector.ts・prompt-provider.ts・openai-provider.tsでconsole.*直接呼び出しが残存

---

## ADR-260131-01: UnitRegistry をバケット化・決定的出力に変更

### 背景
原文スナップショット（旧Snapshot、後にunit-registryと改名）を単一フラットファイルで管理していたため、並行開発時のgit merge競合が頻発した。部分追記方式は順序不定でgit diffがノイズになり、ロックなしの並行追記での競合リスクもあった。

### 決定
CRC32ハッシュの先頭3桁でバケット化（000〜fff、4096バケット）し、常にバケット昇順・エントリ昇順で全体を書き直す（partial append廃止）。同一入力から常に同一出力（決定的）とする。

### 理由
決定的な全書き直しにすることで、同一状態のファイルはgit diffがゼロになり、マージ競合が解消される。バケットヘッダ行も有効なCRC32ハッシュ形式（`aaa00000`）として統一しパース処理の二重ロジックを回避する。

### 備考
- 却下案: DB/SQLiteへの移行 → VS Code拡張の配布・インストール複雑化。ファイルベースの方がgit管理・バックアップと相性が良い
- 詳細: [.tasks/done/260131_snapshot_v2_bucketing.md](../.tasks/done/260131_snapshot_v2_bucketing.md)
- 守ること: バケット昇順・エントリ昇順の決定的出力
- 影響: sync完了後5MB超過時にGCを実行（activeHashesのみ保持）。gzip+base64エンコードでファイルサイズ抑制

---

## ADR-260124-01: conflict 概念を廃止し need:revise に統一

### 背景
翻訳ドメインでは原文と訳文が同時に変更されることは日常的（原文修正＋訳文の誤訳修正など）。これを「conflict」として人手介入を要求することは過剰防衛で、conflict解決UIの複雑性のみが残っていた。

### 決定
`need:solve-conflict` を完全廃止する。source が変更された場合は常に `need:revise@{oldhash}` に統一し、target-only の変更は非干渉とする。hashは常に最新の観測値に更新（未解決状態でも更新を止めない）。

### 理由
LLMには差分と変更後訳文の両方が渡るため、並走変更は自動改訂（diff-aware revise）で自然に吸収できる。conflict解決UIは複雑な割に、LLMが担当できる範囲で代替可能。人手介入が真に必要な条件（マーカー消失・構造破壊・差分過大）は将来の拡張で対応する。

### 備考
- 却下案: conflict解決UI維持 → 複雑性が高い割にLLMが代替可能な範囲が大きい
- 詳細: [.tasks/done/260124_conflict仕様改善.md](../.tasks/done/260124_conflict仕様改善.md)
- 守ること: target-only変更（訳文直接編集）は`need:revise`にしない（非干渉）
- 未決: 差分過大・構造破壊などの「本当に危険な状態」への対応は将来検討

---

## ADR-260112-01: TranslationChecker を markdown-it 構造比較に変更

### 背景
正規表現ベースの品質チェック（数値・リスト・コードブロック）は精度が低く（順序考慮なし、ネスト未対応）、見出し・リンク・画像などの構造チェックが欠如していた。

### 決定
markdown-itでパースした構造（見出しレベル別数・リスト項目・コードブロック・引用・テーブル・リンク・画像）を原文と訳文で比較する。不一致は具体的に報告する（例：「見出しレベル2の数が不一致: 原文3個 vs 訳文2個」）。

### 理由
正規表現ではネスト構造の正確な検出が困難であり、構造チェックの追加コストが高い。markdown-it は既存依存として追加コスト不要であり、トークンツリーから構造を正確に抽出できる。

### 備考
- 却下案: 正規表現の改善継続 → ネスト・混合言語での例外処理が無限に増加する
- 詳細: [.tasks/done/260112_品質チェック再設計.md](../.tasks/done/260112_品質チェック再設計.md)

---

## ADR-260111-01: AIService インターフェースを Promise\<string\> に統一

### 背景
初期実装はストリーミング応答（`AsyncIterable<string>`）を返すインターフェースだったが、全コマンドが結局バッファリングしてから処理しており、ストリーミングのUX上のメリットが皆無だった。

### 決定
`sendMessage()` の戻り値を `Promise<string>` に統一する。プロバイダー内部でのバッファリングはプロバイダー責務とする（VSCodeLMProviderは内部でバッファリング、他は stream=false）。

### 理由
全コマンドがバッファリングしている以上、インターフェースだけストリーミングにしても複雑性しか残らない。将来リアルタイムプレビューが必要になった場合は `sendMessageStream()` をオプショナルで追加すれば良い。

### 備考
- 却下案: ストリーミング維持 → 全コマンドでバッファリングが必要なため複雑性のみ増す
- 詳細: [.tasks/done/260111_AIServiceストリーミング廃止.md](../.tasks/done/260111_AIServiceストリーミング廃止.md)
- 未決: リアルタイムプレビュー機能が必要になった場合の拡張方針は未決

---

## ADR-260110-01: OpenAI API 呼び出しで store:false をハードコーディング

### 背景
翻訳対象は機密文書を含む可能性があり、OpenAIサーバーへのプロンプト・応答の保存は許容できないケースがある。設定で変更可能にすると、ユーザーの設定ミスで機密情報がOpenAIに保存されるリスクが生じる。

### 決定
OpenAIProvider の API 呼び出しで `store: false` を常にハードコーディングし、設定で変更不可とする。APIキーも `${env:VARIABLE_NAME}` 形式で環境変数から読み込み（設定ファイルへの平文保存禁止）。

### 理由
翻訳ツールの性質上、機密性は非交渉的な要件。「設定で変更できる」という選択肢自体がセキュリティリスクになるため、構造的に排除するのが正しい。

### 備考
- 却下案: 設定で切り替え可能にする → ユーザーの設定ミスによる機密漏洩リスクが構造的に残る
- 詳細: [docs/design/llm.md](../docs/design/llm.md)
- 守ること: `store: false`は設定から除外しコードに固定する
- 影響: OpenAIのデバッグログ・活用分析は利用不可（受け入れるトレードオフ）

---

## ADR-260103-01: プロンプトの外部ファイルオーバーライド機構を導入

### 背景
デフォルトプロンプトが全ユーザーに固定されている状況では、専門ドメイン・特定スタイルへの最適化が不可能だった。翻訳品質はプロンプトに大きく依存するため、カスタマイズ性は実用上重要な要件。

### 決定
`mdait.json` の `prompts` セクションで任意のプロンプトIDに対してファイルパスを指定し、デフォルトプロンプトを上書き可能にする。変数展開は `{{variable}}` プレースホルダー形式。外部ファイル不在時は console.warn によるエラーログ出力＋デフォルトフォールバック（サイレントフォールバック禁止）。

### 理由
プロンプトIDをコードの識別子として固定しテキスト内容を外部化することで、コード変更なしにプロンプトをカスタマイズできる。サイレントフォールバック禁止はパスミスによる「変更が効いていない」問題を防ぐため。

### 備考
- 却下案: プロンプト全文をmdait.jsonに直接記述 → JSONエスケープが煩雑・長文管理不可
- 詳細: [.tasks/done/260103_システムプロンプト外部注入機能.md](../.tasks/done/260103_システムプロンプト外部注入機能.md)
- 守ること: プロンプトIDはコード識別子として安定させる（リネーム禁止に準ずる）

---

## ADR-251214-02: 管理情報をドキュメント内 HTML コメントに埋め込む

### 背景
外部ファイル（TSV、サイドカー等）に管理情報を分離すると、ファイルコピー・移動時に整合性が崩れる。マーカーフォーマットをドキュメントに埋め込む場合、レンダリング時の視覚的干渉を防ぐ必要がある。

### 決定
ハッシュ・need・from はすべて `<!-- mdait {hash} [from:{hash}] [need:{flag}] -->` 形式のHTMLコメントとしてドキュメント内に埋め込む。マーカーフォーマットと CRC32（8文字）は互換性のため変更禁止とする。

### 理由
ファイル単体で自己完結するため、ドキュメント移動・コピー時に管理情報が失われない。バージョン管理との相性が良く（ファイルそのものに状態が追跡される）、どんな状態からでも `sync` で復帰できる冪等性が保証できる。HTMLコメントはMarkdownレンダラーで非表示になり可読性を損なわない。

### 備考
- 却下案: サイドカーファイル（`file.ja.md.mdait`）→ ファイル移動時に管理情報が孤立する
- 詳細: [docs/architecture.md](../docs/architecture.md)
- 守ること: マーカーフォーマット `<!-- mdait hash from:xxx need:yyy -->` は変更禁止。CRC32（8文字）固定

---

## ADR-251214-01: ハッシュアルゴリズムに CRC32 を選択（SHA-256 ではなく）

### 背景
マーカー（`<!-- mdait {hash} -->`）にハッシュを埋め込むため、ハッシュ長がMarkdownの可読性に直接影響する。セキュリティ用途ではなく「テキスト変更検出」が目的。

### 決定
CRC32（8文字）を採用する。SHA-256（64文字）は不採用。ハッシュアルゴリズムは後方互換性のため変更禁止とする。

### 理由
SHA-256はマーカーを視覚的に壊す（64文字長）。数千ユニット規模での衝突確率はCRC32でも実用上無視できるレベル。ハッシュの目的が変更検出であり暗号強度は不要。

### 備考
- 却下案: SHA-256 → 64文字でマーカーが読めなくなる。xxHash等 → 切り替えコストに見合う理由がない
- 詳細: [docs/design/core.md](../docs/design/core.md)
- 守ること: CRC32固定（変更禁止）。衝突時は`sync`で再ハッシュされるため運用上問題なし