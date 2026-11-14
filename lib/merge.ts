// Three-way merges over flattened trees, and the line diff the pull-request
// files view reports. A path conflicts when both sides changed it away from
// the merge base in different ways; everything else takes the changed side.

import { flattenTree, parseCommit, type FlatFile, type ObjectStore } from './git.ts';

export interface MergeOutcome {
  conflict: boolean;
  conflictPaths: string[];
  /** The merged path -> file map (meaningful only when conflict is false). */
  files: Map<string, FlatFile>;
}

function treeOfCommit(store: ObjectStore, commitSha: string): Map<string, FlatFile> {
  const obj = store.get(commitSha);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(store, parseCommit(obj.data).tree);
}

/** Merge `head` into `base` relative to their merge base's tree. */
export function mergeTrees(
  store: ObjectStore,
  baseCommit: string,
  headCommit: string,
  mergeBaseCommit: string | null,
): MergeOutcome {
  const base = treeOfCommit(store, baseCommit);
  const head = treeOfCommit(store, headCommit);
  const origin = mergeBaseCommit === null ? new Map<string, FlatFile>() : treeOfCommit(store, mergeBaseCommit);
  const files = new Map<string, FlatFile>();
  const conflictPaths: string[] = [];
  const paths = new Set<string>([...origin.keys(), ...base.keys(), ...head.keys()]);
  const same = (a: FlatFile | undefined, b: FlatFile | undefined): boolean =>
    a === undefined ? b === undefined : b !== undefined && a.sha === b.sha && a.mode === b.mode;
  for (const path of paths) {
    const o = origin.get(path);
    const b = base.get(path);
    const h = head.get(path);
    if (same(b, h)) {
      if (b !== undefined) files.set(path, b);
    } else if (same(o, b)) {
      if (h !== undefined) files.set(path, h);
    } else if (same(o, h)) {
      if (b !== undefined) files.set(path, b);
    } else {
      conflictPaths.push(path);
    }
  }
  return { conflict: conflictPaths.length > 0, conflictPaths, files };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of the change from `before` to `after` via a longest-common-subsequence diff. */
export function lineDiff(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = linesOf(before);
  const b = linesOf(after);
  // LCS lengths over suffixes; the files the suite diffs are small, so the quadratic table is fine.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1] as number) + 1 : Math.max(table[i + 1]![j] as number, table[i]![j + 1] as number);
    }
  }
  const common = table[0]![0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The pull-request files view: every path whose blob differs between two commits' trees. */
export function changedFiles(store: ObjectStore, baseCommit: string, headCommit: string): FileChange[] {
  const base = treeOfCommit(store, baseCommit);
  const head = treeOfCommit(store, headCommit);
  const out: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.sha === h.sha) continue;
    const before = b === undefined ? Buffer.alloc(0) : (store.get(b.sha)?.data ?? Buffer.alloc(0));
    const after = h === undefined ? Buffer.alloc(0) : (store.get(h.sha)?.data ?? Buffer.alloc(0));
    const { additions, deletions } = lineDiff(before, after);
    out.push({
      filename: path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}
