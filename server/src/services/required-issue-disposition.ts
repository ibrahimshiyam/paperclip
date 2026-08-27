export const REQUIRED_ISSUE_DISPOSITION_ERROR_CODE = "missing_issue_disposition";
export const REQUIRED_ISSUE_DISPOSITION_OWNER_WAKE_REASON = "required_issue_disposition_violation";
export const REQUIRED_ISSUE_DISPOSITION_NOTICE_BODY =
  "Paperclip blocked this issue because the assigned agent process exited without recording a required issue disposition.";

export type RequiredIssueDispositionDecision =
  | { kind: "satisfied"; reason: string }
  | { kind: "violation"; reason: string };

export function decideRequiredIssueDisposition(input: {
  enabled: boolean;
  issueId: string | null;
  runAgentId: string;
  issue: {
    id: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  } | null;
}): RequiredIssueDispositionDecision {
  if (!input.enabled) return { kind: "satisfied", reason: "contract disabled" };
  if (!input.issueId) return { kind: "satisfied", reason: "run has no issue" };
  if (!input.issue) return { kind: "satisfied", reason: "issue no longer exists" };
  if (input.issue.id !== input.issueId) {
    return { kind: "violation", reason: "resolved issue does not match the run issue" };
  }
  if (
    input.issue.assigneeAgentId !== input.runAgentId ||
    input.issue.assigneeUserId !== null
  ) {
    return { kind: "satisfied", reason: "issue was handed off to another owner" };
  }
  if (input.issue.status !== "in_progress") {
    return { kind: "satisfied", reason: `issue status is ${input.issue.status}` };
  }
  return {
    kind: "violation",
    reason: "agent process exited successfully while its assigned issue remained in_progress",
  };
}
