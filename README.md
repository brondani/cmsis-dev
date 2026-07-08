# CMSIS-Dev VS Code Extension (MVP)

CMSIS-Dev is a basic VS Code extension scaffold that provides:

- An **AI Actions** view in the Explorer for launching workflows in VS Code Chat.
- Bundled workflow configuration files shipped inside the extension installation.
- Optional workspace workflow overrides under `.cmsis-dev/workflows/` (one YAML file per action).
- Dynamic AI actions loaded from bundled defaults plus workspace overrides.
- A bundled **MCP server** that exposes tools derived from the workflow config.

## Implemented MVP flow: Explain Issue

1. Select **Explain Issue** from the **CMSIS-Dev AI Actions** view.
2. Choose an issue source:
   - list open issues from the workspace repository, or
   - paste a GitHub issue URL.
3. The extension fetches issue metadata, comments, and best-effort linked references from GitHub API.
4. Optional inputs let you add relevant code, logs, and architecture context directly from the workflow definition.
5. The extension builds a structured explanation prompt aimed at onboarding a developer to the issue.
6. The result is saved using the same output and reasoning flow as other workflows.
7. The result is saved using the same output and reasoning flow as other workflows.

## Implemented MVP flow: Review Changes

1. Select **Review Changes** from the **CMSIS-Dev AI Actions** view.
2. If the current VS Code workspace contains multiple git repositories, choose which repository should be reviewed.
3. The extension resolves the repository's default branch from local git refs and compares the local working tree against that branch head.
4. It collects tracked-file diffs plus untracked file contents and builds a review prompt similar to **Review PR**.
5. The result is saved using the same output and reasoning flow as other workflows.
6. The result is saved using the same output and reasoning flow as other workflows.

## Implemented MVP flow: Create PR

1. Select **Create PR** from the **CMSIS-Dev AI Actions** view.
2. If the VS Code workspace contains multiple git repositories, choose which repository should be used.
3. The extension collects the local diff against the default branch, discovers repository PR templates, and reuses the latest **Review Changes** result for the same repo when available.
4. It generates a concise PR title and body in a strict format so the result can be submitted later.
5. The result is saved using the same output and reasoning flow as other workflows.
6. From the completion notification or editor title actions, **Submit PR** asks for confirmation, creates a branch if needed, pushes it to `origin`, creates the GitHub draft pull request, and opens it in the browser.

## Implemented MVP flow: Review PR

1. Select **Review PR** from the **CMSIS-Dev AI Actions** view.
2. Choose a PR source:
   - list open PRs from the workspace repository, or
   - paste a GitHub PR URL.
3. The extension fetches PR metadata + changed files from GitHub API.
4. It builds a detailed review prompt for code review.
5. It shows progress in the status bar during selection, fetch, generation, and save phases.
6. The extension runs the workflow through VS Code Chat using the model selected in the Chat sidebar.
7. Output files are saved only after the review text has actually been generated.
8. The review draft is saved to `.cmsis-dev/runs/...md` and copied to clipboard.
9. A reasoning log (prompt, metadata, and generated output) is written as a persistent sidecar markdown file and can be opened from the completion notification.
10. From the completion notification, you can directly **Post Comment** to the PR thread (requires a stored GitHub token and generated review output).
11. You can also open the PR page and paste the draft manually if preferred.
12. The review result is saved to the runs directory and can be opened from the `Runs` view.

For generic action outputs in `.cmsis-dev/runs`, when PR context is used the filename includes the PR number (for example `review-pr-pr-123-<timestamp>.md`).
Persistent sidecar files are also written:

- `<output>.reasoning.md`
- `<output>.meta.json`

These enable persistent actions even after notifications disappear.

## Dynamic workflows

