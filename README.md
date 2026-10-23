# CMSIS-Dev (MVP)

CMSIS-Dev is a VS Code extension for running AI-assisted development workflows from the CMSIS-Dev activity bar, VS Code Chat, and optional command-line tooling.

Use it to review pull requests, review local changes, draft pull requests, generate commit messages, explain GitHub issues, and investigate failing GitHub Actions runs while keeping generated outputs available in your workspace.

## Status

CMSIS-Dev is currently an MVP (minimum viable product). It is not published in the Visual Studio Code Marketplace. Installation is currently expected to use a locally built or shared VSIX package.

## Features

- **Actions view**: launch bundled or workspace-specific AI workflows from the CMSIS-Dev activity bar.
- **Runs view**: reopen generated outputs, reasoning logs, metadata, and follow-up actions after a workflow finishes.
- **Chat Diagnostics view**: inspect retained proxy requests by chat session, including timing, reported token usage, and request composition.
- **VS Code Chat support**: run CMSIS-Dev workflows through the `@cmsisdev` chat participant.
- **GitHub integration**: fetch pull request, issue, and workflow-run context, then post comments or create draft pull requests when you choose to publish output.
- **Local git integration**: review working tree changes, draft PR text, and generate commit messages from local repository state.
- **Workspace workflows**: override or add team-specific workflows under `.cmsis-dev/workflows/`.

## Getting started

1. Install the CMSIS-Dev extension in VS Code from a locally built or shared VSIX package.
2. Open a workspace that contains the repository you want to work with.
3. Run `CMSIS-Dev: Configure Integrations`, choose **Language Model Provider**, and set the provider API key.
4. In `CMSIS-Dev: Configure Integrations`, choose **GitHub Token** so GitHub-backed workflows can fetch issues, pull requests, workflow runs, and publish follow-up actions when requested.
5. Choose a chat model from the VS Code Chat model picker.
6. Open the **CMSIS-Dev** activity bar item and select an action from the **Actions** view.
7. Follow the prompts, review the generated markdown output, and use the available follow-up actions when you are ready.

## Configure integrations

CMSIS-Dev stores provider API keys and GitHub tokens in VS Code SecretStorage instead of plaintext settings.

Use `CMSIS-Dev: Configure Integrations` from the Command Palette or CMSIS-Dev **Actions** view toolbar to configure:

- **Language Model Provider**
	- **Configure Proxy URL**: set the OpenAI-compatible `v1` base URL used for `/models` and `/responses`. The default is `https://openai-api-proxy.geo.arm.com/api/providers/openai/v1`.
	- **Set API Key**: store the provider API key in SecretStorage.
	- **Clear API Key**: remove the stored provider API key.
	- **Refresh Models**: fetch the provider model catalog and expose permitted models in the VS Code Chat model picker.
- **GitHub Token**
	- **Set GitHub Token**: store a GitHub personal access token for PR, issue, CI, and publishing workflows.
	- **Clear GitHub Token**: remove the stored GitHub token.

Additional commands and settings:

- `CMSIS-Dev: Refresh Language Model Provider`: refresh permitted CMSIS-Dev proxy models without reopening the integration picker.
- `CMSIS-Dev: Set Reasoning Level`: choose the optional `reasoning.effort` value sent to supported reasoning-capable models.
- `cmsisDev.workflowConfigPath`: workspace workflow override directory path. The default is `.cmsis-dev/workflows`.
- `cmsisDev.reasoningEffort`: optional reasoning-effort value. Empty means no override.
- `cmsisDev.languageModelProvider.baseUrl`: OpenAI-compatible `v1` base URL used by the CMSIS-Dev language model provider.
- `cmsisDev.languageModelProvider.defaultMaxInputTokens`: fallback maximum input token count when the provider model catalog does not report one.
- `cmsisDev.languageModelProvider.defaultMaxOutputTokens`: fallback maximum output token count when the provider model catalog does not report one.

