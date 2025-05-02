import * as assert from "node:assert";
import * as vscode from "vscode";
// import * as myExtension from '../../extension';

suite("Extension Test Suite", () => {
  vscode.window.showInformationMessage("Start all tests.");

  test("Sample test", () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });

  test("mdtrans.translateコマンドを実行すると翻訳処理が開始されることを確認", async () => {
    // メッセージ表示用関数をモック
    const originalShowInformationMessage = vscode.window.showInformationMessage;
    const originalShowErrorMessage = vscode.window.showErrorMessage;
    const getConfigurationMock = vscode.workspace.getConfiguration;

    // メッセージ表示をキャプチャ
    const messages: string[] = [];
    const errors: string[] = [];

    try {
      // showInformationMessageをモック
      vscode.window.showInformationMessage = (
        message: string
      ): Thenable<string | undefined> => {
        messages.push(message);
        return Promise.resolve(undefined);
      };

      // showErrorMessageをモック
      vscode.window.showErrorMessage = (
        message: string
      ): Thenable<string | undefined> => {
        errors.push(message);
        return Promise.resolve(undefined);
      };

      // モックの設定：設定が未設定の場合のテスト
      vscode.workspace.getConfiguration = (section?: string) => {
        return {
          get: (key: string) => undefined,
          has: (key: string) => false,
          update: async () => {},
          inspect: () => undefined,
        } as vscode.WorkspaceConfiguration;
      };

      // コマンドの実行（設定が未設定なのでエラーになるはず）
      await vscode.commands.executeCommand("mdtrans.translate");

      // エラーメッセージが表示されたことを確認
      assert.strictEqual(errors.length > 0, true);
      assert.ok(errors[0].includes("翻訳元ディレクトリが設定されていません"));
    } finally {
      // 元の関数を復元
      vscode.window.showInformationMessage = originalShowInformationMessage;
      vscode.window.showErrorMessage = originalShowErrorMessage;
      vscode.workspace.getConfiguration = getConfigurationMock;
    }
  });
});
