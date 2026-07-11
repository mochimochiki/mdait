# command: ai-sync（AI支援同期）

既存対訳サイトの取り込み（adopt）を LLM で支援する機能ファミリー。位置ベースマッチングの限界（誤対応・翻訳漏れ・全件人手レビューの負荷）を、紐付け検証・内容レビュー・修正提案・エスカレーションの個別機能として段階的に解消する。

## 目的と全体像

`sync --adopt`（[command_sync.md](command_sync.md)、ADR-260704-02）の対応付けは SectionMatcher の位置ベース（Phase 2）であり、見出しタイトルも内容も見ない。そのため:

- 中間セクションの欠落・追加・順序入れ替えがあると、以降のペアが全てズレて誤った `from:` リンクが書かれる
- 内容が異なるセクション同士が紐付けられても検出されない
- 部分的な翻訳漏れ（訳抜け・原文改訂への未追随）を検出する仕組みがない
- 唯一の安全網が全ユニットの `need:review` 人手レビューで、大規模サイトでは非現実的

### 設計原則（不変条件）

- **AI は明示起動時のみ**（ADR-260705-01）: 定常 sync（autoSyncOnSave 含む）は AI 不使用・決定的・冪等を維持する。AI を使う経路（アライン・レビュー・合成コマンド）は必ず明示的な起動と確認UIを経由する。
- **決定的な仕組みが提案し、AI が審査する**（ADR-260705-02）: アラインは位置ベースマッチングの結果を AI が差分審査する形を取り、AI の全面生成には委ねない。フォールバックは常に「現行の決定的挙動」。
- **既訳の不可侵**: どのパターン・どの機能でも既存訳文の本文は変更しない。マーカー変異は need の付与/解除のみで、`need:review` が残る限り trans / tm.commit への流出はない。
- すべて既存の状態機械（マーカー・`need:` 語彙・冪等 sync）の上に乗る。新しい need 状態は導入しない（ADR-260704-07）。

### 機能ロードマップ

| 系列 | 機能 | 概要 | 状態 |
|------|------|------|------|
| アライン | **AIアライン** | adopt 時、位置ベース対応付けの結果を AI が差分審査し修正提案（二段トリアージ。ADR-260705-02） | **実装済み** |
| レビュー | **AIペアリング検証** | adopt 済みペアごとに「target は source の忠実で完全な翻訳か」を判定し、高確信 match の `need:review` を自動クリア、それ以外をエスカレーション | **実装済み** |
| レビュー | **AIレビュー拡張** | 対象を翻訳済みペア全般へ拡張（need:review 以外も監査＝**対象拡張モード・実装済み**・ADR-260706-03）、バッチ検証（複数ペア/1コール）、定期実行、partial の修正提案化。非MD・frontmatter も対象化。**穴あきユニットの孤立/漏れ 分類提案**（[orphan-model.md](orphan-model.md) 将来増分） | 対象拡張のみ実装済み・他は未着手 |
| 合成 | **AI同期** | `sync(adopt) → AIアライン → AIレビュー呼び出し → レポート` を束ねる合成コマンド。取り込みと健全性監査を兼ねる | **実装済み**（ADR-260706-01） |
| 孤立 | **孤立の統合モデル（isolate・独立ユニット）** | 原文/訳文の意図的な独自章を一貫表現。`need:isolate`（伝播停止）・独立ユニット（from なし＝訳文役割の孤立）・マーカーなし孤立の need:review 一次受け。keep/backfill は廃止 | **実装済み**（[orphan-model.md](orphan-model.md)・ADR-260711-03）。判断サーフェスは将来増分 |

レビューを同期に埋め込まないのは意図的な分離である: レビューは取り込み直後だけでなく定常運用（定期監査・翻訳品質チェック）で価値を持ち、バッチ化・スケジュール実行の最適化は独立機能でこそ設計できる（ADR-260705-02）。

## 取り込みパターン網羅マトリクス

