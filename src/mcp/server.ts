import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parse } from "yaml";
import { z } from "zod";

const server = new McpServer({
  name: "CMSIS-Dev-MCP",
  version: "0.0.1"
});

const mcpServer: any = server;

type WorkflowInputType = "text" | "github-pr-context" | "github-issue-context" | "git-local-changes-context";

type WorkflowInputDefinition = {
  id: string;
  label: string;
  type?: WorkflowInputType;
  required?: boolean;
};

type WorkflowDefinition = {
  id: string;
  title?: string;
  description?: string;
  promptTemplate?: string;
  inputs?: WorkflowInputDefinition[];
};

type PullRequestSummary = {
  number: number;
  title: string;
  author: string;
  baseRef: string;
  headRef: string;
  body: string;
};

type PullRequestFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type IssueSummary = {
  number: number;
  title: string;
  author: string;
  body: string;
  state: string;
  labels: string[];
  assignees: string[];
  commentsCount: number;
};

type IssueComment = {
  author: string;
  body: string;
  createdAt: string;
};

type LocalChangesContext = {
  rootPath: string;
  workspaceFolderName: string;
  owner?: string;
  repo?: string;
  currentBranch: string;
  defaultRef: string;
  defaultBranchName: string;
  changedFiles: number;
};

type ActionOutputMetadata = {
  workflowId: string;
  generatedOutput?: string;
  localChangesContext?: {
    rootPath?: string;
  };
};

type BranchCandidate = {
  ref: string;
  shortName: string;
  source: "remote" | "local";
};

type WorkflowToolSchema = Record<string, z.ZodTypeAny>;

void start();

