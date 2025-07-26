import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: "out/test-gui/**/*.test.js",
  workspaceFolder: "./src/test/workspace",
});