「既存サイトを mdait 管理下に置く」際に起こりうるパターンと、それぞれがどの仕組みでどう扱われるかの正準一覧。**共通保証: どのパターンでも既存訳文の本文は1文字も変更されない**（唯一の例外は `from` が残った管理済み孤立ユニットへの `orphanTargetPolicy: "delete"`。マーカーなしの独自セクションは削除されず `need:review` で保護される — パターン3参照）。

| # | パターン | 現行の挙動（adopt + AIペアリング検証） | 完全解消する機能（状態） |
|---|---------|--------------------------------------|------------------------|
| 1 | ja/en 同一構造・内容も対応 | 全ペアが正しく `from` 確立 → 検証がほぼ全件を自動承認（低確信のみ kept で人間へ） | **実装済みで完結** |
| 2 | ja の章が en で欠落（中間） | 欠落地点以降が誤ペア化し誤った `from` が書かれる。検証が **mismatch でエスカレーション**（検出まで。修正は[復旧手順](../guide/ja/adopt.md)で手動）。末尾で余った ja 章は `need:translate` 空ユニット生成 | AIアライン（**実装済み**） |
| 3 | ja に無い章が en に存在（訳文側の独自セクション） | マーカーなしの独自章は **`need:review` 一次受け**で保護される（削除も翻訳も決めつけず人間が「素hash化 / `need:isolate` / 削除」を選ぶ・[adopt.md](../guide/ja/adopt.md)）。誤ペア化は AIアラインの unmatchedTarget 識別で防止 | **実装済み**（一次受け＋AIアライン）。判断サーフェスは将来増分（[orphan-model.md](orphan-model.md)） |
| 4 | 章の順序入れ替え | 位置ベースのため誤ペア化 → mismatch 検出（修正は手動） | AIアライン（**実装済み**） |
| 5 | ペアは正しいが訳抜け・原文改訂に未追随 | 検証が **partial でエスカレーション**（issues に欠落箇所を列挙、hover/レポートに表示）。修正は手動 | AIレビュー拡張（修正提案化）＋判断サーフェスで孤立/漏れ 確定（[orphan-model.md](orphan-model.md) 将来増分） |
| 6 | en が原文コピーのまま（未翻訳） | 検証プロンプトの verdict 定義で match を禁止 — 全文未翻訳は mismatch、部分残留は partial に倒す | **実装済み** |
| 7 | en ファイル自体が無い | `syncNew` が全ユニット `need:translate` を生成 → 通常の trans フロー（adopt 不要） | **実装済みで完結** |
| 8 | ja に無いファイルが en にある | **sync はソースファイル起点のため触らない＝管理外のまま放置**（削除も検出もされない）。既知の限界 | 将来課題（未計画） |
| 9 | 見出しレベル設定の不一致 | `validateAndSyncLevel` が target の `mdait.sync.level` をソースに自動同期 | **実装済みで完結** |
| 10 | 非 Markdown ファイル | PlainFileHandler の rebuild 安全網が `need:review` を付与（既訳保護）。AIペアリング検証は対象外のため解除は手動 | AIレビュー拡張 |
| 11 | ja に原文のみの補足章がある（原文側の独自セクション・意図的） | `need:isolate` を付与すれば伝播停止（target 生成・translate/revise 付与なし。凍結）。sync/trans/TM の全経路が対象外として扱う | **実装済み**（`need:isolate`・[orphan-model.md](orphan-model.md)）。宣言 CodeLens UI は将来増分 |

パターン2〜4 で書かれた誤った `from` リンクは、次回 sync の Phase 1（from ベースマッチング）が維持し続けるため自然には直らない。復旧手順（誤ペアのマーカー除去 → 構造修正 → 再 adopt）は [adopt.md](../guide/ja/adopt.md) を参照。mismatch には**誤リンク型**（カスケードズレ・復旧手順が必要）と**内容差し替え型**（位置は正しいが中身が別物・再翻訳でよい）があり、判断サーフェスでの区別は将来増分。孤立（原文/訳文/両方）の統合モデルは [orphan-model.md](orphan-model.md) を参照。