async function start(): Promise<void> {
  try {
    await registerWorkflowTools();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CMSIS-Dev MCP] Failed to register workflow tools: ${message}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function registerWorkflowTools(): Promise<void> {
  const bundledWorkflowConfigPath = resolveBundledWorkflowConfigPath();
  const workspaceWorkflowConfigPath = await resolveWorkspaceWorkflowConfigPath();
  const workflowRunsDirPath = resolveWorkflowRunsDirPath(workspaceWorkflowConfigPath);
  const workflows = dedupeWorkflows(await loadEffectiveWorkflowDefinitions(bundledWorkflowConfigPath, workspaceWorkflowConfigPath));
  const registeredToolNames = new Set<string>();

  for (const workflow of workflows) {
    const promptTemplate = workflow.promptTemplate?.trim();
    if (!promptTemplate) {
      console.warn(`[CMSIS-Dev MCP] Skipping workflow '${workflow.id}' because promptTemplate is missing.`);
      continue;
    }

    const schema = buildWorkflowToolSchema(workflow);
    if (!schema) {
      console.warn(`[CMSIS-Dev MCP] Skipping workflow '${workflow.id}' because its inputs are not MCP-compatible.`);
      continue;
    }

    const toolName = toMcpToolName(workflow.id);
    if (registeredToolNames.has(toolName)) {
      console.warn(`[CMSIS-Dev MCP] Duplicate MCP tool name '${toolName}' derived from workflow '${workflow.id}'. Skipping.`);
      continue;
    }

    registeredToolNames.add(toolName);
    mcpServer.tool(toolName, schema, async (args: Record<string, unknown>) => {
      const values = await resolveWorkflowValues(workflow, workflowRunsDirPath, args);
      const prompt = renderPromptTemplate(promptTemplate, values);
      return {
        content: [
          {
            type: "text",
            text: prompt
          }
        ]
      };
    });
  }
}

function buildWorkflowToolSchema(workflow: WorkflowDefinition): WorkflowToolSchema | undefined {
  const inputs = workflow.inputs ?? [];
  const shape: WorkflowToolSchema = {};
  let needsGitHubToken = false;

  const prContextCount = inputs.filter((input) => input.type === "github-pr-context").length;
  const issueContextCount = inputs.filter((input) => input.type === "github-issue-context").length;
  const localChangesCount = inputs.filter((input) => input.type === "git-local-changes-context").length;

  for (const input of inputs) {
    const required = input.required !== false;
    const label = input.label || input.id;

    if (!input.type || input.type === "text") {
      shape[input.id] = required
        ? z.string().min(1).describe(label)
        : z.string().optional().describe(label);
      continue;
    }

    if (input.type === "github-pr-context") {
      const names = getPrContextArgNames(input.id, prContextCount);
      shape[names.owner] = z.string().min(1).describe(`GitHub repository owner for ${label}`);
      shape[names.repo] = z.string().min(1).describe(`GitHub repository name for ${label}`);
      shape[names.pullNumber] = z.number().int().positive().describe(`Pull request number for ${label}`);
      needsGitHubToken = true;
      continue;
    }

    if (input.type === "github-issue-context") {
      const names = getIssueContextArgNames(input.id, issueContextCount);
      shape[names.owner] = z.string().min(1).describe(`GitHub repository owner for ${label}`);
      shape[names.repo] = z.string().min(1).describe(`GitHub repository name for ${label}`);
      shape[names.issueNumber] = z.number().int().positive().describe(`Issue number for ${label}`);
      needsGitHubToken = true;
      continue;
    }

    if (input.type === "git-local-changes-context") {
      const names = getLocalChangesArgNames(input.id, localChangesCount);
      shape[names.repoPath] = z.string().min(1).describe(`Local git repository path for ${label}`);
      continue;
    }

    return undefined;
  }

  if (needsGitHubToken) {
    shape.githubToken = z.string().optional().describe("Optional GitHub token for GitHub API requests.");
  }

  return shape;
}

async function resolveWorkflowValues(
  workflow: WorkflowDefinition,
  workflowRunsDirPath: string,
  args: Record<string, unknown>
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const token = typeof args.githubToken === "string" && args.githubToken.trim().length > 0 ? args.githubToken.trim() : undefined;
  const inputs = workflow.inputs ?? [];

  const prContextCount = inputs.filter((input) => input.type === "github-pr-context").length;
  const issueContextCount = inputs.filter((input) => input.type === "github-issue-context").length;
  const localChangesCount = inputs.filter((input) => input.type === "git-local-changes-context").length;

  for (const input of inputs) {
    if (!input.type || input.type === "text") {
      const raw = args[input.id];
      values[input.id] = typeof raw === "string" ? raw : "";
      continue;
    }

    if (input.type === "github-pr-context") {
      const names = getPrContextArgNames(input.id, prContextCount);
      const owner = expectStringArg(args, names.owner);
      const repo = expectStringArg(args, names.repo);
      const pullNumber = expectNumberArg(args, names.pullNumber);
      const pr = await getPullRequest(owner, repo, pullNumber, token);
      const files = await getPullRequestFiles(owner, repo, pullNumber, token);
      applyPullRequestValues(values, input.id, owner, repo, pr, files);
      continue;
    }

    if (input.type === "github-issue-context") {
      const names = getIssueContextArgNames(input.id, issueContextCount);
      const owner = expectStringArg(args, names.owner);
      const repo = expectStringArg(args, names.repo);
      const issueNumber = expectNumberArg(args, names.issueNumber);
      const issue = await getIssue(owner, repo, issueNumber, token);
      const comments = await getIssueComments(owner, repo, issueNumber, token);
      const references = await getIssueReferences(owner, repo, issueNumber, token);
      applyIssueValues(values, input.id, owner, repo, issue, comments, references);
      continue;
    }

    if (input.type === "git-local-changes-context") {
      const names = getLocalChangesArgNames(input.id, localChangesCount);
      const repoPath = expectStringArg(args, names.repoPath);
      const localChanges = await collectLocalChangesValues(repoPath, input.id, workflowRunsDirPath);
      Object.assign(values, localChanges.values);
      continue;
    }

    throw new Error(`Unsupported workflow input type '${input.type}' for workflow '${workflow.id}'.`);
  }

  return values;
}

function applyPullRequestValues(
  values: Record<string, string>,
  inputId: string,
  owner: string,
  repo: string,
  pr: PullRequestSummary,
  files: PullRequestFile[]
): void {
  const fileSections = formatPullRequestFileSections(files);

  values[inputId] = `${owner}/${repo}#${pr.number}`;
  values[`${inputId}_owner`] = owner;
  values[`${inputId}_repo`] = repo;
  values[`${inputId}_prNumber`] = String(pr.number);
  values[`${inputId}_prTitle`] = pr.title;
  values[`${inputId}_author`] = pr.author;
  values[`${inputId}_headRef`] = pr.headRef;
  values[`${inputId}_baseRef`] = pr.baseRef;
  values[`${inputId}_prBody`] = pr.body || "(No PR description provided)";
  values[`${inputId}_fileSections`] = fileSections;

  values.owner ??= owner;
  values.repo ??= repo;
  values.prNumber ??= String(pr.number);
  values.prTitle ??= pr.title;
  values.author ??= pr.author;
  values.headRef ??= pr.headRef;
  values.baseRef ??= pr.baseRef;
  values.prBody ??= pr.body || "(No PR description provided)";
  values.fileSections ??= fileSections;
}

function applyIssueValues(
  values: Record<string, string>,
  inputId: string,
  owner: string,
  repo: string,
  issue: IssueSummary,
  comments: IssueComment[],
  references: { linkedPullRequests: string[]; relatedIssues: string[] }
): void {
  values[inputId] = `${owner}/${repo}#${issue.number}`;
  values[`${inputId}_owner`] = owner;
  values[`${inputId}_repo`] = repo;
  values[`${inputId}_issueNumber`] = String(issue.number);
  values[`${inputId}_issueTitle`] = issue.title;
  values[`${inputId}_issueAuthor`] = issue.author;
  values[`${inputId}_issueBody`] = issue.body || "(No issue description provided)";
  values[`${inputId}_issueState`] = issue.state;
  values[`${inputId}_issueLabels`] = issue.labels.join(", ") || "(No labels)";
  values[`${inputId}_issueAssignees`] = issue.assignees.join(", ") || "(No assignees)";
  values[`${inputId}_issueCommentsCount`] = String(issue.commentsCount);
  values[`${inputId}_issueComments`] = formatIssueComments(comments);
  values[`${inputId}_linkedPrs`] = formatSimpleList(references.linkedPullRequests, "(No linked pull requests found)");
  values[`${inputId}_relatedIssues`] = formatSimpleList(references.relatedIssues, "(No related issues found)");

  values.owner ??= owner;
  values.repo ??= repo;
  values.issueNumber ??= String(issue.number);
  values.issueTitle ??= issue.title;
  values.issueAuthor ??= issue.author;
  values.issueBody ??= issue.body || "(No issue description provided)";
  values.issueState ??= issue.state;
  values.issueLabels ??= issue.labels.join(", ") || "(No labels)";
  values.issueAssignees ??= issue.assignees.join(", ") || "(No assignees)";
  values.issueCommentsCount ??= String(issue.commentsCount);
  values.issueComments ??= formatIssueComments(comments);
  values.linkedPrs ??= formatSimpleList(references.linkedPullRequests, "(No linked pull requests found)");
  values.relatedIssues ??= formatSimpleList(references.relatedIssues, "(No related issues found)");
}

async function collectLocalChangesValues(
  repoRoot: string,
  inputId: string,
  workflowRunsDirPath: string
): Promise<{ context: LocalChangesContext; values: Record<string, string> }> {
  const defaultRef = await resolveDefaultBranchRef(repoRoot);
  if (!defaultRef) {
    throw new Error(`Could not resolve the default branch for repository '${repoRoot}'.`);
  }

  const currentBranch = (await runGitCommand(repoRoot, ["branch", "--show-current"])).trim() || "detached HEAD";
  const changedEntries = await getTrackedDiffEntries(repoRoot, defaultRef.ref);
  const untrackedFiles = await getUntrackedFiles(repoRoot);
  if (changedEntries.length === 0 && untrackedFiles.length === 0) {
    throw new Error(`No local changes found in repository '${repoRoot}'.`);
  }

  const fileSections = await formatLocalChangeSections(repoRoot, defaultRef.ref, changedEntries, untrackedFiles);
  const latestLocalReview = await findLatestLocalReviewSummary(repoRoot, workflowRunsDirPath);
  const pullRequestTemplates = await readPullRequestTemplates(repoRoot);
  const changedFilesList = [...changedEntries.map((entry) => entry.displayPath), ...untrackedFiles];
  const uniqueChangedFiles = Array.from(new Set(changedFilesList));
  const repoInfo = await resolveRepoInfoFromGit(repoRoot);
  const workspaceFolderName = path.basename(repoRoot);
  const values: Record<string, string> = {
    [inputId]: repoRoot,
    [`${inputId}_repoPath`]: repoRoot,
    [`${inputId}_workspaceFolder`]: workspaceFolderName,
    [`${inputId}_currentBranch`]: currentBranch,
    [`${inputId}_defaultBranch`]: defaultRef.shortName,
    [`${inputId}_compareRef`]: defaultRef.ref,
    [`${inputId}_changedFiles`]: formatSimpleList(uniqueChangedFiles, "(No changed files found)"),
    [`${inputId}_changedFilesCount`]: String(uniqueChangedFiles.length),
    [`${inputId}_fileSections`]: fileSections,
    [`${inputId}_latestLocalReview`]: latestLocalReview,
    [`${inputId}_pullRequestTemplates`]: pullRequestTemplates
  };

  values.repoPath ??= repoRoot;
  values.workspaceFolder ??= workspaceFolderName;
  values.currentBranch ??= currentBranch;
  values.defaultBranch ??= defaultRef.shortName;
  values.compareRef ??= defaultRef.ref;
  values.changedFiles ??= formatSimpleList(uniqueChangedFiles, "(No changed files found)");
  values.changedFilesCount ??= String(uniqueChangedFiles.length);
  values.fileSections ??= fileSections;
  values.latestLocalReview ??= latestLocalReview;
  values.pullRequestTemplates ??= pullRequestTemplates;
  if (repoInfo?.owner) {
    values.owner ??= repoInfo.owner;
  }
  if (repoInfo?.repo) {
    values.repo ??= repoInfo.repo;
  }

  return {
    context: {
      rootPath: repoRoot,
      workspaceFolderName,
      owner: repoInfo?.owner,
      repo: repoInfo?.repo,
      currentBranch,
      defaultRef: defaultRef.ref,
      defaultBranchName: defaultRef.shortName,
      changedFiles: uniqueChangedFiles.length
    },
    values
  };
}

async function getPullRequest(owner: string, repo: string, number: number, token?: string): Promise<PullRequestSummary> {
  const pr: any = await getJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, token);
  return {
    number: pr.number,
    title: pr.title ?? "",
    author: pr.user?.login ?? "unknown",
    baseRef: pr.base?.ref ?? "",
    headRef: pr.head?.ref ?? "",
    body: pr.body ?? ""
  };
}

