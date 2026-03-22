## サマリ

**全体評価:** ⭐⭐⭐⭐⭐ (5/5)
**結論:** ✅承認
**指摘件数:** 🔴[重大: 0](#重大) 🟠[優先: 0件](#優先) 🟡[推奨: 2件](#推奨) 🟢[任意: 0件](#任意)
**最重要論点（1〜3行）:**
バグの根本原因（`trigramIndex` が `entry.primary` のみを対象にしており lang 別サブマップがなかった）を正確に修正。設計・実装・テストの整合性が取れており、前回レビュー指摘（`loadIfNeeded` の clear 漏れ・DRY 違反）も解消済み。差し戻し理由なし。

**変更:**
- [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts): `trigramIndex` を `Map<lang, Map<trigram, Set<tuid>>>` に変更・`indexEntry` が全 variants を lang 別索引化
- [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts): ja クエリ・en クエリで lang 別インデックスの分離を検証する2テストを追加

---

## 🟡推奨 (2件)

### ① `addEntry` マージ時の stale trigram が lang × variant 分だけ増大する点の設計注記

**場所:**
- [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L373)（`addEntry` → `this.indexEntry(normalizedEntry)`）

**問題:**
旧実装では stale trigram は `entry.primary` 1 本分しか増えなかった。lang 別インデックスになったことで、variant テキストが更新された場合に旧 trigram が「lang 数 × trigram 数」分だけ残留するようになる。`this.index.get(tuid)` が存在するため正確性は保たれるが（filter で除外）、大規模 TM を長期稼働させる場合にメモリ増大が顕在化しうる。

設計仕様 §5 に「stale trigram は許容」と明示されており、今回の修正でその判断が変わるわけではない。しかし lang 別化による変化量の増大については設計書への注記が望ましい。

**提案:**
`docs/design/core.md` の TmxStore 節または `260320_tm-scorer.md` §5 に以下を追記:

> `addEntry` でマージ時に variant テキストが変わると、旧 trigram が lang サブマップに残留する。エントリー数 × 言語数 × テキスト変化頻度に比例してメモリが積み上がるが、`filter` で検索精度への影響はない。超大規模 TM（10万件超）の長期稼働では定期的な `clear + reload` を推奨。

---

### ② `addEntry` で新しい lang variant を追加する際のインクリメンタル更新を検証するテスト

**場所:**
- [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts#L371)（`TmxStore.findCandidatesByTrigram` スイート）

**問題:**
「addEntry 後にインデックスが更新される」テストは en 単言語の追加のみを検証している。既存 `{en}` エントリーに `{en, ja}` を addEntry した場合、ja のインデックスが正しく追加されるシナリオが未テスト。今回のバグ修正（lang 別追加）において、インクリメンタル更新パスが正しく動作することを確認するために有用。

**提案テスト例:**
```typescript
test("addEntry で新しい lang variant を追加するとその lang のインデックスが更新される", () => {
    // en-only エントリーを登録
    store.addEntry(
        createTestEntry({
            tuid: "e1",
            primary: "Hello world test sentence",
            variants: new Map([["en", { text: "Hello world test sentence" }]]),
        }),
    );
    // 最初は ja インデックスにない
    const before = store.findCandidatesByTrigram("こんにちは世界テスト文", "ja");
    assert.strictEqual(before.length, 0);

    // ja variant を追加してマージ
    store.addEntry(
        createTestEntry({
            tuid: "e1",
            primary: "Hello world test sentence",
            variants: new Map([
                ["en", { text: "Hello world test sentence" }],
                ["ja", { text: "こんにちは世界テスト文" }],
            ]),
        }),
    );

    // ja インデックスにヒットするようになる
    const after = store.findCandidatesByTrigram("こんにちは世界テスト文", "ja");
    assert.ok(after.some((e) => e.tuid === "e1"));
});
```

---

## 📊 全体整合性

### ワークスペース全体の整合性

**Core（trigram インデックス）:**
- `trigramIndex` の型変更（`Map<string, Set<string>>` → `Map<string, Map<string, Set<string>>>`）は `rebuildTrigramIndex` / `indexEntry` / `findCandidatesByTrigram` / `clear` / `loadIfNeeded` の全更新箇所に漏れなく反映されている ✅
- `indexEntry` が `normalizeForTm(variant.text)` を使って variant テキストを正規化しており、`findCandidatesByTrigram` 側も同じ `normalizeForTm` を使用—インデックス構築とクエリ処理の正規化が一致 ✅
- `addEntry` マージ処理（既存エントリー更新）の後に `indexEntry(normalizedEntry)` が呼ばれ、インクリメンタル更新も lang 別に機能する ✅
- `loadIfNeeded` の `!fs.existsSync` ブランチで `trigramIndex.clear()` が追加済み（前回レビュー ① 解消）✅

**既存 API の後方互換性:**
- `lookupByHash` / `lookupBatch` / `searchBySource` / `getEntriesByUnitPath` / `getExistingTmEntries` は変更なし ✅

**テスト:**
- 「ja クエリで ja variant を検索できる」でバグ修正の核心（lang 別ヒット）を検証 ✅
- 「en クエリで ja テキストを検索しても en インデックスにないのでヒットしない」でネガティブケース（lang 分離）を検証 ✅
- `clear()` / `addEntry` 後更新 / `load()` でのインデックス構築 / lang フィルタ / limit が引き続きカバーされている ✅
- 推奨②の cross-lang インクリメンタル更新テストが未追加（差し戻し理由には至らない）

**設計書（docs/design/core.md）:**
- `normalizeForTm` の説明が core.md の TmTextNormalizer 節に追記済み（前回レビュー ② 解消の一部）✅
- `trigramIndex` の型が `Map<trigram, Set<tuid>>` から lang 別構造に変わった旨は設計書には未反映 → **本レビューで更新推奨**

### バグ修正の正確性評価

| 観点 | 評価 |
|------|------|
| 根本原因の解消 | `entry.primary` のみ → 全 variants lang 別に変更。バグの直接原因を修正 ✅ |
| エッジケース: variant がない TU | `indexEntry` の for ループが実行されない → 問題なし ✅ |
| エッジケース: variant.text が空 | `computeTrigrams("")` = 空集合 → ループスキップ → 問題なし ✅ |
| メモリ影響 | lang 数倍に増加するが 2〜4 言語程度では許容範囲。拡張型注記を推奨（🟡①）|
| テストの lang 別分離検証 | ja ヒット・en 非ヒットの両方を1テストで検証。適切 ✅ |

### 後方互換性

既存の TM 参照・保存パイプラインに破壊的変更なし。`findCandidatesByTrigram` の引数シグネチャ変更なし。✅

### セキュリティ

外部テキスト入力は `normalizeForTm` → `computeTrigrams` で処理され、コード実行・ファイル書き込みには関与しない。OWASP Top 10 観点で問題なし ✅

---

## 総評

バグの特定（lang 別インデックスの欠如）は正確であり、修正方針（`Map<lang, Map<trigram, Set<tuid>>>` への変更）もシンプルで最小限。`indexEntry` が variant の全 lang をループしてインデックスする実装は読みやすく、意図が明確。テストも ja/en の分離という本質を直接検証している。

前回レビューで指摘した ① `loadIfNeeded` の `trigramIndex.clear()` 漏れ および ② `normalizeForTm` DRY 違反 がいずれも解消されており、本バグ修正とまとめてコードベースの品質が向上している。

🟡 推奨事項（設計注記の追加・cross-lang テストの追加）は改善価値はあるが、差し戻し理由には至らない。現状の修正は本番投入に支障はない。
