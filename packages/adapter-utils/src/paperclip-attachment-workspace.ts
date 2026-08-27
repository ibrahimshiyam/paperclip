import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MaterializePaperclipAttachmentsOptions {
  context: Record<string, unknown>;
  workspaceCwd: string;
  apiBaseUrl?: string | null;
  apiKey?: string | null;
  runId?: string | null;
  fetchImpl?: FetchLike;
  maxAttachmentBytes?: number;
  fetchMaxAttempts?: number;
  retryDelayMs?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface MaterializePaperclipPdfAttachmentsOptions extends MaterializePaperclipAttachmentsOptions {
  maxPdfBytes?: number;
}

export interface MaterializedPaperclipAttachment {
  id: string | null;
  filename: string;
  localPath: string;
  canonicalLocalPath: string | null;
  byteSize: number;
  kind: "pdf" | "docx" | "attachment";
}

export interface MaterializePaperclipAttachmentsResult {
  context: Record<string, unknown>;
  materialized: MaterializedPaperclipAttachment[];
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

function isDocxAttachment(attachment: Record<string, unknown>): boolean {
  const contentType = asString(attachment.contentType).toLowerCase();
  const filename = asString(attachment.filename).toLowerCase();
  return contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    filename.endsWith(".docx");
}

function attachmentKind(attachment: Record<string, unknown>): MaterializedPaperclipAttachment["kind"] {
  if (isPdfAttachment(attachment)) return "pdf";
  if (isDocxAttachment(attachment)) return "docx";
  return "attachment";
}

function safeFilename(filename: string, fallback: string): string {
  const basename = path.basename(filename || fallback);
  const cleaned = basename.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function issueIdFromContext(context: Record<string, unknown>, wake: Record<string, unknown>): string {
  const direct = asString(context.taskId) || asString(context.issueId);
  if (direct) return direct;
  const issue = asObject(wake.issue);
  const issueId = asString(issue.id);
  if (issueId) return issueId;
  throw new Error("Cannot materialize uploaded attachment: Paperclip task id is missing.");
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api") ? trimmed.slice(0, -4) : trimmed;
}

function resolveAttachmentUrl(contentPath: string, apiBaseUrl: string): string {
  if (/^https:\/\//i.test(contentPath)) return contentPath;
  if (!contentPath.startsWith("/")) {
    throw new Error(`Cannot materialize uploaded attachment: unsupported attachment content path "${contentPath}".`);
  }
  return `${normalizeApiBaseUrl(apiBaseUrl)}${contentPath}`;
}

function fallbackFilename(kind: MaterializedPaperclipAttachment["kind"], id: string | null): string {
  if (id) {
    if (kind === "pdf") return `${id}.pdf`;
    if (kind === "docx") return `${id}.docx`;
    return id;
  }
  if (kind === "pdf") return "attachment.pdf";
  if (kind === "docx") return "attachment.docx";
  return "attachment";
}

function canonicalPathForAttachment(input: {
  kind: MaterializedPaperclipAttachment["kind"];
  filename: string;
  hasCanonicalPdf: boolean;
  hasCanonicalCv: boolean;
}): string | null {
  if (input.kind === "pdf" && !input.hasCanonicalPdf) return "paper.pdf";
  if (
    input.kind === "docx" &&
    !input.hasCanonicalCv &&
    /\b(cv|resume|résumé|curriculum[_-]?vitae)\b/i.test(input.filename)
  ) {
    return "cv.docx";
  }
  return null;
}

function validateMaterializedBytes(input: {
  bytes: Uint8Array;
  filename: string;
  kind: MaterializedPaperclipAttachment["kind"];
  maxAttachmentBytes: number;
}) {
  if (input.bytes.byteLength === 0) {
    throw new Error(`Cannot materialize uploaded attachment "${input.filename}": downloaded file is empty.`);
  }
  if (input.bytes.byteLength > input.maxAttachmentBytes) {
    throw new Error(
      `Cannot materialize uploaded attachment "${input.filename}": file is larger than ${input.maxAttachmentBytes} bytes.`,
    );
  }
  if (
    input.kind === "pdf" &&
    (input.bytes[0] !== 0x25 ||
      input.bytes[1] !== 0x50 ||
      input.bytes[2] !== 0x44 ||
      input.bytes[3] !== 0x46 ||
      input.bytes[4] !== 0x2d)
  ) {
    throw new Error(`Cannot materialize uploaded PDF attachment "${input.filename}": downloaded content is not a PDF.`);
  }
  if (input.kind === "docx" && (input.bytes[0] !== 0x50 || input.bytes[1] !== 0x4b)) {
    throw new Error(`Cannot materialize uploaded DOCX attachment "${input.filename}": downloaded content is not a DOCX/ZIP file.`);
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryFetch(error: unknown, response: Response | null): boolean {
  if (response) return response.status >= 500 || response.status === 408 || response.status === 429;
  if (!(error instanceof Error)) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(error.message);
}

async function fetchWithStartupRetry(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: {
    maxAttempts: number;
    retryDelayMs: number;
  },
): Promise<Response> {
  let lastError: unknown = null;
  let lastResponse: Response | null = null;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init);
      if (response.ok || !shouldRetryFetch(null, response) || attempt === options.maxAttempts) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      if (!shouldRetryFetch(error, null) || attempt === options.maxAttempts) throw error;
      lastError = error;
    }
    await sleep(options.retryDelayMs);
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("Attachment fetch failed.");
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

export async function materializePaperclipAttachments(
  options: MaterializePaperclipAttachmentsOptions,
): Promise<MaterializePaperclipAttachmentsResult> {
  const wake = asObject(options.context.paperclipWake);
  const inventory = asObject(wake.artifactInventory);
  const attachments = Array.isArray(inventory.attachments)
    ? inventory.attachments
        .map((entry) => asObject(entry))
        .filter((entry) => Object.keys(entry).length > 0)
    : [];
  if (attachments.length === 0) {
    return { context: options.context, materialized: [] };
  }

  const workspaceCwd = options.workspaceCwd.trim();
  if (!path.isAbsolute(workspaceCwd)) {
    throw new Error("Cannot materialize uploaded attachment: execution workspace is not an absolute local path.");
  }

  const apiBaseUrl = (options.apiBaseUrl ?? "").trim();
  const apiKey = (options.apiKey ?? "").trim();
  if (!apiBaseUrl || !apiKey) {
    throw new Error("Cannot materialize uploaded attachment: authenticated Paperclip API access is unavailable.");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("Cannot materialize uploaded attachment: fetch is unavailable in this runtime.");
  }

  const issueId = issueIdFromContext(options.context, wake);
  const taskWorkspaceDir = path.join(workspaceCwd, ".paperclip-work", issueId);
  const attachmentsDir = path.join(taskWorkspaceDir, "attachments");
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const fetchMaxAttempts = Math.max(1, Math.floor(options.fetchMaxAttempts ?? 6));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 500));
  const materialized: MaterializedPaperclipAttachment[] = [];
  const updatedAttachments: Record<string, unknown>[] = [];
  let hasCanonicalPdf = false;
  let hasCanonicalCv = false;

  for (const attachment of attachments) {
    const id = asString(attachment.id) || null;
    const kind = attachmentKind(attachment);
    const filename = safeFilename(asString(attachment.filename), fallbackFilename(kind, id));
    const contentPath = asString(attachment.contentPath);
    if (!contentPath) {
      throw new Error(`Cannot materialize uploaded attachment "${filename}": content path is missing.`);
    }

    const expectedSize = asNumber(attachment.byteSize);
    if (expectedSize > maxAttachmentBytes) {
      throw new Error(`Cannot materialize uploaded attachment "${filename}": file is larger than ${maxAttachmentBytes} bytes.`);
    }

    const response = await fetchWithStartupRetry(
      fetchImpl,
      resolveAttachmentUrl(contentPath, apiBaseUrl),
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(options.runId ? { "X-Paperclip-Run-Id": options.runId } : {}),
        },
      },
      { maxAttempts: fetchMaxAttempts, retryDelayMs },
    );
    if (!response.ok) {
      throw new Error(`Cannot materialize uploaded attachment "${filename}": Paperclip API returned HTTP ${response.status}.`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    validateMaterializedBytes({ bytes, filename, kind, maxAttachmentBytes });

    const localPath = path.posix.join("attachments", filename);
    const absolutePath = path.join(attachmentsDir, filename);
    await writeFileAtomic(absolutePath, bytes);

    const canonicalLocalPath = canonicalPathForAttachment({
      kind,
      filename,
      hasCanonicalPdf,
      hasCanonicalCv,
    });
    if (canonicalLocalPath) {
      await copyFileAtomic(absolutePath, path.join(taskWorkspaceDir, canonicalLocalPath));
      if (canonicalLocalPath === "paper.pdf") hasCanonicalPdf = true;
      if (canonicalLocalPath === "cv.docx") hasCanonicalCv = true;
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
      kind,
    });
  }

  const nextContext = cloneWakeWithInventory(options.context, updatedAttachments);
  await options.onLog?.(
    "stdout",
    `[paperclip] Materialized ${materialized.length} uploaded attachment${materialized.length === 1 ? "" : "s"} into ${taskWorkspaceDir}; use local files before any authenticated API path or source fetch.\n`,
  );
  return { context: nextContext, materialized };
}

export async function materializePaperclipPdfAttachments(
  options: MaterializePaperclipPdfAttachmentsOptions,
): Promise<MaterializePaperclipAttachmentsResult> {
  return materializePaperclipAttachments({
    ...options,
    maxAttachmentBytes: options.maxAttachmentBytes ?? options.maxPdfBytes,
  });
}