async function getPullRequestFiles(owner: string, repo: string, number: number, token?: string): Promise<PullRequestFile[]> {
  const files = await getJson<any[]>(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, token);
  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch
  }));
}

async function getIssue(owner: string, repo: string, number: number, token?: string): Promise<IssueSummary> {
  const issue: any = await getJson(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, token);
  if (issue.pull_request) {
    throw new Error(`GitHub issue request resolved to a pull request for ${owner}/${repo}#${number}.`);
  }

  return {
    number: issue.number,
    title: issue.title ?? "",
    author: issue.user?.login ?? "unknown",
    body: issue.body ?? "",
    state: issue.state ?? "open",
    labels: Array.isArray(issue.labels)
      ? issue.labels
          .map((label: any) => (typeof label === "string" ? label : label?.name))
          .filter((label: string | undefined): label is string => Boolean(label))
      : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees
          .map((assignee: any) => assignee?.login)
          .filter((assignee: string | undefined): assignee is string => Boolean(assignee))
      : [],
    commentsCount: Number(issue.comments ?? 0)
  };
}

async function getIssueComments(owner: string, repo: string, number: number, token?: string): Promise<IssueComment[]> {
  const comments = await getJson<any[]>(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`, token);
  return comments.map((comment) => ({
    author: comment.user?.login ?? "unknown",
    body: comment.body ?? "",
    createdAt: comment.created_at ?? ""
  }));
}

async function getIssueReferences(
  owner: string,
  repo: string,
  number: number,
  token?: string
): Promise<{ linkedPullRequests: string[]; relatedIssues: string[] }> {
  const linkedPullRequests = new Set<string>();
  const relatedIssues = new Set<string>();

  try {
    const timeline = await getJson<any[]>(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}/timeline?per_page=100`,
      token
    );

    for (const event of timeline) {
      const sourceIssue = event.source?.issue;
      if (!sourceIssue?.number || sourceIssue.number === number) {
        continue;
      }

      const label = `#${sourceIssue.number} ${sourceIssue.title ?? ""}`.trim();
      if (sourceIssue.pull_request) {
        linkedPullRequests.add(label);
      } else {
        relatedIssues.add(label);
      }
    }
  } catch {
    // Timeline references are best-effort only.
  }

  return {
    linkedPullRequests: Array.from(linkedPullRequests).sort(),
    relatedIssues: Array.from(relatedIssues).sort()
  };
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "CMSIS-Dev-MCP",
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`GitHub API request failed (${response.statusCode ?? "unknown"}): ${data}`));
            return;
          }

          try {
            resolve(JSON.parse(data) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
  });
}