## アーキテクチャ

CoreProc を `src/commands/ai-sync/` に置き、VS Code コマンドと LM tool の両面から呼ぶ（tm.commit と同構造、エンベロープは ADR-260704-01 準拠）。判定ロジック（verdict→action）は VS Code 非依存の純関数。

```
src/commands/ai-sync/
  review-result.ts             # 型定義 + decideReviewAction / aggregateReviewResults 純関数
  pair-collector.ts            # 純関数: 検証対象ペア列挙
  verify-response-validator.ts # AI応答のJSONバリデーション
  pair-verifier.ts             # AIService 呼び出し + リトライ
  review-core.ts               # executeAiReviewForFile: 1ファイル分の検証→マーカー変異→書き戻し
  review-command.ts            # VS Code コマンド（file/directory）
  review-result-provider.ts    # 仮想ドキュメントレポート（generateReviewTableSection を AI同期と共有）
  review-targets.ts            # レビュー対象ターゲット解決（mdait_aiReview / AI同期で共有）
  align-result.ts              # 純関数: スケルトン/ダイジェスト・修正提案バリデーション・matchResult 再配線
  align-response-validator.ts  # アライン応答（ok/corrections/needBodies）のJSONバリデーション
  section-aligner.ts           # AIService 呼び出し + 二段トリアージ2ラウンド + リトライ + buildSectionAligner
  align-core.ts                # alignMatchResult: 候補抽出→審査→検証→再配線（sync_CoreProc から adopt+align 時のみ）
  ai-sync-core.ts              # executeAiSync: 各段（sync(adopt+align)→review）を注入合成する薄いオーケストレーター
  ai-sync-result.ts            # 純関数: 合成集計・レポート・nextActions
  ai-sync-command.ts           # VS Code コマンド（mdait.aiSync.run・ワークスペース全体）
  ai-sync-result-provider.ts   # 合成レポートの仮想ドキュメント（mdait-ai-sync スキーム）
src/lm-tools/ai-review-tool.ts # mdait_aiReview
src/lm-tools/ai-sync-tool.ts   # mdait_aiSync（合成コマンド）
src/lm-tools/sync-tool.ts      # mdait_sync（align パラメータ）
```

AIアラインは独立コマンドを持たず、`sync_CoreProc` の `match()`〜`updateSectionHashes()` 間に `SectionAligner` を注入する形で動く（ADR-260705-03）。aligner は `syncCommand` が AIOnboarding 通過後に1回構築し、`syncSingleFile`（定常 sync）へは渡さないため AI 非実行が構造的に保証される。1ファイルの審査ユニット上限は全般設定 `trans.maxUnitsPerRun`（既定300・`0`で上限なし）で制御し、受理 confidence 下限（0.6）・needBodies 上限（8）・トリアージ上限ラウンド（2）はコード内定数で固定（ADR-260711-03）。

## AIペアリング検証（レビュー系・第一形態）

### データフロー

```mermaid
sequenceDiagram
    participant Cmd as command / LM tool
    participant Core as review-core
    participant Col as pair-collector
    participant Ver as pair-verifier
    participant AI as AIService
    rect rgb(240, 248, 255)
    Note over Cmd,Core: 準備
    Cmd->>Core: executeAiReviewForFile(targetFile)
    Core->>Core: source/target をパース（resolveMarkerIO）
    Core->>Col: collectReviewPairs(sourceUnits, targetUnits)
    Col-->>Core: from + need:review のペア列挙（0件なら即終了=冪等）
    end
    rect rgb(255, 250, 240)
    Note over Core,AI: バッチ検証（batchSize 件/コール・batchSize:1 は単ペア経路）
    loop 各バッチ（trans.maxUnitsPerRun 上限・1ファイル単位・キャンセル可）
        Core->>Core: ペア毎に humanNote＋用語集・TM（双方向マッチ）を収集
        Core->>Ver: verifyBatch(pairs[{index, texts, terms, tm, note}])
        Ver->>AI: sendMessage(system固定, user=&lt;pair index&gt;ブロック列)
        AI-->>Ver: {"results":[...]}（欠落index時は RETRY INSTRUCTION 付き再試行→部分受理）
        Ver-->>Core: Map&lt;index, verdict + confidence + issues + reason&gt;
        Core->>Core: applyVerifyOutcome → approve なら removeNeedTag()
    end
    end
    rect rgb(240, 255, 240)
    Note over Core: 書き戻し（変更がある場合のみ・FileMutex 排他）
    Core->>Core: stringify → writeFile（キャンセル時も完了分は書き込む）
    end
```