After configuring the provider API key and refreshing models, choose a CMSIS-Dev model from the VS Code Chat model picker before running workflows.

## Chat diagnostics

The **Chat Diagnostics** view groups recent CMSIS-Dev proxy requests by chat session. Open a session to see its request timeline, peak input size, retained input/cached/output totals, and a chat-versus-internal-request breakdown. Cached tokens are part of input; reported reasoning tokens are part of output. Missing usage remains unavailable, and totals marked as partial omit requests without reported usage. These counts are not a price estimate.

With `full` diagnostics, user turns appear as `Prompt #1`, `Prompt #2`, and so on; tool continuations do not advance the number. Saved prompt labels are restored after a restart. New requests continue the numbering when VS Code supplies earlier chat history and the session can be matched unambiguously. The provider does not receive a guaranteed chat ID, so ambiguous continuations may start a new diagnostic session; older snapshots with trimmed history cannot recover the exact count of discarded turns.

`cmsisDev.languageModelProvider.requestDiagnostics` defaults to `metadata`. Metadata includes request timing, status, reported token usage, and outgoing payload sizes, but not the full prompt and response. Select `full` to retain complete request and response JSON (including potentially sensitive prompts, source code, and tool results) and to enable detailed composition inspection. Select `off` to stop capturing new diagnostics. The **Clear Chat Diagnostics** view action deletes the retained workspace history.

The history is stored in `.cmsis-dev/chat-diagnostics/` in the first local workspace folder and restored on reload; when there is no local workspace, complete request files use the extension log directory instead. Set `cmsisDev.languageModelProvider.maxDiagnosticsRequests` (default 50) and `cmsisDev.languageModelProvider.maxDiagnosticsSessions` (default 20) to positive integers to control retention. The request limit also applies to complete request files; reducing either limit trims existing history immediately. The workspace diagnostics directory is Git-ignored by this repository; add an equivalent rule to other repositories before enabling `full` there.

## Run workflows

You can start workflows in three ways:

- Select an action in the **CMSIS-Dev: Actions** view.
- Run `CMSIS-Dev: Run AI Action in Chat` from the Command Palette.
- Use the `@cmsisdev` participant in VS Code Chat.

Supported chat commands include:

- `@cmsisdev /run`
- `@cmsisdev /review-pr`
- `@cmsisdev /review-changes`
- `@cmsisdev /create-pr`
- `@cmsisdev /commit-message`
- `@cmsisdev /explain-issue`
- `@cmsisdev /explain-ci-failure`
- `@cmsisdev /plan-next-steps`
- `@cmsisdev /transcribe-audio`

## Built-in workflows

### Review Pull Request

Use **Review PR** to fetch pull request metadata and changed files from GitHub, generate a review draft, and optionally post the generated output back to the pull request thread.

You can choose an open pull request from the workspace repository or paste a GitHub pull request URL. CMSIS-Dev saves the result in `.cmsis-dev/runs/`, copies the review draft to the clipboard, and enables follow-up actions such as **Post Comment**, **Open PR**, and **Open Reasoning**.

### Review Local Changes

Use **Review Changes** to review local workspace changes against the repository default branch.

If your workspace contains multiple git repositories, CMSIS-Dev asks which repository to inspect. The generated review is saved with the same runs and reasoning flow used by other workflows.

### Create Pull Request

Use **Create PR** to draft a pull request title and body from local changes.

CMSIS-Dev reads the local diff, repository pull request templates, and the latest matching **Review Changes** output when available. After generation, **Submit PR** asks for confirmation, creates or uses a branch, pushes it to `origin`, creates a GitHub draft pull request, and opens it in the browser.

### Commit Message

Use **Commit Message** to generate a commit message from local git changes. The result can be reviewed before using **Commit Changes** from the run output actions.

### Transcribe Audio or Video

