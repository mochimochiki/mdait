# E2E テストパターンカタログ

機能実装・修正後に、変更に応じた適切なE2Eシナリオを**その場で組み立てて実行する**ためのパターン集。
全パターンを毎回実行するのではなく、今回の変更に効くパターンを選んで組み合わせる。

## 使い方

1. 実装した変更の影響範囲を特定する
2. 下記マッチングガイドで該当パターンを選ぶ
3. パターンの手順テンプレートを参考に、具体的なファイルパスやアサーション値を埋めて実行する
4. 結果を `result.json` の `status` + `structuredLogs` で検証する

**前提**: SKILL.mdの「前提条件」「IPC プロトコル」「実行手順」に従うこと。

### コスト原則

- **対象ファイルは最大2ファイル**。全ファイル翻訳はLLMコストに見合わない
- ファイル数より**フローの複雑さとパターンの網羅**にフォーカスする
- 例: 1ファイルで基本翻訳（P2）、別の1ファイルでTM参照効果（P6）を確認

---

## マッチングガイド: 変更内容 → テストパターン

| 変更した領域 | 推奨パターン |
|-------------|-------------|
| sync関連（マーカー、ハッシュ、level、diff検出） | P1, P4 |
| trans関連（翻訳ロジック、プロンプト、出力処理） | P2, P4, P5 |
| patchMode関連（差分翻訳、パッチ適用） | P4, P5 |
| TM関連（commit、検索、参照、フォーマット） | P3, P6 |
| term関連（検出、展開、用語集） | P7 |
| エラーハンドリング、バリデーション | P8 |
| 複数機能にまたがる変更、リファクタ | P9 |
| UI関連（通知、進捗、キャンセル） | P10 |
| エージェント・オーケストレーション（adopt/独立ユニット/isolate、LM Tools、並列翻訳） | P11, P12 |

---

## パターン一覧

### P1: sync基本動作

**いつ使う**: sync処理、マーカー挿入、ハッシュ計算、ファイルペア検出に変更があったとき

**手順**:
1. `npm run copy-test-files` でリセット
2. sync実行: `{"id":"p1","command":"mdait.sync","args":[]}`

**アサーション**:
- `result.status === "done"`
- `result.result.totalFileCount > 0`
- `result.result.successCount > 0`
- ターゲットファイル（en側）に`<!-- md:hash:`マーカーが挿入されている
- `structuredLogs`に`scope:"sync"`のログが存在

---

### P2: trans基本翻訳

**いつ使う**: 翻訳ロジック、プロンプト生成、出力サニタイズに変更があったとき

**前提**: P1完了後（syncでマーカー付与済み）

**手順**:
1. ターゲットファイル（en側）から`need:translate`マーカーを含むファイルを特定
2. ファイル翻訳: `{"id":"p2","command":"mdait.translate.file","args":["<ターゲット絶対パス>"]}`

**アサーション**:
- `result.status === "done"`
- `result.result` がnullでない（`TransCommandResult`が返る）
- `result.result.translatedCount > 0`
- ターゲットファイルの`need:translate`マーカーが除去されている
- ターゲットファイルに翻訳テキストが書き込まれている

---

### P3: tm.commit

**いつ使う**: TM登録、TMXフォーマット、TMエントリ生成に変更があったとき

**前提**: P2完了後（翻訳済みファイルが存在）

**手順**:
1. TMコミット: `{"id":"p3","command":"mdait.tm.commit.file","args":["<ソース絶対パス>"]}`

**アサーション**:
- `result.status === "done"`
- `result.result.committed > 0`
- `.mdait/translations.tmx`にエントリが追加されている

---

### P4: 改訂フロー（原文変更 → re-sync → revise）

**いつ使う**: patchMode、差分検出、revision判定、`need:revise`マーカー処理に変更があったとき

**前提**: P3完了後（翻訳+TM登録済み）

**手順**:
1. ソースファイル（ja側）のテキストを一部変更
2. re-sync: `{"id":"p4s","command":"mdait.sync","args":[]}`
3. result確認
4. re-trans: `{"id":"p4t","command":"mdait.translate.file","args":["<ターゲット絶対パス>"]}`