### 検証対象

`target.marker.from` があり `target.marker.need === "review"` の Markdown ユニットのみ。ソースユニットは `from` ハッシュの一致で解決し、見つからない場合は skipped（`need:review` 維持）。frontmatter ユニット・非MDファイルはスコープ外（AIレビュー拡張で対応）。

### verdict 語彙と判定→アクション対応

| verdict | 意味 | 条件 | マーカー操作 | action |
|---------|------|------|--------------|--------|
| match | 忠実かつ完全な翻訳 | autoApprove ∧ issues空 ∧ confidence ≥ threshold | `removeNeedTag()` | approved |
| match | 〃 | 上記以外 | 変更なし | kept |
| partial | 対応関係はあるが不完全（訳抜け・追加・未追随） | — | 変更なし | escalated |
| mismatch | 別トピック。ペアリング自体が誤りの疑い | — | 変更なし | escalated |
| uncertain | 判定不能 | — | 変更なし | kept |
| （リトライ枯渇） | JSON不正が続いた | — | 変更なし | error |
| （source未解決） | from に対応するソースが無い | — | 変更なし | skipped |

マーカー変異は `removeNeedTag()` の1種類のみで、`hash`・`from`・本文には一切触れない。approve は CodeLens「Mark as Reviewed」手動ボタンと同じ結果状態であり、既存の trans / tm.commit / StatusTree セマンティクスにそのまま乗る。mismatch/partial の差別化はレポートと hover（`SummaryManager.reviewReasons`）で行い、新しい `need:` 値は導入しない（ADR-260704-07）。

### 冪等性・キャンセル

- approve されたユニットは `need:review` が消えるため次回実行で列挙されない（2回目実行は無変更）
- escalated/kept は `need:review` のまま残るため再実行で再検証される（判定が揺れる場合は human レビューへ）
- キャンセル時は完了分（処理済みバッチ）の approve のみ書き込む（冪等なので再実行で残りを処理できる）
- バッチ単位の失敗（リトライ枯渇・例外）はバッチ内全ペアを error にしてファイル全体は止めない（tm.commit と同方針）

### バッチ検証（batchSize・実装済み・ADR-260709-01)

`aiSync.review.batchSize`（既定 **3**、1..10 クランプ）件のペアを1回の LLM コールにまとめる。`chunk()` で固定サイズに分割し、`PairVerifier.verifyBatch()` が `aiSync.verifyPairingBatch` プロンプトで `{"results": [{index, verdict, ...}]}` を要求する（index echo で対応付け）。

- **batchSize: 1 は従来の単ペア経路**（`verify()` ＋ `aiSync.verifyPairing`）に完全後方互換。既存の単ペアカスタムプロンプト利用者は batchSize: 1 を設定する
- **バリデーション**: `{"results": [...]}` に全 index の有効エントリが揃わなければ retryable エラーとしてバッチ全体をリトライ（欠落 index を RETRY INSTRUCTION に列挙）。重複 index は最初を採用、範囲外は無視
- **部分受理フォールバック**: リトライ枯渇時、最後に有効だったエントリはそのまま採用し、欠落・不正の index のみ `uncertain / confidence 0`（fallback）で埋める。単ペアの「不正応答→安全側 uncertain」をペア粒度に拡張した形
- ペア本文は `<pair index="N">` ブロックに単ペア版と同様エスケープなしで埋め込む（境界崩れは index echo 検証→retry→fallback で概ね検出される。humanNote・terms・tmReferences は外部データとして山括弧をエスケープ）

