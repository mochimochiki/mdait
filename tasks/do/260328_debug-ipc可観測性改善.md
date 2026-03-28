# 260328 - debug-ipc可観測性改善

debug-ipcのresult.jsonにdone-with-errorsステータス・構造化ログ・sync診断ログを追加し、エージェントの可観測性を向上させる。

## 背景
syncコマンドが部分的にファイルエラーを起こした場合、statusが"done"のままでエージェントが検知しにくい。また、ログがフォーマット済み文字列のみで構造化されていないため、プログラム的なパースが難しい。

## 方針
1. ResultPayloadのstatusに`"done-with-errors"`を追加（resultのerrorCount > 0判定）
2. LogListenerのシグネチャを拡張し、構造化ログデータも渡せるようにする（後方互換維持）
3. ResultPayloadに`structuredLogs`フィールドを追加
4. sync-commandのスキップログメッセージを改善

## TODO
- [x] `src/utils/logger.ts`: LogListenerの拡張（StructuredLogEntry型追加、addLogListenerの第2引数対応）
- [x] `src/debug/debug-command-handler.ts`: ResultPayload拡張（done-with-errors, structuredLogs）
- [x] `src/commands/sync/sync-command.ts`: スキップ時ログメッセージ改善
- [x] `.github/skills/debug-ipc/SKILL.md`: result.jsonスキーマ更新
- [x] テスト実行・パス確認

## 品質要件
- [x] 既存の`logs: string[]`を維持（後方互換）
- [x] `npm run test`で全テストパス

## まとめ
全3件の改善を実装完了。283テスト全パス。

- LoggerのLogListenerシグネチャを`(line: string, entry: StructuredLogEntry) => void`に拡張（シグネチャ変更が必要だった）
- `formatMessage`を内部で`formatMessageWithTimestamp`に分離し、timestampを構造化エントリと共有
- ResultPayloadに`done-with-errors`ステータスと`structuredLogs`フィールドを追加
- syncのスキップログメッセージを具体的な理由に改善、targetファイル未作成時のdebugログを追加

## 備考
- LoggerのonLogリスナーは`(line: string) => void`のみ → 構造化データを渡すにはシグネチャ拡張が必要
