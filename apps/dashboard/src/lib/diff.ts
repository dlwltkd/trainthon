export type DiffLineKind = "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  generated: boolean;
}

const GENERATED = [/^node_modules\//, /\/node_modules\//, /^\.vite\//, /\/\.vite\//, /^dist\//, /\.lock$/, /-lock\.json$/];

function stripPrefix(path: string): string | null {
  if (path === "/dev/null") return null;
  return path.replace(/^[abciw]\//, "");
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!patch || !patch.trim()) return files;
  const lines = patch.split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (file) {
      file.path = file.newPath ?? file.oldPath ?? "unknown";
      if (file.oldPath === null && file.newPath) file.status = "added";
      else if (file.newPath === null && file.oldPath) file.status = "deleted";
      else if (file.oldPath && file.newPath && file.oldPath !== file.newPath) file.status = "renamed";
      file.generated = GENERATED.some((re) => re.test(file!.path));
      files.push(file);
    }
    file = null;
    hunk = null;
  };

  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git (\S+) (\S+)$/.exec(raw);
      file = {
        oldPath: match ? stripPrefix(match[1]!) : null,
        newPath: match ? stripPrefix(match[2]!) : null,
        path: "",
        status: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
        generated: false,
      };
      continue;
    }
    if (!file) {
      if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
        file = { oldPath: null, newPath: null, path: "", status: "modified", hunks: [], additions: 0, deletions: 0, generated: false };
      } else {
        continue;
      }
    }
    if (raw.startsWith("--- ")) {
      file.oldPath = stripPrefix(raw.slice(4).trim());
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file.newPath = stripPrefix(raw.slice(4).trim());
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[2]) : 0;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (raw.startsWith("new file mode") || raw.startsWith("deleted file mode")) {
      if (raw.startsWith("new file")) file.oldPath = null;
      if (raw.startsWith("deleted file")) file.newPath = null;
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("similarity ") || raw.startsWith("rename ") || raw.startsWith("old mode") || raw.startsWith("new mode")) {
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
      file.additions++;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null });
      file.deletions++;
    } else if (raw.startsWith("\\")) {
      hunk.lines.push({ kind: "meta", text: raw.slice(2), oldNo: null, newNo: null });
    } else if (raw === "" && hunk.lines.length === 0) {
      continue;
    } else {
      hunk.lines.push({ kind: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  flush();
  return files;
}

export function diffStats(files: DiffFile[]): { additions: number; deletions: number; files: number } {
  return files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions, files: acc.files + 1 }),
    { additions: 0, deletions: 0, files: 0 },
  );
}
