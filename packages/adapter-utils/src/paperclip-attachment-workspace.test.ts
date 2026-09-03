import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializePaperclipAttachments, materializePaperclipPdfAttachments } from "./paperclip-attachment-workspace.js";
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

function writeUInt16LE(buffer: Uint8Array, offset: number, value: number) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
}

function writeUInt32LE(buffer: Uint8Array, offset: number, value: number) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function storedZip(entries: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const local = new Uint8Array(30 + name.byteLength + content.byteLength);
    writeUInt32LE(local, 0, 0x04034b50);
    writeUInt16LE(local, 8, 0);
    writeUInt32LE(local, 18, content.byteLength);
    writeUInt32LE(local, 22, content.byteLength);
    writeUInt16LE(local, 26, name.byteLength);
    local.set(name, 30);
    local.set(content, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    writeUInt32LE(central, 0, 0x02014b50);
    writeUInt16LE(central, 10, 0);
    writeUInt32LE(central, 20, content.byteLength);
    writeUInt32LE(central, 24, content.byteLength);
    writeUInt16LE(central, 28, name.byteLength);
    writeUInt32LE(central, 42, offset);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const eocd = new Uint8Array(22);
  writeUInt32LE(eocd, 0, 0x06054b50);
  writeUInt16LE(eocd, 8, entries.length);
  writeUInt16LE(eocd, 10, entries.length);
  writeUInt32LE(eocd, 12, centralSize);
  writeUInt32LE(eocd, 16, offset);

  const output = new Uint8Array(offset + centralSize + eocd.byteLength);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  return output;
}

function docxBytes() {
  return storedZip([
    {
      name: "word/document.xml",
      content:
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body><w:p><w:r><w:t>Dr. Ibrahim Shiyam</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>PhD-qualified technology and digital transformation professional</w:t></w:r></w:p>" +
        "</w:body></w:document>",
    },
  ]);
}

describe("materializePaperclipAttachments", () => {
  it("creates an empty task workspace even when a task has no uploaded attachments", async () => {
    const workspace = await makeWorkspace();
    const context = {
      taskId: "issue-aca-empty",
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "issue-aca-empty", identifier: "ACA-EMPTY", title: "Research with no attachments" },
        artifactInventory: {
          counts: { documents: 0, workProducts: 0, attachments: 0 },
          documents: [],
          workProducts: [],
          attachments: [],
        },
      },
    };

    const result = await materializePaperclipAttachments({
      context,
      workspaceCwd: workspace,
    });

    expect(result.materialized).toEqual([]);
    const stats = await fs.stat(path.join(workspace, ".paperclip-work", "issue-aca-empty"));
    expect(stats.isDirectory()).toBe(true);
  });

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
        extractedTextLocalPath: null,
        byteSize: uploadedPdf.byteLength,
        kind: "pdf",
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

  it("turns an uploaded CV DOCX attachment into a local file before prompt render", async () => {
    const workspace = await makeWorkspace();
    const uploadedDocx = docxBytes();
    const fetchImpl = vi.fn(async () =>
      new Response(uploadedDocx, {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      })
    );

    const context = {
      taskId: "issue-per-3",
      paperclipWake: {
        reason: "issue_reopened_via_comment",
        issue: { id: "issue-per-3", identifier: "PER-3", title: "Migrate and Verify Remote Tech Roles History" },
        artifactInventory: {
          counts: { documents: 0, workProducts: 0, attachments: 1 },
          documents: [],
          workProducts: [],
          attachments: [
            {
              id: "attachment-cv",
              filename: "CV-Dr_Ibrahim_Shiyam.docx",
              contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              byteSize: uploadedDocx.byteLength,
              contentPath: "/api/attachments/attachment-cv/content",
              downloadPath: "/api/attachments/attachment-cv/content?download=1",
            },
          ],
        },
      },
    };

    const result = await materializePaperclipAttachments({
      context,
      workspaceCwd: workspace,
      apiBaseUrl: "https://paperclip.example/api",
      apiKey: "run-token",
      runId: "run-per-3",
      fetchImpl,
    });

    await expect(fs.readFile(path.join(workspace, ".paperclip-work", "issue-per-3", "cv.docx")))
      .resolves.toEqual(Buffer.from(uploadedDocx));
    await expect(fs.readFile(path.join(workspace, ".paperclip-work", "issue-per-3", "attachments", "CV-Dr_Ibrahim_Shiyam.docx")))
      .resolves.toEqual(Buffer.from(uploadedDocx));
    expect(result.materialized).toEqual([
      {
        id: "attachment-cv",
        filename: "CV-Dr_Ibrahim_Shiyam.docx",
        localPath: "attachments/CV-Dr_Ibrahim_Shiyam.docx",
        canonicalLocalPath: "cv.docx",
        extractedTextLocalPath: "cv.txt",
        byteSize: uploadedDocx.byteLength,
        kind: "docx",
      },
    ]);
    await expect(fs.readFile(path.join(workspace, ".paperclip-work", "issue-per-3", "cv.txt"), "utf8"))
      .resolves.toContain("Dr. Ibrahim Shiyam");

    const prompt = renderPaperclipWakePrompt(result.context.paperclipWake);
    expect(prompt).toContain("canonical local file: cv.docx");
    expect(prompt).toContain("local copy: attachments/CV-Dr_Ibrahim_Shiyam.docx");
    expect(prompt).toContain("extracted text file: cv.txt");
    expect(prompt).toContain("task_workspace.py read cv.txt");
    expect(prompt).toContain("do not ask the user to paste, convert, or reupload it");
    expect(prompt).not.toContain("download it from its content path");
  });

  it("does not fetch or alter wake context when no uploaded attachment exists", async () => {
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

  it("retries transient startup fetch failures before declaring an uploaded attachment unavailable", async () => {
    const workspace = await makeWorkspace();
    const uploadedPdf = pdfBytes("retry");
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed: connect ECONNREFUSED 100.86.18.61:3100"))
      .mockResolvedValueOnce(new Response(uploadedPdf, { status: 200 }));

    const result = await materializePaperclipPdfAttachments({
      context: {
        taskId: "issue-retry",
        paperclipWake: {
          artifactInventory: {
            counts: { documents: 0, workProducts: 0, attachments: 1 },
            documents: [],
            workProducts: [],
            attachments: [
              {
                id: "attachment-retry",
                filename: "retry.pdf",
                contentType: "application/pdf",
                byteSize: uploadedPdf.byteLength,
                contentPath: "/api/attachments/attachment-retry/content",
              },
            ],
          },
        },
      },
      workspaceCwd: workspace,
      apiBaseUrl: "https://paperclip.example",
      apiKey: "run-token",
      fetchImpl,
      fetchMaxAttempts: 2,
      retryDelayMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.materialized).toHaveLength(1);
    await expect(fs.readFile(path.join(workspace, ".paperclip-work", "issue-retry", "paper.pdf"), "utf8"))
      .resolves.toContain("%PDF-1.7");
  });
});
