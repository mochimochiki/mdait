# 📘 設計書：mdait (Markdown AI Translator)

## 概要

**mdait**（Markdown AI Translator）は、Markdown文書の構造を活かしてAI翻訳を支援するVS Code拡張機能です。文書を「ユニット」に分割し、ハッシュベースの差分管理と翻訳状態追跡により、**変更検出・翻訳差分・多段翻訳**に対応する設計となっています。

## アーキテクチャ概要

mdaitは階層化されたモジュール構成を採用し、各層が明確な責務を持って連携します：

```plain
UI層 ([ui.md])：VS Code統合、ステータス表示
↓
Commands層 ([commands.md])：sync/transコマンド実行
↓
Core層 ([core.md])：mdaitUnit、ハッシュ、ステータス管理
↓
Config層 ([config.md])：設定管理
API層 ([api.md])：外部連携
Utils層 ([utils.md])：汎用機能
```
## リポジトリ構成

```
src/
  extension.ts           # エントリーポイント
  commands/              # sync,transなど各種コマンド処理
  core/                  # コア機能
    ├── markdown/        # Markdownの構造解析、ユニット分割、marker処理など
    ├── hash/            # 文書の正規化とハッシュ計算アルゴリズム
    └── status/          # ステータス情報管理
  config/                # 設定管理
  utils/                 # 汎用ユーティリティ
  api/                   # 外部サービス連携
  ui/                    # UI コンポーネント
  test/                  # テスト関連
    └── workspace/       # テスト作業ディレクトリ
design/                  # 設計ドキュメント
```

## 中核概念

### mdaitUnit
**mdaitUnit**は翻訳・管理の基本単位であり、mdaitシステムの中核となる概念です。Markdown文書をユニット単位に分割し、各ユニットに状態情報を付与することで、精密な差分管理と翻訳追跡を実現します。

#### マーカー構造
ユニットはMarkdown内に`<!-- mdait hash [from:hash] [need:flag] -->`形式のHTMLコメントマーカーとして埋め込まれます：

- **hash**: ユニット内容の正規化後8文字短縮ハッシュ（CRC32）
- **from**: 翻訳元ユニットのハッシュ値（翻訳追跡用、オプショナル）
- **need**: 必要なアクション指示（オプショナル）

#### needフラグ
needフラグはユニットの状態とプロジェクトワークフローを管理する重要な仕組みです：

- **translate**: AI翻訳が必要な新規・更新ユニット
- **review**: 人手レビューが推奨されるユニット
- **verify-deletion**: 削除対象ユニットの確認が必要
- **revise@{hash}**: 原文変更に対する改訂が必要（hashは旧原文のハッシュ）

※現在の実装では「conflict」状態は存在しない。ソースとターゲットの両方が変更された場合も、すべて`revise`として処理する。翻訳ドメインでは「原文と訳文の両方が変更される」ことは通常であり、それをconflictと扱うのは過剰防衛となる。LLMによるdiff-aware reviseを主戦力とする。

#### 実用例
```markdown
<!-- mdait 3f7c8a1b from:2d5e9c4f need:translate -->
This paragraph needs translation from the source document.
```

**詳細実装：** [core.md](core.md) の mdaitUnit概念

### 全体フロー

```plaintext
ja.md <--> en.md <--> de.md
      hash       hash
```

**主要コマンド：**

#### sync - ユニット同期
関連Markdownファイル群間でmdaitUnitの対応関係を確立し、差分検出とneedフラグ付与を行います。変更されたソースユニットに対応するターゲットユニットに`need:translate`を自動付与し、翻訳ワークフローを開始します。
- **機能**: ハッシュ比較による差分検出、from追跡による翻訳チェーン管理
- **詳細**: [command_sync.md](command_sync.md)

#### trans - AI翻訳実行  
`need:translate`フラグが付与されたユニットを特定し、設定されたAIプロバイダーを使用してバッチ翻訳を実行します。翻訳完了後はハッシュ更新とneedフラグ除去を自動実行します。
- **機能**: 翻訳対象の自動識別、AIプロバイダー連携、翻訳結果の統合
- **詳細**: [command_trans.md](command_trans.md)

## モジュール間の依存関係

### データフロー
1. **Config層** → 各層への設定提供
2. **Core層** → Commands層への基盤機能提供  
3. **Commands層** → UI層への処理結果通知
4. **API層** → Commands層への外部サービス連携
5. **Utils層** → 全層への汎用機能提供

### 状態管理
全ユニットの状態は[core.md](core.md)のStatusItem構造で一元管理され、[ui.md](ui.md)でツリー表示されます。

## 国際化（l10n）

VS Codeの標準l10nシステムを活用し、日本語・英語の完全サポートを提供します。

**言語リソース：** `/l10n` ディレクトリ
**UI統合詳細：** [ui.md](ui.md)

## 開発・デバッグ環境

### テスト環境
- **サンプルコンテンツ**: `src/test/sample-content/` のテスト用原稿
- **自動コピー**: テスト実行前の `src/test/workspace/content/` への自動展開
- **VS Code Test**: 拡張機能環境での統合テスト

**詳細：** [test.md](test.md)

### ビルド・実行
```bash
npm run compile  # TypeScriptコンパイル
npm run lint     # コード品質チェック  
npm run test     # テスト実行
npm run watch    # 開発時の自動ビルド
```

## 設計原則

### 全体方針
- **モジュラー設計**: 各層の独立性と明確な責務分離
- **VS Code統合**: VS Codeエコシステムとの完全な統合
- **型安全性**: TypeScriptによる堅牢な型システム活用
- **拡張性**: 新機能・新プロバイダーの追加容易性

### 品質保証
- **冪等性**: sync処理の何度実行しても安全な設計
- **エラー回復**: 各処理段階での適切なエラーハンドリング
- **パフォーマンス**: メモリ効率とファイルI/O最小化
- **テスタビリティ**: [test.md](test.md)による包括的テスト
- **キャンセル対応**: 長時間処理（AI翻訳・用語検出等）は`CancellationToken`による中断を全面サポート
