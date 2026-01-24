# Frontmatter翻訳サポート修正 - コードマップ

## 1. 修正対象ファイル一覧

### メインの実装ファイル
| ファイル | 用途 | 関連行数 |
|---------|-----|--------|
| `src/commands/sync/sync-command.ts` | sync処理のコア | Line 135-220 (syncNew_CoreProc), Line 231-327 (sync_CoreProc) |
| `src/commands/trans/trans-command.ts` | trans処理のコア | Line 506-579 (translateFrontmatterIfNeeded) |
| `src/core/status/status-collector.ts` | ステータス収集 | Line 86-177 (collectFileStatus), Line 218-245 (determineFileStatus) |
| `src/core/status/status-item.ts` | ステータス型定義 | StatusItemType, StatusItem型群 |

### ユーティリティファイル
| ファイル | 用途 |
|---------|-----|
| `src/core/markdown/frontmatter-translation.ts` | frontmatter翻訳ユーティリティ |
| `src/core/markdown/mdait-marker.ts` | マーカー管理クラス |
| `src/core/markdown/front-matter.ts` | FrontMatterクラス |

### テストファイル
| ファイル | 対象 |
|---------|-----|
| `src/test/commands/sync/sync-frontmatter-marker.test.ts` | sync時のsource側マーカー付与（TODO実装） |
| `src/test/commands/trans/trans-frontmatter.test.ts` | frontmatter翻訳（TODO実装） |
| `src/test/core/markdown/frontmatter-translation.test.ts` | ユーティリティ関数（既に完成） |
| `src/test/core/status/status-collector-frontmatter.test.ts` | StatusCollector対応（TODO実装） |

## 2. 問題1: Source側にmdait.frontマーカーが付与されない

### 問題が発生する箇所

**ファイル**: `src/commands/sync/sync-command.ts`

1. **syncNew_CoreProc関数** (Line 135-220)
   - Line 177: `setFrontmatterMarker(targetFrontMatter, frontMarker)` ← target側のみにマーカーを設定
   - **修正が必要**: source側にもマーカーを設定する処理を追加

2. **sync_CoreProc関数** (Line 231-327)
   - syncNew_CoreProcと同様にsource側マーカー処理が必要
   - **修正が必要**: 既存同期時にもsource側マーカーを付与

3. **syncFrontmatterMarkers関数** (Line 329-380)
   - frontmatter同期のロジック
   - Line 352-378: target側のマーカー設定処理のみ
   - **修正が必要**: source側マーカー設定処理を追加

### 修正内容

- **syncNew_CoreProc**: 
  - target側のsetFrontmatterMarkerの直後に、source側マーカー設定を追加
  - source側: `new MdaitMarker(sourceFrontHash)` （hashのみ）
  
- **sync_CoreProc**:
  - target側のマーカー設定と同様にsource側マーカー設定を追加

- **syncFrontmatterMarkers**:
  - source側hashをsyncFrontmatterMarkers内で返し、呼び出し側で使用

## 3. 問題2: trans実行時にfrontmatterが翻訳されない

### 問題が発生する箇所

**ファイル**: `src/commands/trans/trans-command.ts`

1. **transFile_CoreProc関数** (Line ~100-200 と推定)
   - frontmatter翻訳の呼び出し: Line 140-144
   - `await translateFrontmatterIfNeeded(markdown, sourceFilePath, frontmatterKeys, ...)`
   - **調査が必要**: この関数が実行されているかログで確認

2. **translateFrontmatterIfNeeded関数** (Line 506-579)
   - Line 516-521: マーカー確認とneedsTranslation()判定
   - Line 534-579: 翻訳実行ロジック
   - **問題の可能性**:
     - needsTranslation()がfalseを返しているか?
     - sourceFilePath==nullでマーカーなしか?
     - AI翻訳が失敗しているか?

## 4. 問題3: frontmatterの翻訳状況がステータス上に表示されない