function formatPullRequestFileSections(files: PullRequestFile[]): string {
  return files
    .map((file) => {
      const patch = (file.patch ?? "(No textual diff available)").slice(0, 4000);
      return `File: ${file.filename}\nStatus: ${file.status}, +${file.additions} -${file.deletions}\nPatch:\n${patch}`;
    })
    .join("\n\n---\n\n");
}

function formatIssueComments(comments: IssueComment[]): string {
  if (comments.length === 0) {
    return "(No issue comments available)";
  }

  return comments
    .map((comment) => {
      const body = (comment.body || "(No comment body)").slice(0, 4000);
      return `Comment by @${comment.author}${comment.createdAt ? ` on ${comment.createdAt}` : ""}:\n${body}`;
    })
    .join("\n\n---\n\n");
}

function formatSimpleList(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

async function readPullRequestTemplates(repoRoot: string): Promise<string> {
  const templatePaths = [
    path.join(repoRoot, ".github", "pull_request_template.md"),
    path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md"),
    path.join(repoRoot, "pull_request_template.md"),
    path.join(repoRoot, "PULL_REQUEST_TEMPLATE.md")
  ];
  const templatesDir = path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE");

  try {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        templatePaths.push(path.join(templatesDir, entry.name));
      }
    }
  } catch {
    // No template directory found.
  }

  const sections: string[] = [];
  for (const templatePath of Array.from(new Set(templatePaths))) {
    try {
      const content = (await fs.readFile(templatePath, "utf8")).trim();
      if (!content) {
        continue;
      }

      sections.push(`Template: ${path.relative(repoRoot, templatePath)}\n${content.slice(0, 6000)}`);
    } catch {
      // Skip missing or unreadable template files.
    }
  }

  return sections.length > 0 ? sections.join("\n\n---\n\n") : "(No pull request templates found)";
}