Use **Transcribe Audio** from the Actions view or Command Palette, `@cmsisdev /transcribe-audio` in Chat, or the **Transcribe Audio** tool in Chat Agent mode to select a workspace recording and save a diarized transcript with an executive summary. The Chat tool asks for confirmation before opening the picker. Audio and video are converted to temporary mono 16 kHz MP3 chunks of up to three minutes, with 10 seconds of overlap to retain boundary context. Temporary media is removed after the workflow completes or is canceled.

FFmpeg and FFprobe are used when transcribing. If either is unavailable, CMSIS-Dev asks before downloading portable copies into its extension storage using npm (Windows, macOS, and Linux); declining cancels the transcription without installing anything. An npm installation is required for the optional download, or you can install both tools on `PATH` yourself. Chunks are transcribed in order so each request can use references gathered from earlier speakers (up to four); matching overlap utterances also helps carry labels across chunks. The progress notification advances only when a chunk is complete. Speaker matching can still be imperfect when the provider does not recognize a reference or there is no matching utterance at a boundary. Transcript sections may be summarized up to three at a time.

The saved run shows the original recording duration, elapsed transcription processing time (including media preparation and cleanup, but not executive-summary generation), and input/output transcription tokens when reported by the provider. Executive-summary model usage is not included.

### Explain Issue

Use **Explain Issue** to turn a GitHub issue into an onboarding-oriented explanation.

You can choose an open issue from the workspace repository or paste a GitHub issue URL. CMSIS-Dev fetches issue metadata, comments, and best-effort linked references before generating the explanation.

### Explain CI Failure

Use **Explain CI Failure** to summarize why a GitHub Actions workflow run is failing.

CMSIS-Dev fetches workflow-run metadata, failing jobs, and relevant log excerpts before generating the explanation.

### Plan Next Steps

Use **Plan Next Steps** from a previous run output to continue work in chat with the generated result attached as context.

## Outputs and follow-up actions

Workflow outputs are saved under `.cmsis-dev/runs/` in the current workspace. PR-related outputs include the pull request number in the filename when available, for example `review-pr-pr-123-<timestamp>.md`.

`cmsisDev.maxRetainedRuns` controls how many recent workflow runs are kept (default 10, minimum 1). On startup, after saving a run, or when the setting changes, older outputs and their related files are removed from disk.

Each run can also include sidecar files:

- `<output>.reasoning.md`
- `<output>.meta.json`

The visible markdown output is the editable source used by publishing actions. For example, **Post Comment** posts the current markdown output, and **Submit PR** parses the current markdown output into a pull request title and body. This lets you edit generated text before anything is sent to GitHub.

Follow-up actions can appear in completion notifications, editor title actions, and the **Runs** view:

- `CMSIS-Dev: Open Reasoning`
- `CMSIS-Dev: Attach to Chat`
- `CMSIS-Dev: Plan Next Steps`
- `CMSIS-Dev: Open PR`
- `CMSIS-Dev: Open Issue`
- `CMSIS-Dev: Post Comment`
- `CMSIS-Dev: Submit PR`
- `CMSIS-Dev: Commit Changes`

## Workspace workflows

CMSIS-Dev ships with bundled workflows and can load workspace-specific workflows from `.cmsis-dev/workflows/`.

Use `CMSIS-Dev: Create Workflow Overrides` to create editable workspace copies of the bundled workflows. After adding or changing a workflow file, refresh the **Workflows** view or reload VS Code.

Workspace workflows can override bundled workflows with the same workflow id or add new actions for a repository or team. See [DEVELOPMENT.md](DEVELOPMENT.md) for workflow schema and placeholder reference material.

## Command line and MCP

CMSIS-Dev also includes a prompt-rendering CLI and an MCP server for tool clients. See [DEVELOPMENT.md](DEVELOPMENT.md#cli-development-reference) for CLI usage and [DEVELOPMENT.md](DEVELOPMENT.md#mcp-server-development-reference) for MCP server usage.

## More information

- Contributor and packaging notes: [DEVELOPMENT.md](DEVELOPMENT.md)
