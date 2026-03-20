# コードレビュー: tm-commit hashスキップ最適化

**レビュー日:** 2026-03-20  
**対象チケット:** [260320_tm-commit-hash-skip.md](260320_tm-commit-hash-skip.md)  
**レビュアー:** m.reviewer

---

## サマリ

**全体評価:** ⭐⭐⭐⭐ (4/5)  
**結論:** ✅承認（設計書更新を伴う）  
**指摘件数:** 🔴[重大: 0件](#重大) 🟠[優先: 0件](#優先) 🟡[推奨: 2件](#推奨) 🟢[任意: 2件](#任意)

**最重要論点:**  
旧実装の廃止理由（localハッシュ未検証問題）は確実に解消されており、スキップ条件・テストカバレッジともに仕様通り。設計書の「検討した代替案」が旧情報のままで「hash スキップは廃止」と記述されており実装と乖離していたため、本レビューにて更新済み。

**変更:**
- [src/commands/tm/commit-processor.ts](../src/commands/tm/commit-processor.ts): `canSkipUnit()` メソッド追加、`processUnit()` 内でのスキップ判定組み込み
- [src/test/commands/tm/commit-processor.test.ts](../src/test/commands/tm/commit-processor.test.ts): `canSkipUnit — hashベーススキップ` スイート追加（5ケース）

---

## 🔴重大 (0件)

---

## 🟠優先 (0件)

---

## 🟡推奨

### 1. 設計書の「検討した代替案」が実装と乖離していた

**場所:**
- [x] [docs/design/command_tm.md — 検討した代替案](../docs/design/command_tm.md#L120)
- [x] [docs/design/command_tm.md — 実行時の流れ](../docs/design/command_tm.md#L110)
- [x] [docs/design/command_tm.md — シーケンス図](../docs/design/command_tm.md#L130)

**問題:**  
「検討した代替案」に「hash スキップ（旧実装）…現在は必ず ExistingTmEntries を照合」と記載されていたが、今回の実装でより安全な dual-hash スキップが再導入された。シーケンス図にも `canSkipUnit()` が未記載だった。

**対応:** 本レビューにて設計書を更新済み。「実行時の流れ」に `canSkipUnit()` ステップを追加、「検討した代替案」の記述を実態に合わせて修正、シーケンス図に `canSkipUnit()` 分岐を追加した。

---

### 2. `canSkipUnit()` がストアへの二重参照を強いられる設計

**場所:**
- [ ] [src/commands/tm/commit-processor.ts — canSkipUnit()](../src/commands/tm/commit-processor.ts#L219)
- [ ] [src/core/tm/types.ts](../src/core/tm/types.ts#L29)

**問題:**  
`filterRelevantEntries()` 内でストアから取得したエントリの `unitHash` は `ExistingTmEntriesItem` に保持されない。そのため `canSkipUnit()` では 同エントリを `store.findByTuid()` で再参照している。インメモリ操作なのでパフォーマンス影響は軽微だが、設計上の冗長性がある。

**提案:**  
`ExistingTmEntriesItem` に `primaryUnitHash?: string` / `localUnitHash?: string` を追加し、`filterRelevantEntries()` がそれらを埋めれば、`canSkipUnit()` でのストア参照が不要になる。ただし `ExistingTmEntries` は LLM プロンプトコンテキストとしても使われるため、インターフェース変更の影響範囲を慎重に評価すること。現時点では必須対応ではない。

---

## 🟢任意

### 1. hash-skip ユニットの集計区分がログ上見えない

**場所:**
- [ ] [src/commands/tm/command-commit.ts](../src/commands/tm/command-commit.ts#L281)

**問題:**  
`canSkipUnit()` でスキップされたユニットも呼び出し元では `result.processedUnits++` に計上される。ログでは「LLMを呼ばずにスキップされたユニット数」が `processedUnits` に混入する。debug ログは出力されているので実害はないが、統計の透明性が低い。

**提案:** `TmCommitResult` に `hashSkippedUnits: number` フィールドを追加するか、`processUnit()` の戻り値に `wasHashSkipped: boolean` を加えて呼び出し元が区別できるようにする。任意対応。

---

### 2. スキップ時テストのアサーション不足（微小）

**場所:**
- [ ] [src/test/commands/tm/commit-processor.test.ts](../src/test/commands/tm/commit-processor.test.ts#L341)

**問題:**  
正常スキップテストで `result.newCount === 0`、`result.existingCount === 0` を検証しているが、`result.skippedCount === 0` と `result.warnedCount === 0` の検証がない。実装上 `{skippedCount: 0, warnedCount: 0}` が返ることは保証されているため実害はなく、任意対応。

---

## 📊 全体整合性

### ワークスペース全体の整合性

**Core:** `TmVariant.unitHash` がオプショナル（`?`）であることを踏まえた実装。`undefined === "hash-xxx"` が `false` になる TypeScript 型の性質を正しく活用しており、旧来エントリ（unitHash未記録）でも安全にスキップ回避される。  
**UI:** 変更なし  
**Utility:** 変更なし  
**テスト:** 仕様要件の5ケース（正常スキップ・初回コミット・primary変化・local変化・部分変化）が揃っており、境界条件の網羅性は十分。  
**設計書:** 本レビューで更新対応済み。

### 後方互換性

`processUnit()` のシグネチャ・戻り値型に変更なし。スキップ時の戻り値 `{newCount:0, existingCount:0, skippedCount:0, warnedCount:0}` は従来の「0件処理」と同じ構造であり、呼び出し元の既存ロジックへの影響なし。

### セキュリティ

問題なし。スキップ判定はインメモリ比較のみで、外部入力のエスケープ・バリデーション要件はない。

---

## 総評

旧実装の根本的な問題（primary unitHash のみ比較でローカル変更を見落とす）に対し、`every(entry => primary.hash一致 && local.hash一致)` という明快な条件で解決されている。実装コードはシンプルで意図が明確であり、テストの構造（suite + 5ケース）も読みやすい。特に「複数エントリのうち1件でも不一致」ケースのテストは、`filterRelevantEntries` との連携動作を正しく検証できている。

設計書との乖離は本レビューで解消した。推奨事項（ストア二重参照）は技術的負債として記録しておく価値はあるが、即時対応の必要性は低い。
