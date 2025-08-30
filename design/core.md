# コア機能層設計

## 概要

mdaitの中核となる概念と処理ロジックを提供する層です。Markdownの解析、ユニット管理、ハッシュ計算、ステータス管理など、システム全体で共通利用される基盤機能を実装します。

## 主要コンポーネント

### mdaitUnit概念

`mdaitUnit`は翻訳・管理の基本単位であり、Markdown文書内では`<!-- mdait ... -->`形式のマーカーとして表現されます。

**構成要素：**
- **hash**: ユニット内容の正規化後8文字短縮ハッシュ（CRC32）
- **from**: 翻訳元ユニットのハッシュ値（翻訳追跡用）
- **need**: 必要なアクション（translate、review、verify-deletion、solve-conflict）

**参照実装：** `../src/core/markdown/` ディレクトリ

### ハッシュ管理
文書の正規化とハッシュ計算を提供します。

**機能：**
- Markdown内容の正規化処理
- CRC32によるハッシュ計算
- ユニット単位でのハッシュ管理

**参照実装：** `../src/core/hash/` ディレクトリ

### ステータス管理
全ユニットの状態を`StatusItem`型で一元管理します。

**StatusItem型の特徴：**
- type（"directory"|"file"|"unit"）による階層構造
- children配列によるツリー表現
- fromHash、unitHashでの検索機能
- 進捗集計とエラー情報の統合

**参照実装：** `../src/core/status/` ディレクトリ

## Markdownオブジェクト構造

```typescript
interface Markdown {
  frontMatter?: FrontMatter;
  units: MdaitUnit[];
}

interface MdaitUnit {
  mdaitUnit: MdaitMarker;
  content: string;
}

interface MdaitMarker {
  hash: string;
  from?: string;
  need?: string;
}
```

**参照実装：** `../src/core/markdown/` ディレクトリの型定義

## sync時のSectionMatcherによるユニット対応付け

本節は、[src/commands/sync/section-matcher.ts](../src/commands/sync/section-matcher.ts)による同期時のセクション対応付け処理について解説します。

### 対応付けの流れ（SectionMatcher.match）

1. `target.marker.from === source.marker.hash` の組をアンカーとして優先マッチします。
2. アンカー間区間で、未マッチの source と「from を持たない未マッチ target」を順に 1:1 で対応付けます
3. 残りの source は片側のみのペアとして保持します。
4. from を持つ未マッチ target は「孤立」として追加します。出力は source の出現順→孤立 target の順に並べます。

### 同期結果の組み立て（SectionMatcher.createSyncedTargets）

マッチ結果からtargetを組み立てます。
1. source+target のペアは既存 target を採用。
2. source のみ(原文追加)は `MdaitUnit.createEmptyTargetUnit` で新規 target を生成し`from=sourceHash`、`need: translate` を付与。
3. target のみ(原文削除)は既定で削除し、削除しない運用では `need: verify-deletion` を付与して残します。

### ハッシュと need フラグの更新（updateSectionHashes）

source+target のペアでは双方の本文ハッシュを再計算します。両方変更なら競合として双方に `need: solve-conflict` を付与（ハッシュは据え置き）。片側のみ変更なら当該側の `marker.hash` を更新。さらに `target.from !== source.hash` なら `from` を最新化し `need: translate` を付与します。片側のみのケースは `marker.hash` のみ最新化します（この段階では need を付けません）。

### 初回同期の挙動（createInitialTargetFile）

初回同期では、source 各ユニットに `hash` を付与（from/need なし）し、それを複製して target を生成します（`{ hash: sourceHash, from: sourceHash, need: translate }`）。

### 同期後に原文を更新した場合

原文更新後の同期では、まず対応付け（match）が行われ、その時点では source の `marker.hash` はまだ再計算されていません。そのため、`target.marker.from` は旧ハッシュと一致し、ペアのマッチは成立します。その後のハッシュ更新段階（`updateSectionHashes`）で、source の実原稿から新ハッシュが計算され、`target.marker.from` が新ハッシュに更新されると同時に `need: translate` が付与されます。つまり「from の差し替えと need の付与だけが行われる」のが基本挙動です。

### 同期後に原文にUnitレベルの章を挿入した場合

挿入位置の前後に存在する from一致ペアがアンカーとなり、その区間内で新しく増えた source ユニットは「source のみ」として検出されます。結果として、当該位置に新しい target ユニットが生成され、`from` には挿入された source のハッシュが入り、`need: translate` が付与されます。複数章を連続して挿入した場合も、source の並び順を保ったまま同数の target ユニットが同位置に差し込まれます。

逆に、原文から章を削除した場合は、対応する target が「孤立」となります。既定では自動削除され、無効化時は `need: verify-deletion` を付けて残ります。こうした挙動により、章の追加・削除・入れ替えが発生しても、from一致アンカーを基準として周辺の順序をできる限り安定に保ちます。


## 設計原則

- **型安全性**: TypeScriptの型システムを活用した堅牢性
- **パフォーマンス**: メモリ効率とファイルI/O最小化
- **拡張性**: 新機能追加時の柔軟性
- **検索性**: ハッシュベースの高速検索

## 関連モジュールとの連携

- **commands層**: 各コマンドがコア機能を組み合わせて利用
- **config層**: 設定値（autoMarkerLevel、autoDeleteなど）を参照
- **ui層**: StatusItem構造をUI表示に活用

## 参考

- [ルート設計書](design.md) - 全体アーキテクチャ
- [commands.md](commands.md) - コマンド実装
- [config.md](config.md) - 設定管理