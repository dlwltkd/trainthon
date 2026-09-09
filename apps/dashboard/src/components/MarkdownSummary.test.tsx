import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownSummary } from "./MarkdownSummary";

const render = (text: string) => renderToStaticMarkup(<MarkdownSummary text={text} />);

describe("safe summary markdown", () => {
  it("formats headings, emphasis, lists, quotes and code used by agent summaries", () => {
    const html = render("## Review\n\n**Finding:** inspect `handler`.\n\n- First **item**\n- Second *item*\n\n1. Inspect\n2. Review\n\n> Observed in source\n\n```ts\nconst value = 1;\n```");
    expect(html).toContain("<h4");
    expect(html).toContain("Review</h4>");
    expect(html).toContain(">Finding:</strong>");
    expect(html).toContain(">handler</code>");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<em>item</em>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<pre");
    expect(html).toContain("<code>const value = 1;</code>");
    expect(html).not.toContain("**Finding:**");
  });

  it("escapes HTML and emits neither arbitrary links nor image requests", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://example.test/pixel" onerror="alert(1)">\n\n[Read this](javascript:alert(1)) and ![remote image](https://example.test/image.png)');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Read this");
    expect(html).toContain("remote image");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('src="');
  });

  it("keeps markdown and HTML literal inside code, including unfinished fences", () => {
    expect(render("`**literal** <div>`")).toContain(">**literal** &lt;div&gt;</code>");
    const html = render("```html\n<script>example</script>\n**literal**");
    expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
    expect(html).toContain("**literal**");
    expect(html).not.toContain("<strong");
  });

  it("preserves unfinished markers and ordinary underscores in source names", () => {
    const html = render("**unfinished and `open\n\nread_only_file.py\n\n\\*literal\\*");
    expect(html).toContain("**unfinished and `open");
    expect(html).toContain("read_only_file.py");
    expect(html).toContain("*literal*");
    expect(html).not.toContain("<em>");
  });
});
