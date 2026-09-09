import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NewRunDialog } from "./NewRunDialog";

describe("new repository workflow dialog", () => {
  it("defaults to a public repository and a task prompt without requesting a regression", () => {
    const html = renderToStaticMarkup(<NewRunDialog open onClose={() => undefined} onStarted={() => undefined} />);
    expect(html).toContain("Public GitHub repository URL");
    expect(html).toContain('placeholder="https://github.com/owner/repo"');
    expect(html).toContain("Task prompt (required)");
    expect(html).toContain("Security report (optional)");
    expect(html).toContain("Review &amp; propose fix");
    expect(html).toContain("Red identifies source concerns; Blue checks the evidence and proposes a fix.");
    expect(html).toContain("Tests are not run in this workflow");
    expect(html).toContain("Repair with regression");
    expect(html).toContain("실시간 외부 API");
    expect(html).not.toContain("Existing regression test (required)");
    expect(html).not.toContain("Patch file");
    const report = html.match(/<textarea[^>]*placeholder="Add context[^>]*>/)?.[0];
    expect(report).toBeDefined();
    expect(report).not.toContain("required");
  });
});
