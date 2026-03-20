# レビューレポート: TM normalize処理の一元化とtrigramキャッシュ

**レビュー日**: 2026-03-20  
**対象チケット**: [260320_TM_normalize一元化.md](260320_TM_normalize一元化.md)

---

## サマリ

**全体評価:** ⭐⭐⭐⭐ (4/5)  
**結論:** ✅承認  
**指摘件数:** 🔴[重大: 0](#重大) 🟠[優先: 0件](#優先) 🟡[推奨: 1件](#推奨) 🟢[任意: 2件](#任意)

**最重要論点:**  
設計仕様通りの正確な実装。`trigramCache` の構築・参照・クリアが一貫しており、normalize一元化も完全実施済み。`loadIfNeeded` でのファイル非存在時の `trigramCache.clear()` 漏れが軽微な一貫性問題として残るが、実動作への影響なし。

**変更:**
- [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts): `trigramCache` フィールド追加、`indexEntry`/`clear`/`rebuildTrigramIndex` 修正、`getTrigramCache()` 追加
- [src/core/tm/tm-ranker.ts](../../src/core/tm/tm-ranker.ts): `RankOptions.trigramCache` 追加、候補 trigram 取得にキャッシュ優先ロジック追加
- [src/commands/trans/trans-command.ts](../../src/commands/trans/trans-command.ts): `stripMarkdown` import/呼び出し削除、生テキスト渡し、`trigramCache` 渡し
- [src/core/tm/types.ts](../../src/core/tm/types.ts): `CurrentPrimaryUnit` 型復元（既存コンパイルエラー修正）
- `src/core/tm/translation-example-retrieval.ts`（削除）
- `src/core/tm/translation-memory-cleanup-service.ts`（削除）
- `src/test/core/tm/translation-memory-cleanup-service.test.ts`（削除）
- [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts): `getTrigramCache()` 動作確認テスト群追加
- [src/test/commands/trans/trans-tm-lookup.test.ts](../../src/test/commands/trans/trans-tm-lookup.test.ts): コメント更新（normalize内部化の注釈）

---

## 🟡推奨 (1件)

### `loadIfNeeded` でのファイル非存在時 trigramCache クリア漏れ

**場所:**
- [ ] [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L287)（`loadIfNeeded` の file 非存在パス）

**問題:**  
`loadIfNeeded` でファイルが存在しない場合、`index.clear()` と `trigramIndex.clear()` は呼んでいるが `trigramCache.clear()` が呼ばれていない。同一タイミングで追加した `trigramIndex.clear()` と対称性が欠けている。

```ts
// 現状 (src/core/tm/tmx-store.ts の loadIfNeeded 内)
if (!fs.existsSync(filePath)) {
    if (this.loadedFilePath !== filePath || this.index.size > 0) {
        this.index.clear();
        this.trigramIndex.clear();
        // ← this.trigramCache.clear() が抜けている
        this.loadedFilePath = filePath;
        this.loadedMtime = 0;
    }
    return;
}
```

**実害の有無:**  
`getEntryCount() === 0` チェック（`lookupTmReferences` 内の早期リターン）によってその後の `findCandidatesByTrigram` / `rankTmEntries` は呼ばれないため、stale な `trigramCache` が実際の検索に使われることはない。ただし、TMX ファイルが削除・再作成されるライフサイクルでキャッシュのみ残留し続け、メモリを無駄に消費する。

**提案:**  
`trigramIndex.clear()` の直後に `trigramCache.clear()` を追加。3メソッド（`clear()` / `rebuildTrigramIndex()` / `loadIfNeeded` の非存在パス）すべてで統一させることで保守性も向上する。

---

## 🟢任意 (2件)

### `trans-tm-lookup.test.ts` — テスト内容とファイル名の乖離

**場所:**
- [ ] [src/test/commands/trans/trans-tm-lookup.test.ts](../../src/test/commands/trans/trans-tm-lookup.test.ts#L1)

**問題:**  
ファイル名・スイート名は "TM検索の正規化ロジック" だが、テストの実体は `stripMarkdown` の動作確認と `lookupByHash` 経由の exact match テストであり、本タスクで変更された「生テキスト → `findCandidatesByTrigram` → `rankTmEntries`」のフローを直接検証していない。カバレッジ上の欠如は `tmx-store.test.ts` の新規テスト「Markdown含む生テキストを渡しても正規化後の候補がヒットする」で補完されているため機能上の問題はない。

**提案:**  
コメント更新は実施済みなので、次の機会（ファイル修正時）にスイート名を "lookupByHash 経由の exact match / normalize 正確性テスト" 等に修正するとファイル名との整合がとれる。今回は変更不要。

---

### `getTrigramCache` の ReadonlyMap テストコメントの正確性

**場所:**
- [ ] [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts#L558)

**問題:**  
テストコメントに「ReadonlyMap なので set() メソッドが存在しないことを型レベルで保証」とあるが、実行時には `as Map<...>` キャストで迂回可能。これは TypeScript の構造型による型安全性（コンパイル時のみ）であり、コメントが暗示する「実行時保護」ではない。テスト本体は正しく機能を検証できている。

**提案:**  
コメントを「型システム上 set() が公開されないためコンパイルエラーで誤用を防ぐ（実行時キャスト迂回は可能）」程度に言い直すと正確になる。今回は変更不要。

---

## 📊 全体整合性

### VS Code Language Server エラーについて

`get_errors` ツールが `src/commands/sync/sync-command.ts` の Line 20（`import { UnitRegistryManager }`）上に  
`Cannot find module '../../core/tm/tm-cleanup'` を報告している。  
ただしソース全ファイルを検索しても `tm-cleanup` への import は存在しない。

```
out/test/core/tm/tm-cleanup.test.js   ← 削除前のコンパイル済み出力が残留
out/core/tm/tm-cleanup.js             ← 同上
```

`out/` ディレクトリに stale なコンパイル済み出力が残っており、VS Code の TS Language Server がこれを拾っていると思われる。**`npx tsc --noEmit` でのクリーンビルドでエラーなし（チケット7. ✅）** と一致するため言語サーバーのアーティファクトと判断。`out/` のクリーン再ビルドで解消される見込み。

### ワークスペース全体の整合性

**Core (TM):** `trigramCache` の構築・参照・クリアが3箇所（`indexEntry`/`clear`/`rebuildTrigramIndex`）で一貫。`loadIfNeeded` のみ漏れあり（🟡推奨）。  
**UI/Commands:** `trans-command.ts` の `stripMarkdown` 依存が完全除去されており、Command層のnormalize依存がゼロになった。  
**Utility:** `tm-text-normalizer.ts` の実装自体は変更なし。仕様通り。  
**テスト:** `tmx-store.test.ts` に `getTrigramCache` スイートが追加され、構築・clear・load再構築・ReadonlyMap型の4ケースを網羅。`trans-tm-lookup.test.ts` は整合性コメントを更新済み。  
**設計書:** `docs/design/core.md` の TmxStore セクションと `rankTmEntries` セクションが trigramCache/getTrigramCache を正確に記述。更新済み。

### 後方互換性

- `RankOptions.trigramCache` は optional プロパティであり、既存テストへの影響ゼロ。  
- `findCandidatesByTrigram` のシグネチャ変更なし。呼び出し規約のみ変更（raw text 渡しへ）。  
- dead code（`translation-example-retrieval.ts`, `translation-memory-cleanup-service.ts`）は未参照かつコンパイルエラー状態だったため、削除による後方互換性への影響なし。

### セキュリティ

リファクタリング性質の変更のみ。外部入力の処理経路に変化なし。メモリキャッシュのスコープはプロセス内シングルトンに閉じており問題なし。

---

## 総評

仕様・設計の読み込みが丁寧で、trigramCache のフォワードインデックスとtrigramIndex の転置インデックスの役割分担が明快に実装されている。`ReadonlyMap<string, ReadonlySet<string>>` による型レベルの保護、フォールバックロジック（trigramCache 未設定時は従来ロジック）、dead code の適切な除去と `CurrentPrimaryUnit` 型ェラー修正まで、チケット仕様を漏れなく消化している。設計書の同期も完了済みで高品質。

`loadIfNeeded` の一貫性（🟡推奨）は今後の保守性のために対応を推奨するが、現行動作への影響はなく承認を妨げるものではない。
