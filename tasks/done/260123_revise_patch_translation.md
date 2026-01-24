# 作業チケット: 改訂翻訳パッチ適用フロー

## 1. 概要と方針

need:revise時は原文差分を活用し、前回訳文に対する差分パッチのみをLLMから取得して適用する。パッチ適用失敗時は全文翻訳へフォールバックする。LLM統合テストは手動実行に分離する。

## 2. シーケンス図

```mermaid
sequenceDiagram
	rect rgb(240, 248, 255)
	participant Cmd as TransCommand
	participant Translator as Translator
	participant Diff as DiffApplier
	participant AI as LLM
	end

	Cmd->>Translator: translateRevisionPatch(前回訳文, diff, context)
	Translator->>AI: 改訂パッチ用プロンプト
	AI-->>Translator: 目标差分パッチ(JSON)
	Translator-->>Cmd: targetPatch
	Cmd->>Diff: applyUnifiedPatch(prevTranslation, targetPatch)
	alt パッチ適用成功
		Diff-->>Cmd: patchedTranslation
	else 失敗
		Cmd->>Translator: translate(全文翻訳)
		Translator->>AI: 通常翻訳プロンプト
		AI-->>Translator: 翻訳結果(JSON)
		Translator-->>Cmd: fullTranslation
	end
	Cmd-->>Cmd: 品質チェック・保存・need更新
```

## 3. 考慮事項

- LLM出力は統一diff形式を要求し、ヘッダ欠落時の補正を行う。
- パッチ適用に失敗した場合のフォールバックを必ず実施し、ユーザー影響を最小化する。
- 新プロンプトID追加に伴い、設定スキーマとプロンプト一覧を更新する。
- LLM統合テストはAPIキーが必要なため、通常テストから分離する。

## 4. 実装計画と進捗

- [x] 改訂パッチ用プロンプトIDとデフォルトプロンプトを追加
- [x] unified diffパッチ適用ユーティリティを追加
- [x] Translatorに改訂パッチ翻訳APIを追加
- [x] trans-commandのneed:reviseフローでパッチ適用→フォールバックを実装
- [x] configスキーマとドキュメント更新
- [x] unitテストでパッチ適用を検証
- [x] LLM統合テスト（手動実行）を追加しスクリプトを用意