### 問題が発生する箇所

**ファイル**: `src/core/status/status-collector.ts`

1. **collectFileStatus関数** (Line 86-177)
   - Line 96-127: units（ユニット）の処理のみ
   - **修正が必要**: frontmatter状態をchild要素として追加
   - `markdown.frontMatter`をチェックしてFrontmatterStatusItemを作成

2. **determineFileStatus関数** (Line 218-245)
   - unitのステータスのみで判定
   - **修正が必要**: children全体のステータスを考慮するか、frontmatter状態を別途考慮

### 修正内容

**ファイル**: `src/core/status/status-item.ts`
- StatusItemTypeに `Frontmatter` を追加
- FrontmatterStatusItem インターフェースを定義:
  ```typescript
  interface FrontmatterStatusItem extends BaseStatusItem {
    type: StatusItemType.Frontmatter;
    filePath: string;
    fileName: string;
    fromHash?: string;
    needFlag?: string;
    contextValue: "mdaitFrontmatterSource" | "mdaitFrontmatterTarget";
  }
  ```

**ファイル**: `src/core/status/status-collector.ts`
- collectFileStatusでfrontmatterをchild要素として追加
- determineFileStatusを修正（frontmatter状態を考慮）

## 5. 主要なユーティリティ関数

### frontmatter-translation.ts内の関数

| 関数 | 用途 | 戻り値 |
|------|-----|-------|
| `getFrontmatterTranslationKeys(config)` | 設定から翻訳対象キー一覧を取得 | `string[]` |
| `calculateFrontmatterHash(fm, keys, opts?)` | frontmatterのハッシュを計算 | `string \| null` |
| `getFrontmatterTranslationValues(fm, keys)` | 翻訳対象値を抽出 | `Record<string, string>` |
| `parseFrontmatterMarker(fm)` | mdait.frontマーカーをparse | `MdaitMarker \| null` |
| `setFrontmatterMarker(fm, marker)` | mdait.frontマーカーを設定 | `void` |
| `serializeFrontmatterMarker(marker)` | マーカーを文字列にserialize | `string` |
| `FRONTMATTER_MARKER_KEY` | マーカーのキー名 | `"mdait.front"` |

### MdaitMarker内の主要メソッド

| メソッド | 用途 |
|---------|------|
| `constructor(hash, from?, need?)` | マーカーを作成 |
| `needsTranslation()` | `need === "translate"` か判定 |
| `needsRevision()` | revision必要か判定 |
| `removeNeedTag()` | needタグを削除 |
| `toString()` | マーカー文字列を生成 |
| `static parse(str)` | 文字列からマーカーをparse |

### FrontMatterクラスの主要メソッド

| メソッド | 用途 |
|---------|------|
| `set(key, value)` | キー値を設定（pending） |
| `get(key)` | キー値を取得 |
| `has(key)` | キーが存在するか確認 |
| `toRaw()` | frontmatterをraw文字列に変換 |
| `static fromData(data)` | オブジェクトからFrontMatterを作成 |
| `static empty()` | 空のFrontMatterを作成 |

## 6. 修正順序と依存関係

```
問題1修正（sync-command.ts）
    ↓
問題3修正（status-collector.ts + status-item.ts）← problem1の修正が前提
    ↓
問題2修正（trans-command.ts）← problem1/3の修正結果で問題が見えてくる可能性
    ↓
テスト実装・検証
```

## 7. 実装時に参照すべきパターン

### 既存のunitベースの処理パターン

1. **sync時**: sync-command.ts内のunitループパターン
   - `markdown.units.forEach(unit => { ... })`

2. **trans時**: trans-command.ts内のtranslateUnit関数
   - 値を翻訳してmarkdown側に設定

3. **status時**: status-collector.ts内のunitStatusItem作成パターン
   - `units.map(unit => { ... })`

これらのパターンをfrontmatter向けに適応させる
