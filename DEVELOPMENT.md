# CMSIS-Dev Development

This file collects information for contributors, workflow authors, and maintainers. End-user usage is documented in [README.md](README.md).

## Project structure

- `src/extension.ts`: VS Code extension entry point and command registration.
- `src/actionsProvider.ts`: CMSIS-Dev Actions view.
- `src/runsProvider.ts`: generated run output view and actions.
- `src/requestDiagnostics.ts`: retained proxy request grouping and usage metadata.
- `src/chatDiagnosticsProvider.ts`: chat diagnostics tree view.
- `src/chatDiagnosticsTrace.ts` and `src/chatDiagnosticsTracePanel.ts`: session trace calculations and webview.
- `src/workflowsProvider.ts`: effective workflow file view.
- `src/workflowCore.ts`: prompt rendering and follow-up normalization.
- `src/workflowRegistryCore.ts`: workflow file loading and installed/workspace merge behavior.
- `src/workflowContextCore.ts`: VS Code-free placeholder projection and formatting.
- `src/workflowContextResolverCore.ts`: non-interactive context argument naming and provider orchestration.
- `src/githubCore.ts`: VS Code-free GitHub API helpers.
- `src/localGitCore.ts`: VS Code-free local git helpers.
- `src/cli.ts`: non-interactive workflow prompt renderer.
- `src/mcp/server.ts`: MCP server entry point.
- `docs/architecture.md`: architecture and design notes.
- `scripts/`: CLI/MCP smoke checks and VSIX packaging helpers.

## Build and run

Use a Node.js and npm version supported by the installed VS Code extension tooling. On a fresh clone, install locked dependencies and compile both extension and MCP outputs:

```bash
npm ci
npm run build:dev
npm run smoke
```

Open the repository folder in VS Code and press `F5` to launch the Extension Development Host. The checked-in launch configuration runs `build:dev` first, so the MCP server exists even on a fresh clone. Breakpoints in `src/` map to the compiled JavaScript through source maps. Set the provider key in the development host to exercise proxy requests; the CLI/MCP smoke checks do not require that key.

Useful scripts:

- `npm run compile`: compile the VS Code extension TypeScript project.
- `npm run watch`: compile the extension in watch mode.
- `npm run build:mcp`: compile the MCP server TypeScript project.
- `npm run build:dev`: remove stale generated output, then compile both outputs used by F5.
- `npm run smoke`: run CLI and MCP smoke checks.
- `npm run smoke:cli`: run the CLI smoke check.
- `npm run smoke:mcp`: run the MCP smoke check.
- `npm run package:vsix`: compile extension and MCP output, then package a VSIX using `scripts/package-vsix.js`.

There is currently no repository test suite. `npm run smoke` exercises the CLI and MCP paths without a provider key; inspect the **Chat Diagnostics** view in the Extension Development Host for proxy UI behavior. The checked-in `.vscodeignore` excludes local run files and diagnostics from VSIX packages, and `.gitignore` excludes them from Git; do not commit sensitive workspace diagnostics.

## Architecture

CMSIS-Dev has four runtime layers:

1. Shared workflow core modules own prompt rendering, follow-up normalization, context value projection, non-interactive context resolution, and Node-compatible workflow registry loading.
2. The VS Code extension owns UI, workflow discovery, input collection, AI execution, output persistence, and follow-up actions.
3. The MCP server exposes the same workflow catalog as MCP tools, resolving supported inputs and returning rendered prompts.
4. The CLI renders workflow prompts from explicit placeholder values and supported rich context flags for non-interactive command-line use.

See [docs/architecture.md](docs/architecture.md) for the full architecture notes.

## Workflow registry

AI actions are loaded dynamically from bundled workflow files in `.cmsis-dev/workflows/` inside the extension installation. Optional workspace files in `.cmsis-dev/workflows/` override bundled workflows with the same `id`.

One YAML file per action is the preferred layout. No per-workflow command needs to be added to `package.json`.

Use `CMSIS-Dev: Create Workflow Overrides` to scaffold editable workspace copies when needed. Add a new workspace `.yml` file under `.cmsis-dev/workflows/`, refresh the **Workflows** view, and launch it from the **Actions** view.

Generic workflows run by collecting declared inputs and rendering `promptTemplate`.

## Workflow schema

The workflow definition contract is intentionally small:

```ts
export interface WorkflowDefinition {
  id: string;
  title: string;
  description: string;
  type: string;
  inputs: WorkflowInputDefinition[];
  promptTemplate?: string;
  followUps?: WorkflowFollowUp[];
}
```

Supported input types:

- `text`
- `github-pr-context`
- `github-issue-context`
- `git-local-changes-context`
- `run-output-context`
- `github-workflow-run-context`

Supported follow-ups:

- `openReasoning`
- `openPr`
- `openIssue`
- `postComment`
- `submitPr`
- `commitChanges`

Example workflow:

