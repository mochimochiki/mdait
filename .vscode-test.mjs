import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: "out/test/commands/sync/tmp",
});