async function findLatestLocalReviewSummary(repoRoot: string, workflowRunsDirPath: string): Promise<string> {
  let metadataFiles: string[] = [];

  try {
    const entries = await fs.readdir(workflowRunsDirPath, { withFileTypes: true });
    metadataFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
      .map((entry) => path.join(workflowRunsDirPath, entry.name));
  } catch {
    return "(No previous local review found)";
  }

  const matches: Array<{ modifiedAt: number; output: string }> = [];
  for (const metadataPath of metadataFiles) {
    try {
      const raw = await fs.readFile(metadataPath, "utf8");
      const metadata = JSON.parse(raw) as ActionOutputMetadata;
      if (!isReviewChangesWorkflowId(metadata.workflowId)) {
        continue;
      }
      if (metadata.localChangesContext?.rootPath !== repoRoot) {
        continue;
      }
      if (!metadata.generatedOutput) {
        continue;
      }

      const stat = await fs.stat(metadataPath);
      matches.push({
        modifiedAt: stat.mtimeMs,
        output: metadata.generatedOutput.slice(0, 8000)
      });
    } catch {
      // Skip malformed metadata.
    }
  }

  if (matches.length === 0) {
    return "(No previous local review found)";
  }

  matches.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return matches[0].output;
}

async function resolveDefaultBranchRef(repoRoot: string): Promise<BranchCandidate | undefined> {
  const originHead = (await tryRunGitCommand(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (originHead) {
    return { ref: originHead, shortName: originHead.replace(/^origin\//, ""), source: "remote" };
  }

  const fallbackRefs: BranchCandidate[] = [
    { ref: "refs/remotes/origin/main", shortName: "main", source: "remote" },
    { ref: "refs/remotes/origin/master", shortName: "master", source: "remote" },
    { ref: "refs/remotes/origin/develop", shortName: "develop", source: "remote" },
    { ref: "refs/remotes/origin/dev", shortName: "dev", source: "remote" },
    { ref: "refs/remotes/origin/trunk", shortName: "trunk", source: "remote" },
    { ref: "refs/heads/main", shortName: "main", source: "local" },
    { ref: "refs/heads/master", shortName: "master", source: "local" },
    { ref: "refs/heads/develop", shortName: "develop", source: "local" },
    { ref: "refs/heads/dev", shortName: "dev", source: "local" },
    { ref: "refs/heads/trunk", shortName: "trunk", source: "local" }
  ];

  for (const candidate of fallbackRefs) {
    const resolved = await tryRunGitCommand(repoRoot, ["rev-parse", "--verify", candidate.ref]);
    if (resolved?.trim()) {
      return candidate;
    }
  }

  const remoteCandidates = await listBranchRefCandidates(repoRoot, "refs/remotes/origin", "remote");
  if (remoteCandidates.length === 1) {
    return remoteCandidates[0];
  }

  const localCandidates = await listBranchRefCandidates(repoRoot, "refs/heads", "local");
  if (localCandidates.length === 1) {
    return localCandidates[0];
  }

  const candidates = dedupeBranchRefCandidates([...remoteCandidates, ...localCandidates]);
  return candidates[0];
}

async function listBranchRefCandidates(repoRoot: string, refPrefix: string, source: "remote" | "local"): Promise<BranchCandidate[]> {
  const raw = await tryRunGitCommand(repoRoot, ["for-each-ref", "--format=%(refname)", refPrefix]);
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((ref) => ref !== "refs/remotes/origin/HEAD")
    .map((ref) => ({
      ref,
      shortName: ref.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, ""),
      source
    }));
}

function dedupeBranchRefCandidates(candidates: BranchCandidate[]): BranchCandidate[] {
  const priority = (candidate: BranchCandidate): number => {
    const preferredNames = ["main", "master", "develop", "dev", "trunk"];
    const nameIndex = preferredNames.indexOf(candidate.shortName);
    const sourceWeight = candidate.source === "remote" ? 0 : 10;
    return sourceWeight + (nameIndex >= 0 ? nameIndex : preferredNames.length + 1);
  };

  return candidates
    .slice()
    .sort((left, right) => {
      const leftPriority = priority(left);
      const rightPriority = priority(right);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return left.shortName.localeCompare(right.shortName);
    })
    .filter((candidate, index, all) => {
      const firstIndex = all.findIndex(
        (entry) => entry.shortName === candidate.shortName && entry.source === candidate.source
      );
      return firstIndex === index;
    });
}

async function getTrackedDiffEntries(
  repoRoot: string,
  defaultRef: string
): Promise<Array<{ status: string; displayPath: string; pathSpec: string }>> {
  const raw = await runGitCommand(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--name-status", defaultRef]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "M";
      if (status.startsWith("R") || status.startsWith("C")) {
        const fromPath = parts[1] ?? "";
        const toPath = parts[2] ?? fromPath;
        return {
          status,
          displayPath: `${fromPath} -> ${toPath}`,
          pathSpec: toPath
        };
      }

      return {
        status,
        displayPath: parts[1] ?? parts[0],
        pathSpec: parts[1] ?? parts[0]
      };
    });
}

async function getUntrackedFiles(repoRoot: string): Promise<string[]> {
  const raw = await runGitCommand(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function formatLocalChangeSections(
  repoRoot: string,
  defaultRef: string,
  changedEntries: Array<{ status: string; displayPath: string; pathSpec: string }>,
  untrackedFiles: string[]
): Promise<string> {
  const trackedSections = await Promise.all(
    changedEntries.map(async (entry) => {
      const patch = (
        await runGitCommand(repoRoot, ["diff", "--no-ext-diff", "--find-renames", "--unified=3", defaultRef, "--", entry.pathSpec])
      ).trim();
      const displayPatch = patch.length > 0 ? patch.slice(0, 4000) : "(No textual diff available)";
      return `File: ${entry.displayPath}\nStatus: ${entry.status}\nPatch:\n${displayPatch}`;
    })
  );

  const untrackedSections = await Promise.all(
    untrackedFiles.map(async (filePath) => {
      const absolutePath = path.join(repoRoot, filePath);
      let content = "(Binary or unreadable untracked file)";
      try {
        const buffer = await fs.readFile(absolutePath);
        content = buffer.includes(0) ? "(Binary untracked file)" : buffer.toString("utf8").slice(0, 4000);
      } catch {
        // Keep fallback text.
      }

      return `File: ${filePath}\nStatus: ??\nPatch:\n${content}`;
    })
  );

  return [...trackedSections, ...untrackedSections].join("\n\n---\n\n");
}

async function runGitCommand(
  repoRoot: string,
  args: string[],
  options: {
    timeoutMs?: number;
  } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      {
        cwd: repoRoot,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeoutMs,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never"
        }
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim() || `git ${args.join(" ")} failed`));
          return;
        }

        resolve(stdout);
      }
    );
  });
}