### 用語集・TM注入（訳揺れ検知・実装済み・ADR-260709-01)

検証プロンプトに用語集と TM 参照をペア毎に注入し、確立訳語との不整合（訳揺れ）を LLM の判定ルールに乗せる。pending / audit 両モード共通。

- **双方向マッチが要点**: 用語集は「原文に原語（＋variants）が出現」**または**「訳文に訳語（＋variants）が出現」したエントリをすべて注入する（`extractBidirectionalTerms`、コード除去後に照合）。原文側だけのヒットは「訳語不使用」、訳文側だけのヒットは「別訳語・原文に無い用語の混入」の兆候で、判定は用語集を受け取った AI に委ねる
- **TM も双方向**: `searchTmBidirectional` が原文→TM原文の既存検索に加え、言語を入れ替えて訳文→TM訳文を検索し（結果の source/target を戻す）、tuid で重複排除して合計 `tm.maxReferences` 件に cap する。対訳が揃ったエントリのみ返る
- **注入粒度は per-pair**（`<pair>` ブロック内の `<terms>` / `<tmReferences>`）。バッチレベルで union すると用語の帰属が曖昧になり無関係ペアへの偽 issue を誘発するため
- 判定ルール: 用語集と異なる訳語は terminology inconsistency として `partial` + issue（`<humanNote>` が説明する場合を除く）。TM 参照との文体差は減点せず、同一表現の確立訳と明確に矛盾する場合のみ issue
- ロードは `ReviewContextProvider` がファイル単位で1回（用語集は `TermsCacheManager`、TM は `tm.enabled` とエントリ有無でガード）。ペア毎の抽出・検索は同期の純計算

### プロンプト契約（aiSync.verifyPairing / aiSync.verifyPairingBatch）

`PromptIds.AI_SYNC_VERIFY_PAIRING = "aiSync.verifyPairing"`（単ペア・batchSize:1）と `PromptIds.AI_SYNC_VERIFY_PAIRING_BATCH = "aiSync.verifyPairingBatch"`（batchSize>=2）。system 部は変数なし（プレフィックスキャッシュ有効、[prompt.md](prompt.md) の user-section 分割）。`prompts["aiSync.verifyPairing"]` / `prompts["aiSync.verifyPairingBatch"]` による外部ファイル上書き・`mdait-instructions.md` 注入は既存機構で自動対応。

期待レスポンス（単ペア / バッチ）:

```json
{ "verdict": "match", "confidence": 0.95, "issues": [], "reason": "Faithful and complete translation." }
```

```json
{ "results": [ { "index": 1, "verdict": "match", "confidence": 0.95, "issues": [], "reason": "..." } ] }
```

バリデーション: verdict が4値 enum・confidence が number（0..1 クランプ）でなければ retryable エラーとしてリトライ（system 固定・user message 末尾に RETRY INSTRUCTION 追記、`trans.retryLimit` と同じ最大2回）。リトライ枯渇時は `verdict: uncertain, confidence: 0` 相当（自動承認されない安全側。バッチは部分受理）。

### 設定（aiSync.review）

```jsonc
"aiSync": {
  "review": {
    "autoApprove": true,          // false = レポートのみ（need:review を一切変更しないセーフモード）
    "batchSize": 3                // 1コールあたりの検証ペア数（1..10 クランプ。1 = 従来の単ペアプロンプト）
  }
}
// 検証ユニット数の上限は全般設定 trans.maxUnitsPerRun（既定300・0で上限なし・1ファイル単位で適用）。
// 自動承認閾値（0.9）はコード内定数で固定（設定廃止）。
```

### UI・レポート

