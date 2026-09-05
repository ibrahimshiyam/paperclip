#!/usr/bin/env python3
"""Read-only web discovery and page inspection tools for Paperclip agents."""

from __future__ import annotations

import asyncio
import concurrent.futures
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from bs4 import BeautifulSoup
from ddgs import DDGS
from mcp.server.mcpserver import MCPServer


DEFAULT_BACKENDS = ("duckduckgo", "bing", "brave", "mojeek", "startpage")
ALLOWED_BACKENDS = frozenset(DEFAULT_BACKENDS + ("google", "yahoo"))
TRACKING_KEYS = frozenset(
    {
        "fbclid",
        "gclid",
        "mc_cid",
        "mc_eid",
        "msclkid",
        "ref_src",
    }
)
USER_AGENT = "Paperclip-Search/1.0 (+read-only research tool)"
MAX_QUERY_COUNT = 12
MAX_BACKEND_COUNT = 5
MAX_RESULTS_PER_REQUEST = 20
MAX_PAGE_COUNT = 8
MAX_RESPONSE_BYTES = 3_000_000
MAX_TEXT_CHARS = 16_000


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Only absolute HTTP or HTTPS URLs are supported")
    host = parsed.hostname.lower().rstrip(".")
    port = parsed.port
    netloc = host
    if port and not (
        (parsed.scheme.lower() == "http" and port == 80)
        or (parsed.scheme.lower() == "https" and port == 443)
    ):
        netloc = f"{host}:{port}"
    query = []
    for key, item in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True):
        lower = key.lower()
        if lower.startswith("utm_") or lower in TRACKING_KEYS:
            continue
        query.append((key, item))
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    return urllib.parse.urlunsplit(
        (parsed.scheme.lower(), netloc, path, urllib.parse.urlencode(query, doseq=True), "")
    )


def _validate_public_url(value: str) -> str:
    canonical = _canonical_url(value)
    parsed = urllib.parse.urlsplit(canonical)
    if parsed.username or parsed.password:
        raise ValueError("URLs containing credentials are not supported")
    host = parsed.hostname or ""
    try:
        default_port = 80 if parsed.scheme == "http" else 443
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                host, parsed.port or default_port, type=socket.SOCK_STREAM
            )
        }
    except socket.gaierror as exc:
        raise ValueError(f"Could not resolve host: {host}") from exc
    if not addresses:
        raise ValueError(f"Could not resolve host: {host}")
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise ValueError("Private, loopback, link-local, and reserved destinations are blocked")
    return canonical


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        _validate_public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _bounded_fetch(url: str, *, timeout: int = 25) -> dict[str, Any]:
    safe_url = _validate_public_url(url)
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    request = urllib.request.Request(
        safe_url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        },
    )
    with opener.open(request, timeout=timeout) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError(f"Response exceeded {MAX_RESPONSE_BYTES} bytes")
        content_type = response.headers.get_content_type()
        charset = response.headers.get_content_charset() or "utf-8"
        return {
            "requested_url": safe_url,
            "final_url": _validate_public_url(response.geturl()),
            "http_status": response.status,
            "content_type": content_type,
            "text": body.decode(charset, errors="replace"),
        }


