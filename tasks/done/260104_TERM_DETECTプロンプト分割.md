# 作業チケット: TERM_DETECTプロンプト分割

## 1. 概要と方針

現在の `TERM_DETECT` プロンプトは `hasPairs` 分岐や `primaryLang` の「preferred」指定など、LLMに不要な判断を委ねている。これをコード側で事前判定し、対訳ペアあり/なしで別々のプロンプトを使用することで安定性を向上させる。

## 2. シーケンス図

```mermaid
sequenceDiagram
    participant Cmd as TermDetectCommand
    participant Det as AITermDetector
    participant Prompt as PromptProvider

    rect rgb(230, 245, 255)
        Note over Cmd,Det: ペア分類（既存）
        Cmd->>Det: detectTerms(pairs, sourceLang, targetLang, primaryLang)
        Det->>Det: pairedUnits / unpairedUnitsに分類
    end

    rect rgb(255, 245, 230)
        Note over Det,Prompt: 対訳ペアあり処理
        Det->>Det: contextLang = primaryLangがsrc/tgtにあるか判定
        Det->>Prompt: getPrompt(TERM_DETECT_PAIRS, {contextLang})
        Prompt-->>Det: 対訳ペア用プロンプト
        Det->>Det: AI呼び出し（sourceTerm, targetTerm両方必須）
    end

    rect rgb(245, 255, 230)
        Note over Det,Prompt: ソース単独処理
        Det->>Prompt: getPrompt(TERM_DETECT_SOURCE_ONLY)
        Prompt-->>Det: ソース単独用プロンプト
        Det->>Det: AI呼び出し（sourceTermのみ）
    end
```

## 3. 考慮事項

- `primaryLang` が `sourceLang` でも `targetLang` でもない場合は `sourceLang` をフォールバック
- プロンプト分割により出力形式が明確化され、パース処理も簡潔に
- 既存テストへの影響確認

## 4. 実装計画と進捗

- [x] `PromptIds` に `TERM_DETECT_PAIRS` と `TERM_DETECT_SOURCE_ONLY` を追加
- [x] `DEFAULT_TERM_DETECT_PAIRS` プロンプト作成（contextLang明示、両term必須）
- [x] `DEFAULT_TERM_DETECT_SOURCE_ONLY` プロンプト作成（sourceTermのみ）
- [x] 旧 `TERM_DETECT` を削除し `DEFAULT_PROMPTS` を更新
- [x] `AITermDetector.detectTerms` を分岐処理に修正
- [x] コンパイル確認