**アサーション**:
- Step 2: `result.result.revisionsNeeded >= 1`
- Step 2: ターゲットファイルに`need:revise@{hash}`マーカーが存在
- Step 4: `structuredLogs`に`patchMode: true`を含むログ
- Step 4: 変更箇所のみ更新、非変更箇所は元の翻訳を維持

---

### P5: 手修正保全

**いつ使う**: patchModeフォールバック、確認ダイアログ、既存翻訳の保護に変更があったとき

**前提**: P2完了後（翻訳済み）

**手順**:
1. ターゲットファイルの翻訳済みテキストに手修正を追加（例: `(HAND-EDITED)`を追記）
2. ソースファイルの対応するセクションを変更
3. sync: `{"id":"p5s","command":"mdait.sync","args":[]}`
4. trans: `{"id":"p5t","command":"mdait.translate.file","args":["<ターゲット絶対パス>"]}`

**アサーション**:
- Step 3: 手修正テキストがsync後も残っている
- Step 4: `patchMode: true`であれば手修正が保持される
- Step 4: patchMode失敗時は確認ダイアログ相当のログ

---

### P6: TM参照効果

**いつ使う**: TM検索、TM参照フォーマット、TM参照のプロンプト注入に変更があったとき

**前提**: P3完了後（TMにエントリ登録済み）

**手順**:
1. TM登録したファイルとは**別の**ターゲットファイルを翻訳
2. `{"id":"p6","command":"mdait.translate.file","args":["<別のターゲット絶対パス>"]}`

**アサーション**:
- `structuredLogs`に`"TM references found"`を含むログ
- `result.result.tmHits > 0`

---

### P7: term.detect + expand

**いつ使う**: 用語検出、用語展開、用語集ファイル操作に変更があったとき

**前提**: P1完了後（syncでマーカー付与済み）

**手順**:
1. `{"id":"p7d","command":"mdait.term.detect.file","args":["<ソース絶対パス>"]}`
2. `{"id":"p7e","command":"mdait.term.expand.file","args":["<ソース絶対パス>"]}`

**アサーション**:
- 各ステップで`result.status === "done"`
- `.mdait/terms.json`（またはterms.yaml/csv）にエントリが追加されている

---

### P8: エラーリカバリ

**いつ使う**: エラーハンドリング、入力バリデーション、エラーメッセージに変更があったとき

**手順**:
1. 存在しないパス: `{"id":"p8","command":"mdait.trans","args":["C:\\nonexistent\\file.md"]}`

**アサーション**:
- `result.status === "error"`
- `result.error`にファイル関連のエラーメッセージ

---

### P9: 全体統合フロー

**いつ使う**: 複数機能にまたがるリファクタ、依存関係の変更、大規模な構造変更時

**手順**:
1. `npm run copy-test-files` でリセット
2. sync
3. ファイルAをtrans → tm.commit
4. ファイルAのソースを変更 → re-sync → re-trans（patchMode確認）
5. ファイルBをtrans（TM参照効果の確認）

**アサーション**:
- 各ステップの`result.status === "done"`
- Step 4でre-transが`patchMode: true`で成功
- Step 5で`tmHits > 0`（ファイルAのTMがファイルBに参照された）

> P1→P2→P3→P4→P6を**2ファイルで**連続実行するのと同等。

---

### P10: キャンセル動作

**いつ使う**: 進捗表示、キャンセル処理、中断時のファイル保全に変更があったとき

**手順**:
1. ディレクトリ翻訳を開始: `{"id":"p10","command":"mdait.translate.directory","args":["<ディレクトリパス>"]}`
2. 実行中にExtension Host側でキャンセル

**アサーション**:
- 翻訳済みファイルは正常に保存されている
- 未翻訳ファイルのマーカーが壊れていない

> IPC経由でのキャンセルは困難なため、手動テスト併用。

---

## 組み合わせの例


### P11: S1 新規翻訳オーケストレーション（ひとこと依頼→完成状態）

**いつ使う**: エージェント・オーケストレーション関連（LM Toolsのdata形式、needフラグ経路、並列翻訳）に変更があったとき。
[agent-orchestration.md](../../../docs/design/agent-orchestration.md) の「完成状態の定義」をそのまま判定条件に使う。