- 進捗: `withProgress`（cancellable）。AI 初回利用は AIOnboarding ゲート
- 結果通知: escalated > 0 なら warning、それ以外は info
- レポート: `mdait-ai-review:` スキームの仮想ドキュメント（Markdown 表）。mismatch を先頭にソートし、**自動承認したユニットも必ず列挙**する（TM 登録可能状態への昇格を可視化）
- hover: `SummaryManager.reviewReasons` に `AI pairing review: {verdict} ({confidence}) — {reason}` を保存
- StatusTree: 変更なし（need:review 数の減少が自然に反映される）

### LM tool 契約（mdait_aiReview）

入力: `{ path?: string, dryRun?: boolean }`（path 省略はワークスペース全体。ファイル/ディレクトリ両対応）。マーカー書き換えを伴うため `prepareInvocation` で確認 UI を出す。

data:

```jsonc
{
  "files": { "scanned": 3, "withReviewUnits": 2 },
  "units": { "verified": 40, "approved": 31, "mismatch": 2, "partial": 4, "uncertain": 1, "keptBelowThreshold": 2, "errors": 0, "skipped": 0 },
  "autoApprove": { "enabled": true, "threshold": 0.9 },
  "escalations": [ { "file": "...", "unitHash": "...", "title": "...", "verdict": "mismatch", "confidence": 0.85, "reason": "..." } ]
}
```

nextActions: mismatch あり →「見出し対応を目視確認し、必要なら手動でユニットを並べ替えて mdait_sync 再実行」、approved あり →「mdait_tm (action:"commit") で承認済みペアを TM 登録」、全消化 →「mdait_getStatus で確認」。エージェント駆動の取り込みフローは [agent-orchestration.md](agent-orchestration.md) を参照。

## 将来増分の設計要点

### AIアライン（差分審査型・ADR-260705-02）

**実装済み**（`syncCommand({ adopt: true, align: true })` / `mdait_sync` の `align` パラメータ・ADR-260705-03）。adopt 時のみ・明示指定でのみ発動する（定常 sync では絶対に動かない）。`SectionMatcher.match()` の Phase 2 結果を AI が審査する形:

- **入力**: 両言語のユニットスケルトン `{index, level, 見出し, 本文ダイジェスト（コード除去済み先頭~80字）, 長さ}` ＋ 位置ベースの対応表
- **出力**: `{ok | corrections: [{sourceIndex, targetIndex, confidence}] | needBodies: [index...]}`。大半のページは構造一致なので応答は「ok」で終わる（出力サイズが問題の数に比例）
- **二段トリアージ**: `needBodies` で特定ユニットの本文（切り詰め・上限K件）を要求できる、上限付き2ラウンドのプロトコル。`AIService.sendMessage` の `AIMessage[]`（assistant ロール含む多ターン）で実装可能
- **バリデーション**: 修正提案は1件ずつ独立に検証（インデックス範囲・単射性）し、不正な提案のみ棄却。応答不正・上限超過は位置ベース結果へフォールバック（安全側は常に現行挙動）
- **追認バイアス対策**: プロンプトで「1章の挿入・削除は以降の全ペアを連鎖的にズラす。この連鎖パターンを特に疑え」と位置ズレの署名を明示
- 既に `from` アンカーを持つユニットは審査対象外（Phase 1 が優先）。unmatchedTarget の識別により orphanTargetPolicy の誤爆（独自セクションの誤削除・誤ペア）も防ぐ
- アラインの誤りは後段のペアリング検証が mismatch として拾うため、アライン→検証のパイプラインは自己検証的になる

### AIレビュー拡張

現行のペアリング検証を独立機能ファミリーとして発展させる（同期には埋め込まない）:

- **対象拡張（実装済み・ADR-260706-03）**: 下記「対象拡張モード（audit）」参照。
- **バッチ検証（実装済み・ADR-260709-01）**: 上記「バッチ検証（batchSize）」参照。二段トリアージ（ファイル粗判定→個別精査）ではなく固定サイズバッチ＋部分受理を採用した（プロトコルが単純で、部分受理により1コール失敗の影響がペア粒度に留まるため）
- **定期実行**: 「ユーザーが明示的にスケジュール設定した」ことを起動要件として ADR-260705-01 と両立させる
- **修正提案化**: partial の issues を構造化（欠落文の位置・種別）し、revise 風の修正パッチ提案へ。非MD（PlainFileHandler の1ユニット全文）はトークン上限設計とあわせてここで対象化