- AI actions are loaded dynamically from the bundled `.cmsis-dev/workflows/` directory in the extension by default.
- Optional workspace files in `.cmsis-dev/workflows/` override bundled workflows with the same `id`.
- One YAML file per action is the preferred layout.
- No per-workflow command needs to be added to `package.json`.
- Use `CMSIS-Dev: Create Workflow Overrides` to scaffold editable workspace copies when needed.
- Add a new workspace `.yml` file under `.cmsis-dev/workflows/`, refresh the view, and launch it from the AI Actions tree.
- Clicking an AI Action opens VS Code Chat and auto-submits the matching `@cmsisdev` command. Dynamic workspace-only actions use the `/run` chat entry point with the selected workflow preselected.
- Generic workflows run by collecting declared inputs and rendering `promptTemplate`.
- Reusable input types include:
  - `text`: prompts the user for a value.
  - `github-pr-context`: fetches PR metadata and changed-file patches and injects placeholders.
  - `github-issue-context`: fetches issue metadata, comments, and best-effort linked references and injects placeholders.
  - `git-local-changes-context`: lets the user choose a local git repository, resolves the default branch, and injects local diff information, repository PR templates, and the latest matching local review output when available.

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

## Token management

Use VS Code SecretStorage commands (no plaintext settings):

- `CMSIS-Dev: Set GitHub Token`
- `CMSIS-Dev: Clear GitHub Token`
- `CMSIS-Dev: Open Reasoning`
- `CMSIS-Dev: Post Comment`
- `CMSIS-Dev: Submit PR`

## Configure

Settings:

- `cmsisDev.workflowConfigPath`: workspace workflow override directory path (default `.cmsis-dev/workflows`).
- `cmsisDev.languageModelProvider.baseUrl`: OpenAI-compatible `v1` base URL used by the built-in CMSIS-Dev model provider.

The `Actions` view toolbar provides commands to change CMSIS-Dev settings without opening settings. Use `CMSIS-Dev: Set Reasoning Level` to inspect or change the current reasoning level.

Provider setup:

- Run `CMSIS-Dev: Manage Language Model Provider`.
- Configure the proxy base URL.
- Set the API key in SecretStorage.
- Refresh models, then choose the CMSIS-Dev chat model from VS Code's Chat sidebar model picker.

VS Code Chat:

- `@cmsisdev /run` opens a workflow picker inside chat.
- `@cmsisdev /review-pr`, `/review-changes`, `/create-pr`, and `/explain-issue` run the built-in workflows with the currently selected chat model.
- `CMSIS-Dev: Run AI Action in Chat` opens the selected workflow in Chat and auto-submits the matching `@cmsisdev` command.

## Build and run

```bash
npm install
npm run compile
npm run build:mcp
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Documentation

- Architecture and design: [docs/architecture.md](docs/architecture.md)

## MCP server

Source file: `src/mcp/server.ts`

Build output: `out/mcp/server.js`

Exposed tools are derived from the bundled workflow files plus any workspace overrides in `.cmsis-dev/workflows/*.yml`.
Workflow ids are converted to MCP tool names by replacing `-` with `_`.

With the default workflow set, the MCP server exposes:

- `review_pr(owner, repo, pullNumber, githubToken?)`
  - Fetches PR details from GitHub and returns the rendered review prompt.
- `explain_issue(owner, repo, issueNumber, githubToken?)`
  - Fetches issue details, comments, and related references, then returns the rendered explanation prompt.
- `review_changes(repoPath)`
  - Inspects local git changes against the default branch and returns the rendered local review prompt.
- `create_pr(repoPath)`
  - Inspects local git changes, PR templates, and the latest local review output, then returns the rendered PR draft prompt.

Supported workflow input types for MCP exposure:

- `text`
- `github-pr-context`
- `github-issue-context`
- `git-local-changes-context`

## Notes

- Workflow behavior is primarily driven by the bundled workflow files, with optional workspace overrides in `.cmsis-dev/workflows/*.yml`.
- The MCP server exposes tools dynamically from the workflow config, but only for workflow input types it currently knows how to resolve: `text`, `github-pr-context`, `github-issue-context`, and `git-local-changes-context`.
