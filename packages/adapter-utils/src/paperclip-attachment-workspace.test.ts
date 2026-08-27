import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializePaperclipPdfAttachments } from "./paperclip-attachment-workspace.js";
import { renderPaperclipWakePrompt, stringifyPaperclipWakePayload } from "./server-utils.js";

const tempDirs: string[] = [];

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pdf-attachments-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

function pdfBytes(text = "fixture") {
  return new TextEncoder().encode(`%PDF-1.7\n% ${text}\n%%EOF\n`);
}

describe("materializePaperclipPdfAttachments", () => {
  it("turns an uploaded Paperclip PDF attachment into canonical local files before prompt render", async () => {
    const workspace = await makeWorkspace();
    const uploadedPdf = pdfBytes("aca-46");
    const fetched: Array<{ url: string; authorization: string | null; runId: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      fetched.push({
        url,
        authorization: headers.get("authorization"),
        runId: headers.get("x-paperclip-run-id"),
      });
      return new Response(uploadedPdf, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    });

    const context = {
      taskId: "issue-aca-46",
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "issue-aca-46", identifier: "ACA-46", title: "Deep read attached paper" },
        artifactInventory: {
          counts: { documents: 0, workProducts: 0, attachments: 1 },
          documents: [],
          workProducts: [],
          attachments: [
            {
              id: "attachment-1",
              filename: "official paper.pdf",
              contentType: "application/pdf",
              byteSize: uploadedPdf.byteLength,
              contentPath: "/api/attachments/attachment-1/content",
              downloadPath: "/api/attachments/attachment-1/content?download=1",
            },
          ],
        },
      },
    };

    const result = await materializePaperclipPdfAttachments({
      context,
      workspaceCwd: workspace,
      apiBaseUrl: "https://paperclip.example/api",
      apiKey: "run-token",
      runId: "run-46",
      fetchImpl,
    });

    expect(fetched).toEqual([
      {
        url: "https://paperclip.example/api/attachments/attachment-1/content",
        authorization: "Bearer run-token",
        runId: "run-46",
      },
    ]);
    await expect(fs.readFile(path.join(workspace, ".paperclip-work", "issue-aca-46", "paper.pdf"), "utf8"))
      .resolves.toContain("%PDF-1.7");
    await expect(fs.readFile(path.join(workspace, ".paperclip-work", "issue-aca-46", "attachments", "official_paper.pdf"), "utf8"))
      .resolves.toContain("%PDF-1.7");
    expect(result.materialized).toEqual([
      {
        id: "attachment-1",
        filename: "official_paper.pdf",
        localPath: "attachments/official_paper.pdf",
        canonicalLocalPath: "paper.pdf",
        byteSize: uploadedPdf.byteLength,
      },
    ]);

    const payloadJson = stringifyPaperclipWakePayload(result.context.paperclipWake);
    expect(payloadJson).toContain('"canonicalLocalPath":"paper.pdf"');
    const prompt = renderPaperclipWakePrompt(result.context.paperclipWake);
    expect(prompt).toContain("canonical local file: paper.pdf");
    expect(prompt).toContain("local copy: attachments/official_paper.pdf");
    expect(prompt).toContain("do not pass the authenticated API path to fetch-pdf");
    expect(prompt).not.toContain("download it from its content path");
  });

  it("does not fetch or alter wake context when no uploaded PDF attachment exists", async () => {
    const workspace = await makeWorkspace();
    const fetchImpl = vi.fn();
    const context = {
      taskId: "issue-with-url-only",
      paperclipWake: {
        reason: "issue_assigned",
        issue: {
          id: "issue-with-url-only",
          identifier: "ACA-URL",
          title: "Deep read verified URL",
          description: "Verified source: https://arxiv.org/pdf/2002.00388",
        },
        artifactInventory: {
          counts: { documents: 0, workProducts: 0, attachments: 0 },
          documents: [],
          workProducts: [],
          attachments: [],
        },
      },
    };

    const result = await materializePaperclipPdfAttachments({
      context,
      workspaceCwd: workspace,
      apiBaseUrl: "https://paperclip.example",
      apiKey: "run-token",
      runId: "run-url",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ context, materialized: [] });
    const prompt = renderPaperclipWakePrompt(result.context.paperclipWake);
    expect(prompt).toContain("https://arxiv.org/pdf/2002.00388");
    expect(prompt).not.toContain("canonical local file: paper.pdf");
  });
});