async function tryRunGitCommand(repoRoot: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGitCommand(repoRoot, args);
  } catch {
    return undefined;
  }
}

async function resolveRepoInfoFromGit(repoRoot: string): Promise<{ owner: string; repo: string } | undefined> {
  const remoteUrl = (await tryRunGitCommand(repoRoot, ["config", "--get", "remote.origin.url"]))?.trim();
  return remoteUrl ? parseRepoFromRemote(remoteUrl) : undefined;
}

function parseRepoFromRemote(remoteUrl: string): { owner: string; repo: string } | undefined {
  const cleaned = remoteUrl.replace(/\.git$/, "");
  const httpsMatch = cleaned.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return undefined;
}

function resolveBundledWorkflowConfigPath(): string {
  const fromEnv = process.env.CMSIS_DEV_BUNDLED_WORKFLOW_CONFIG?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const extensionPath = process.env.CMSIS_DEV_EXTENSION_PATH?.trim();
  if (extensionPath) {
    return path.join(extensionPath, ".cmsis-dev", "workflows");
  }

  return path.resolve(__dirname, "..", "..", ".cmsis-dev", "workflows");
}

function resolveWorkflowRunsDirPath(workspaceWorkflowConfigPath?: string): string {
  const fromEnv = process.env.CMSIS_DEV_WORKFLOW_RUNS_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  if (workspaceWorkflowConfigPath) {
    return path.join(path.dirname(workspaceWorkflowConfigPath), "runs");
  }

  return path.join(process.cwd(), ".cmsis-dev", "runs");
}

