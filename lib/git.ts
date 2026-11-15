// The git object engine: loose objects in memory, trees, commits, ancestry,
// packfiles in both directions. Pure node:crypto + node:zlib — the trial pod
// has no git binary, so every byte of the protocol is produced here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const ZERO_SHA = '0000000000000000000000000000000000000000';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** The object store of one repository: sha hex -> object. */
export type ObjectStore = Map<string, GitObject>;

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function writeObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!store.has(sha)) store.set(sha, { type, data });
  return sha;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  sha: string;
}

/** Tree entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : 1));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('utf8', at, space),
      name: data.toString('utf8', space + 1, nul),
      sha: data.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

export interface FlatFile {
  mode: string;
  sha: string;
}

/** Flatten a tree (recursively) into path -> {mode, sha}. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, FlatFile>()): Map<string, FlatFile> {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> {mode, sha} map; returns the root tree sha. */
export function buildTree(store: ObjectStore, files: Map<string, FlatFile>): string {
  interface Dir {
    files: Map<string, FlatFile>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      if (!dir.dirs.has(name)) dir.dirs.set(name, { files: new Map(), dirs: new Map() });
      dir = dir.dirs.get(name) as Dir;
    }
    dir.files.set(parts[parts.length - 1] as string, file);
  }
  const emit = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: emit(sub) });
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, sha: file.sha });
    return writeObject(store, 'tree', serializeTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function formatCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** True when `ancestor` is reachable from `descendant` by walking parents (or equal). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** A merge base of two commits (the first common ancestor a breadth search meets), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOf = (start: string): Set<string> => {
    const set = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const sha = queue.pop() as string;
      if (set.has(sha)) continue;
      set.add(sha);
      const obj = store.get(sha);
      if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return set;
  };
  const fromA = ancestorsOf(a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (fromA.has(sha)) return sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Every object reachable from the given commit tips (commits, their trees and blobs, tags peeled). */
export function reachableObjects(store: ObjectStore, tips: string[]): Set<string> {
  const out = new Set<string>();
  const walkObject = (sha: string): void => {
    if (out.has(sha)) return;
    const obj = store.get(sha);
    if (obj === undefined) return;
    out.add(sha);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) walkObject(entry.sha);
    } else if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      walkObject(info.tree);
      for (const parent of info.parents) walkObject(parent);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match !== null) walkObject(match[1] as string);
    }
  };
  for (const tip of tips) walkObject(tip);
  return out;
}

