# GUI Test Separation

## Overview

GUI tests have been separated from regular tests to avoid running them in CI environments where VS Code GUI components may not be available.

## Structure

```
src/
├── test/          # Regular unit tests (run in CI)
│   ├── commands/
│   ├── core/
│   ├── config/
│   └── ...
└── test-gui/      # GUI tests (excluded from CI)
    └── ui/        # VS Code UI component tests
        └── status/
```

## Scripts

- `npm test` - Runs regular tests (excluding GUI tests)
- `npm run test:gui` - Runs GUI tests only

## CI Configuration

The CI pipeline runs `npm test` which excludes GUI tests, ensuring that tests requiring VS Code UI components don't break the CI build.

## Configuration Files

- `.vscode-test.mjs` - Configuration for regular tests
- `.vscode-test-gui.mjs` - Configuration for GUI tests