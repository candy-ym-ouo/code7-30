import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  applyReportThreshold,
  assertTargetRestorable,
  countOpenReports,
  isReportThresholdOpen,
  lockReportTarget,
  REPORT_HIDE_THRESHOLD
} from "./report-threshold";
import { AppError } from "./errors";

type PlannedQuery = { match: string; rows?: unknown[]; rowCount?: number };

function stubClient(plan: PlannedQuery[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      calls.push({ text: normalized, values });
      for (const step of plan) {
        if (normalized.includes(step.match)) {
          return { rows: step.rows ?? [], rowCount: step.rowCount ?? 0 };
        }
      }
      throw new Error(`unexpected query: ${normalized}`);
    }
  } as unknown as PoolClient;
  return { client, calls };
}

const openReports = (count: number): PlannedQuery => ({
  match: "FROM reports",
  rows: [{ count }],
  rowCount: 1
});

describe("report threshold recalculation", () => {
  it("counts open reports for the target", async () => {
    const { client, calls } = stubClient([openReports(2)]);
    const count = await countOpenReports(client, "feature", "00000000-0000-0000-0000-000000000001");
    expect(count).toBe(2);
    expect(calls[0]!.text).toContain("status = 'open'");
  });

  it("locks the target row for update before recalculating", async () => {
    const { client, calls } = stubClient([{ match: "FROM map_features", rows: [{ id: "f" }], rowCount: 1 }]);
    await lockReportTarget(client, "feature", "00000000-0000-0000-0000-000000000001");
    expect(calls[0]!.text).toContain("FOR UPDATE");
    expect(calls[0]!.text).toContain("map_features");
  });

  it("does nothing while open reports stay below the threshold", async () => {
    const { client, calls } = stubClient([openReports(REPORT_HIDE_THRESHOLD - 1)]);
    const count = await applyReportThreshold(client, {
      targetType: "feature",
      targetId: "00000000-0000-0000-0000-000000000001"
    });
    expect(count).toBe(REPORT_HIDE_THRESHOLD - 1);
    expect(calls).toHaveLength(1);
  });

  it("hides a published target at the threshold and audits the transition", async () => {
    const { client, calls } = stubClient([
      openReports(REPORT_HIDE_THRESHOLD),
      { match: "UPDATE map_features", rowCount: 1 },
      { match: "INSERT INTO audit_logs", rowCount: 1 }
    ]);
    const count = await applyReportThreshold(client, {
      targetType: "feature",
      targetId: "00000000-0000-0000-0000-000000000001",
      actorId: null
    });
    expect(count).toBe(REPORT_HIDE_THRESHOLD);
    const update = calls.find((call) => call.text.includes("UPDATE map_features"));
    expect(update?.text).toContain("status = 'hidden'");
    expect(update?.text).toContain("status = 'published'");
    const audit = calls.find((call) => call.text.includes("INSERT INTO audit_logs"));
    expect(audit).toBeDefined();
    expect(audit!.values[1]).toBe("report.threshold_hidden");
    expect(JSON.parse(String(audit!.values[4]))).toMatchObject({
      openReports: REPORT_HIDE_THRESHOLD,
      threshold: REPORT_HIDE_THRESHOLD
    });
  });

  it("hides reported comments through the same unified path", async () => {
    const { client, calls } = stubClient([
      openReports(REPORT_HIDE_THRESHOLD + 2),
      { match: "UPDATE comments", rowCount: 1 },
      { match: "INSERT INTO audit_logs", rowCount: 1 }
    ]);
    await applyReportThreshold(client, {
      targetType: "comment",
      targetId: "00000000-0000-0000-0000-000000000002"
    });
    expect(calls.some((call) => call.text.includes("UPDATE comments"))).toBe(true);
  });

  it("skips the audit write when the target was already hidden", async () => {
    const { client, calls } = stubClient([
      openReports(REPORT_HIDE_THRESHOLD),
      { match: "UPDATE map_features", rowCount: 0 }
    ]);
    await applyReportThreshold(client, {
      targetType: "feature",
      targetId: "00000000-0000-0000-0000-000000000001"
    });
    expect(calls.some((call) => call.text.includes("INSERT INTO audit_logs"))).toBe(false);
  });

  it("allows restoring while open reports are below the threshold", async () => {
    const { client } = stubClient([openReports(REPORT_HIDE_THRESHOLD - 1)]);
    await expect(
      assertTargetRestorable(client, "comment", "00000000-0000-0000-0000-000000000002")
    ).resolves.toBeUndefined();
  });

  it("rejects restoring while open reports still meet the threshold", async () => {
    const targetId = "00000000-0000-0000-0000-000000000002";
    const { client } = stubClient([openReports(REPORT_HIDE_THRESHOLD)]);
    const error = await assertTargetRestorable(client, "comment", targetId).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(409);
    expect((error as AppError).code).toBe("REPORT_THRESHOLD_OPEN");
    expect((error as AppError).details).toMatchObject({
      targetType: "comment",
      targetId,
      openReports: REPORT_HIDE_THRESHOLD,
      threshold: REPORT_HIDE_THRESHOLD
    });
    expect(isReportThresholdOpen(error)).toBe(true);
    expect(isReportThresholdOpen(new Error("other"))).toBe(false);
  });
});
