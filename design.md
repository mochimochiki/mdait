# 📘 設計書：mdait (Markdown AI Translator)

## 概要

**mdait**（Markdown AI Translator）は、Markdown文書の構造を活かしてAI翻訳を支援するVS Code拡張機能です。文書を「ユニット」に分割し、ハッシュベースの差分管理と翻訳状態追跡により、**変更検出・翻訳差分・多段翻訳**に対応する設計となっています。

## アーキテクチャ概要

mdaitは階層化されたモジュール構成を採用し、各層が明確な責務を持って連携します：

```
┌─────────────────────────────────────────┐
│                UI層                      │ ← VS Code統合、ステータス表示
├─────────────────────────────────────────┤
│              Commands層                  │ ← sync/trans/chatコマンド実行
├─────────────────────────────────────────┤  
│                Core層                    │ ← mdaitUnit、ハッシュ、ステータス管理
├─────────────────────────────────────────┤
│      Config層    │    API層    │Utils層  │ ← 設定管理、外部連携、汎用機能
└─────────────────────────────────────────┘
```

**各層の詳細設計：**
- **[src/ui/design.md](src/ui/design.md)** - UI層設計
- **[src/commands/design.md](src/commands/design.md)** - Commands層設計  
- **[src/core/design.md](src/core/design.md)** - Core層設計
- **[src/config/design.md](src/config/design.md)** - Config層設計
- **[src/api/design.md](src/api/design.md)** - API層設計
- **[src/utils/design.md](src/utils/design.md)** - Utils層設計
- **[src/test/design.md](src/test/design.md)** - テスト設計

## 中核概念

### mdaitUnit
翻訳・管理の基本単位。Markdown内の`<!-- mdait hash [from:hash] [need:flag] -->`マーカーで表現され、文書構造を保持しながら差分管理を実現します。

**詳細：** [src/core/design.md](src/core/design.md) の mdaitUnit概念

### 全体フロー

```plaintext
----------------          ----------------          ----------------
| documentA.md | ◀------▶ | documentB.md │◀------▶ | documentC.md |
| (e.g. ja.md) |   hash   | (e.g. en.md) │  hash   | (e.g. de.md) |
----------------          ----------------          ----------------
```

**主要コマンド：**
- **sync**: ユニット間のハッシュ・from追跡・needフラグ同期
- **trans**: need:translateユニットのAI翻訳実行
- **chat**: 対話型AIサポート

**詳細：** [src/commands/design.md](src/commands/design.md)

## モジュール間の依存関係

### データフロー
1. **Config層** → 各層への設定提供
2. **Core層** → Commands層への基盤機能提供  
3. **Commands層** → UI層への処理結果通知
4. **API層** → Commands層への外部サービス連携
5. **Utils層** → 全層への汎用機能提供

### 状態管理
全ユニットの状態は[src/core/design.md](src/core/design.md)のStatusItem構造で一元管理され、[src/ui/design.md](src/ui/design.md)でツリー表示されます。

## リポジトリ構成

```
src/
  extension.ts           # エントリーポイント（コマンド登録など）
  commands/              # syncコマンド、transコマンド、chatコマンド関連処理
    ├── sync/
    ├── trans/
    ├── chat/
    └── design.md
  core/                  # 共通コア機能
    ├── markdown/        # Markdownの構造解析、ユニット分割、marker処理など
    ├── hash/            # 文書の正規化とハッシュ計算アルゴリズム
    ├── status/          # ステータス情報管理
    └── design.md
  config/                # 設定管理
    ├── configuration.ts
    └── design.md
  utils/                 # 汎用ユーティリティ
    ├── file-explorer.ts
    └── design.md
  api/                   # 外部サービス連携
    └── design.md
  ui/                    # UI コンポーネント
    └── design.md
  test/                  # テスト関連
    ├── sample-content/  # テスト用コンテンツ
    ├── workspace/       # テスト作業ディレクトリ
    └── design.md
```

**参照実装：** 各ディレクトリ内のソースコード

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
- **テスタビリティ**: [src/test/design.md](src/test/design.md)による包括的テスト

## 国際化（l10n）

VS Codeの標準l10nシステムを活用し、日本語・英語の完全サポートを提供します。

**言語リソース：** `/l10n` ディレクトリ
**UI統合詳細：** [src/ui/design.md](src/ui/design.md)

## 開発・デバッグ環境

### テスト環境
- **サンプルコンテンツ**: `src/test/sample-content/` のテスト用原稿
- **自動コピー**: テスト実行前の `src/test/workspace/content/` への自動展開
- **VS Code Test**: 拡張機能環境での統合テスト

**詳細：** [src/test/design.md](src/test/design.md)

### ビルド・実行
```bash
npm run compile  # TypeScriptコンパイル
npm run lint     # コード品質チェック  
npm run test     # テスト実行
npm run watch    # 開発時の自動ビルド
```

## 今後の拡張予定

- **多段翻訳**: 複数の中間言語を経由した翻訳チェーン
- **AIプロバイダー拡張**: 新しいAIサービスとの連携
- **高度なコンフリクト解決**: 双方向編集での自動マージ機能
- **パフォーマンス最適化**: 大規模文書での処理効率化

---

各層の詳細な設計については、対応する design.md ファイルを参照してください。このドキュメントは全体のアーキテクチャと層間連携の道標として機能します。