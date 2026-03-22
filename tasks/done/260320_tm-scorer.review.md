## サマリ

**全体評価:** ⭐⭐⭐⭐ (4/5)
**結論:** ⚠️条件付き承認
**指摘件数:** 🔴[重大: 0](#重大) 🟠[優先: 2件](#優先) 🟡[推奨: 2件](#推奨) 🟢[任意: 1件](#任意)
**最重要論点:**
シングルトン `TmxStore` で TMX ファイルが消えた際に `trigramIndex` がクリアされない状態不整合バグがある（機能的には filter で回避されるが、メモリリーク起因のパフォーマンス劣化につながる）。また、設計仕様 §4.2 で一元化が明示されていた正規化パイプラインが `TmxStore` と `tm-ranker` で重複実装されており、将来の乖離リスクがある。アルゴリズム実装・テスト・後方互換性・セキュリティは概ね良好。

**変更:**
- [src/core/tm/tm-text-normalizer.ts](../../src/core/tm/tm-text-normalizer.ts): `computeTrigrams` 関数追加
- [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts): `trigramIndex` フィールド・インデックス構築・`findCandidatesByTrigram` 追加
- [src/core/tm/tm-ranker.ts](../../src/core/tm/tm-ranker.ts): 新規（MMR スコアリングエンジン）
- [src/commands/trans/trans-command.ts](../../src/commands/trans/trans-command.ts): `lookupTmReferences` を trigram+MMR パイプラインに差し替え
- [src/test/core/tm/tm-ranker.test.ts](../../src/test/core/tm/tm-ranker.test.ts): 新規テスト
- [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts): trigram インデックス関連テスト追加
- [docs/design/core.md](../../docs/design/core.md): 設計書更新（本レビューで実施）

---

## 🟠優先 (2件) {#優先}

### ①`loadIfNeeded()` でファイルが消えた際に `trigramIndex` が未クリア

**場所:**
- [ ] [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L268)（`loadIfNeeded` の `!fs.existsSync` ブランチ）

**問題:**
```typescript
private loadIfNeeded(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        if (this.loadedFilePath !== filePath || this.index.size > 0) {
            this.index.clear();          // ← trigramIndex.clear() が漏れている
            this.loadedFilePath = filePath;
            this.loadedMtime = 0;
        }
        return;
    }
```

`load()` や `clear()` は両インデックスをセットで操作するが、`loadIfNeeded` の「ファイルなし」パスだけが `this.index.clear()` のみで `this.trigramIndex.clear()` を呼ばない。ファイルが削除された後に `findCandidatesByTrigram` を呼ぶと、存在しない tuid を指す stale エントリが trigramIndex に大量に残り、`index.get(tuid) → undefined` の filter で吸収はされるが、O(N_trigrams) のループ全体が空振りする。大規模 TM ではメモリリーク・CPU 無駄につながる。

`clear()` との対称性が崩れているため、状態不変条件（`index.size == 0 ↔ trigramIndex.size == 0`）が保証されていない。

**提案:**
```typescript
if (!fs.existsSync(filePath)) {
    if (this.loadedFilePath !== filePath || this.index.size > 0) {
        this.index.clear();
        this.trigramIndex.clear();   // ← 追加
        this.loadedFilePath = filePath;
        this.loadedMtime = 0;
    }
    return;
}
```

---

### ② 正規化パイプラインの DRY 違反（`normalizeForTrigram` vs `normalizeForRanking`）

**場所:**
- [ ] [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L600)（`private static normalizeForTrigram`）
- [ ] [src/core/tm/tm-ranker.ts](../../src/core/tm/tm-ranker.ts#L36)（`function normalizeForRanking`）

**問題:**
チケット §4.2 は「正規化パイプライン（`stripMarkdown + toLowerCase + trim`）を `tm-text-normalizer.ts` に集約し、インデックス構築時とスコアリング時で同一ロジックを保証する」と明示していた。しかし実装では同一処理（`stripMarkdown(text).toLowerCase().trim()`）が 2 箇所に別名で存在する:

```typescript
// tmx-store.ts
private static normalizeForTrigram(text: string): string {
    return stripMarkdown(text).toLowerCase().trim();
}

// tm-ranker.ts
function normalizeForRanking(text: string): string {
    return stripMarkdown(text).toLowerCase().trim();
}
```

一方に空白正規化（`.replace(/\s+/g, ' ')`）などの改善が入った際、他方が追随しないと **インデックス構築時とスコアリング時の trigram が一致しなくなる**。これは Jaccard 計算の精度劣化や再現率低下を招く致命的な乖離につながりうる。

**提案:**
`computeTrigrams` と同様に `tm-text-normalizer.ts` に `normalizeForTm` を export し、両モジュールが import して使用する:

```typescript
// tm-text-normalizer.ts に追加
/**
 * TM trigram インデックス・スコアリング用のテキスト正規化。
 * stripMarkdown + toLowerCase + trim。
 * TmxStore（インデックス構築）と tm-ranker（スコアリング）で共有すること。
 */
export function normalizeForTm(text: string): string {
    return stripMarkdown(text).toLowerCase().trim();
}
```

---

## 🟡推奨 (2件) {#推奨}

### ③ `lookupTmReferences` での二重正規化

**場所:**
- [ ] [src/commands/trans/trans-command.ts](../../src/commands/trans/trans-command.ts#L963)（`lookupTmReferences`）

**問題:**
```typescript
const strippedContent = stripMarkdown(sourceContent);   // ← 1回目
const candidates = store.findCandidatesByTrigram(strippedContent, ...);
//     ↑ findCandidatesByTrigram 内で normalizeForTrigram → stripMarkdown 2回目
const ranked = rankTmEntries(strippedContent, ...);
//     ↑ rankTmEntries 内で normalizeForRanking → stripMarkdown 3回目
```

`strippedContent` を生成してから渡しているが、各関数が内部で再度 `stripMarkdown` を適用するため、Markdown 除去が最大 3 回発生する。`stripMarkdown` は markdown-it による DOM ツリー構築を伴うため、計算コストが高い。現状 `stripMarkdown` は冪等なので正確性への影響はないが、設計の意図（各関数は raw テキストを受け取って内部正規化する）と呼び出し側の前処理が噛み合っていない。

**提案:**
シーケンス図のコメント「`normalize(primary) の trigram で〜`」に合わせて、`lookupTmReferences` 側の `stripMarkdown` 事前処理を削除、または逆に各関数が正規化済みテキストを受け取る旨を明示（API コメントに「正規化済みテキストを渡すこと」と記載）。

---

### ④ テスト未カバー：ファイル消滅後の `findCandidatesByTrigram`

**場所:**
- [ ] [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts#L370)（`TmxStore.findCandidatesByTrigram` スイート）

**問題:**
上記①の stale trigram 問題が最も顕在化するシナリオ（ロード後にファイルが消えた TmxStore でシングルトン再 `getInstance`）がテストされていない。バグの信頼性保証の意味でも、修正と同時にテストを追加することを推奨する。

**提案テスト例:**
```typescript
test("ファイル消滅後に getInstance するとインデックスがリセットされる", () => {
    // ARRANGE: ロード → ファイル削除 → 再 getInstance
    store.addEntry(createTestEntry({ tuid: "e1", primary: "Hello world test" }));
    // (シングルトン経由のロードをシミュレート)
    // ACT: ファイルなし状態で findCandidatesByTrigram
    store.clear();  // ← 直接テストする場合
    const result = store.findCandidatesByTrigram("Hello world test", "en");
    assert.strictEqual(result.length, 0);
});
```

---

## 🟢任意 (1件) {#任意}

### ⑤ MMR ループ内の `Math.max(...array)` スプレッド

**場所:**
- [ ] [src/core/tm/tm-ranker.ts](../../src/core/tm/tm-ranker.ts#L108)

**問題:**
```typescript
const maxSimToSelected = Math.max(...selected.map((s) => jaccard(s.trigrams, c.trigrams)));
```

`selected.map(...)` で中間配列を毎イテレーション生成し、スプレッドで `Math.max` に渡している。`topK` が小さい（デフォルト 5）ため現実的な問題は起きないが、可読性・GC プレッシャーの観点から `reduce` や明示ループが GC チャーンを抑える。

```typescript
// 例: reduce を使った改善
const maxSimToSelected = selected.reduce(
    (max, s) => Math.max(max, jaccard(s.trigrams, c.trigrams)),
    0,
);
```

---

## 📊 全体整合性

### ワークスペース全体の整合性

**Core（TM モジュール）:**
- `lookupByHash` / `lookupBatch` / `searchBySource` / `getEntriesByUnitPath` — 変更なし、後方互換性維持 ✅
- `trigramIndex` の状態管理が `clear()` と `load()` では正しいが `loadIfNeeded` の片側パスで欠落（①で指摘）

**Commands（trans）:**
- `lookupTmReferences` の新パイプライン実装はシーケンス図と一致 ✅
- `calculateHash` import は `line:472` の別用途で必要なため維持されており正しい ✅
- `SentenceSplitter` は不要になったため import が削除されていることを確認 ✅

**Utility（`tm-text-normalizer.ts`）:**
- `computeTrigrams` の実装（`[...text]` スプレッドによるサロゲート対応）は仕様通り ✅
- `computeTrigrams` が `TmxStore` / `tm-ranker` 両方から import されている ✅
- ただし正規化関数自体が export されておらず DRY 違反（②で指摘）

**テスト:**
- `tm-ranker.test.ts`: lambda=1.0 純粋類似度順・MMR 多様性・エッジケースをカバー ✅
- `tmx-store.test.ts`: `findCandidatesByTrigram` 基本動作・addEntry 後更新・load 構築・clear をカバー ✅
- ファイル消滅シナリオが未テスト（④で指摘）

**設計書:**
- `docs/design/core.md` に `TmxStore` trigram インデックスと `rankTmEntries` が既に記載済み ✅
- `computeTrigrams` が `TmTextNormalizer` 節に未記載 → **本レビューで更新済み**

### 後方互換性

既存の `lookupByHash` / `lookupBatch` / `searchBySource` / `getEntriesByUnitPath` / `getExistingTmEntries` は変更なく後方互換性は維持されている。

### セキュリティ

- 外部入力（翻訳テキスト）は `stripMarkdown` による正規化を経て trigram 変換のみに使用され、コード実行・ファイル書き込みには一切関与しない ✅
- trigram は固定長 3 文字の substring 生成のみであり、injection リスクは存在しない ✅
- OWASP Top 10 観点で問題なし ✅

---

## 総評

`tm-ranker.ts` の MMR 実装は仕様に忠実で、`lambda=1.0` 時の純粋類似度順保証・MMR greedy ループ・型定義の全てがチケット仕様と一致している。trigram インデックスの構築・インクリメンタル更新・取得パイプラインも概ね正しく設計されており、テストカバレッジも品質要件チェックリストをほぼカバーしている。

**条件付き承認とする理由は以下 2 点**:
1. `loadIfNeeded` の `trigramIndex.clear()` 欠落（①）は 1 行修正で解消可能な明確なバグ
2. 正規化 DRY 違反（②）は設計仕様の明示的な要件が守られていない箇所であり、将来の trigram 精度乖離リスクがある

いずれも小規模な修正で解消できるため、修正後の再レビューは不要（差分確認で承認可能）。

---

## 🔄 差分確認（2026-03-20）

### 確認①：`loadIfNeeded` の `trigramIndex.clear()` 追加

**確認結果: ✅ 修正済み**

[src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L289)（`loadIfNeeded` の `!fs.existsSync` ブランチ）において、`this.index.clear()` の直後に `this.trigramIndex.clear()` が追加されていることを確認:

```typescript
private loadIfNeeded(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        if (this.loadedFilePath !== filePath || this.index.size > 0) {
            this.index.clear();
            this.trigramIndex.clear();   // ← 追加済み
            this.loadedFilePath = filePath;
            this.loadedMtime = 0;
        }
        return;
    }
    // ...
}
```

`index` と `trigramIndex` の整合性（`index.size == 0 ↔ trigramIndex.size == 0`）が `loadIfNeeded` の全パスで保証された。

---

### 確認②：正規化関数の `normalizeForTm` への統一

**確認結果: ✅ 修正済み**

- [src/core/tm/tm-text-normalizer.ts](../../src/core/tm/tm-text-normalizer.ts#L310) に `export function normalizeForTm(text: string): string` が追加されていることを確認
- [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L5) が `normalizeForTm` を import し、旧 `private static normalizeForTrigram` は削除済みであることを確認
- [src/core/tm/tm-ranker.ts](../../src/core/tm/tm-ranker.ts#L10) が `normalizeForTm` を import し、旧 `function normalizeForRanking` は削除済みであることを確認

インデックス構築（`TmxStore`）とスコアリング（`tm-ranker`）が同一の正規化関数を使用する状態が実現された。

---

## ✅ 最終判定：**承認**

🟠優先指摘 2 件がいずれも仕様通りに修正されており、状態不変条件の保証と正規化パイプラインの DRY 化が達成された。🟡推奨・🟢任意指摘は引き続き将来対応で可。

