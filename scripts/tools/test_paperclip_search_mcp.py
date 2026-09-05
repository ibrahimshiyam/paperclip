from __future__ import annotations

import unittest
from unittest.mock import patch

import paperclip_search_mcp as search


class CanonicalUrlTests(unittest.TestCase):
    def test_removes_tracking_and_fragment_without_losing_identifiers(self) -> None:
        self.assertEqual(
            search._canonical_url("HTTPS://Jobs.Example.com:443/role/42/?id=7&utm_source=x#apply"),
            "https://jobs.example.com/role/42?id=7",
        )

    def test_rejects_non_http_urls(self) -> None:
        with self.assertRaises(ValueError):
            search._canonical_url("file:///etc/passwd")


class HtmlInspectionTests(unittest.TestCase):
    def test_extracts_structure_and_jobposting_schema(self) -> None:
        html = """
        <html><head><title>AI Consultant</title>
        <link rel="canonical" href="/jobs/7?utm_campaign=test">
        <script type="application/ld+json">
        {"@type":"JobPosting","title":"AI Consultant","validThrough":"2026-10-01"}
        </script></head><body><h1>AI Consultant</h1>
        <p>This is a sufficiently detailed public consulting opportunity description
        with international scope.</p>
        <a href="/apply/7">Apply</a></body></html>
        """
        payload = {
            "final_url": "https://jobs.example.com/jobs/7",
            "text": html,
        }
        result = search._html_structure(payload, max_text_chars=4_000)
        self.assertEqual(result["title"], "AI Consultant")
        self.assertEqual(result["canonical_url"], "https://jobs.example.com/jobs/7")
        self.assertEqual(result["schema_types"], ["JobPosting"])
        self.assertEqual(result["job_postings"][0]["validThrough"], "2026-10-01")
        self.assertEqual(result["links"][0]["url"], "https://jobs.example.com/apply/7")


class SearchBatchTests(unittest.TestCase):
    def test_classifies_clean_no_results_as_empty_not_failed(self) -> None:
        with patch.object(search, "DDGS") as ddgs:
            ddgs.return_value.text.side_effect = Exception("No results found.")
            result = search._search_one("rare query", "mojeek", 5, None)

        self.assertEqual(result["status"], "empty")
        self.assertEqual(result["result_count"], 0)
        self.assertNotIn("error", result)

    def test_records_each_request_and_deduplicates_results(self) -> None:
        def fake_search(query: str, backend: str, max_results: int, timelimit: str | None):
            return {
                "query": query,
                "engine": backend,
                "started_at": "2026-09-05T00:00:00Z",
                "finished_at": "2026-09-05T00:00:01Z",
                "status": "ok",
                "result_count": 1,
                "results": [
                    {
                        "title": "Role",
                        "href": "https://jobs.example.com/role/42?utm_source=" + backend,
                        "body": "Official role",
                    }
                ],
            }

        with patch.object(search, "_search_one", side_effect=fake_search):
            result = search._search_batch_sync(
                ["ai consultant", "digital transformation"],
                ["duckduckgo", "brave"],
                5,
                "m",
            )
        self.assertEqual(result["request_count"], 4)
        self.assertEqual(result["completed_requests"], 4)
        self.assertEqual(result["successful_requests"], 4)
        self.assertEqual(result["result_bearing_requests"], 4)
        self.assertEqual(result["empty_requests"], 0)
        self.assertEqual(result["failed_requests"], 0)
        self.assertEqual(result["unique_result_count"], 1)
        self.assertEqual(result["results"][0]["engines"], ["duckduckgo", "brave"])
        self.assertEqual(len(result["results"][0]["queries"]), 2)

    def test_rejects_unbounded_batches(self) -> None:
        with self.assertRaises(ValueError):
            search._validate_search_inputs([f"q{index}" for index in range(13)], None, 8, None)

    def test_distinguishes_empty_requests_from_real_failures(self) -> None:
        def fake_search(query: str, backend: str, max_results: int, timelimit: str | None):
            return {
                "query": query,
                "engine": backend,
                "started_at": "2026-09-05T00:00:00Z",
                "finished_at": "2026-09-05T00:00:01Z",
                "status": "empty" if backend == "yahoo" else "error",
                "result_count": 0,
                "results": [],
                **({"error": "HTTP 429"} if backend == "brave" else {}),
            }

        with patch.object(search, "_search_one", side_effect=fake_search):
            result = search._search_batch_sync(
                ["ai consultant"], ["yahoo", "brave"], 5, None
            )

        self.assertEqual(result["completed_requests"], 1)
        self.assertEqual(result["successful_requests"], 1)
        self.assertEqual(result["result_bearing_requests"], 0)
        self.assertEqual(result["empty_requests"], 1)
        self.assertEqual(result["failed_requests"], 1)


if __name__ == "__main__":
    unittest.main()