```yaml
id: summarize-issue
title: Summarize Issue
description: Produce a concise issue summary for a developer joining the work.
type: summarize-issue
followUps:
  - openReasoning
  - openIssue
inputs:
  - id: issue
    label: GitHub Issue
    type: github-issue-context
    required: true
promptTemplate: |
  Summarize this issue for a developer who is new to the codebase.

  Repository: {{owner}}/{{repo}}
  Issue: #{{issueNumber}} {{issueTitle}}

  Description:
  {{issueBody}}

  Comments:
  {{issueComments}}
```

## Prompt placeholders

Prompt templates use simple `{{placeholder}}` replacement. Missing values render as an empty string.

### github-pr-context placeholders

For input id `pr`:

- `{{pr_owner}}`, `{{pr_repo}}`, `{{pr_prNumber}}`, `{{pr_prTitle}}`
- `{{pr_author}}`, `{{pr_headRef}}`, `{{pr_baseRef}}`, `{{pr_prBody}}`
- `{{pr_fileSections}}`, `{{pr_prUrl}}`
- `{{pr_repoPath}}`, `{{pr_workspaceFolder}}` when the PR matches a local repo in the current VS Code workspace

Compatibility placeholders for single-PR workflows are also provided:

- `{{owner}}`, `{{repo}}`, `{{prNumber}}`, `{{prTitle}}`, `{{author}}`
- `{{headRef}}`, `{{baseRef}}`, `{{prBody}}`, `{{fileSections}}`, `{{prUrl}}`
- `{{repoPath}}`, `{{workspaceFolder}}` when the PR matches a local repo in the current VS Code workspace

### github-issue-context placeholders

For input id `issue`:

- `{{issue_owner}}`, `{{issue_repo}}`, `{{issue_number}}`, `{{issue_title}}`
- `{{issue_author}}`, `{{issue_body}}`, `{{issue_state}}`, `{{issue_labels}}`
- `{{issue_assignees}}`, `{{issue_commentsCount}}`, `{{issue_comments}}`
- `{{issue_linkedPrs}}`, `{{issue_relatedIssues}}`, `{{issue_url}}`
- `{{issue_repoPath}}`, `{{issue_workspaceFolder}}` when the issue matches a local repo in the current VS Code workspace

Compatibility placeholders for single-issue workflows are also provided:

- `{{owner}}`, `{{repo}}`, `{{issueNumber}}`, `{{issueTitle}}`, `{{issueAuthor}}`
- `{{issueBody}}`, `{{issueState}}`, `{{issueLabels}}`, `{{issueAssignees}}`
- `{{issueCommentsCount}}`, `{{issueComments}}`, `{{linkedPrs}}`, `{{relatedIssues}}`, `{{issueUrl}}`
- `{{repoPath}}`, `{{workspaceFolder}}` when the issue matches a local repo in the current VS Code workspace

### git-local-changes-context placeholders

For input id `localChanges`:

- `{{localChanges_repoPath}}`, `{{localChanges_workspaceFolder}}`
- `{{localChanges_currentBranch}}`, `{{localChanges_defaultBranch}}`, `{{localChanges_compareRef}}`
- `{{localChanges_changedFiles}}`, `{{localChanges_changedFilesCount}}`, `{{localChanges_fileSections}}`
- `{{localChanges_latestLocalReview}}`, `{{localChanges_pullRequestTemplates}}`

Compatibility placeholders for single-repo local review workflows are also provided:

- `{{owner}}`, `{{repo}}`, `{{repoPath}}`, `{{workspaceFolder}}`
- `{{currentBranch}}`, `{{defaultBranch}}`, `{{compareRef}}`
- `{{changedFiles}}`, `{{changedFilesCount}}`, `{{fileSections}}`
- `{{latestLocalReview}}`, `{{pullRequestTemplates}}`

## CLI development reference

The package installs a non-interactive `cmsis-dev-cli` command for rendering workflow prompts without VS Code. It uses the same bundled workflow definitions as the extension and merges local overrides from `.cmsis-dev/workflows/*.yml` when run inside a workspace.

The CLI currently expects the `render <workflow-id>` subcommand. Running bare `cmsis-dev-cli` is only useful for checking usage or error output.

```bash
cmsis-dev-cli render review-changes --repo-path .
cmsis-dev-cli render review-pr --owner ARM-software --repo CMSIS_6 --pull-number 123
cmsis-dev-cli render explain-issue --owner ARM-software --repo CMSIS_6 --issue-number 456
cmsis-dev-cli render explain-ci-failure --owner ARM-software --repo CMSIS_6 --run-id 789
```

GitHub-backed workflows read `CMSIS_DEV_GITHUB_TOKEN` or `GITHUB_TOKEN` by default. You can also pass `--github-token <token>` for non-interactive environments that inject secrets at runtime.

The CLI render path does not call a language model, so it does not require an OpenAI API key. OpenAI-compatible provider configuration is only needed for VS Code workflow execution.

