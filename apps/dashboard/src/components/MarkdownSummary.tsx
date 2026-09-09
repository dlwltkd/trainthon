import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

function inline(text: string, depth = 0): ReactNode[] {
  if (depth >= 4) return [text];
  const output: ReactNode[] = [];
  let plain = "";
  const add = (node: ReactNode) => {
    if (plain) output.push(plain);
    plain = "";
    output.push(node);
  };

  for (let index = 0; index < text.length;) {
    const char = text[index]!;
    if (char === "\\" && /[\\`*_\[\]#!]/.test(text[index + 1] ?? "")) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (char === "`") {
      const marker = /^`+/.exec(text.slice(index))![0];
      const end = text.indexOf(marker, index + marker.length);
      if (end > index + marker.length) {
        add(<code key={index} className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.92em]">{text.slice(index + marker.length, end)}</code>);
        index = end + marker.length;
        continue;
      }
    }
    const labelStart = char === "[" ? index : char === "!" && text[index + 1] === "[" ? index + 1 : -1;
    if (labelStart >= 0) {
      const labelEnd = text.indexOf("](", labelStart + 1);
      if (labelEnd >= 0) {
        let end = labelEnd + 2;
        let nesting = 1;
        while (end < text.length && nesting > 0) {
          if (text[end] === "\\") end++;
          else if (text[end] === "(") nesting++;
          else if (text[end] === ")") nesting--;
          end++;
        }
        if (nesting === 0) {
          add(<span key={index}>{inline(text.slice(labelStart + 1, labelEnd), depth + 1)}</span>);
          index = end;
          continue;
        }
      }
    }
    if (char === "*" || (char === "_" && !/[\w]/.test(text[index - 1] ?? ""))) {
      const strong = text[index + 1] === char;
      const marker = strong ? char.repeat(2) : char;
      const end = text.indexOf(marker, index + marker.length);
      if (end > index + marker.length) {
        const children = inline(text.slice(index + marker.length, end), depth + 1);
        add(strong ? <strong key={index} className="font-semibold text-ink">{children}</strong> : <em key={index}>{children}</em>);
        index = end + marker.length;
        continue;
      }
    }
    plain += char;
    index++;
  }
  if (plain) output.push(plain);
  return output;
}

const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/;
const listItem = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/;
const fence = /^ {0,3}(`{3,}|~{3,})([\w+-]*)\s*$/;
const quote = /^ {0,3}>\s?(.*)$/;
const divider = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const startsBlock = (line: string) => heading.test(line) || listItem.test(line) || fence.test(line) || quote.test(line) || divider.test(line);

export function MarkdownSummary({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const key = index;
    if (!line.trim()) { index++; continue; }
    const code = fence.exec(line);
    if (code) {
      const contents: string[] = [];
      const closing = new RegExp(`^ {0,3}${code[1]![0]}{${code[1]!.length},}\\s*$`);
      index++;
      while (index < lines.length && !closing.test(lines[index]!)) contents.push(lines[index++]!);
      if (index < lines.length) index++;
      blocks.push(<pre key={key} className="code max-h-80 overflow-auto rounded-lg border border-line bg-canvas p-3"><code>{contents.join("\n")}</code></pre>);
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      const Tag = `h${Math.min(6, title[1]!.length + 2)}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={key} className="font-semibold leading-snug text-ink">{inline(title[2]!)}</Tag>);
      index++;
      continue;
    }
    if (divider.test(line)) { blocks.push(<hr key={key} className="border-line" />); index++; continue; }
    const firstItem = listItem.exec(line);
    if (firstItem) {
      const ordered = firstItem[2] !== undefined;
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = listItem.exec(lines[index]!);
        if (!item || (item[2] !== undefined) !== ordered) break;
        items.push(<li key={index} className="pl-0.5 leading-relaxed">{inline(item[3]!)}</li>);
        index++;
      }
      blocks.push(ordered ? <ol key={key} start={Number(firstItem[2])} className="list-decimal space-y-1 pl-5">{items}</ol> : <ul key={key} className="list-disc space-y-1 pl-5">{items}</ul>);
      continue;
    }
    if (quote.test(line)) {
      const contents: string[] = [];
      while (index < lines.length && quote.test(lines[index]!)) contents.push(quote.exec(lines[index++]!)![1]!);
      blocks.push(<blockquote key={key} className="whitespace-pre-line border-l-2 border-line-2 pl-3 text-ink-3">{inline(contents.join("\n"))}</blockquote>);
      continue;
    }
    const paragraph = [line];
    index++;
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push(<p key={key} className="whitespace-pre-line leading-relaxed">{inline(paragraph.join("\n"))}</p>);
  }
  return <div className={cn("min-w-0 space-y-3 break-words", className)}>{blocks}</div>;
}
