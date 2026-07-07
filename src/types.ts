export interface WorkflowInputDefinition {
  id: string;
  label: string;
  type?: "text" | "github-pr-context" | "github-issue-context" | "git-local-changes-context" | "run-output-context";
  placeholder?: string;
  required?: boolean;
}

export type WorkflowFollowUp =
  | "openReasoning"
  | "openPr"
  | "openIssue"
  | "postComment"
  | "submitPr";

export interface WorkflowDefinition {
  id: string;
  title: string;
  description: string;
  type: "review-pr" | string;
  inputs: WorkflowInputDefinition[];
  promptTemplate?: string;
  followUps?: WorkflowFollowUp[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  htmlUrl: string;
  author: string;
  baseRef: string;
  headRef: string;
  body: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  htmlUrl: string;
  author: string;
  body: string;
  state: string;
  labels: string[];
  assignees: string[];
  commentsCount: number;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}
