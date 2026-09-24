import { describe, expect, it } from "vitest";
import { decideTargetVisibility, REPORT_HIDE_THRESHOLD } from "./report-visibility";

describe("report threshold visibility", () => {
  it("keeps targets hidden while open reports still meet the threshold", () => {
    expect(decideTargetVisibility("restore", REPORT_HIDE_THRESHOLD)).toBe("hidden");
    expect(decideTargetVisibility("restore", REPORT_HIDE_THRESHOLD + 2)).toBe("hidden");
    expect(decideTargetVisibility("none", REPORT_HIDE_THRESHOLD)).toBe("hidden");
    expect(decideTargetVisibility("hide", REPORT_HIDE_THRESHOLD)).toBe("hidden");
  });

  it("hides targets on explicit hide even below the threshold", () => {
    expect(decideTargetVisibility("hide", 0)).toBe("hidden");
    expect(decideTargetVisibility("hide", REPORT_HIDE_THRESHOLD - 1)).toBe("hidden");
  });

  it("allows restore only after open reports fall below the threshold", () => {
    expect(decideTargetVisibility("restore", REPORT_HIDE_THRESHOLD - 1)).toBe("published");
    expect(decideTargetVisibility("restore", 0)).toBe("published");
  });

  it("leaves targets untouched when resolving without action below the threshold", () => {
    expect(decideTargetVisibility("none", 0)).toBe("unchanged");
    expect(decideTargetVisibility("none", REPORT_HIDE_THRESHOLD - 1)).toBe("unchanged");
  });
});
