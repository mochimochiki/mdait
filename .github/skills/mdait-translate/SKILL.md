---
name: mdait-translate
description: "mdaitプロジェクトのl10n（国際化）対応を行います。新機能実装後の翻訳対応、既存翻訳の更新・修正、翻訳漏れの検出と対応が必要なときに使います。"
---

# mdait-translate Skill

## Purpose

このスキルは、mdaitプロジェクトの **l10n（国際化）対応** を行うためのものです。  
新機能実装後に翻訳が必要なとき、既存翻訳の修正・更新が必要なときに使います。

## When to use

- 新機能実装後の翻訳対応（`vscode.l10n.t()` ラップ漏れの検出と対応）
- 既存翻訳の更新・修正
- 翻訳漏れの検出と対応
- `package.json` の多言語対応（`package.nls.*.json` の更新）

## References

- `docs/docs.md` の 11. l10n（国際化）

## 翻訳手順

### 1. コードの翻訳対応

1. `src` ディレクトリ内のコードを確認し、翻訳が必要な文字列を特定する  
   特に、ユーザー向けメッセージが `vscode.l10n.t()` でラップされていない部分を探す
2. 見つけた部分に必要な処置を行う  
   - 英語メッセージ → `vscode.l10n.t()` でラップ  
   - 日本語メッセージ → 英語に変更して `vscode.l10n.t()` でラップ
3. `npm run l10n` を実行して `l10n/bundle.l10n.json` を生成
4. `l10n/bundle.l10n.json` を確認し、翻訳キーが正確であることを確認
5. `l10n/bundle.l10n.ja.json` を更新（日本語訳を追加・修正）

### 2. package.json の翻訳対応

1. `package.json` を確認し、翻訳が必要なワード（`description` など）を特定
2. `package.nls.json` と `package.nls.ja.json` に翻訳を追加・修正

## 網羅的検索が必要な場合

翻訳対象文字列の網羅的検索や既存翻訳キーとの整合性確認が必要な場合は、`search_subagent` に委譲してください。

## 作業完了時の報告

翻訳完了時、以下を報告:
- 翻訳したファイル一覧
- 追加・変更したキー一覧
- 注意が必要な翻訳（文脈依存、専門用語等）
