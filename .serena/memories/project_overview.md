# プロジェクト概要

## プロジェクト名
**mdait** (Markdown AI Translator)

## 目的
Markdownドキュメントを**継続的に多言語運用するための**VS Code拡張機能。一度きりの翻訳ではなく、文書構造に基づいて変更を追跡し、「再翻訳が必要な部分」だけを、用語と文脈を保ったまま継続的にAI翻訳できる。

## 主要機能
- **ユニット単位の同期**: 指定した見出しレベルでMarkdownをユニット単位に自動分割し、ユニットごとの内容ハッシュ(CRC32)による訳文/原文対応づけと原文変更検出
- **翻訳フロー可視化**: ユニットごとの翻訳状態をサイドバーに一覧表示
- **一貫性を維持するAI翻訳**: 用語集・対象ユニットの前後コンテキストを含む文脈情報を利用したAI翻訳

## 核心概念
- **mdaitUnit**: 翻訳・管理の基本単位。Markdown内に`<!-- mdait hash [from:hash] [need:flag] -->`形式のHTMLコメントマーカーとして埋め込まれる
- **needフラグ**: `translate`, `review`, `verify-deletion`, `revise@{hash}`などでワークフローを管理

## コマンド
- **sync**: 関連Markdownファイル群間でmdaitUnitの対応関係を確立し、差分検出とneedフラグ付与を行う
- **trans**: `need:translate`フラグが付与されたユニットをAI翻訳実行
- **term.detect**: 用語抽出
- **term.expand**: 用語展開

## アーキテクチャ
- **UI層**: VS Code統合、ステータス表示
- **Commands層**: sync/transコマンド実行
- **Core層**: mdaitUnit、ハッシュ、ステータス管理
- **Config層/API層/Utils層**: 設定管理、外部連携、汎用機能
