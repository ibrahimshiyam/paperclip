#!/usr/bin/env python3
"""Structured, verified Paperclip task operations for local OpenCode agents."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from mcp.server.mcpserver import MCPServer


HELPER = "/home/paperclip/.paperclip/bin/task_workspace.py"
ALLOWED_STATUSES = frozenset(
    {"backlog", "todo", "in_progress", "in_review", "done", "blocked"}
)


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _relative_file(value: str) -> str:
    path = Path(value.strip())
    if not value.strip() or path.is_absolute() or ".." in path.parts:
        raise ValueError("file must be a relative task-workspace path without '..'")
    return str(path)


def _run_helper(*args: str) -> str:
    completed = subprocess.run(
        [HELPER, *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"task operation failed: {detail or completed.returncode}")
    return completed.stdout.strip()


def _api_base() -> str:
    base = _require_env("PAPERCLIP_API_URL").rstrip("/")
    return base[:-4] if base.endswith("/api") else base


def _api_request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    headers = {
        "Authorization": f"Bearer {_require_env('PAPERCLIP_API_KEY')}",
        "Accept": "application/json",
    }
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "").strip()
    if run_id:
        headers["X-Paperclip-Run-Id"] = run_id
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        _api_base() + path,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:2000]
        raise RuntimeError(f"Paperclip API {method} failed: HTTP {exc.code}: {detail}") from exc
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Paperclip API returned invalid JSON") from exc


def _write_text(file: str, content: str) -> str:
    file = _relative_file(file)
    if not content:
        raise ValueError("content must not be empty")
    encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")
    return _run_helper("write-base64", file, encoded)


def _publish(file: str, key: str, title: str, change_summary: str) -> str:
    if not key.strip() or not title.strip():
        raise ValueError("key and title must not be empty")
    return _run_helper(
        "publish-review",
        "--file",
        _relative_file(file),
        "--key",
        key.strip(),
        "--title",
        title.strip(),
        "--change-summary",
        change_summary.strip() or "Published verified task result",
        "--min-revision",
        "1",
    )


def _create_decision(
    title: str,
    summary: str,
    question_id: str,
    prompt: str,
    options: list[dict[str, Any]],
    idempotency_key: str,
) -> dict[str, Any]:
    if not all(item.strip() for item in (title, question_id, prompt, idempotency_key)):
        raise ValueError("title, question_id, prompt, and idempotency_key are required")
    if not 2 <= len(options) <= 10:
        raise ValueError("provide between 2 and 10 decision options")
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for option in options:
        option_id = str(option.get("id") or "").strip()
        label = str(option.get("label") or "").strip()
        if not option_id or not label:
            raise ValueError("every option requires non-empty id and label")
        if option_id in seen:
            raise ValueError("decision option ids must be unique")
        seen.add(option_id)
        item: dict[str, Any] = {"id": option_id, "label": label}
        description = str(option.get("description") or "").strip()
        if description:
            item["description"] = description
        if option.get("freeText") is True:
            item["freeText"] = True
        normalized.append(item)

    task_id = urllib.parse.quote(_require_env("PAPERCLIP_TASK_ID"), safe="")
    payload = {
        "kind": "ask_user_questions",
        "resolverPolicy": "human_only",
        "continuationPolicy": "wake_assignee",
        "idempotencyKey": idempotency_key.strip(),
        "title": title.strip(),
        "summary": summary.strip() or None,
        "payload": {
            "version": 1,
            "questions": [
                {
                    "id": question_id.strip(),
                    "prompt": prompt.strip(),
                    "selectionMode": "single",
                    "required": True,
                    "options": normalized,
                }
            ],
        },
    }
    created = _api_request("POST", f"/api/issues/{task_id}/interactions", payload)
    interaction_id = created.get("id") if isinstance(created, dict) else None
    interactions = _api_request("GET", f"/api/issues/{task_id}/interactions")
    if not isinstance(interactions, list):
        raise RuntimeError("interaction verification returned a non-list response")
    verified = next(
        (
            item
            for item in interactions
            if isinstance(item, dict)
            and (
                (interaction_id and item.get("id") == interaction_id)
                or item.get("idempotencyKey") == idempotency_key.strip()
            )
        ),
        None,
    )
    if not verified or verified.get("status") != "pending":
        raise RuntimeError("decision interaction was not verified as pending")
    return {
        "id": verified.get("id"),
        "status": verified.get("status"),
        "kind": verified.get("kind"),
        "title": verified.get("title"),
    }


async def task_issue_summary() -> dict[str, Any]:
    """Return the current issue, assignee, status, and published document summaries."""

    raw = await asyncio.to_thread(_run_helper, "issue-summary")
    return json.loads(raw)


async def task_write_report(file: str, content: str) -> dict[str, str]:
    """Write a complete UTF-8 report to the current task workspace without shell quoting."""

    result = await asyncio.to_thread(_write_text, file, content)
    return {"file": _relative_file(file), "result": result}


async def task_publish_report(
    file: str,
    key: str,
    title: str,
    change_summary: str = "Published verified task result",
) -> dict[str, str]:
    """Publish a workspace report as a durable issue document and verify its body."""

    result = await asyncio.to_thread(_publish, file, key, title, change_summary)
    return {"file": _relative_file(file), "key": key, "result": result}


async def task_add_result_comment(body: str) -> dict[str, str]:
    """Add a non-empty result comment to the current issue."""

    if not body.strip():
        raise ValueError("comment body must not be empty")
    result = await asyncio.to_thread(_run_helper, "add-comment", body.strip())
    return {"result": result}


async def task_set_disposition(status: str) -> dict[str, str]:
    """Set and verify the current issue disposition."""

    if status not in ALLOWED_STATUSES:
        raise ValueError(f"status must be one of {sorted(ALLOWED_STATUSES)}")
    result = await asyncio.to_thread(_run_helper, "set-status", status)
    return {"status": status, "result": result}


async def task_assign_current_issue(
    agent_id: str,
    status: str = "todo",
    comment: str | None = None,
) -> dict[str, str]:
    """Assign the current issue to a verified agent UUID and leave a handoff status."""

    if status not in ALLOWED_STATUSES - {"done"}:
        raise ValueError("handoff status cannot be done")
    args = ["assign-agent", agent_id, "--status", status]
    if comment and comment.strip():
        args.extend(["--comment", comment.strip()])
    result = await asyncio.to_thread(_run_helper, *args)
    return {"agent_id": agent_id, "status": status, "result": result}


async def task_complete_with_report(
    file: str,
    content: str,
    key: str,
    title: str,
    comment: str,
    change_summary: str = "Published completed task result",
) -> dict[str, Any]:
    """Write, publish, comment, and mark Done; later steps run only after earlier verification."""

    if not comment.strip():
        raise ValueError("comment must not be empty")
    written = await asyncio.to_thread(_write_text, file, content)
    published = await asyncio.to_thread(_publish, file, key, title, change_summary)
    commented = await asyncio.to_thread(_run_helper, "add-comment", comment.strip())
    disposed = await asyncio.to_thread(_run_helper, "set-status", "done")
    summary = json.loads(await asyncio.to_thread(_run_helper, "issue-summary"))
    if summary.get("status") != "done":
        raise RuntimeError("final issue read-back is not done")
    return {
        "status": "done",
        "file": _relative_file(file),
        "key": key,
        "written": written,
        "published": published,
        "commented": commented,
        "disposed": disposed,
        "issue": summary,
    }


async def task_submit_report_for_review(
    file: str,
    content: str,
    key: str,
    title: str,
    comment: str,
    decision_title: str,
    decision_summary: str,
    question_id: str,
    question_prompt: str,
    options: list[dict[str, Any]],
    idempotency_key: str,
    change_summary: str = "Published task result for human review",
) -> dict[str, Any]:
    """Publish a report, create a clickable human decision, then verify In Review."""

    if not comment.strip():
        raise ValueError("comment must not be empty")
    written = await asyncio.to_thread(_write_text, file, content)
    published = await asyncio.to_thread(_publish, file, key, title, change_summary)
    decision = await asyncio.to_thread(
        _create_decision,
        decision_title,
        decision_summary,
        question_id,
        question_prompt,
        options,
        idempotency_key,
    )
    commented = await asyncio.to_thread(_run_helper, "add-comment", comment.strip())
    disposed = await asyncio.to_thread(_run_helper, "set-status", "in_review")
    summary = json.loads(await asyncio.to_thread(_run_helper, "issue-summary"))
    if summary.get("status") != "in_review":
        raise RuntimeError("final issue read-back is not in_review")
    return {
        "status": "in_review",
        "file": _relative_file(file),
        "key": key,
        "written": written,
        "published": published,
        "decision": decision,
        "commented": commented,
        "disposed": disposed,
        "issue": summary,
    }


mcp = MCPServer("paperclip-task-operations")
mcp.tool()(task_issue_summary)
mcp.tool()(task_write_report)
mcp.tool()(task_publish_report)
mcp.tool()(task_add_result_comment)
mcp.tool()(task_set_disposition)
mcp.tool()(task_assign_current_issue)
mcp.tool()(task_complete_with_report)
mcp.tool()(task_submit_report_for_review)


if __name__ == "__main__":
    asyncio.run(mcp.run_stdio_async())
