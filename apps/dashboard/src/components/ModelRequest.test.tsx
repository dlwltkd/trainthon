import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deriveRun } from "@/lib/derive";
import type { HarnessEvent } from "@vouch/protocol";
import { ActivityFeed } from "./ActivityFeed";

describe("model activity display", () => {
  it("shows a live retry countdown and retained tool results instead of an opaque working placeholder", () => {
    const events: HarnessEvent[] = [
      { type: "run_start", runId: "r", seq: 0, ts: 1000, runKind: "local_repository", configHash: "test", model: "test", seed: 1, budgets: { maxTokens: 1000, maxSteps: 10, maxWallMs: 60_000 } },
      { type: "model_request", runId: "r", seq: 1, ts: 1000, requestId: "request-1", attempt: 1, transport: "stream", phase: "retry_wait", agentRole: "red", stage: "REVIEW", elapsedMs: 1000, outputChars: 32, firstChunkMs: 500, retryAt: 12_000, detail: "Model stream failed (bad_gateway)." },
    ];
    const html = renderToStaticMarkup(<ActivityFeed view={deriveRun(events)!} now={2000} live files={[]} actions={{ openFile() {}, openDiff() {}, openEvidence() {} }} />);
    expect(html).toContain("10s");
    expect(html).toContain("tool results preserved");
    expect(html).toContain("First response");
    expect(html).not.toContain("Harness is working");
  });
});
