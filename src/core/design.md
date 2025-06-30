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

**参照実装：** `./markdown/` ディレクトリ

### ハッシュ管理
文書の正規化とハッシュ計算を提供します。

**機能：**
- Markdown内容の正規化処理
- CRC32によるハッシュ計算
- ユニット単位でのハッシュ管理

**参照実装：** `./hash/` ディレクトリ

### ステータス管理
全ユニットの状態を`StatusItem`型で一元管理します。

**StatusItem型の特徴：**
- type（"directory"|"file"|"unit"）による階層構造
- children配列によるツリー表現
- fromHash、unitHashでの検索機能
- 進捗集計とエラー情報の統合

**参照実装：** `./status/` ディレクトリ

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

**参照実装：** `./markdown/` ディレクトリの型定義

## ユニット対応処理アルゴリズム

関連ファイル間のユニット対応付けアルゴリズム：

1. **fromハッシュ一致優先**: targetユニットのfromとsourceユニットのハッシュが一致
2. **順序ベース推定**: from情報がない場合の順序による推定
3. **新規ユニット挿入**: マッチしないsourceユニットの適切な位置への挿入
4. **孤立ユニット処理**: 対応するsourceがないtargetユニットの削除または確認要求

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

- [ルート設計書](../../design.md) - 全体アーキテクチャ
- [../commands/design.md](../commands/design.md) - コマンド実装
- [../config/design.md](../config/design.md) - 設定管理