def _json_ld_records(soup: BeautifulSoup) -> tuple[list[str], list[dict[str, Any]]]:
    types: list[str] = []
    job_postings: list[dict[str, Any]] = []

    def walk(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        raw_type = value.get("@type")
        record_types = raw_type if isinstance(raw_type, list) else [raw_type]
        for item in record_types:
            if isinstance(item, str) and item not in types:
                types.append(item)
        if any(str(item).lower() == "jobposting" for item in record_types):
            keep = {
                key: value.get(key)
                for key in (
                    "title",
                    "datePosted",
                    "validThrough",
                    "employmentType",
                    "hiringOrganization",
                    "jobLocation",
                    "applicantLocationRequirements",
                    "baseSalary",
                    "url",
                )
                if value.get(key) is not None
            }
            job_postings.append(keep)
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                walk(nested)

    for node in soup.find_all("script", attrs={"type": re.compile(r"ld\+json", re.I)}):
        raw = node.string or node.get_text(" ", strip=True)
        if not raw or len(raw) > 500_000:
            continue
        try:
            walk(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return types[:50], job_postings[:10]


def _html_structure(payload: dict[str, Any], *, max_text_chars: int) -> dict[str, Any]:
    html = payload["text"]
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else None
    canonical_node = soup.find(
        "link", attrs={"rel": lambda value: value and "canonical" in value}
    )
    canonical = None
    if canonical_node and canonical_node.get("href"):
        try:
            canonical = _canonical_url(
                urllib.parse.urljoin(payload["final_url"], canonical_node["href"])
            )
        except (TypeError, ValueError):
            canonical = None
    headings = [
        {"level": node.name, "text": node.get_text(" ", strip=True)[:500]}
        for node in soup.find_all(re.compile(r"^h[1-6]$"))
        if node.get_text(" ", strip=True)
    ][:60]
    links: list[dict[str, str]] = []
    seen_links: set[str] = set()
    for node in soup.find_all("a", href=True):
        href = urllib.parse.urljoin(payload["final_url"], str(node["href"]))
        try:
            href = _canonical_url(href)
        except ValueError:
            continue
        if href in seen_links:
            continue
        seen_links.add(href)
        links.append({"text": node.get_text(" ", strip=True)[:300], "url": href})
        if len(links) >= 120:
            break
    forms = [
        {
            "method": str(node.get("method") or "get").lower(),
            "action": urllib.parse.urljoin(payload["final_url"], str(node.get("action") or "")),
        }
        for node in soup.find_all("form")[:20]
    ]
    schema_types, job_postings = _json_ld_records(soup)
    script_count = len(soup.find_all("script"))
    for node in soup(["script", "style", "noscript", "svg", "template"]):
        node.decompose()
    body_text = "\n".join(
        line.strip()
        for line in soup.get_text("\n").splitlines()
        if line.strip()
    )
    lower = body_text.lower()
    shell_markers = (
        "enable javascript",
        "javascript is required",
        "checking your browser",
        "access denied",
        "just a moment",
    )
    likely_js_shell = len(body_text) < 500 or any(marker in lower for marker in shell_markers)
    return {
        "title": title,
        "canonical_url": canonical or payload["final_url"],
        "headings": headings,
        "links": links,
        "forms": forms,
        "schema_types": schema_types,
        "job_postings": job_postings,
        "script_count": script_count,
        "likely_javascript_shell": likely_js_shell,
        "text": body_text[:max_text_chars],
        "text_truncated": len(body_text) > max_text_chars,
        "text_chars_available": len(body_text),
    }


def _jina_reader(url: str, *, max_text_chars: int) -> dict[str, Any]:
    safe_url = _validate_public_url(url)
    jina_url = "https://r.jina.ai/" + safe_url
    payload = _bounded_fetch(jina_url, timeout=35)
    text = payload["text"].strip()
    return {
        "requested_url": safe_url,
        "final_url": safe_url,
        "http_status": payload["http_status"],
        "content_type": payload["content_type"],
        "retrieval_method": "jina_reader_fallback",
        "title": next(
            (line[7:].strip() for line in text.splitlines() if line.startswith("Title: ")),
            None,
        ),
        "canonical_url": safe_url,
        "headings": [],
        "links": [],
        "forms": [],
        "schema_types": [],
        "job_postings": [],
        "script_count": None,
        "likely_javascript_shell": False,
        "text": text[:max_text_chars],
        "text_truncated": len(text) > max_text_chars,
        "text_chars_available": len(text),
    }


def _inspect_one(
    url: str, *, allow_jina_fallback: bool, max_text_chars: int
) -> dict[str, Any]:
    started = _utc_now()
    direct_error: str | None = None
    try:
        payload = _bounded_fetch(url)
        if payload["content_type"] in {"text/html", "application/xhtml+xml"}:
            structure = _html_structure(payload, max_text_chars=max_text_chars)
            result = {key: value for key, value in payload.items() if key != "text"}
            result.update(structure)
            result["retrieval_method"] = "direct_html"
            if result["likely_javascript_shell"] and allow_jina_fallback:
                fallback = _jina_reader(url, max_text_chars=max_text_chars)
                if fallback["text_chars_available"] > result["text_chars_available"]:
                    fallback["direct_http_status"] = payload["http_status"]
                    fallback["direct_issue"] = (
                        "Page appeared to be a JavaScript or access-control shell"
                    )
                    result = fallback
        else:
            text = payload.pop("text")
            result = {
                **payload,
                "retrieval_method": "direct_text",
                "canonical_url": payload["final_url"],
                "title": None,
                "headings": [],
                "links": [],
                "forms": [],
                "schema_types": [],
                "job_postings": [],
                "script_count": None,
                "likely_javascript_shell": False,
                "text": text[:max_text_chars],
                "text_truncated": len(text) > max_text_chars,
                "text_chars_available": len(text),
            }
    except (OSError, ValueError, urllib.error.URLError) as exc:
        direct_error = f"{type(exc).__name__}: {exc}"
        if not allow_jina_fallback:
            return {"url": url, "status": "error", "checked_at": started, "error": direct_error}
        try:
            result = _jina_reader(url, max_text_chars=max_text_chars)
            result["direct_error"] = direct_error
        except (OSError, ValueError, urllib.error.URLError) as fallback_exc:
            return {
                "url": url,
                "status": "error",
                "checked_at": started,
                "error": direct_error,
                "fallback_error": f"{type(fallback_exc).__name__}: {fallback_exc}",
            }
    result["status"] = "ok"
    result["checked_at"] = started
    return result


def _search_one(
    query: str, backend: str, max_results: int, timelimit: str | None
) -> dict[str, Any]:
    started = _utc_now()
    try:
        results = list(
            DDGS(timeout=15).text(
                query=query,
                region="wt-wt",
                safesearch="moderate",
                timelimit=timelimit,
                max_results=max_results,
                backend=backend,
            )
        )
        return {
            "query": query,
            "engine": backend,
            "started_at": started,
            "finished_at": _utc_now(),
            "status": "ok",
            "result_count": len(results),
            "results": results,
        }
    except Exception as exc:  # DDGS backends expose several provider-specific exceptions.
        return {
            "query": query,
            "engine": backend,
            "started_at": started,
            "finished_at": _utc_now(),
            "status": "error",
            "result_count": 0,
            "error": f"{type(exc).__name__}: {str(exc)[:500]}",
            "results": [],
        }


def _validate_search_inputs(
    queries: list[str],
    backends: list[str] | None,
    max_results_per_engine: int,
    timelimit: str | None,
) -> tuple[list[str], list[str], int, str | None]:
    clean_queries = list(dict.fromkeys(item.strip() for item in queries if item.strip()))
    if not clean_queries or len(clean_queries) > MAX_QUERY_COUNT:
        raise ValueError(f"Provide between 1 and {MAX_QUERY_COUNT} distinct non-empty queries")
    clean_backends = list(
        dict.fromkeys(item.strip().lower() for item in (backends or DEFAULT_BACKENDS))
    )
    if not clean_backends or len(clean_backends) > MAX_BACKEND_COUNT:
        raise ValueError(f"Provide between 1 and {MAX_BACKEND_COUNT} search engines")
    invalid = sorted(set(clean_backends) - ALLOWED_BACKENDS)
    if invalid:
        raise ValueError(f"Unsupported search engines: {', '.join(invalid)}")
    if not 1 <= max_results_per_engine <= MAX_RESULTS_PER_REQUEST:
        raise ValueError(
            f"max_results_per_engine must be between 1 and {MAX_RESULTS_PER_REQUEST}"
        )
    if timelimit not in {None, "d", "w", "m", "y"}:
        raise ValueError("timelimit must be one of d, w, m, y, or null")
    return clean_queries, clean_backends, max_results_per_engine, timelimit


def _search_batch_sync(
    queries: list[str],
    backends: list[str] | None,
    max_results_per_engine: int,
    timelimit: str | None,
) -> dict[str, Any]:
    clean_queries, clean_backends, max_results, clean_timelimit = _validate_search_inputs(
        queries, backends, max_results_per_engine, timelimit
    )
    started = _utc_now()
    jobs = [(query, backend) for query in clean_queries for backend in clean_backends]
    requests: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(jobs))) as pool:
        futures = {
            pool.submit(_search_one, query, backend, max_results, clean_timelimit): (query, backend)
            for query, backend in jobs
        }
        for future in concurrent.futures.as_completed(futures):
            requests.append(future.result())
    requests.sort(
        key=lambda item: (
            clean_queries.index(item["query"]),
            clean_backends.index(item["engine"]),
        )
    )

    aggregated: dict[str, dict[str, Any]] = {}
    for request in requests:
        for rank, raw in enumerate(request.pop("results"), start=1):
            href = str(raw.get("href") or raw.get("url") or "").strip()
            if not href:
                continue
            try:
                canonical = _canonical_url(href)
            except ValueError:
                continue
            item = aggregated.setdefault(
                canonical,
                {
                    "url": canonical,
                    "title": str(raw.get("title") or "").strip(),
                    "snippet": str(
                        raw.get("body") or raw.get("description") or ""
                    ).strip(),
                    "engines": [],
                    "queries": [],
                    "best_rank": rank,
                },
            )
            if request["engine"] not in item["engines"]:
                item["engines"].append(request["engine"])
            if request["query"] not in item["queries"]:
                item["queries"].append(request["query"])
            item["best_rank"] = min(item["best_rank"], rank)
            if len(str(raw.get("body") or "")) > len(item["snippet"]):
                item["snippet"] = str(raw.get("body") or "").strip()
    results = list(aggregated.values())
    for item in results:
        item["corroboration_score"] = (
            len(item["engines"]) * 10
            + len(item["queries"]) * 3
            - item["best_rank"]
        )
    results.sort(
        key=lambda item: (
            -item["corroboration_score"],
            item["best_rank"],
            item["url"],
        )
    )
    ok_requests = sum(item["status"] == "ok" for item in requests)
    return {
        "started_at": started,
        "finished_at": _utc_now(),
        "query_count": len(clean_queries),
        "engine_count": len(clean_backends),
        "request_count": len(requests),
        "successful_requests": ok_requests,
        "failed_requests": len(requests) - ok_requests,
        "unique_result_count": len(results),
        "requests": requests,
        "results": results,
    }


