import { posix } from "node:path";

export function safeJoin(root: string, ...parts: string[]): string {
  const rootN = posix.normalize(root);
  const resolved = posix.normalize(posix.join(rootN, ...parts));
  const prefix = rootN.endsWith("/") ? rootN : `${rootN}/`;
  if (resolved !== rootN && !resolved.startsWith(prefix)) {
    throw new Error("path escapes root");
  }
  return resolved;
}
