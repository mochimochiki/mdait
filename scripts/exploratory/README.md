# 探索的スイープ（Extension Host 非依存）

VS Code の Extension Host を起動せずに、`out/` のコンパイル済み commands 層を Node から直接駆動して
「機構（挙動）」を決定的に検証する探索テストの土台。クラウドなど VS Code をヘッドレス起動できない
環境で UX/挙動系のリグレッション（特に `sync` の冪等性）を炙り出す目的で使う。

位置付けは [docs/design/test.md](../../docs/design/test.md) の「探索的スイープ」を参照。

## 実行

```bash
npm run test:explore   # compile → scripts/exploratory/run-sweep.js
```

終了コードは決定的アサーション（P1 全部 / P2 need クリア / P3 revise 付与）に失敗すると `1`。
モック限界の項目（訳質、revise パッチ適用）は `INFO` として記録し、失敗にはしない。

## 構成

| ファイル | 役割 |
|---------|------|
| `vscode-shim.js` | `src/test/unit/__mocks__` の vscode モックを読み込み、commands 層が使う API（`withProgress`/`commands`/`findFiles` など）を実FS委譲で増補 |
| `fake-ai.js` | trans が要求する JSON エンベロープ `{"translation": ...}` を返す構造化フェイク。`AIServiceBuilder.prototype.build` を差し替えて全 AI 経路へ注入 |
| `run-sweep.js` | 総なめランナー（P1 sync 冪等/マーカー整合、P2 translate、P3 revise、P4 非MD、P5 external 正規フロー、P6 モード切替→sync 自己修復）。共有 `mdait.json` は snapshot/restore して汚さない |
| `probe-robustness.js` | 頑健性プローブ（調査用・CI 非対象）。編集・章の挿入/削除/並べ替え・リネーム・フォルダ移動・ファイル削除・外部変更を **embedded と external の両方で同じ手順で流し**、sync 後の状態を並べて出す。判定はせず観察結果を出力するだけ |

### probe-robustness.js の使い方

```bash
npm run compile && node scripts/exploratory/probe-robustness.js   # S0〜S14 を全部流す
PROBE_ONLY=S3,S13 node scripts/exploratory/probe-robustness.js    # シナリオを絞る
PROBE_TIME=1 node scripts/exploratory/probe-robustness.js         # 各ステップの所要時間も出す
```

読み方と実測結果の評価は [docs/design/unit-state.md](../../docs/design/unit-state.md) を参照。

## 前提

- 事前に `npm run compile`（`test:explore` が内部で実行）
- LLM は `provider: "default"`（決定的モック）に一時上書きして走る。`sync` は AI 非使用のため完全に決定的
- 訳質・revise パッチ適用など実LLMが要る項目は対象外。必要なら実プロバイダで別途確認する