#### 対象拡張モード（audit・実装済み・ADR-260706-03）

`collectReviewPairs` に列挙モードを追加し、`AiReviewOptions.mode` / `mdait_aiReview` の `mode` / コマンドの QuickPick で選択する:

- **`mode: "pending"`（既定・従来挙動）**: `from` あり ∧ `need === "review"` のみ。
- **`mode: "audit"`**: `from` あり ∧（`need === "review"` **または** `need` なし）＝確定済みペアも監査。**非冗長な価値は「①採用（位置ベース adopt）コンテンツの意味的対応検証」「②原文不変のまま訳文が手修正で劣化したケースの検出」**。原文改訂は hash-sync が `need:revise` で決定的に検出し（かつ in-flight として）audit 対象外なので、audit は「原文改訂の検出器」ではない。`translate`/`revise@`/`isolate`/`verify-deletion` 等の need 残り状態は対象外。

検証対象の**元の状態**（`need:review` か確定済みか）で意味が分岐する。**確定済みペアの不備は「報告のみ」でマーカーを一切変更しない**（ADR-260706-03）:

| 元状態 | verdict | 処理 | action |
|--------|---------|------|--------|
| pending（need:review） | match（承認条件） | `removeNeedTag()` | approved |
| pending | partial/mismatch | 変更なし | escalated |
| pending | uncertain/閾値未満 | 変更なし | kept |
| settled（need なし・audit のみ） | match / uncertain | 変更なし（クリーン確認） | audited |
| settled（audit のみ） | partial/mismatch | **変更なし（報告のみ）** | flagged |

`decideReviewAction`（純関数）は不変。マーカー変異は pending 承認時の `removeNeedTag()` のみで、audit は確定済みペアに新たな need を付与しない。flagged/audited はレポート・エンベロープ（`aggregateReviewResults`）で独立カウントし、flagged ユニットは hover と escalations 一覧に載せて可視化する。

**なぜ報告のみか**: audit は確定済みペアを毎回再スキャンするため、need:review を書き戻すと「意図的な単文乖離」を毎回蒸し返し、人間の承認（need:review 解除）を上書きする churn が起きる。マーカーは変えず、意図的乖離の説明は下記のユニット note で AI に伝える。

#### ユニット note（意図的乖離の説明・実装済み・ADR-260708-01）

ADR-260706-03 の既知の限界（意図的な単文乖離が audit のたびに flagged として再報告される）を解消する。**受理を決定論的に記録してスキップするのではなく、人間の説明（note）を AI へ渡して判定に織り込ませる**（audit は本質的に AI 判定なので）。

- **保存先は `unit-registry` に統合**（1ファイル）。エントリを `hash → { content, note? }` に拡張（行 `<hash> <encContent>[ <encNote>]`、旧2列と後方互換）。note は「hash キーのユニットメタ」。
- **同一性はユニットに追従**: content は content-addressed で不変（revise 用に旧 hash に残す）。note だけ、本文編集で hash が変わったとき **sync が旧→新 hash へ移送**する（`updateSectionHashes` が hash 差分を集め `migrateNotes` で付け替え。決定的・冪等・AI 不使用）。削除ユニットの note は GC（`retainOnly`）で消える。
- **編集 UI は CodeLens**「Note」（対訳ユニット）→ `showInputBox`。本文・マーカー・hash・from は不変。hover は registry から note を直接読んで表示。
- **レポート → note ジャンプ**: audit レポート（仮想ドキュメント）の flagged 行に「Add / edit note」CodeLens を出す（`AiReviewResultCodeLensProvider`）。クリックで該当ファイルの当該ユニットへスクロールし note 入力を開く（`mdait.unit.editNoteForUnit`）。レポート生成（`buildReviewReport`）が flagged 行の行番号アンカーを返す。
- **audit は note を verify プロンプトに `<humanNote>` として添える**（`PairVerifier`）。AI は note が説明する乖離を意図的とみなし match/audited を返す。**決定論的な抑止はしない**（毎回 AI を呼ぶ）。churn は「AI が note を見て flagged にしない」形で消える。
- **TM 連携は不変**: note は機械的な受理フラグではないため TM 登録可否（need ベース）に影響させない。

