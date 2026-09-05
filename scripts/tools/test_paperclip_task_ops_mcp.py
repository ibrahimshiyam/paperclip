from __future__ import annotations

import asyncio
import base64
import os
import unittest
from unittest.mock import patch

import paperclip_task_ops_mcp as ops


class TaskOpsTests(unittest.TestCase):
    def test_write_uses_base64_helper_without_shell_quoting(self) -> None:
        with patch.object(ops, "_run_helper", return_value="WROTE result.md") as helper:
            result = ops._write_text("result.md", "A quote: ' and a newline\n")

        encoded = helper.call_args.args[2]
        self.assertEqual(helper.call_args.args[:2], ("write-base64", "result.md"))
        self.assertEqual(base64.b64decode(encoded).decode(), "A quote: ' and a newline\n")
        self.assertEqual(result, "WROTE result.md")

    def test_rejects_workspace_escape(self) -> None:
        with self.assertRaises(ValueError):
            ops._relative_file("../other-task/report.md")

    def test_accepts_absolute_path_only_inside_current_task_workspace(self) -> None:
        env = {
            "PAPERCLIP_WORKSPACE_CWD": "/workspace",
            "PAPERCLIP_TASK_ID": "task-1",
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(
                ops._relative_file("/workspace/.paperclip-work/task-1/result.md"),
                "result.md",
            )
            with self.assertRaises(ValueError):
                ops._relative_file("/workspace/another-task/result.md")

    def test_completion_stops_before_status_when_publish_fails(self) -> None:
        calls: list[tuple[str, ...]] = []

        def fake_helper(*args: str) -> str:
            calls.append(args)
            return "WROTE"

        with (
            patch.object(ops, "_run_helper", side_effect=fake_helper),
            patch.object(ops, "_publish", side_effect=RuntimeError("publish failed")),
        ):
            with self.assertRaisesRegex(RuntimeError, "publish failed"):
                asyncio.run(
                    ops.task_complete_with_report(
                        "PER-1.md",
                        "per-1",
                        "PER-1 result",
                        "Completed.",
                        content="report",
                    )
                )

        self.assertFalse(any(call[:2] == ("set-status", "done") for call in calls))

    def test_decision_is_human_only_and_verified_pending(self) -> None:
        calls: list[tuple[str, str, object]] = []

        def fake_request(method: str, path: str, payload=None):
            calls.append((method, path, payload))
            if method == "POST":
                return {"id": "interaction-1"}
            return [
                {
                    "id": "interaction-1",
                    "idempotencyKey": "per-1-choice",
                    "status": "pending",
                    "kind": "ask_user_questions",
                    "title": "Choose next step",
                }
            ]

        env = {
            "PAPERCLIP_API_URL": "http://paperclip.test:3100",
            "PAPERCLIP_API_KEY": "secret",
            "PAPERCLIP_TASK_ID": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(
            ops, "_api_request", side_effect=fake_request
        ):
            result = ops._create_decision(
                "Choose next step",
                "Report ready",
                "next-step",
                "What should happen?",
                [
                    {"id": "proceed", "label": "Proceed"},
                    {"id": "reject", "label": "Reject"},
                ],
                "per-1-choice",
            )

        post = calls[0][2]
        self.assertEqual(post["resolverPolicy"], "human_only")
        self.assertEqual(post["continuationPolicy"], "wake_assignee")
        self.assertEqual(result["status"], "pending")

    def test_review_status_runs_only_after_pending_decision(self) -> None:
        calls: list[tuple[str, ...]] = []

        def fake_helper(*args: str) -> str:
            calls.append(args)
            if args == ("issue-summary",):
                return '{"status":"in_review"}'
            return "OK"

        with (
            patch.object(ops, "_run_helper", side_effect=fake_helper),
            patch.object(ops, "_write_text", return_value="WROTE"),
            patch.object(ops, "_publish", return_value="PUBLISHED"),
            patch.object(
                ops,
                "_create_decision",
                return_value={"id": "interaction-1", "status": "pending"},
            ),
        ):
            result = asyncio.run(
                ops.task_submit_report_for_review(
                    "PER-1.md",
                    "per-1",
                    "PER-1 result",
                    "Ready for review.",
                    "Choose",
                    "Choose a next step",
                    [
                        {"id": "proceed", "label": "Proceed"},
                        {"id": "reject", "label": "Reject"},
                    ],
                    content="report",
                    decision_summary="Report ready",
                    question_id="choice",
                    idempotency_key="per-1-choice",
                )
            )

        self.assertIn(("set-status", "in_review"), calls)
        self.assertEqual(result["status"], "in_review")


if __name__ == "__main__":
    unittest.main()