async function resolveWorkspaceWorkflowConfigPath(): Promise<string | undefined> {
  const fromEnv = process.env.CMSIS_DEV_WORKSPACE_WORKFLOW_CONFIG?.trim();
  if (fromEnv && (await fileExists(fromEnv))) {
    return fromEnv;
  }

  const directDir = path.join(process.cwd(), ".cmsis-dev", "workflows");
  if (await fileExists(directDir)) {
    return directDir;
  }

  const directPath = path.join(process.cwd(), ".cmsis-dev", "workflows.yml");
  if (await fileExists(directPath)) {
    return directPath;
  }

  const nestedPath = await findNestedWorkflowConfig(process.cwd(), 6);
  if (nestedPath) {
    return nestedPath;
  }

  return undefined;
}

async function findNestedWorkflowConfig(rootDir: string, maxDepth: number): Promise<string | undefined> {
  const skipDirs = new Set([".git", "node_modules", "out", "dist"]);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const candidates = [path.join(current.dir, ".cmsis-dev", "workflows"), path.join(current.dir, ".cmsis-dev", "workflows.yml")];
    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }

    if (current.depth >= maxDepth) {
      continue;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || skipDirs.has(entry.name)) {
        continue;
      }

      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return undefined;
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadEffectiveWorkflowDefinitions(
  bundledWorkflowConfigPath: string,
  workspaceWorkflowConfigPath?: string
): Promise<WorkflowDefinition[]> {
  const [bundledWorkflows, workspaceWorkflows] = await Promise.all([
    loadWorkflowDefinitions(bundledWorkflowConfigPath),
    workspaceWorkflowConfigPath ? loadWorkflowDefinitions(workspaceWorkflowConfigPath) : Promise.resolve([])
  ]);

  return mergeWorkflowDefinitions(bundledWorkflows, workspaceWorkflows);
}