**手順**:
1. `npm run copy-test-files` でリセット
2. sync: `{"id":"p11-1","command":"mdait.sync","args":[]}`
3. ディレクトリ翻訳（並列実行の確認を兼ねる）: `{"id":"p11-2","command":"mdait.translate.directory","args":["<workspace>/en"]}`
4. 用語検出: `{"id":"p11-3","command":"mdait.term.detect.directory","args":["<workspace>/ja"]}`
5. 用語展開: `{"id":"p11-4","command":"mdait.term.expand.directory","args":["<workspace>/en"]}`
6. TMコミット: `{"id":"p11-5","command":"mdait.tm.commit.directory","args":["<workspace>/en"]}`
7. 再sync（定常状態確認）: `{"id":"p11-6","command":"mdait.sync","args":[]}`

**アサーション（完成状態の定義に対応）**:
- 手順7の `result.result.totalAdded === 0 && totalModified === 0 && totalDeleted === 0 && revisionsNeeded === 0`（条件5: 冪等な定常状態）
- en側全ファイルのマーカーに `need:` が残っていない（条件1。`need:isolate` は除外）
- 手順4-5 を再実行して新規用語0件・手順6を再実行して新規TU0件（条件3・4）
- 手順3の `structuredLogs` で複数ファイルの翻訳開始が交互に出ている（並列実行の確認。trans.concurrency >= 2 のとき）

---

### P12: S2 既存対訳の取り込みオーケストレーション（adopt→知識構築→翻訳）

**いつ使う**: adopt / 孤立ユニットモデル（独立ユニット・need:isolate・一次受け）/ 取り込みフローに変更があったとき

**準備**: `40_structure_mismatch.md`（ja/en両方に存在・マーカーなし・構造ズレあり）がテストワークスペースにあることを確認。en側の既訳本文のスナップショットを取っておく。

**手順**:
1. `npm run copy-test-files` でリセット
2. adopt sync: `{"id":"p12-1","command":"mdait.sync","args":[{"adopt":true}]}`
3. en側 `40_structure_mismatch.md` を確認
4. 「English-only Notice」ユニットの `need:review` を除去して素 hash 化（独立ユニット宣言）、対応ペアの `need:review` も除去（レビュー承認相当）して再sync: `{"id":"p12-2","command":"mdait.sync","args":[]}`
5. TMコミット: `{"id":"p12-3","command":"mdait.tm.commit.directory","args":["<workspace>/en"]}`
6. 残りの翻訳: `{"id":"p12-4","command":"mdait.translate.directory","args":["<workspace>/en"]}`
7. 再sync（定常状態確認）: `{"id":"p12-5","command":"mdait.sync","args":[]}`

**アサーション**:
- 手順2後: 既訳ユニットの本文が**1文字も変わっていない**（スナップショット比較）。対応ペアに `from` + `need:review` が付く。`result.result.totalAdopted > 0`
- 手順2後: 「日本語のみのセクション」に対応するen側ユニットに `need:translate` が付く
- 手順2後: 「English-only Notice」ユニット（マーカーなしの訳文側独自章）が**削除されず** `need:review`（`from` なし）で一次受けされる（`totalOrphanReviewed > 0`）
- 手順4後: 素 hash 化した独立ユニットが以後の sync で不変（パススルー・`kept` 集計。対応付けにも使われない）
- 手順5: `result.result.newEntries > 0`（既訳がTM登録される）。手順4より前に実行すると `need:review` スキップ、独立ユニットは `noFrom` スキップになることも確認できる
- 手順7: added/modified/deleted/revisionsNeeded/adopted すべて 0（冪等な定常状態）

**isolate 検証（追加）**: ja側の任意ユニットに `need:isolate` を付けて再sync → en側に対応 target が生成されない（既存ペアがある場合は ja本文を変更しても en側に `need:revise` が付かず、hash/from のみ更新される＝凍結）。

---

### sync改修の場合
```
P1（基本動作確認） → P4（改訂フロー確認）
```

### patchMode改修の場合
```
P1 → P2 → P4（差分翻訳確認） → P5（手修正保全確認）
```

### TM機能改修の場合
```
P1 → P2 → P3（TM登録確認） → P6（TM参照効果確認）
```

### 全面リファクタの場合
```
P9（全体統合フロー一気通貫）
```

### エージェント・オーケストレーション改修の場合
```
P11（S1: 新規翻訳の完成状態） → P12（S2: adopt取り込みの完成状態）
```
