-- 统一举报阈值口径：同一目标的开放举报达到 3 条时必须保持 hidden。
-- 此前目标可在开放举报仍超阈值时被个别处置（逐条处理举报或直接恢复）恢复为
-- published，本迁移校正历史口径：把仍超阈值却处于 published 的目标回退为
-- hidden，并为每个被校正的目标写入 report.threshold_reconciled 审计记录。

WITH offenders AS (
  SELECT r.target_id AS id, count(*) AS open_reports
  FROM reports r
  WHERE r.target_type = 'feature' AND r.status = 'open'
  GROUP BY r.target_id
  HAVING count(*) >= 3
),
corrected AS (
  UPDATE map_features mf
  SET status = 'hidden', updated_at = now()
  FROM offenders o
  WHERE mf.id = o.id AND mf.deleted_at IS NULL AND mf.status = 'published'
  RETURNING mf.id, o.open_reports
)
INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
SELECT NULL,
       'report.threshold_reconciled',
       'feature',
       c.id,
       jsonb_build_object('openReports', c.open_reports, 'threshold', 3, 'source', '0003_report_threshold_reconcile')
FROM corrected c;

WITH offenders AS (
  SELECT r.target_id AS id, count(*) AS open_reports
  FROM reports r
  WHERE r.target_type = 'comment' AND r.status = 'open'
  GROUP BY r.target_id
  HAVING count(*) >= 3
),
corrected AS (
  UPDATE comments c
  SET status = 'hidden', updated_at = now()
  FROM offenders o
  WHERE c.id = o.id AND c.deleted_at IS NULL AND c.status = 'published'
  RETURNING c.id, o.open_reports
)
INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, metadata)
SELECT NULL,
       'report.threshold_reconciled',
       'comment',
       c.id,
       jsonb_build_object('openReports', c.open_reports, 'threshold', 3, 'source', '0003_report_threshold_reconcile')
FROM corrected c;
