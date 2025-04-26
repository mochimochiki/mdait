import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "famous-saying" is now active!');

  const disposable = vscode.commands.registerCommand(
    "famous-saying.helloWorld",
    () => {
      vscode.window.showInformationMessage("Hello World from famous-saying!");
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
