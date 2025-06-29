# 設定管理層設計

## 概要

mdaitの動作に必要な各種設定の管理を担当する層です。VSCodeの設定システムと連携し、翻訳ペア、プロバイダー設定、同期オプションなどを一元管理します。

## 主要機能

### Configuration クラス
全設定の中央管理を行うクラスです。

**管理する設定項目：**
- **翻訳ペア設定** (`transPairs`): sourceDir/targetDir/sourceLang/targetLangの組み合わせ
- **除外パターン** (`ignoredPatterns`): 処理対象外とするファイル・ディレクトリのパターン
- **sync設定** (`sync`): autoMarkerLevel、autoDeleteなどの同期動作設定
- **trans設定** (`trans`): プロバイダー、モデル、エンドポイント等の翻訳設定

**参照実装：** `./configuration.ts`

### 翻訳設定 (TransConfig)
AI翻訳プロバイダーの設定を管理します。

**設定項目：**
- **provider**: 使用するプロバイダー（default、ollama等）
- **model**: 翻訳に使用するAIモデル
- **markdown**: Markdown特有の設定（skipCodeBlocksなど）
- **ollama**: Ollamaプロバイダー固有設定（endpoint、model）

### 翻訳ペア設定 (TransPair)
関連ドキュメント間の翻訳方向を定義します。

**設定項目：**
- **sourceDir**: 翻訳元ディレクトリ
- **targetDir**: 翻訳先ディレクトリ  
- **sourceLang**: 翻訳元言語
- **targetLang**: 翻訳先言語

## 設計原則

- **VSCode統合**: VSCodeの設定システムと完全に統合
- **型安全性**: TypeScriptによる設定値の型保証
- **デフォルト値**: 合理的なデフォルト設定の提供
- **拡張性**: 新しいプロバイダーや設定項目の追加に対応

## 設定の読み込みフロー

1. VSCodeワークスペース設定から値を取得
2. デフォルト値との統合
3. 型安全性の確保
4. 各コンポーネントへの設定提供

## 関連モジュールとの連携

- **commands層**: 各コマンドが設定値を参照して動作制御
- **core層**: ハッシュ計算やステータス管理で設定値を利用
- **api層**: AI翻訳プロバイダーの初期化に設定を供給

## 参考

- [ルート設計書](../../design.md) - 全体アーキテクチャ
- [../commands/design.md](../commands/design.md) - 設定を利用するコマンド実装
- [../api/design.md](../api/design.md) - 翻訳プロバイダー設定の利用