### Running from this repository

After compiling, run the CLI entry point directly:

```powershell
npm ci
npm run build:dev
node .\out\cli.js render review-pr --owner Open-CMSIS-Pack --repo vscode-cmsis-solution --pull-number 348
```

To make the `cmsis-dev-cli` command available on your PATH while developing, link the package locally:

```powershell
npm link
cmsis-dev-cli render review-changes --repo-path .
```

On Windows, the linked command is implemented by an npm-generated shim, so these forms are equivalent in PowerShell after `npm link`:

```powershell
cmsis-dev-cli render review-changes --repo-path .
cmsis-dev-cli.cmd render review-changes --repo-path .
```

Useful options:

- `--installed-workflows <path>` points at bundled workflow definitions.
- `--workspace-workflows <path>` points at local workflow overrides.
- `--workflow-runs-dir <path>` points at saved CMSIS-Dev run metadata for workflows that reuse prior outputs.
- `--values-file <path>` loads placeholder values from a JSON object.
- `--value <key=value>` injects or overrides a single placeholder value and can be repeated.

## MCP server development reference

Source file: `src/mcp/server.ts`

Build output: `out/mcp/server.js`

Exposed tools are derived from the bundled workflow files plus any workspace overrides in `.cmsis-dev/workflows/*.yml`. Workflow ids are converted to MCP tool names by replacing `-` with `_`.

The MCP server speaks MCP over stdio. It can be launched from a terminal, but it is meant to be driven by an MCP client rather than used as a direct prompt-rendering command. For direct terminal input/output, use the CLI instead.

Build the MCP server before launching it:

```powershell
npm run build:mcp
```

Launch the raw server process with Node:

```powershell
node .\out\mcp\server.js
```

When started this way, the process waits for MCP JSON-RPC messages on stdin. For interactive command-line exploration, launch it through an MCP client such as the MCP inspector:

```powershell
npx @modelcontextprotocol/inspector node .\out\mcp\server.js
```

The smoke test uses the same stdio model programmatically through `@modelcontextprotocol/sdk`:

```powershell
npm run smoke:mcp
```

Useful environment variables when launching the server outside VS Code:

- `CMSIS_DEV_BUNDLED_WORKFLOW_CONFIG`: path to bundled workflow definitions.
- `CMSIS_DEV_WORKSPACE_WORKFLOW_CONFIG`: path to workspace workflow overrides.
- `CMSIS_DEV_WORKFLOW_RUNS_DIR`: path to saved workflow runs used by follow-up tools.
- `GITHUB_TOKEN` or `CMSIS_DEV_GITHUB_TOKEN`: token for GitHub-backed MCP tools when a token is not passed as a tool argument.

With the default workflow set, the MCP server exposes:

- `review_pr(owner, repo, pullNumber, githubToken?)`: fetches PR details from GitHub and returns the rendered review prompt.
- `explain_issue(owner, repo, issueNumber, githubToken?)`: fetches issue details, comments, and related references, then returns the rendered explanation prompt.
- `review_changes(repoPath)`: inspects local git changes against the default branch and returns the rendered local review prompt.
- `create_pr(repoPath)`: inspects local git changes, PR templates, and the latest local review output, then returns the rendered PR draft prompt.
- `explain_ci_failure(owner, repo, runId, githubToken?)`: fetches workflow run metadata, failing jobs, and log excerpts, then returns the rendered CI failure explanation prompt.

Supported workflow input types for MCP exposure:

- `text`
- `github-pr-context`
- `github-issue-context`
- `git-local-changes-context`
- `github-workflow-run-context`

## Output model

Each workflow run can produce three related files:

- `<output>.md`
- `<output>.md.reasoning.md`
- `<output>.md.meta.json`

The markdown output is the source of truth for user-editable follow-ups. `Post Comment` posts the current markdown output content, and `Submit PR` parses the current markdown output content into PR title and body.

Proxy request diagnostics are separate from workflow runs. The `requestDiagnostics` setting defaults to `metadata`; `full` stores complete request and response JSON under `.cmsis-dev/chat-diagnostics/` in the first local workspace folder, while `off` stops new capture. `maxDiagnosticsRequests` (default 50) and `maxDiagnosticsSessions` (default 20) bound the history; the request limit also bounds complete request files. Internal provider requests can appear alongside chat requests when correlated; totals include only retained requests, and missing provider usage is shown as unavailable or partial. Cached input and reasoning output are subsets, not additional tokens. See [README.md](README.md#chat-diagnostics) for user-facing controls and privacy details.

## Packaging notes

`npm run package:vsix` invokes `scripts/package-vsix.js`. VSIX packaging calls `vscode:prepublish`, which runs `build:dev` once to replace stale generated output and compile the extension and MCP server. The checked-in `.vscodeignore` keeps workspace runs, diagnostics, and development sources out of the VSIX while retaining bundled workflows and runtime dependencies.