import { strict as assert } from "node:assert";
import { decodeUnitRegistry, encodeUnitRegistry } from "../../../core/unit-registry/unit-registry-encoder";

suite("UnitRegistryEncoder", () => {
	test("encode/decode: 基本的なテキストを正しくエンコード・デコードする", () => {
		const originalText = "Hello, World!";
		const encoded = encodeUnitRegistry(originalText);
		const decoded = decodeUnitRegistry(encoded);

		assert.equal(decoded, originalText);
		// エンコード後はbase64形式
		assert.ok(encoded.length > 0);
		assert.notEqual(encoded, originalText);
	});

	test("encode/decode: 日本語テキストを正しく処理する", () => {
		const originalText = "こんにちは、世界！これはテストです。";
		const encoded = encodeUnitRegistry(originalText);
		const decoded = decodeUnitRegistry(encoded);

		assert.equal(decoded, originalText);
	});

	test("encode/decode: 空文字列を正しく処理する", () => {
		const originalText = "";
		const encoded = encodeUnitRegistry(originalText);
		const decoded = decodeUnitRegistry(encoded);

		assert.equal(decoded, originalText);
	});

	test("encode/decode: 改行を含むテキストを正しく処理する", () => {
		const originalText = "Line 1\nLine 2\nLine 3\n";
		const encoded = encodeUnitRegistry(originalText);
		const decoded = decodeUnitRegistry(encoded);

		assert.equal(decoded, originalText);
	});

	test("encode/decode: Markdownコンテンツを正しく処理する", () => {
		const originalText = `## 見出し

これは**太字**のテキストです。

- リスト1
- リスト2

\`\`\`javascript
const code = "example";
\`\`\`
`;
		const encoded = encodeUnitRegistry(originalText);
		const decoded = decodeUnitRegistry(encoded);

		assert.equal(decoded, originalText);
	});

	test("encode: 圧縮により元のテキストより短くなる場合がある", () => {
		// 長い繰り返しテキストは圧縮で小さくなる
		const longRepeatedText = "Hello World! ".repeat(100);
		const encoded = encodeUnitRegistry(longRepeatedText);

		// gzip圧縮+base64でも繰り返しが多いと短くなる
		assert.ok(encoded.length < longRepeatedText.length);
	});
});
