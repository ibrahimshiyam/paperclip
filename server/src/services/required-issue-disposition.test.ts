import { describe, expect, it } from "vitest";
import {
  REQUIRED_ISSUE_DISPOSITION_ERROR_CODE,
  decideRequiredIssueDisposition,
} from "./required-issue-disposition.js";

const issue = {
  id: "issue-1",
  status: "in_progress",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
};

describe("required issue disposition", () => {
  it("fails closed when the assigned issue remains in progress", () => {
    expect(REQUIRED_ISSUE_DISPOSITION_ERROR_CODE).toBe("missing_issue_disposition");
    expect(decideRequiredIssueDisposition({
      enabled: true,
      issueId: issue.id,
      runAgentId: "agent-1",
      issue,
    })).toEqual({
      kind: "violation",
      reason: "agent process exited successfully while its assigned issue remained in_progress",
    });
  });

  it.each(["done", "cancelled", "in_review", "blocked", "todo", "backlog"])(
    "accepts an explicit %s status",
    (status) => {
      expect(decideRequiredIssueDisposition({
        enabled: true,
        issueId: issue.id,
        runAgentId: "agent-1",
        issue: { ...issue, status },
      }).kind).toBe("satisfied");
    },
  );

  it("accepts an explicit ownership handoff", () => {
    expect(decideRequiredIssueDisposition({
      enabled: true,
      issueId: issue.id,
      runAgentId: "agent-1",
      issue: { ...issue, assigneeAgentId: "agent-2" },
    }).kind).toBe("satisfied");
  });

  it("does not affect agents that did not opt into the contract", () => {
    expect(decideRequiredIssueDisposition({
      enabled: false,
      issueId: issue.id,
      runAgentId: "agent-1",
      issue,
    })).toEqual({ kind: "satisfied", reason: "contract disabled" });
  });
});
