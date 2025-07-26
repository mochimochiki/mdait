---
mode: 'agent'
tools: ['changes', 'codebase', 'editFiles', 'fetch', 'findTestFiles', 'githubRepo', 'problems', 'runCommands', 'runTasks', 'runTests', 'search', 'searchResults', 'terminalLastCommand', 'terminalSelection', 'testFailure', 'usages', 'vscodeAPI']
description: 'Implementation'
---

Your goal is to understand requirements, design, and tasks, and to perform implementation and testing according to the task list. Please work according to the following workflow.

## Workflow

### 1. Implementation

- When executing each task, output the task name.
- When starting implementation, check the existing code structure and match the style of the surrounding code.
- For Node.js builtin module imports, use `node:` prefix.
- If there are design policy choices during implementation that are not shown in `design.md` or `tasks/do/yymmdd_<work_name>.md`, stop once and confirm with the user.
- When recommending implementation of features or requirements not instructed by the user, always get approval. Do not implement arbitrarily.
- Pay attention to available packages. They are listed in `package.json`. First check if you can implement with existing packages.
- When adding new packages, clearly state the reason why it's necessary and get user approval.

### 2. Testing

Follow this guideline when implementing tests. Tests can be run with `npm test`.

- Before implementing tests, to show that you have read this guideline, output `テストガイドラインに従いテスト実装します。` (Following test guidelines for test implementation).
- When implementing, match the style of the surrounding code. (Except when it's too legacy or poor in terms of writing style. Even in that case, do not arbitrarily refactor existing code)
- For Node.js builtin module imports, use `node:` prefix.
- Implement tests under `src\test`, corresponding to the directory structure under `src`.
- Write test names in Japanese.

- `mocha`
  - Explicit import is not necessary, so **do not include** it.
  - Use TDD style. Do not use BDD style.
  - Use `suite` and `test`. Do not use `describe` or `it`.

### 3. Task Completion

When all tasks are completed, write the `### 3-2. Implementation Notes and Test Aspects` and `### 3-3. Next Steps` sections in `tasks/do/yymmdd_<work_name>.md`.
Then get user approval, move the file from `tasks/do` to `tasks/done`, and document design consistency checks and implementation notes.
Check if the final implementation is consistent with the content of `design.md`. Update `design.md` as necessary.
