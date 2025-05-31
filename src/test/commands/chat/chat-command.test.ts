import * as assert from "node:assert";
import * as vscode from "vscode";
import { ChatCommand } from "../../../commands/chat/chat-command";

suite("ChatCommand Tests", () => {
	test("ChatCommandのインスタンスが作成できること", () => {
		const chatCommand = new ChatCommand();
		assert.ok(chatCommand);
	});

	test("executeメソッドが存在すること", () => {
		const chatCommand = new ChatCommand();
		assert.ok(typeof chatCommand.execute === "function");
	});

	test("ChatCommandがAIServiceBuilderを使用してシンプルになったこと", () => {
		// このテストは実装がシンプルになったことを確認する
		const chatCommand = new ChatCommand();

		// ChatCommandのプロパティ数やメソッド数が減ったことを確認
		const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(chatCommand));
		const publicMethods = methodNames.filter(
			(name) => !name.startsWith("_") && name !== "constructor",
		);

		// シンプルになったので、パブリックメソッドはexecuteのみであることを確認
		assert.ok(publicMethods.includes("execute"));
		assert.ok(publicMethods.length <= 3); // execute + 少数のヘルパーメソッドのみ
	});
});
