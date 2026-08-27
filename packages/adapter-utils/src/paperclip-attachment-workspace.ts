import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MaterializePaperclipPdfAttachmentsOptions {
  context: Record<string, unknown>;
  workspaceCwd: string;
  apiBaseUrl?: string | null;
  apiKey?: string | null;
  runId?: string | null;
  fetchImpl?: FetchLike;
  maxPdfBytes?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface MaterializedPaperclipPdfAttachment {
  id: string | null;
  filename: string;
  localPath: string;
  canonicalLocalPath: string | null;
  byteSize: number;
}

export interface MaterializePaperclipPdfAttachmentsResult {
  context: Record<string, unknown>;
  materialized: MaterializedPaperclipPdfAttachment[];
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPdfAttachment(attachment: Record<string, unknown>): boolean {
  const contentType = asString(attachment.contentType).toLowerCase();
  const filename = asString(attachment.filename).toLowerCase();
  return contentType === "application/pdf" || filename.endsWith(".pdf");
}

function safeFilename(filename: string, fallback: string): string {
  const basename = path.basename(filename || fallback);
  const cleaned = basename.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const value = cleaned || fallback;
  return value.toLowerCase().endsWith(".pdf") ? value : `${value}.pdf`;
}

function issueIdFromContext(context: Record<string, unknown>, wake: Record<string, unknown>): string {
  const direct = asString(context.taskId) || asString(context.issueId);
  if (direct) return direct;
  const issue = asObject(wake.issue);
  const issueId = asString(issue.id);
  if (issueId) return issueId;
  throw new Error("Cannot materialize uploaded PDF attachment: Paperclip task id is missing.");
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function resolveAttachmentUrl(contentPath: string, apiBaseUrl: string): string {
  if (/^https:\/\//i.test(contentPath)) return contentPath;
  if (!contentPath.startsWith("/")) {
    throw new Error(`Cannot materialize uploaded PDF attachment: unsupported attachment content path "${contentPath}".`);
  }
  return `${normalizeApiBaseUrl(apiBaseUrl)}${contentPath}`;
}

async function writeFileAtomic(filePath: string, bytes: Uint8Array) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, filePath);
}

async function copyFileAtomic(sourcePath: string, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.copyFile(sourcePath, tempPath);
  await fs.rename(tempPath, targetPath);
}

function cloneWakeWithInventory(
  context: Record<string, unknown>,
  attachments: Record<string, unknown>[],
): Record<string, unknown> {
  const wake = asObject(context.paperclipWake);
  const inventory = asObject(wake.artifactInventory);
  return {
    ...context,
    paperclipWake: {
      ...wake,
      artifactInventory: {
        ...inventory,
        attachments,
      },
    },
  };
}

export async function materializePaperclipPdfAttachments(
  options: MaterializePaperclipPdfAttachmentsOptions,
): Promise<MaterializePaperclipPdfAttachmentsResult> {
  const wake = asObject(options.context.paperclipWake);
  const inventory = asObject(wake.artifactInventory);
  const attachments = Array.isArray(inventory.attachments)
    ? inventory.attachments
        .map((entry) => asObject(entry))
        .filter((entry) => Object.keys(entry).length > 0)
    : [];
  const pdfAttachments = attachments.filter(isPdfAttachment);
  if (pdfAttachments.length === 0) {
    return { context: options.context, materialized: [] };
  }

  const workspaceCwd = options.workspaceCwd.trim();
  if (!path.isAbsolute(workspaceCwd)) {
    throw new Error("Cannot materialize uploaded PDF attachment: execution workspace is not an absolute local path.");
  }

  const apiBaseUrl = (options.apiBaseUrl ?? "").trim();
  const apiKey = (options.apiKey ?? "").trim();
  if (!apiBaseUrl || !apiKey) {
    throw new Error("Cannot materialize uploaded PDF attachment: authenticated Paperclip API access is unavailable.");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Cannot materialize uploaded PDF attachment: fetch is unavailable in this runtime.");
  }

  const issueId = issueIdFromContext(options.context, wake);
  const taskWorkspaceDir = path.join(workspaceCwd, ".paperclip-work", issueId);
  const attachmentsDir = path.join(taskWorkspaceDir, "attachments");
  const maxPdfBytes = options.maxPdfBytes ?? DEFAULT_MAX_PDF_BYTES;
  const materialized: MaterializedPaperclipPdfAttachment[] = [];
  const updatedAttachments: Record<string, unknown>[] = [];
  let canonicalSourcePath: string | null = null;

  for (const attachment of attachments) {
    if (!isPdfAttachment(attachment)) {
      updatedAttachments.push(attachment);
      continue;
    }

    const id = asString(attachment.id) || null;
    const filename = safeFilename(asString(attachment.filename), id ? `${id}.pdf` : "attachment.pdf");
    const contentPath = asString(attachment.contentPath);
    if (!contentPath) {
      throw new Error(`Cannot materialize uploaded PDF attachment "${filename}": content path is missing.`);
    }

    const expectedSize = asNumber(attachment.byteSize);
    if (expectedSize > maxPdfBytes) {
      throw new Error(`Cannot materialize uploaded PDF attachment "${filename}": PDF is larger than ${maxPdfBytes} bytes.`);
    }

    const response = await fetchImpl(resolveAttachmentUrl(contentPath, apiBaseUrl), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.runId ? { "X-Paperclip-Run-Id": options.runId } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Cannot materialize uploaded PDF attachment "${filename}": Paperclip API returned HTTP ${response.status}.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error(`Cannot materialize uploaded PDF attachment "${filename}": downloaded file is empty.`);
    }
    if (bytes.byteLength > maxPdfBytes) {
      throw new Error(`Cannot materialize uploaded PDF attachment "${filename}": PDF is larger than ${maxPdfBytes} bytes.`);
    }
    if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
      throw new Error(`Cannot materialize uploaded PDF attachment "${filename}": downloaded content is not a PDF.`);
    }

    const localPath = path.posix.join("attachments", filename);
    const absolutePath = path.join(attachmentsDir, filename);
    await writeFileAtomic(absolutePath, bytes);

    let canonicalLocalPath: string | null = null;
    if (!canonicalSourcePath) {
      canonicalLocalPath = "paper.pdf";
      await copyFileAtomic(absolutePath, path.join(taskWorkspaceDir, canonicalLocalPath));
      canonicalSourcePath = absolutePath;
    }

    const enriched = {
      ...attachment,
      localPath,
      canonicalLocalPath,
      materializedAt: new Date().toISOString(),
    };
    updatedAttachments.push(enriched);
    materialized.push({
      id,
      filename,
      localPath,
      canonicalLocalPath,
      byteSize: bytes.byteLength,
    });
  }

  const nextContext = cloneWakeWithInventory(options.context, updatedAttachments);
  await options.onLog?.(
    "stdout",
    `[paperclip] Materialized ${materialized.length} uploaded PDF attachment${materialized.length === 1 ? "" : "s"} into ${taskWorkspaceDir}; use paper.pdf before any source fetch.\n`,
  );
  return { context: nextContext, materialized };
}
