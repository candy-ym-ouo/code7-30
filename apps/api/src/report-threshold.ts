import type { PoolClient } from "pg";
import { recordAudit } from "./audit";
import { AppError } from "./errors";

/**
 * 统一举报阈值口径：同一目标的开放举报达到该阈值时必须保持 hidden，
 * 任何处置路径都不能在仍超阈值时把目标恢复为公开。
 */
export const REPORT_HIDE_THRESHOLD = 3;

export type ReportTargetType = "feature" | "comment";

const TARGET_TABLE: Record<ReportTargetType, "map_features" | "comments"> = {
  feature: "map_features",
  comment: "comments"
};

export async function countOpenReports(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM reports
     WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
    [targetType, targetId]
  );
  return result.rows[0]!.count;
}

/**
 * 重算前锁定目标行，串行化同一目标上的举报创建、举报处置和恢复，
 * 保证阈值判定基于同一口径的最新状态。
 */
export async function lockReportTarget(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<void> {
  await client.query(
    `SELECT id FROM ${TARGET_TABLE[targetType]} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [targetId]
  );
}

/**
 * 统一重算目标可见性：开放举报仍超阈值时把公开目标回退为 hidden 并写审计。
 * 返回重算后的开放举报数。
 */
export async function applyReportThreshold(
  client: PoolClient,
  input: { targetType: ReportTargetType; targetId: string; actorId?: string | null }
): Promise<number> {
  const openReports = await countOpenReports(client, input.targetType, input.targetId);
  if (openReports < REPORT_HIDE_THRESHOLD) return openReports;
  const result = await client.query(
    `UPDATE ${TARGET_TABLE[input.targetType]}
     SET status = 'hidden', updated_at = now()
     WHERE id = $1 AND status = 'published' AND deleted_at IS NULL`,
    [input.targetId]
  );
  if (result.rowCount) {
    await recordAudit(client, {
      actorId: input.actorId ?? null,
      action: "report.threshold_hidden",
      resourceType: input.targetType,
      resourceId: input.targetId,
      metadata: { openReports, threshold: REPORT_HIDE_THRESHOLD }
    });
  }
  return openReports;
}

/**
 * 恢复前置校验：开放举报仍超阈值时抛出 409，使整笔处置事务回退。
 */
export async function assertTargetRestorable(
  client: PoolClient,
  targetType: ReportTargetType,
  targetId: string
): Promise<void> {
  const openReports = await countOpenReports(client, targetType, targetId);
  if (openReports >= REPORT_HIDE_THRESHOLD) {
    throw new AppError(
      409,
      "REPORT_THRESHOLD_OPEN",
      `Target still has ${openReports} open reports (threshold ${REPORT_HIDE_THRESHOLD}); resolve or dismiss them before restoring`,
      { targetType, targetId, openReports, threshold: REPORT_HIDE_THRESHOLD }
    );
  }
}

export function isReportThresholdOpen(error: unknown): error is AppError {
  return error instanceof AppError && error.code === "REPORT_THRESHOLD_OPEN";
}
