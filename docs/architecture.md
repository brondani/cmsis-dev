# CMSIS-Dev MVP Architecture

## Scope

This document describes the current MVP as implemented in the VS Code extension, bundled MCP server, and prompt-rendering CLI.

Two boundaries are important:

- Workflow registration is currently local: bundled workflows shipped with the extension, plus optional workspace overrides.
- GitHub is currently a context source and execution target, not a remote workflow registry.

That distinction matters for extensibility: adding workflows from a GitHub repository is not a first-class feature yet, but the current registry design leaves a clear insertion point for it.

## Architecture Overview

CMSIS-Dev has four runtime layers:

1. Shared workflow core modules own prompt rendering, follow-up normalization, context value projection, non-interactive context resolution, and Node-compatible workflow registry loading.
2. The VS Code extension owns UI, workflow discovery, input collection, AI execution, output persistence, and follow-up actions.
3. The MCP server exposes the same workflow catalog as MCP tools, resolving supported inputs and returning rendered prompts.
4. The CLI renders workflow prompts from explicit placeholder values and supported rich context flags for non-interactive command-line use.

```mermaid
flowchart LR
  Workflows["Workflow Definitions\nbundled + local overrides"]
  Core["Shared Workflow Core\nregistry, context, rendering"]
  Extension["VS Code Extension\nUI, model execution, follow-ups"]
  MCP["MCP Server\ntools return rendered prompts"]
  CLI["CLI\nnon-interactive prompt rendering"]
  Sources["Context Sources\nGitHub API + local git"]

  Workflows --> Core
  Sources --> Core
  Core --> Extension
  Core --> MCP
  Core --> CLI
```

## Core Design

The central abstraction is `WorkflowDefinition`. A workflow is data, not code: the extension reads YAML, normalizes it, and drives both the VS Code action list and the MCP tool list from that shared definition.

The refactor has introduced shared workflow core modules:

- `src/workflowCore.ts` contains pure prompt rendering and follow-up normalization.
- `src/workflowRegistryCore.ts` contains Node-compatible workflow file loading and installed/workspace merge behavior.
- `src/workflowContextCore.ts` contains VS Code-free context value projection and formatting for PR, issue, and workflow-run inputs.
- `src/workflowContextResolverCore.ts` contains VS Code-free non-interactive context argument naming, validation, and provider orchestration shared by the MCP server and CLI.
- `src/githubCore.ts` contains VS Code-free GitHub API data fetching and write helpers used by both the extension facade and MCP server.
- `src/localGitCore.ts` contains VS Code-free local git data fetching, diff formatting, PR template loading, and latest local review lookup used by the extension and MCP server.
- `src/cli.ts` provides a non-interactive `cmsis-dev-cli render` command that renders prompts from explicit placeholder values and supported context flags.

That gives the MVP a simple separation of concerns:

- Workflow files define intent: inputs, prompt template, follow-ups.
- The extension implements interaction and execution.
- The MCP server implements tool exposure for the same workflow set.
- The CLI implements prompt rendering for automation without VS Code.
- GitHub and local git integrations are context providers rather than workflow-specific logic.

## VS Code Extension Layer

The extension entrypoint is `src/extension.ts`. It wires together four responsibilities:

- View registration: `ActionsProvider`, `WorkflowsProvider`, `RunsProvider`, and `ChatDiagnosticsProvider`.
- Commands: run action, refresh, create overrides, follow-up actions, token management, delete runs.
- Watchers and diagnostics: workflow file watchers, runs watcher, YAML validation.
- MCP process hosting: starts `out/mcp/server.js` as a child process and passes the paths it needs via environment variables.

The UI surface is intentionally thin:

- `ActionsProvider` shows runnable workflows loaded from the registry.
- The `Actions` view title exposes model controls and shows the effective selection as view description text.
- `WorkflowsProvider` shows the effective workflow files, labeled as `installed` or `workspace`.
- `RunsProvider` shows generated outputs from the runs directory and supports multi-select deletion.
- `ChatDiagnosticsProvider` shows retained proxy requests by chat session; `chatDiagnosticsTrace` derives timing, token usage, and payload composition for the trace webview.

