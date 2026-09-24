-- 校正历史口径：举报处置曾允许在开放举报仍达阈值（>= 3）时恢复目标，
-- 导致部分目标处于"开放举报超阈值却已公开"的不一致状态。
-- 本迁移按统一口径重算存量数据：开放举报仍达阈值的目标必须隐藏，
-- 并对每个被校正的目标写入审计日志。
-- 迁移由 migrate.ts 在单事务内执行，任一步失败整体回滚，可安全重跑。

DO $$
DECLARE
  threshold CONSTANT integer := 3;
  rec RECORD;
BEGIN
  -- 地点细节：开放举报数仍达阈值却被恢复为 published 的目标，重新隐藏
  FOR rec IN
    SELECT f.id, count(r.id)::integer AS open_reports
    FROM map_features f
    JOIN reports r ON r.target_type = 'feature' AND r.target_id = f.id AND r.status = 'open'
    WHERE f.status = 'published' AND f.deleted_at IS NULL
    GROUP BY f.id
    HAVING count(r.id) >= threshold
    ORDER BY f.id
  LOOP
    UPDATE map_features SET status = 'hidden', updated_at = now() WHERE id = rec.id;
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
    VALUES (
      NULL,
      'report.threshold_hidden',
      'feature',
      rec.id,
      jsonb_build_object(
        'openReports', rec.open_reports,
        'threshold', threshold,
        'source', 'migration_0003_report_threshold_reconcile'
      )
    );
  END LOOP;

  -- 评论：同一口径重算
  FOR rec IN
    SELECT c.id, count(r.id)::integer AS open_reports
    FROM comments c
    JOIN reports r ON r.target_type = 'comment' AND r.target_id = c.id AND r.status = 'open'
    WHERE c.status = 'published' AND c.deleted_at IS NULL
    GROUP BY c.id
    HAVING count(r.id) >= threshold
    ORDER BY c.id
  LOOP
    UPDATE comments SET status = 'hidden', updated_at = now() WHERE id = rec.id;
    INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
    VALUES (
      NULL,
      'report.threshold_hidden',
      'comment',
      rec.id,
      jsonb_build_object(
        'openReports', rec.open_reports,
        'threshold', threshold,
        'source', 'migration_0003_report_threshold_reconcile'
      )
    );
  END LOOP;
END $$;