// ---------------------------------------------------------------- packfiles

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const id = TYPE_IDS[type];
  const bytes: number[] = [];
  let first = (id << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize the given objects into a complete packfile (no deltas; every object whole). */
export function buildPack(store: ObjectStore, shas: string[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(shas.length, 8);
  const parts: Buffer[] = [head];
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (from a pack) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) { offset |= delta[at] as number; at += 1; }
      if ((op & 0x02) !== 0) { offset |= (delta[at] as number) << 8; at += 1; }
      if ((op & 0x04) !== 0) { offset |= (delta[at] as number) << 16; at += 1; }
      if ((op & 0x08) !== 0) { offset |= (delta[at] as number) << 24; at += 1; }
      if ((op & 0x10) !== 0) { size |= delta[at] as number; at += 1; }
      if ((op & 0x20) !== 0) { size |= (delta[at] as number) << 8; at += 1; }
      if ((op & 0x40) !== 0) { size |= (delta[at] as number) << 16; at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

export interface ParsedPack {
  /** sha -> object for every object the pack carried (deltas resolved). */
  objects: Map<string, GitObject>;
  count: number;
}

/** Parse a packfile sent by a client, resolving ofs/ref deltas against the pack and the store. */
export function parsePack(store: ObjectStore, pack: Buffer): ParsedPack {
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let at = 12;
  const byOffset = new Map<number, GitObject>();
  const pendingRef: Array<{ baseSha: string; delta: Buffer; offset: number }> = [];
  const objects = new Map<string, GitObject>();
  const record = (offset: number, obj: GitObject): void => {
    byOffset.set(offset, obj);
    objects.set(hashObject(obj.type, obj.data), obj);
  };
  for (let i = 0; i < count; i += 1) {
    const offset = at;
    let byte = pack[at] as number;
    at += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: a negative offset to the base object in this pack.
      let b = pack[at] as number;
      at += 1;
      let baseOffset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[at] as number;
        at += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const compressed = readInflated(pack, at, size);
      at += compressed.consumed;
      const base = byOffset.get(offset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base missing from pack');
      record(offset, { type: base.type, data: applyDelta(base.data, compressed.data) });
    } else if (typeId === 7) {
      // REF_DELTA: the base is named by sha; it may sit in this pack or in the store.
      const baseSha = pack.toString('hex', at, at + 20);
      at += 20;
      const compressed = readInflated(pack, at, size);
      at += compressed.consumed;
      pendingRef.push({ baseSha, delta: compressed.data, offset });
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const compressed = readInflated(pack, at, size);
      at += compressed.consumed;
      if (compressed.data.length !== size) throw new Error('pack object size mismatch');
      record(offset, { type, data: compressed.data });
    }
  }
  // Resolve ref deltas (possibly chained) once every whole object is known.
  let progress = true;
  while (pendingRef.length > 0 && progress) {
    progress = false;
    for (let i = pendingRef.length - 1; i >= 0; i -= 1) {
      const pending = pendingRef[i] as { baseSha: string; delta: Buffer; offset: number };
      const base = objects.get(pending.baseSha) ?? store.get(pending.baseSha);
      if (base === undefined) continue;
      record(pending.offset, { type: base.type, data: applyDelta(base.data, pending.delta) });
      pendingRef.splice(i, 1);
      progress = true;
    }
  }
  if (pendingRef.length > 0) throw new Error('ref-delta base not found');
  return { objects, count };
}

/** Adler-32 of `data`, as the zlib stream trailer carries it (big-endian). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let at = 0;
  while (at < data.length) {
    const end = Math.min(at + 5552, data.length);
    for (let i = at; i < end; i += 1) {
      a += data[i] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
    at = end;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one zlib stream starting at `at`; report the raw bytes and how much input it used.
 * Fast path: one inflate at an upper bound for the compressed length (deflate's stored-block
 * worst case over the known plain size), then locate the stream's exact end from its Adler-32
 * trailer and confirm with a second inflate at that length — two inflates per object instead
 * of a search's worth. Anything unexpected falls back to the original search: exponential
 * growth for a working bound, then binary search for the shortest slice that inflates
 * (inflateSync tolerates trailing bytes but fails on a truncated stream).
 */
function readInflated(pack: Buffer, at: number, size: number): { data: Buffer; consumed: number } {
  const rest = pack.subarray(at);
  const inflates = (length: number): Buffer | null => {
    try {
      return inflateSync(rest.subarray(0, length));
    } catch {
      return null;
    }
  };
  const bound = Math.min(rest.length, size + 16 + 5 * Math.ceil(size / 65535) + Math.ceil(size / 8));
  const whole = bound > 0 ? inflates(bound) : null;
  if (whole !== null && whole.length === size) {
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(adler32(whole), 0);
    let idx = rest.indexOf(tail, 2);
    while (idx !== -1 && idx + 4 <= bound) {
      const consumed = idx + 4;
      const check = inflates(consumed);
      if (check !== null && check.equals(whole)) return { data: whole, consumed };
      idx = rest.indexOf(tail, idx + 1);
    }
  }
  let hi = 1;
  let data = inflates(hi);
  while (data === null && hi < rest.length) {
    hi = Math.min(rest.length, hi * 2);
    data = inflates(hi);
  }
  if (data === null) throw new Error('corrupt zlib stream in pack');
  let lo = Math.max(1, hi >> 1);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inflates(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflates(lo) as Buffer, consumed: lo };
}