**残る限界**: audit は対象ペアに毎回 AI を呼ぶ（決定論的な短絡はしない）。コストが問題になれば将来 `(contentHash, noteHash)` での verdict キャッシュを検討する。`need:isolate`（[orphan-model.md](orphan-model.md)）は**章＝ユニット単位**の孤立で、この単文粒度とは別レイヤ。

### AI同期（合成コマンド）

**実装済み**（`mdait.aiSync.run` コマンド / `mdait_aiSync` ツール・ADR-260706-01）。`sync(adopt+align) → AIレビュー呼び出し → レポート` を束ねる薄いオーケストレーター（`executeAiSync`）:

- 各段は独立機能（冪等）のまま。採用・アライン・検証・マーカー変異のロジックは一切再実装せず、既存プリミティブ（`syncCommand({adopt,align})` / `executeAiReviewForFiles`）へ配線するだけ
- 合成側は **AI を使う3段を列挙した確認UIを冒頭に1回**出す（＋AIオンボーディング）。sync の align 段は内部でオンボーディングを再確認するが冪等
- 各段が冪等なので途中キャンセル→再実行で残りから再開できる。sync が undefined（設定不正等）なら `aborted` で安全に中断しレビューは行わない
- **取り込み専用ではない**: 管理済みサイトで実行するとアラインは no-op（全ユニット from アンカー済み）となりレビューだけが走る＝「サイトが色々ごちゃごちゃして大丈夫かな」の健全性監査ボタンとして同じ機能が使える
- **各段を注入可能**（`AiSyncStages`）にし、合成層のテストはスタブ各段で「順序・sync undefined フォールバック・段間キャンセル・dryRun 伝播・冪等 no-op」を検証する。AI に触れる段は各モジュールでスタブ AIService により検証済み
- スコープは v1 ではワークスペース全体のみ（sync 全体・レビュー全体の整合を優先。path スコープは将来課題）
- レポートは `mdait-ai-sync` スキームの仮想ドキュメント（sync サマリ→レビューサマリ→ファイル別レビュー表）。レビュー表は `generateReviewTableSection` を mdait_aiReview と共有
- エージェント側は `mdait_aiSync`（または `mdait_sync → mdait_aiReview → mdait_tm` の手動組み合わせ）で駆動する。プレイブック（docs/guide/ja/agent-playbook.md）参照

## テスト戦略

- 純関数（decideReviewAction / collectReviewPairs / validator）を単体テストの中心に置く
- pair-verifier / review-core はスタブ AIService（応答列を返す・呼び出しを記録）で検証
- 重点エッジケース: 冪等性（2回目無変更）、dryRun、途中キャンセルで完了分のみ書き込み、リトライ枯渇 → uncertain、autoApprove off、trans.maxUnitsPerRun 上限
- 構造ズレの実サンプルは `src/test/unit/sample-content/{ja,en}/40_structure_mismatch.md` を利用

## 制約・既知のリスク

- LLM の自己申告 confidence は校正されていない。自動承認は三重条件（match ∧ issues空 ∧ 閾値以上）＋レポート必須列挙で緩和する（ADR-260704-07）
- 誤承認 → tm.commit 昇格の経路は残る。TM 品質が最重要の運用では `autoApprove: false` でレポートのみ運用にできる
- ユニット単位の並列化は v1 では見送り（書き込みはファイル末尾1回のため将来安全に追加可能）
