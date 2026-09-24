import type { PoolClient } from "pg";
import { recordAudit } from "./audit";

/** 开放举报达到该数量时，目标必须处于隐藏状态。 */
export const REPORT_HIDE_THRESHOLD = 3;

export type ReportTargetType = "feature" | "comment";
export type ReportResolveAction = "none" | "hide" | "restore";
export type TargetVisibility = "hidden" | "published" | "unchanged";

/**
 * 统一口径：处置动作 + 处置后剩余开放举报数 → 目标可见性。
 * 开放举报仍达阈值时，包括 restore 在内的任何个别处置都不得恢复目标。
 */
export function decideTargetVisibility(action: ReportResolveAction, openReports: number): TargetVisibility {
  if (action === "hide") return "hidden";
  if (openReports >= REPORT_HIDE_THRESHOLD) return "hidden";
  if (action === "restore") return "published";
  return "unchanged";
}

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
 * 按统一口径重算目标可见性：开放举报达到阈值时把公开目标转为隐藏并写入审计。
 * 返回当前开放举报数，供调用方继续决策（例如是否允许恢复）。
 */
export async function enforceReportThreshold(
  client: PoolClient,
  input: { targetType: ReportTargetType; targetId: string; actorId?: string | null }
): Promise<number> {
  const openReports = await countOpenReports(client, input.targetType, input.targetId);
  if (openReports < REPORT_HIDE_THRESHOLD) return openReports;

  const table = input.targetType === "feature" ? "map_features" : "comments";
  const result = await client.query(
    `UPDATE ${table} SET status = 'hidden', updated_at = now()
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
