import { describe, expect, it } from "vitest";
import { formatSourceValue, getReleaseSnapshotMessage, isWebMcpReady } from "./App";
import type { CheckStatus, SourceFact, VerificationManifest } from "./domain";

const manifest = (status: CheckStatus, valueStatus: CheckStatus): VerificationManifest => ({
  schemaVersion: 1,
  claimId: "claim-1",
  workspaceRevision: 1,
  status,
  sourceEvidenceIds: valueStatus === "blocked" ? [] : ["evidence-1"],
  checks: [
    {
      id: "source-coverage",
      label: "Shared source coverage",
      status: valueStatus === "blocked" ? "fail" : "pass",
      detail: valueStatus === "blocked" ? "No evidence is linked to this claim." : "Source is available.",
    },
    {
      id: "value-check",
      label: "Quantitative value",
      status: valueStatus,
      detail: valueStatus === "fail" ? "The source resolves to 20%, not 40%." : "Values match.",
    },
  ],
});

describe("WebMCP readiness", () => {
  it("does not report ready during partial registration", () => {
    expect(isWebMcpReady("registering", 1)).toBe(false);
    expect(isWebMcpReady("registered", 0)).toBe(false);
  });

  it("reports ready only after registration completes with tools", () => {
    expect(isWebMcpReady("registered", 10)).toBe(true);
  });
});

describe("release snapshot messaging", () => {
  it("formats both range and scalar bound facts", () => {
    const range: SourceFact = { kind: "range", metric: "reviews", unit: "count", sourceWindow: "week", sourceExcerpt: "50 to 60", baseline: 50, observed: 60 };
    const scalar: SourceFact = { kind: "scalar", metric: "packets", unit: "count", sourceWindow: "launch week", sourceExcerpt: "72 packets", value: 72 };
    expect(formatSourceValue(range)).toBe("50 → 60");
    expect(formatSourceValue(scalar)).toBe("72");
    expect(formatSourceValue(undefined)).toBe("—");
  });

  it("distinguishes unavailable evidence from disagreement", () => {
    expect(getReleaseSnapshotMessage(manifest("fail", "blocked"), false, "pending")).toBe(
      "Source unavailable — comparison cannot run. Release stays locked.",
    );
  });

  it("describes an actual quantitative conflict", () => {
    expect(getReleaseSnapshotMessage(manifest("fail", "fail"), true, "pending")).toBe(
      "These values do not agree. Release stays locked.",
    );
  });

  it("keeps human confirmation separate from deterministic agreement", () => {
    expect(getReleaseSnapshotMessage(manifest("pass", "pass"), true, "pending")).toBe(
      "The values agree. Your confirmation is still required.",
    );
    expect(getReleaseSnapshotMessage(manifest("pass", "pass"), true, "approved")).toBe(
      "The bound source and claim agree.",
    );
  });
});
