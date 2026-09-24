import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../migrations/0001_init.sql"),
  "utf8"
);

describe("initial migration", () => {
  it("contains the core audited entities", () => {
    for (const table of [
      "users", "sessions", "auth_tokens", "categories", "map_features",
      "feature_revisions", "media_assets", "comments", "reports",
      "moderation_actions", "outbox_events", "audit_logs", "notifications"
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });

  it("adds public thumbnail and outbox recovery fields in migration 0002", () => {
    const followup = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0002_media_public_thumb.sql"),
      "utf8"
    );
    expect(followup).toContain("public_thumbnail_object_key");
    expect(followup).toContain("updated_at timestamptz");
  });

  it("uses PostGIS geography points and spatial indexes", () => {
    expect(migration).toContain("geography(Point, 4326)");
    expect(migration).toContain("USING gist (geom)");
  });

  it("reconciles over-threshold targets with audit trail in migration 0003", () => {
    const reconcile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../migrations/0003_report_threshold_reconcile.sql"),
      "utf8"
    );
    // 统一口径：开放举报仍达阈值（>= 3）的公开目标必须重新隐藏
    expect(reconcile).toContain("threshold CONSTANT integer := 3");
    expect(reconcile).toContain("r.status = 'open'");
    expect(reconcile).toContain("HAVING count(r.id) >= threshold");
    expect(reconcile).toContain("SET status = 'hidden'");
    // 只校正 published 且未删除的目标，不反向恢复人工隐藏
    expect(reconcile).toContain("f.status = 'published' AND f.deleted_at IS NULL");
    expect(reconcile).toContain("c.status = 'published' AND c.deleted_at IS NULL");
    // 每个被校正的目标写入审计日志
    expect(reconcile).toContain("INSERT INTO audit_logs");
    expect(reconcile).toContain("report.threshold_hidden");
  });
});
