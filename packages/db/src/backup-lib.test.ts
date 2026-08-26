import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createBufferedTextFileWriter, runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "keeps the newest backup for each retained calendar month",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-retention-");
      const realDateNow = Date.now;
      Date.now = () => Date.UTC(2026, 2, 31, 12, 0, 0);

      const janNewest = path.join(backupDir, "paperclip-test-2026-01-28T12-00-00.sql.gz");
      const janOlder = path.join(backupDir, "paperclip-test-2026-01-10T12-00-00.sql.gz");
      const decOld = path.join(backupDir, "paperclip-test-2025-12-15T12-00-00.sql.gz");

      try {
        fs.writeFileSync(janNewest, "jan-newest");
        fs.writeFileSync(janOlder, "jan-older");
        fs.writeFileSync(decOld, "dec-old");

        fs.utimesSync(janNewest, new Date("2026-01-28T12:00:00Z"), new Date("2026-01-28T12:00:00Z"));
        fs.utimesSync(janOlder, new Date("2026-01-10T12:00:00Z"), new Date("2026-01-10T12:00:00Z"));
        fs.utimesSync(decOld, new Date("2025-12-15T12:00:00Z"), new Date("2025-12-15T12:00:00Z"));

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 2 },
          filenamePrefix: "paperclip-test",
        });

        expect(result.prunedCount).toBe(2);
        expect(fs.existsSync(janNewest)).toBe(true);
        expect(fs.existsSync(janOlder)).toBe(false);
        expect(fs.existsSync(decOld)).toBe(false);
      } finally {
        Date.now = realDateNow;
      }
    },
    30_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);
        await sourceSql.unsafe(`
          CREATE FUNCTION "public"."backup_test_mark_done"()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          BEGIN
            NEW."state" := 'done';
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER "backup_test_mark_done_trigger"
          BEFORE UPDATE OF "title" ON "public"."backup_test_records"
          FOR EACH ROW
          EXECUTE FUNCTION "public"."backup_test_mark_done"();
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);

        await restoreSql.unsafe(`
          UPDATE "public"."backup_test_records"
          SET "title" = 'triggered'
          WHERE "title" = 'row-0'
        `);
        const triggeredRows = await restoreSql.unsafe<{ state: string }[]>(`
          SELECT "state"::text AS "state"
          FROM "public"."backup_test_records"
          WHERE "title" = 'triggered'
        `);
        expect(triggeredRows).toEqual([{ state: "done" }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores scheduler session and recovery safeguard state",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_safeguard_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-safeguard-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."routines" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            "description" text NOT NULL,
            "status" text NOT NULL,
            "schedule" jsonb NOT NULL
          );
          CREATE TABLE "public"."routine_revisions" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "routine_id" uuid NOT NULL REFERENCES "public"."routines"("id") ON DELETE CASCADE,
            "revision_number" integer NOT NULL,
            "title" text NOT NULL,
            "description" text NOT NULL,
            "snapshot" jsonb NOT NULL
          );
          CREATE TABLE "public"."routine_runs" (
            "id" uuid PRIMARY KEY,
            "routine_id" uuid NOT NULL REFERENCES "public"."routines"("id") ON DELETE CASCADE,
            "company_id" uuid NOT NULL,
            "status" text NOT NULL,
            "issue_id" uuid,
            "created_at" timestamptz NOT NULL
          );
          CREATE TABLE "public"."company_skills" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "key" text NOT NULL,
            "name" text NOT NULL,
            "markdown" text NOT NULL,
            "current_version_id" uuid
          );
          CREATE TABLE "public"."company_skill_versions" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "company_skill_id" uuid NOT NULL REFERENCES "public"."company_skills"("id") ON DELETE CASCADE,
            "revision_number" integer NOT NULL,
            "file_inventory" jsonb NOT NULL
          );
          CREATE TABLE "public"."agent_task_sessions" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "agent_id" uuid NOT NULL,
            "adapter_type" text NOT NULL,
            "task_key" text NOT NULL,
            "session_id" text NOT NULL,
            "last_run_id" uuid,
            "updated_at" timestamptz NOT NULL,
            CONSTRAINT "agent_task_sessions_company_agent_adapter_task_uniq"
              UNIQUE ("company_id", "agent_id", "adapter_type", "task_key")
          );
          CREATE TABLE "public"."agent_config_revisions" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "agent_id" uuid NOT NULL,
            "source" text NOT NULL,
            "changed_keys" jsonb NOT NULL,
            "before_config" jsonb,
            "after_config" jsonb NOT NULL,
            "created_at" timestamptz NOT NULL
          );
          CREATE TABLE "public"."issues" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "slug" text NOT NULL,
            "title" text NOT NULL,
            "status" text NOT NULL,
            "unblock_descriptor" jsonb
          );
          CREATE TABLE "public"."heartbeat_runs" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "agent_id" uuid NOT NULL,
            "issue_id" uuid REFERENCES "public"."issues"("id") ON DELETE SET NULL,
            "status" text NOT NULL,
            "error_code" text,
            "context_snapshot" jsonb NOT NULL,
            "result_json" jsonb,
            "last_output_at" timestamptz,
            "finished_at" timestamptz
          );
          CREATE TABLE "public"."agent_wakeup_requests" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "agent_id" uuid NOT NULL,
            "issue_id" uuid REFERENCES "public"."issues"("id") ON DELETE CASCADE,
            "status" text NOT NULL,
            "reason" text NOT NULL,
            "context" jsonb NOT NULL
          );
          CREATE TABLE "public"."issue_recovery_actions" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE CASCADE,
            "status" text NOT NULL,
            "reason" text NOT NULL,
            "details" jsonb NOT NULL
          );
          CREATE TABLE "public"."documents" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            "latest_body" text NOT NULL
          );
          CREATE TABLE "public"."issue_documents" (
            "issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE CASCADE,
            "document_id" uuid NOT NULL REFERENCES "public"."documents"("id") ON DELETE CASCADE,
            "company_id" uuid NOT NULL,
            "key" text NOT NULL,
            PRIMARY KEY ("issue_id", "document_id")
          );
          CREATE TABLE "public"."issue_work_products" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE CASCADE,
            "kind" text NOT NULL,
            "metadata" jsonb NOT NULL
          );
          CREATE TABLE "public"."assets" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "provider" text NOT NULL,
            "object_key" text NOT NULL,
            "content_type" text NOT NULL,
            "byte_size" bigint NOT NULL,
            "sha256" text NOT NULL,
            "original_filename" text,
            "created_by_agent_id" uuid
          );
          CREATE TABLE "public"."issue_attachments" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "issue_id" uuid NOT NULL REFERENCES "public"."issues"("id") ON DELETE CASCADE,
            "asset_id" uuid NOT NULL REFERENCES "public"."assets"("id") ON DELETE CASCADE
          );
        `);
        await sourceSql.unsafe(`
          INSERT INTO "public"."routines" ("id", "company_id", "title", "description", "status", "schedule")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'Daily job research',
            'Continue the Remote Tech Roles history.',
            'active',
            '{"cron":"0 8 * * *","timezone":"Asia/Male"}'
          );
          INSERT INTO "public"."routine_revisions" (
            "id", "company_id", "routine_id", "revision_number", "title", "description", "snapshot"
          )
          VALUES (
            '10101010-1010-4010-8010-101010101010',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '11111111-1111-4111-8111-111111111111',
            7,
            'Daily job research',
            'Preserve stable routine task sessions and inspect recovery evidence before terminalizing.',
            '{"taskKey":"routine:11111111-1111-4111-8111-111111111111","policy":"stable-session-history"}'
          );
          INSERT INTO "public"."company_skills" (
            "id", "company_id", "key", "name", "markdown", "current_version_id"
          )
          VALUES (
            '14141414-1414-4414-8414-141414141414',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'company/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evidence-grounded-literature-review',
            'Evidence-Grounded Literature Review',
            'Uploaded PDFs are canonical local full-text inputs; invalid citations are quarantined; inaccessible lawful full text receives a named deferred blocker and the queue continues.',
            '15151515-1515-4515-8515-151515151515'
          );
          INSERT INTO "public"."company_skill_versions" (
            "id", "company_id", "company_skill_id", "revision_number", "file_inventory"
          )
          VALUES (
            '15151515-1515-4515-8515-151515151515',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '14141414-1414-4414-8414-141414141414',
            3,
            '{"files":[{"path":"SKILL.md","sha256":"skill-sha"}]}'
          );
          INSERT INTO "public"."issues" ("id", "company_id", "slug", "title", "status", "unblock_descriptor")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'PER-3',
            'Migrate and Verify Remote Tech Roles History',
            'blocked',
            '{"type":"missing_live_path","owner":"board","action":"restore scheduled prompt/session handoff"}'
          );
          INSERT INTO "public"."routine_runs" ("id", "routine_id", "company_id", "status", "issue_id", "created_at")
          VALUES (
            '33333333-3333-4333-8333-333333333333',
            '11111111-1111-4111-8111-111111111111',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'running',
            '22222222-2222-4222-8222-222222222222',
            '2026-08-26T04:10:00Z'
          );
          INSERT INTO "public"."heartbeat_runs" (
            "id", "company_id", "agent_id", "issue_id", "status", "error_code",
            "context_snapshot", "result_json", "last_output_at", "finished_at"
          )
          VALUES (
            '44444444-4444-4444-8444-444444444444',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '22222222-2222-4222-8222-222222222222',
            'timed_out',
            'codex_output_inactivity_monitor',
            '{"taskKey":"routine:11111111-1111-4111-8111-111111111111","originKind":"routine","originId":"11111111-1111-4111-8111-111111111111"}',
            '{"livenessState":"failed","reason":"critical output silence"}',
            '2026-08-26T04:11:00Z',
            '2026-08-26T14:00:00Z'
          );
          INSERT INTO "public"."agent_task_sessions" (
            "id", "company_id", "agent_id", "adapter_type", "task_key", "session_id", "last_run_id", "updated_at"
          )
          VALUES (
            '55555555-5555-4555-8555-555555555555',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'codex',
            'routine:11111111-1111-4111-8111-111111111111',
            'ses_daily_remote_roles',
            '44444444-4444-4444-8444-444444444444',
            '2026-08-26T14:00:00Z'
          );
          INSERT INTO "public"."agent_config_revisions" (
            "id", "company_id", "agent_id", "source", "changed_keys", "before_config", "after_config", "created_at"
          )
          VALUES (
            '16161616-1616-4616-8616-161616161616',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'managed_instruction_policy_update',
            '["adapterConfig","capabilities"]',
            NULL,
            '{"adapterConfig":{"instructionsBundleMode":"managed","paperclipSkillSync":{"desiredSkills":["company/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/evidence-grounded-literature-review"]}}}',
            '2026-08-26T14:05:00Z'
          );
          INSERT INTO "public"."agent_wakeup_requests" ("id", "company_id", "agent_id", "issue_id", "status", "reason", "context")
          VALUES (
            '66666666-6666-4666-8666-666666666666',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '22222222-2222-4222-8222-222222222222',
            'pending',
            'routine_schedule',
            '{"taskKey":"routine:11111111-1111-4111-8111-111111111111"}'
          );
          INSERT INTO "public"."issue_recovery_actions" ("id", "company_id", "issue_id", "status", "reason", "details")
          VALUES (
            '77777777-7777-4777-8777-777777777777',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222',
            'active',
            'missing_disposition',
            '{"sourceState":{"documentCount":1,"attachmentCount":1},"unblockDescriptorRequired":true}'
          );
          INSERT INTO "public"."documents" ("id", "company_id", "title", "latest_body")
          VALUES (
            '88888888-8888-4888-8888-888888888888',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'Evidence rows',
            'E01,E02,E03'
          );
          INSERT INTO "public"."issue_documents" ("issue_id", "document_id", "company_id", "key")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '88888888-8888-4888-8888-888888888888',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'evidence'
          );
          INSERT INTO "public"."issue_work_products" ("id", "company_id", "issue_id", "kind", "metadata")
          VALUES (
            '99999999-9999-4999-8999-999999999999',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222',
            'csv_results',
            '{"rows":3}'
          );
          INSERT INTO "public"."assets" (
            "id", "company_id", "provider", "object_key", "content_type", "byte_size", "sha256",
            "original_filename", "created_by_agent_id"
          )
          VALUES (
            '12121212-1212-4212-8212-121212121212',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'local_disk',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/per-3/evidence.pdf',
            'application/pdf',
            2048,
            'abc123',
            'evidence.pdf',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
          );
          INSERT INTO "public"."issue_attachments" ("id", "company_id", "issue_id", "asset_id")
          VALUES (
            '13131313-1313-4313-8313-131313131313',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '22222222-2222-4222-8222-222222222222',
            '12121212-1212-4212-8212-121212121212'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-safeguard-test",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const [restored] = await restoreSql.unsafe<{
          routine_title: string;
          session_id: string;
          task_key: string;
          run_status: string;
          run_error_code: string;
          wakeup_task_key: string;
          routine_revision_policy: string;
          skill_policy: string;
          skill_version_revision: number;
          agent_skill_count: number;
          issue_status: string;
          unblock_action: string;
          recovery_document_count: number;
          document_body: string;
          work_product_rows: number;
          attachment_object_key: string;
        }[]>(`
          SELECT
            r."title" AS "routine_title",
            s."session_id",
            s."task_key",
            hr."status" AS "run_status",
            hr."error_code" AS "run_error_code",
            awr."context" ->> 'taskKey' AS "wakeup_task_key",
            rr."snapshot" ->> 'policy' AS "routine_revision_policy",
            cs."markdown" AS "skill_policy",
            csv."revision_number" AS "skill_version_revision",
            jsonb_array_length(acr."after_config" #> '{adapterConfig,paperclipSkillSync,desiredSkills}') AS "agent_skill_count",
            i."status" AS "issue_status",
            i."unblock_descriptor" ->> 'action' AS "unblock_action",
            (ira."details" -> 'sourceState' ->> 'documentCount')::int AS "recovery_document_count",
            d."latest_body" AS "document_body",
            (iwp."metadata" ->> 'rows')::int AS "work_product_rows",
            a."object_key" AS "attachment_object_key"
          FROM "public"."routines" r
          JOIN "public"."agent_task_sessions" s
            ON s."task_key" = 'routine:' || r."id"::text
          JOIN "public"."heartbeat_runs" hr
            ON hr."id" = s."last_run_id"
          JOIN "public"."issues" i
            ON i."id" = hr."issue_id"
          JOIN "public"."agent_wakeup_requests" awr
            ON awr."issue_id" = i."id"
          JOIN "public"."routine_revisions" rr
            ON rr."routine_id" = r."id"
          JOIN "public"."company_skills" cs
            ON cs."company_id" = r."company_id"
          JOIN "public"."company_skill_versions" csv
            ON csv."id" = cs."current_version_id"
          JOIN "public"."agent_config_revisions" acr
            ON acr."agent_id" = s."agent_id"
          JOIN "public"."issue_recovery_actions" ira
            ON ira."issue_id" = i."id"
          JOIN "public"."issue_documents" idoc
            ON idoc."issue_id" = i."id"
          JOIN "public"."documents" d
            ON d."id" = idoc."document_id"
          JOIN "public"."issue_work_products" iwp
            ON iwp."issue_id" = i."id"
          JOIN "public"."issue_attachments" ia
            ON ia."issue_id" = i."id"
          JOIN "public"."assets" a
            ON a."id" = ia."asset_id"
        `);

        expect(restored).toEqual({
          routine_title: "Daily job research",
          session_id: "ses_daily_remote_roles",
          task_key: "routine:11111111-1111-4111-8111-111111111111",
          run_status: "timed_out",
          run_error_code: "codex_output_inactivity_monitor",
          wakeup_task_key: "routine:11111111-1111-4111-8111-111111111111",
          routine_revision_policy: "stable-session-history",
          skill_policy: "Uploaded PDFs are canonical local full-text inputs; invalid citations are quarantined; inaccessible lawful full text receives a named deferred blocker and the queue continues.",
          skill_version_revision: 3,
          agent_skill_count: 1,
          issue_status: "blocked",
          unblock_action: "restore scheduled prompt/session handoff",
          recovery_document_count: 1,
          document_body: "E01,E02,E03",
          work_product_rows: 3,
          attachment_object_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/per-3/evidence.pdf",
        });
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "preserves composite foreign key column order without duplicate referenced columns",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_composite_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-composite-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_composite_fk";
          CREATE TABLE "plugin_composite_fk"."content_cases" (
            "id" uuid PRIMARY KEY,
            "company_id" uuid NOT NULL,
            "title" text NOT NULL,
            CONSTRAINT "content_cases_company_case_unique" UNIQUE ("company_id", "id")
          );
          CREATE TABLE "plugin_composite_fk"."content_case_signals" (
            "company_id" uuid NOT NULL,
            "case_id" uuid NOT NULL,
            "signal" text NOT NULL,
            "scopes" text[] NOT NULL,
            "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
            CONSTRAINT "content_case_signals_company_case"
              FOREIGN KEY ("company_id", "case_id")
              REFERENCES "plugin_composite_fk"."content_cases" ("company_id", "id")
              ON DELETE CASCADE
          );
          INSERT INTO "plugin_composite_fk"."content_cases" ("company_id", "id", "title")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'case'
          );
          INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes", "warnings")
          VALUES (
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
            'signal',
            ARRAY['upstream_import:preview', 'scope with space', 'quoted "scope"', 'NULL', 'null'],
            jsonb_build_array('json warning', jsonb_build_object('code', 'quoted "value"'))
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-composite-fk-test",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{
          signal: string;
          title: string;
          scopes: string[];
          warnings: Array<string | { code: string }>;
        }[]>(`
          SELECT s."signal", c."title", s."scopes", s."warnings"
          FROM "plugin_composite_fk"."content_case_signals" s
          JOIN "plugin_composite_fk"."content_cases" c
            ON c."company_id" = s."company_id"
           AND c."id" = s."case_id"
        `);
        expect(rows).toEqual([
          {
            signal: "signal",
            title: "case",
            scopes: ["upstream_import:preview", "scope with space", 'quoted "scope"', "NULL", "null"],
            warnings: ["json warning", { code: 'quoted "value"' }],
          },
        ]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_composite_fk"."content_case_signals" ("company_id", "case_id", "signal", "scopes")
            VALUES (
              '11111111-1111-4111-8111-111111111111',
              '33333333-3333-4333-8333-333333333333',
              'orphan',
              ARRAY[]::text[]
            )
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores fallback COPY data when child tables are dumped before parent tables",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_copy_fk_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-copy-fk-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const originalPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = "/bin/false";

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."zzz_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          CREATE TABLE "public"."aaa_child_records" (
            "id" uuid PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."zzz_parent_records"("id") ON DELETE CASCADE,
            "note" text NOT NULL
          );
          INSERT INTO "public"."zzz_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
          INSERT INTO "public"."aaa_child_records" ("id", "parent_id", "note")
          VALUES (
            '22222222-2222-4222-8222-222222222222',
            '11111111-1111-4111-8111-111111111111',
            'child emitted before parent'
          );
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-fk-test",
          backupEngine: "auto",
        });

        const backupSql = gunzipSync(await fs.promises.readFile(result.backupFile)).toString("utf8");
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeGreaterThan(-1);
        expect(backupSql.indexOf("-- Data for: public.aaa_child_records")).toBeLessThan(
          backupSql.indexOf("-- Data for: public.zzz_parent_records"),
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<{ note: string; name: string }[]>(`
          SELECT child."note", parent."name"
          FROM "public"."aaa_child_records" child
          JOIN "public"."zzz_parent_records" parent ON parent."id" = child."parent_id"
        `);
        expect(rows).toEqual([{ note: "child emitted before parent", name: "parent" }]);
      } finally {
        if (originalPgDumpPath === undefined) {
          delete process.env.PAPERCLIP_PG_DUMP_PATH;
        } else {
          process.env.PAPERCLIP_PG_DUMP_PATH = originalPgDumpPath;
        }
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});