This keeps the views declarative. They render the current model but do not own workflow semantics.

## MCP Server Layer

The MCP server lives in `src/mcp/server.ts`. On startup it:

1. Resolves the bundled workflow directory.
2. Resolves the optional workspace override path.
3. Loads and merges both sets of workflows.
4. Registers one MCP tool per compatible workflow.

Each registered tool:

- derives its input schema from the workflow input list,
- resolves supported context inputs,
- renders `promptTemplate`,
- returns the rendered prompt as MCP text output.

The MCP server is intentionally narrower than the extension. It does not run models, persist output files, or perform VS Code follow-up actions. Its job is prompt materialization and tool exposure.

## CLI Layer

The CLI entry point lives in `src/cli.ts` and is exposed as `cmsis-dev-cli` after compilation or packaging.

The first supported command is prompt rendering:

```bash
cmsis-dev-cli render <workflow-id> \
  --installed-workflows .cmsis-dev/workflows \
  --workspace-workflows path/to/local/workflows \
  --owner owner \
  --repo repo \
  --pull-number 123 \
  --values-file values.json \
  --value key=value
```

This command is intentionally non-interactive:

- it loads installed workflows plus optional workspace overrides using `src/workflowRegistryCore.ts`,
- it resolves supported rich context inputs from explicit flags such as `--owner`, `--repo`, `--pull-number`, `--issue-number`, `--run-id`, and `--repo-path`,
- it accepts placeholder values from JSON and repeated `--value key=value` arguments, with explicit values overriding resolved context values,
- it renders the prompt using the same `src/workflowCore.ts` renderer used by the extension and MCP server,
- it writes the rendered prompt to stdout.

GitHub contexts use `--github-token` or the `CMSIS_DEV_GITHUB_TOKEN` / `GITHUB_TOKEN` environment variables when authentication is needed. Workflows with multiple inputs of the same context type use input-scoped flags such as `--pr-owner` or `--workflow-run-run-id`, matching the MCP argument naming convention.

## AI Execution Layer

Current execution logic:

- `tryGenerateWithVsCodeLm()` uses `vscode.lm` and can also be driven from the `@cmsisdev` chat participant.
- `src/languageModelProvider.ts` contributes a CMSIS-Dev language model provider backed by an OpenAI-compatible proxy.
- `src/aiSettings.ts` resolves either an explicitly selected VS Code model or the preferred automatic fallback.

This keeps model execution separate from workflow definition. A workflow does not know which concrete provider or model has been selected for the run.

The proxy provider also records bounded diagnostics according to `cmsisDev.languageModelProvider.requestDiagnostics`. Metadata mode retains timing, reported usage, and outgoing payload sizes; full mode additionally retains request/response JSON. The first local workspace folder holds the session index and full records in `.cmsis-dev/chat-diagnostics/`. The trace distinguishes internal requests from chat requests, peak input from cumulative usage, and missing usage from reported zero. Cached and reasoning counts are subsets of input and output respectively, not additional billable totals.

## Workflow Registry

### Current registry sources

The workflow registry is implemented in `src/workflowConfig.ts`.

The effective registry is:

- bundled workflows in `.cmsis-dev/workflows/` inside the extension installation,
- optionally overridden by workspace files in `.cmsis-dev/workflows/`.

Merge rule:

- Workflows are keyed by `id`.
- A workspace workflow with the same `id` replaces the bundled one.

```mermaid
flowchart LR
  Installed["Installed workflows"] --> Merge["Merge by workflow id"]
  Shared["Future shared source"] -. optional .-> Merge
  Workspace["Workspace/local overrides"] --> Merge
  Merge --> Effective["Effective workflow catalog"]
```

Normalization then fills in required defaults for the built-in workflow types such as `review-pr`, `review-changes`, `create-pr`, and `explain-issue`.

