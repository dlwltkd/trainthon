import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DraftPullRequest } from "./DraftPullRequest";
import { Button } from "./ui";

function delivery() {
  return { connection: "configured" as const, status: "idle" as const, url: undefined, error: undefined, create: vi.fn(async () => undefined), refresh: vi.fn() };
}

function findCreate(node: ReactNode): (() => void) | undefined {
  let click: (() => void) | undefined;
  Children.forEach(node, (child) => {
    if (!isValidElement<{ children?: ReactNode; variant?: string; onClick?: () => void }>(child)) return;
    if (child.type === Button && child.props.variant === "primary") click = child.props.onClick;
    else click ??= findCreate(child.props.children);
  });
  return click;
}

describe("explicit draft pull request action", () => {
  it("discloses the untested scope and writes only after the create button is clicked", () => {
    const state = delivery();
    const element = DraftPullRequest({ delivery: state, repositoryUrl: "https://github.com/example/repository", tested: false });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Untested source patch");
    expect(html).toContain("Tests were not run");
    expect(html).toContain("writes a branch and draft pull request");
    expect(html).toContain("Create draft PR");
    expect(state.create).not.toHaveBeenCalled();
    const click = findCreate(element);
    expect(click).toBeDefined();
    click!();
    expect(state.create).toHaveBeenCalledOnce();
  });

  it("shows GitHub connection errors and returned draft links", () => {
    const missing = renderToStaticMarkup(<DraftPullRequest delivery={{ ...delivery(), connection: "missing" }} repositoryUrl="https://github.com/example/repository" tested={false} />);
    expect(missing).toContain("GitHub delivery is not connected");
    expect(missing).toContain("disabled");
    const created = renderToStaticMarkup(<DraftPullRequest delivery={{ ...delivery(), status: "created", url: "https://github.com/example/repository/pull/12" }} repositoryUrl="https://github.com/example/repository" tested />);
    expect(created).toContain("Open draft PR");
    expect(created).toContain('href="https://github.com/example/repository/pull/12"');
    expect(created).not.toContain("Tests were not run");
  });
});
