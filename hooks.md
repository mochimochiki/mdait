# Skill: VS Code拡張（TypeScript）向け 依存関係強制 Hook 実装

## 目的

このスキルは、GitHub Copilot エージェントを前提として、
VS Code拡張（TypeScript）プロジェクトにおける**依存関係ルールの強制**を実装するものです。

エージェントのコーディング後に以下を保証します：

* 循環依存が存在しない
* ディレクトリ／レイヤー間の依存関係が守られている
* `core` が VS Code API に依存していない
* 違反が自動検知される
* 違反内容がエージェントにフィードバックされ、修正ループが回る
* ローカル・CIの両方で再現可能

これは「提案」ではなく、**実装まで完了させるスキル**です。

---

## 成果物

通常このスキルで生成されるもの：

1. 実行可能な依存ルール（コードとして定義）
2. dependency-cruiser 設定
3. 必要に応じて eslint-plugin-boundaries 設定
4. `.github/hooks/` 配下の Copilot hook 設定
5. hook から呼び出すスクリプト
6. package.json のスクリプト
7. 簡単なアーキテクチャ説明
8. 実行結果（成功／失敗）

---

## 必須の振る舞い

### 1. まず自律的に調査する

ユーザーに聞く前にリポジトリから推測する：

* パッケージマネージャ
* tsconfig
* ESLint の有無
* ディレクトリ構成
* 既存スクリプト
* CI
* `.github/hooks/` の有無

---

### 2. 不明点だけ質問する

以下のような「アーキテクチャに影響する点」だけ聞く：

* レイヤー構造（core / platform / feature など）
* レイヤー間の依存方向
* feature間依存の可否
* testの例外扱い
* strictにblockするか警告か

それ以外は聞かない。

---

### 3. 必ず実装する

提案だけで終わらない。

---

### 4. 必ずテストする

* コマンドを実行
* 成功 or 失敗を確認
* 既存違反は隠さない

---

## 技術方針

### 主軸: dependency-cruiser

用途：

* 循環依存検出
* パスベース依存制御
* レイヤー制約

---

### 補助: eslint-plugin-boundaries

条件：

* ESLintが既にある場合のみ
* import単位で即時検知したい場合

---

## Hook設計

### 基本戦略

**編集後に必ず検査し、違反したら修正させる**

---

### 使用タイミング

* PostToolUse（編集後）
* Stop（終了前）

---

### 出力要件

hookは以下を返す：

* どのルール違反か
* どのファイルが原因か
* どの依存が問題か
* 修正方向

---

## 実装フロー

### Step1: リポジトリ調査

* package.json
* tsconfig
* src構成
* eslint
* docs
* .github

---

### Step2: ルール決定

最低限：

* no circular
* core → vscode 禁止
* core → extension 禁止
* レイヤー依存方向

---

### Step3: 不明点確認

例：

* core→platformはOK？
* feature間依存はOK？
* test例外は？

---

### Step4: 実装

作成物：

* dependency-cruiser config
* スクリプト
* package.json scripts

---

### Step5: hook実装

`.github/hooks/` に配置

hookは：

* npm script を呼ぶだけにする
* ロジックを埋め込まない

---

### Step6: テスト

* スクリプト実行
* exit code確認
* 出力確認

---

### Step7: 報告

* 何を追加したか
* 何を検出するか
* 違反の有無

---

## 設計ガイドライン

### 除外対象

* dist
* build
* coverage
* node_modules

---

### ルール例

* no-circular
* core → vscode 禁止
* core → features 禁止
* layer方向固定

---

### スクリプト

例：

* check:deps
* validate:architecture

---

### hook設計

良い例：

* hook → npm run check:deps

悪い例：

* hookに巨大なシェルを書く

---

## 判断基準

* dependency-cruiser を優先
* ESLintは補助
* CIでも使える構成

---

## 禁止事項

* 提案だけで終わる
* 違反を無視
* ルールを緩める
* ドキュメントだけで済ませる

---

## 出力フォーマット

1. 推測した構造
2. 確認事項
3. 実装内容
4. 実行結果
5. 残課題

---

## 品質基準

* ルールがコード化されている
* hookで自動実行される
* 違反で確実に失敗する
* 実行確認済み

---

## 最終指示

あなたの役割は

**依存関係強制の仕組みを完全に実装し、動作確認まで行うこと**。

* まず調査
* 必要な質問のみ
* 実装
* テスト
* 正直に結果報告