### Why this matters

This gives two useful sharing modes:

- Extension-wide shared actions: bundled workflows travel with the extension version.
- Team-wide repo actions: workspace overrides live in the repository and can be versioned with source code.

### GitHub-hosted workflows

The MVP does not yet load workflows directly from GitHub. If that is added, the clean insertion point is another loader that returns `WorkflowDefinition[]` and participates in the merge before workspace overrides are applied.

A likely precedence order would be:

1. installed
2. GitHub-shared
3. workspace override

The existing merge-by-`id` logic already matches that model.

## Action Definition Schema

The contract for workflow files is intentionally small:

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

The YAML schema is enforced in `src/workflowDiagnostics.ts`, which validates open workflow documents and surfaces errors as VS Code diagnostics.

## Context Providers

Context resolution is shared at the provider core boundary. `src/workflowContextCore.ts` owns the flat placeholder values and formatting for GitHub PR, GitHub issue, and GitHub workflow-run contexts. `src/workflowContextResolverCore.ts` owns non-interactive argument naming, validation, workflow-run log collection, and provider orchestration for MCP tools and CLI flags. `src/githubCore.ts` owns the VS Code-free GitHub API calls used by the extension facade, MCP server, and CLI. `src/localGitCore.ts` owns VS Code-free local git data fetching, default branch resolution, diff formatting, PR template loading, and latest local review lookup. Provider selection, VS Code pickers, SecretStorage, MCP schema generation, and CLI flag parsing remain adapters around those shared functions.

Each input type maps to a provider:

- `text`: prompts the user directly.
- `github-pr-context`: selects a PR, fetches PR metadata and file patches, and injects placeholders.
- `github-issue-context`: selects an issue, fetches issue metadata, comments, and linked references.
- `git-local-changes-context`: selects a local repository, resolves the default branch, computes diffs, reads PR templates, and reuses the latest local review when relevant.
- `run-output-context`: selects a previous CMSIS-Dev run output.
- `github-workflow-run-context`: fetches a GitHub Actions workflow run, jobs, and relevant log excerpts.

These providers isolate external data collection from prompt construction. The prompt renderer only sees a flat `Record<string, string>`, and shared context helpers merge input-scoped placeholders while preserving the first resolved bare alias such as `owner`, `repo`, or `fileSections`.

That flat-value contract is a strong design choice for an MVP:

- workflow YAML stays simple,
- templates stay string-based,
- new providers can be added without changing the renderer.

## Language Model Integration

The execution pipeline depends on one narrow generated-output shape:

```ts
interface GeneratedReview {
  agentName: string;
  modelName: string;
  content: string;
}
```

As long as the language-model integration can return that structure, the rest of the pipeline stays unchanged.

That keeps model-transport details isolated:

- VS Code language model request and response handling stay inside `tryGenerateWithVsCodeLm()`,
- the rest of the system only consumes normalized text plus metadata.

## Execution Pipeline

The extension execution lifecycle is:

```mermaid
sequenceDiagram
  participant U as User
  participant V as VS Code UI
  participant R as Workflow Registry
  participant C as Context Providers
  participant P as Shared Core
  participant A as AI Backend
  participant F as File Persistence
  participant G as Follow-up Actions

  U->>V: Select action
  V->>R: Load normalized workflow
  V->>C: Resolve declared inputs
  C-->>V: Placeholder values + structured context
  V->>P: Render promptTemplate
  P-->>V: Prompt
  V->>A: Generate text
  A-->>V: Output + model metadata
  V->>F: Write output.md, reasoning.md, meta.json
  V->>G: Enable follow-up actions
  G-->>U: Open PR / post comment / submit PR / open chat
```

### Step-by-step