async function loadWorkflowDefinitions(workflowConfigPath: string): Promise<WorkflowDefinition[]> {
  try {
    const stats = await fs.stat(workflowConfigPath);
    if (stats.isDirectory()) {
      const entries = (await fs.readdir(workflowConfigPath))
        .filter((entry) => entry.toLowerCase().endsWith(".yml") || entry.toLowerCase().endsWith(".yaml"))
        .sort((left, right) => left.localeCompare(right));
      const loaded = await Promise.all(entries.map((entry) => loadWorkflowDefinitionsFromFile(path.join(workflowConfigPath, entry))));
      return loaded.flat();
    }

    return loadWorkflowDefinitionsFromFile(workflowConfigPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CMSIS-Dev MCP] Failed to load workflow config '${workflowConfigPath}': ${message}`);
    return [];
  }
}

async function loadWorkflowDefinitionsFromFile(workflowConfigPath: string): Promise<WorkflowDefinition[]> {
  try {
    const raw = await fs.readFile(workflowConfigPath, "utf8");
    const parsed = parse(raw) as
      | { workflows?: WorkflowDefinition[]; workflow?: WorkflowDefinition }
      | WorkflowDefinition
      | undefined;

    if (!parsed) {
      return [];
    }

    if (Array.isArray((parsed as { workflows?: WorkflowDefinition[] }).workflows)) {
      return (parsed as { workflows: WorkflowDefinition[] }).workflows;
    }

    if ((parsed as { workflow?: WorkflowDefinition }).workflow) {
      return [(parsed as { workflow: WorkflowDefinition }).workflow];
    }

    if (isWorkflowDefinition(parsed)) {
      return [parsed];
    }

    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[CMSIS-Dev MCP] Failed to parse workflow config '${workflowConfigPath}': ${message}`);
    return [];
  }
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkflowDefinition>;
  return typeof candidate.id === "string";
}

function dedupeWorkflows(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
  const unique = new Map<string, WorkflowDefinition>();
  for (const workflow of workflows) {
    if (!workflow.id || unique.has(workflow.id)) {
      continue;
    }
    unique.set(workflow.id, workflow);
  }
  return Array.from(unique.values());
}

function mergeWorkflowDefinitions(
  bundledWorkflows: WorkflowDefinition[],
  workspaceWorkflows: WorkflowDefinition[]
): WorkflowDefinition[] {
  const merged = new Map<string, WorkflowDefinition>();

  for (const workflow of bundledWorkflows) {
    if (!workflow.id || merged.has(workflow.id)) {
      continue;
    }

    merged.set(workflow.id, workflow);
  }

  for (const workflow of workspaceWorkflows) {
    if (!workflow.id) {
      continue;
    }

    merged.set(workflow.id, workflow);
  }

  return Array.from(merged.values());
}

function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, key: string) => values[key] ?? "");
}

function toMcpToolName(workflowId: string): string {
  return workflowId.replace(/-/g, "_");
}

function getPrContextArgNames(inputId: string, contextCount: number): { owner: string; repo: string; pullNumber: string } {
  if (contextCount === 1) {
    return { owner: "owner", repo: "repo", pullNumber: "pullNumber" };
  }

  return {
    owner: `${inputId}Owner`,
    repo: `${inputId}Repo`,
    pullNumber: `${inputId}PullNumber`
  };
}

function getIssueContextArgNames(inputId: string, contextCount: number): { owner: string; repo: string; issueNumber: string } {
  if (contextCount === 1) {
    return { owner: "owner", repo: "repo", issueNumber: "issueNumber" };
  }

  return {
    owner: `${inputId}Owner`,
    repo: `${inputId}Repo`,
    issueNumber: `${inputId}IssueNumber`
  };
}

function getLocalChangesArgNames(inputId: string, contextCount: number): { repoPath: string } {
  if (contextCount === 1) {
    return { repoPath: "repoPath" };
  }

  return { repoPath: `${inputId}RepoPath` };
}

function expectStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required argument '${key}'.`);
  }
  return value.trim();
}

function expectNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Missing required numeric argument '${key}'.`);
  }
  return value;
}

function isReviewChangesWorkflowId(workflowId: string | undefined): boolean {
  return workflowId === "review-changes";
}