async def search_web_batch(
    queries: list[str],
    backends: list[str] | None = None,
    max_results_per_engine: int = 8,
    timelimit: str | None = None,
) -> dict[str, Any]:
    """Run bounded multi-engine web searches with per-request evidence and deduplication.

    Use multiple focused queries, including site: filters for official portals. The result includes
    every executed engine request, errors, counts, canonical URLs, and cross-engine corroboration.
    """

    return await asyncio.to_thread(
        _search_batch_sync, queries, backends, max_results_per_engine, timelimit
    )


async def inspect_web_pages(
    urls: list[str],
    allow_jina_fallback: bool = True,
    max_text_chars: int = 12_000,
) -> dict[str, Any]:
    """Inspect page structure, then extract text, with Jina Reader for difficult pages.

    Returns headings, links, forms, schema.org types, JobPosting JSON-LD, and bounded readable text.
    This tool is read-only and blocks private or local network destinations.
    """

    clean_urls = list(dict.fromkeys(item.strip() for item in urls if item.strip()))
    if not clean_urls or len(clean_urls) > MAX_PAGE_COUNT:
        raise ValueError(f"Provide between 1 and {MAX_PAGE_COUNT} distinct URLs")
    if not 500 <= max_text_chars <= MAX_TEXT_CHARS:
        raise ValueError(f"max_text_chars must be between 500 and {MAX_TEXT_CHARS}")
    started = _utc_now()
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(clean_urls))) as pool:
        futures = [
            pool.submit(
                _inspect_one,
                url,
                allow_jina_fallback=allow_jina_fallback,
                max_text_chars=max_text_chars,
            )
            for url in clean_urls
        ]
        pages = [future.result() for future in futures]
    return {
        "started_at": started,
        "finished_at": _utc_now(),
        "page_count": len(pages),
        "successful_pages": sum(page["status"] == "ok" for page in pages),
        "failed_pages": sum(page["status"] != "ok" for page in pages),
        "pages": pages,
    }


mcp = MCPServer("paperclip-effective-search")
mcp.tool()(search_web_batch)
mcp.tool()(inspect_web_pages)


if __name__ == "__main__":
    asyncio.run(mcp.run_stdio_async())
