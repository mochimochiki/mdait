import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  extensionDevelopmentPath: "..",
  files: "../out/test/gui/**/*.test.js",
  workspaceFolder: "../src/test/unit/workspace",
  mocha: {
    ui: 'tdd',
    timeout: 10000,
  },
});
