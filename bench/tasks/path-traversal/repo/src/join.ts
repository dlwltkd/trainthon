export function safeJoin(root: string, ...parts: string[]): string {
  return [root.replace(/\/$/, ""), ...parts].join("/");
}