1. A workflow is selected from the actions view or command palette.
2. The workflow definition is loaded from the effective registry.
3. Declared inputs are resolved one by one.
4. Placeholder values are merged into a flat map.
5. `promptTemplate` is rendered by `src/workflowCore.ts`.
6. The selected VS Code language model generates output.
7. The extension writes the user-facing output markdown, a reasoning sidecar, and a metadata sidecar.
8. Follow-up actions are derived from workflow metadata and current context.

## Prompt Construction

Prompt construction is deliberately dumb and predictable:

```ts
function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_full, key) => values[key] ?? "");
}
```

That simplicity is useful for workflow authors:

- no embedded code in workflow files,
- no hidden execution model,
- no workflow-specific renderer branching.

The tradeoff is that complex templating logic must be expressed either as a richer context provider or as prompt wording.

## Output Model and Follow-ups

Each run produces three related files:

- `<output>.md`
- `<output>.md.reasoning.md`
- `<output>.md.meta.json`

The markdown output is now the source of truth for user-editable follow-ups:

- `Post Comment` posts the current markdown output content.
- `Submit PR` parses the current markdown output content into PR title and body.

That design is important because it lets the user edit the generated `.md` file before publishing anything externally.

## How Abstractions Isolate Concerns

`WorkflowDefinition`

- isolates action intent from execution code.

Input providers

- isolate GitHub and git access from prompt rendering.

Prompt rendering

- isolates template expansion from context collection and model execution.

VS Code language model integration

- isolate model-specific transport details from workflow behavior.

Metadata sidecars

- isolate execution state and follow-up context from the visible markdown output.

MCP tool registration

- isolates workflow exposure for external clients from the VS Code UI.

## Extensibility

### Add a new workflow

The lowest-friction extension point is a new workflow YAML file.

Example:

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

Place it in:

- bundled defaults: `.cmsis-dev/workflows/` in the extension project,
- or workspace override: `<repo>/.cmsis-dev/workflows/`.

No `package.json` command wiring is required. The action appears automatically after reload or refresh.

### Add a new context source

Add a new `WorkflowInputDefinition.type`, then implement three pieces:

1. schema validation in `workflowDiagnostics.ts`
2. input resolution in `promptWorkflow.ts`
3. MCP schema and resolution in `mcp/server.ts`

This is the main place where the extension and MCP server must stay aligned.

### Add a new tool or team-shared source

For team-wide actions, the current solution is repository-managed workspace workflows. For organization-wide shared actions outside the extension package, add another workflow loader that reads from a shared source and merges into the registry before workspace overrides.

## MCP and VS Code Communication

The extension starts the MCP server as a child Node process and passes it file-system context through environment variables:

- `CMSIS_DEV_EXTENSION_PATH`
- `CMSIS_DEV_WORKSPACE_WORKFLOW_CONFIG`
- `CMSIS_DEV_WORKFLOW_RUNS_DIR`

This is intentionally loose coupling:

- the extension remains the process supervisor,
- the MCP server resolves its own effective workflow set,
- both sides share the workflow shape but do not share in-memory state.

That makes the MCP server independently testable and keeps the boundary simple: file paths and stdio.

## Developer Notes

### Where to look

- `src/extension.ts`: extension composition, commands, watchers, MCP hosting
- `src/workflowConfig.ts`: workflow loading, merge rules, normalization, runs path resolution
- `src/workflows/promptWorkflow.ts`: input collection, prompt rendering, backend execution, follow-ups
- `src/mcp/server.ts`: MCP tool registration and prompt materialization
- `src/workflowDiagnostics.ts`: workflow schema validation
- `src/githubCore.ts`: shared GitHub API access for extension and MCP
- `src/github.ts`: VS Code-facing GitHub facade and workspace repo discovery
- `src/localGitCore.ts`: shared local git context collection for extension and MCP

### Current MVP constraints

- Workflow templating is string replacement only.
- MCP tools return prompts; they do not execute models.
- Only the extension persists runs and performs follow-up actions.
- Direct GitHub-hosted workflow registries are not implemented yet.

These are reasonable MVP constraints because they keep the workflow contract stable while leaving the main seams for future growth already visible.
