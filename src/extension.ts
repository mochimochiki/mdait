import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "mdtrans" is now active!');

  const disposable = vscode.commands.registerCommand(
    "mdtrans.helloWorld",
    () => {
      vscode.window.showInformationMessage("Hello World from mdtrans!");
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
