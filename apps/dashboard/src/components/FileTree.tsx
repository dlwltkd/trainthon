import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye, FileCode2, FolderClosed, FolderOpen, Pencil } from "lucide-react";
import { cn } from "@/lib/cn";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: boolean;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map(), file: false };
  for (const file of files) {
    const parts = file.split("/");
    let node = root;
    let path = "";
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), file: index === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  return [...node.children.values()].sort((a, b) => {
    if (a.file !== b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function FileTree({
  files,
  inspected,
  changed,
  selected,
  onSelect,
}: {
  files: string[];
  inspected: Set<string>;
  changed: Set<string>;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const autoOpen = useMemo(() => {
    const open = new Set<string>();
    const mark = (path: string) => {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) open.add(parts.slice(0, i).join("/"));
    };
    for (const p of changed) mark(p);
    for (const p of inspected) mark(p);
    if (open.size === 0) {
      for (const child of tree.children.values()) if (!child.file) open.add(child.path);
    }
    return open;
  }, [changed, inspected, tree]);
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const isOpen = (path: string) => toggled.get(path) ?? autoOpen.has(path);
  const toggle = (path: string) => setToggled((prev) => new Map(prev).set(path, !isOpen(path)));

  if (files.length === 0) {
    return <div className="p-4 text-[0.9em] text-ink-3">The file list arrives with the repository snapshot.</div>;
  }

  const render = (node: TreeNode, depth: number): React.ReactNode =>
    sortedChildren(node).map((child) => {
      const pad = { paddingLeft: `${depth * 12 + 8}px` };
      if (child.file) {
        const isChanged = changed.has(child.path);
        const isInspected = inspected.has(child.path);
        const isSelected = selected === child.path;
        return (
          <button
            key={child.path}
            onClick={() => onSelect(child.path)}
            style={pad}
            className={cn(
              "group flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[0.9em] hover:bg-zinc-100",
              isSelected && "bg-info-soft text-info hover:bg-info-soft",
              !isSelected && (isChanged ? "text-ink font-medium" : isInspected ? "text-ink" : "text-ink-2"),
            )}
            title={child.path}
          >
            <FileCode2 className={cn("size-3.5 shrink-0", isSelected ? "text-info" : "text-ink-3")} />
            <span className="min-w-0 flex-1 truncate font-mono text-[0.95em]">{child.name}</span>
            {isChanged && <Pencil className="size-3 shrink-0 text-blue-role" aria-label="changed" />}
            {!isChanged && isInspected && <Eye className="size-3 shrink-0 text-ink-3" aria-label="inspected" />}
          </button>
        );
      }
      const open = isOpen(child.path);
      return (
        <div key={child.path}>
          <button onClick={() => toggle(child.path)} style={pad} className="flex h-7 w-full items-center gap-1 pr-2 text-left text-[0.9em] text-ink-2 hover:bg-zinc-100">
            {open ? <ChevronDown className="size-3 shrink-0 text-ink-3" /> : <ChevronRight className="size-3 shrink-0 text-ink-3" />}
            {open ? <FolderOpen className="size-3.5 shrink-0 text-ink-3" /> : <FolderClosed className="size-3.5 shrink-0 text-ink-3" />}
            <span className="truncate">{child.name}</span>
          </button>
          {open && render(child, depth + 1)}
        </div>
      );
    });

  return <div className="py-1">{render(tree, 0)}</div>;
}
