import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  extensionDevelopmentPath: "..",
  files: "../out/{test,test-gui}/**/*.test.js",
  workspaceFolder: "../src/test/workspace",
  mocha: {
    ui: 'tdd',
    timeout: 10000,
  },
});
