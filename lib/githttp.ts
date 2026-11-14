// Git smart HTTP: info/refs advertisements, protocol v2 ls-refs and fetch for
// upload-pack, and v0 receive-pack with report-status over side-band-64k.
// The suite speaks the protocol in process (no git binary anywhere), so this
// module is the whole transport: pkt-lines, shallow object sets and packs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import {
  buildPack,
  isAncestor,
  parseCommit,
  parsePack,
  parseTree,
  reachableObjects,
  ZERO_SHA,
  type GitObject,
} from './git.ts';
import { readBody, sendRaw } from './http.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse pkt-lines from `buf` starting at `at`; returns the packets and the offset after them. */
export function parsePkts(buf: Buffer, at = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let offset = at;
  while (offset + 4 <= buf.length) {
    const head = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      // Response-end packet (protocol v2); treat as a flush.
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

function pktText(pkt: Pkt): string {
  return pkt.data.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------- advertisements

const AGENT = 'forge/1.0';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The v0 ref advertisement lines for a repository (HEAD first, peeled tags after their tag). */
function v0RefLines(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer[] {
  const capabilities =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=${AGENT}`
      : `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [];
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_SHA;
  if (repo.refs.size === 0) {
    lines.push(pktLine(`${ZERO_SHA} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  lines.push(pktLine(`${headSha} HEAD\0${capabilities}\n`));
  for (const ref of sortedRefNames(repo)) {
    const sha = repo.refs.get(ref) as string;
    lines.push(pktLine(`${sha} ${ref}\n`));
    const obj = repo.objects.get(sha);
    if (obj !== undefined && obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match !== null) lines.push(pktLine(`${match[1]} ${ref}^{}\n`));
    }
  }
  return lines;
}

function isV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && /(?:^|,)version=2(?:,|$)/.test(header.replace(/\s/g, ''));
}

export function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string | null,
): void {
  void store;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendRaw(res, 403, Buffer.from('only git services are served\n'), { 'content-type': 'text/plain' });
    return;
  }
  if (service === 'git-upload-pack' && isV2(req)) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow wait-for-done filter\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    sendRaw(res, 200, body, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    return;
  }
  const body = Buffer.concat([
    pktLine(`# service=${service}\n`),
    PKT_FLUSH,
    ...v0RefLines(repo, service),
    PKT_FLUSH,
  ]);
  sendRaw(res, 200, body, { 'content-type': `application/x-${service}-advertisement` });
}

// ---------------------------------------------------------------- upload-pack v2

/** Objects reachable from `starts`, treating commits in `graft` as parentless (a shallow
 *  client's view of its own history: the boundary commits' parents are cut). */
function graftedReachable(store: Map<string, GitObject>, starts: string[], graft: Set<string>): Set<string> {
  const out = new Set<string>();
  const walk = (sha: string): void => {
    if (out.has(sha)) return;
    const obj = store.get(sha);
    if (obj === undefined) return;
    out.add(sha);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) walk(entry.sha);
    } else if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      walk(info.tree);
      if (!graft.has(sha)) for (const parent of info.parents) walk(parent);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (match !== null) walk(match[1] as string);
    }
  };
  for (const start of starts) walk(start);
  return out;
}

/** Pack order: commits, then trees, then blobs, then tags, each sorted — deterministic bytes. */
function orderPack(store: Map<string, GitObject>, set: Set<string>): string[] {
  const byType = (type: GitObject['type']): string[] => [...set].filter((sha) => store.get(sha)?.type === type).sort();
  return [...byType('commit'), ...byType('tree'), ...byType('blob'), ...byType('tag')];
}

/**
 * The object set for a fetch: everything reachable from wants minus what the client already
 * holds, honoring shallow depth. `shallowKnown` is the client's declared shallow boundary:
 * those commits count as held and parentless, and a deepen window is measured in generations
 * from the wants. The returned shallow list names the new boundary; unshallow names declared
 * boundary commits whose parents this fetch delivers.
 */
function fetchObjectSet(
  repo: Repo,
  wants: string[],
  haves: Set<string>,
  deepen: number | null,
  shallowKnown: string[],
): { shas: string[]; shallow: string[]; unshallow: string[] } {
  const store = repo.objects;
  if (deepen === null) {
    const all = reachableObjects(store, wants);
    for (const sha of reachableObjects(store, [...haves])) all.delete(sha);
    return { shas: orderPack(store, all), shallow: [], unshallow: [] };
  }
  const graft = new Set(shallowKnown);
  const held = graftedReachable(store, [...haves, ...shallowKnown], graft);
  // The depth window: commits within `deepen` generations of a want.
  const window = new Set<string>();
  const queue: Array<{ sha: string; gen: number }> = [];
  for (const want of wants) {
    if (store.get(want)?.type === 'commit') queue.push({ sha: want, gen: 0 });
  }
  while (queue.length > 0) {
    const { sha, gen } = queue.shift() as { sha: string; gen: number };
    if (window.has(sha) || gen >= deepen) continue;
    window.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push({ sha: parent, gen: gen + 1 });
    }
  }
  // The pack: window commits the client lacks, their trees and blobs, plus any non-commit
  // wants (tags) with their closure — minus everything already held.
  const pack = new Set<string>();
  for (const sha of window) if (!held.has(sha)) pack.add(sha);
  for (const sha of graftedReachable(store, [...pack], new Set())) {
    if (!held.has(sha) && (window.has(sha) || store.get(sha)?.type !== 'commit')) pack.add(sha);
  }
  for (const want of wants) {
    if (store.get(want)?.type !== 'commit') {
      for (const sha of reachableObjects(store, [want])) if (!held.has(sha)) pack.add(sha);
    }
  }
  // The new boundary: delivered (or window) commits whose parents stay outside the window
  // and are not held. Declared boundary commits whose parents arrive become unshallowed.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const sha of window) {
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const parentsInside = parents.every((parent) => window.has(parent) || held.has(parent));
    if (parents.length > 0 && !parentsInside) shallow.push(sha);
    if (graft.has(sha) && parents.length > 0 && parents.every((parent) => window.has(parent))) unshallow.push(sha);
  }
  return { shas: orderPack(store, pack), shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** Wrap pack bytes in side-band-64k frames (band 1 = data), with a trailing flush.
 *  A pkt-line totals at most 65520 bytes including its 4-byte header, so a frame's
 *  payload is at most 65516 and the data chunk at most 65515 after the band byte. */
export const SIDEBAND_CHUNK = 65515;

function sideBandWrap(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < pack.length; at += SIDEBAND_CHUNK) {
    const slice = pack.subarray(at, at + SIDEBAND_CHUNK);
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  frames.push(PKT_FLUSH);
  return frames;
}

async function handleUploadPackV2(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  void store;
  const raw = await readBody(req);
  const { packets } = parsePkts(raw);
  const lines = packets.filter((pkt) => pkt.kind === 'data').map(pktText);
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length) ?? '';
  const delimAt = packets.findIndex((pkt) => pkt.kind === 'delim');
  const args = (delimAt === -1 ? lines.slice(1) : packets.slice(delimAt + 1).filter((pkt) => pkt.kind === 'data').map(pktText));

  if (command === 'ls-refs') {
    const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const wantPeel = args.includes('peel');
    const wantSymrefs = args.includes('symrefs');
    const wantUnborn = args.includes('unborn');
    const out: Buffer[] = [];
    const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
    if (matches('HEAD')) {
      if (headSha !== undefined) {
        out.push(pktLine(`${headSha} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      } else if (wantUnborn) {
        out.push(pktLine(`${ZERO_SHA} HEAD symref-target:refs/heads/${repo.defaultBranch} unborn\n`));
      }
    }
    for (const ref of sortedRefNames(repo)) {
      if (!matches(ref)) continue;
      const sha = repo.refs.get(ref) as string;
      let suffix = '';
      const obj = repo.objects.get(sha);
      if (wantPeel && obj !== undefined && obj.type === 'tag') {
        const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
        if (match !== null) suffix = ` peeled:${match[1]}`;
      }
      out.push(pktLine(`${sha} ${ref}${suffix}\n`));
    }
    out.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  if (command === 'fetch') {
    const wants: string[] = [];
    const haves = new Set<string>();
    const shallowKnown: string[] = [];
    let deepen: number | null = null;
    let done = false;
    let waitForDone = false;
    let sideBandAll = false;
    for (const line of args) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowKnown.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7));
      else if (line === 'done') done = true;
      else if (line === 'wait-for-done') waitForDone = true;
      else if (line === 'side-band-all') sideBandAll = true;
    }
    if (waitForDone && !done) {
      const out: Buffer[] = [pktLine('acknowledgments\n')];
      let anyCommon = false;
      for (const have of haves) {
        if (repo.objects.has(have)) {
          out.push(pktLine(`common ${have}\n`));
          anyCommon = true;
        }
      }
      if (!anyCommon) out.push(pktLine('NAK\n'));
      out.push(pktLine('ready\n'), PKT_FLUSH);
      sendRaw(res, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result' });
      return;
    }
    void sideBandAll;
    const cacheKey = `v2|${wants.join(',')}|${[...haves].sort().join(',')}|${deepen}|${shallowKnown.join(',')}`;
    const cached = repo.fetchCache.get(cacheKey);
    if (cached !== undefined) {
      sendRaw(res, 200, cached, { 'content-type': 'application/x-git-upload-pack-result' });
      return;
    }
    const { shas, shallow, unshallow } = fetchObjectSet(repo, wants, haves, deepen, shallowKnown);
    const pack = buildPack(repo.objects, shas);
    const out: Buffer[] = [];
    if (deepen !== null) {
      out.push(pktLine('shallow-info\n'));
      for (const sha of shallow) out.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) out.push(pktLine(`unshallow ${sha}\n`));
      out.push(PKT_DELIM);
    }
    // The suite's client reads the packfile section as sideband packets (band 1 = data),
    // whether or not side-band-all was requested, so the pack always goes out framed.
    out.push(pktLine('packfile\n'));
    out.push(...sideBandWrap(pack));
    const body = Buffer.concat(out);
    if (repo.fetchCache.size < 128) repo.fetchCache.set(cacheKey, body);
    sendRaw(res, 200, body, { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  sendRaw(res, 400, Buffer.from('unknown command\n'), { 'content-type': 'text/plain' });
}

// ---------------------------------------------------------------- upload-pack v0

async function handleUploadPackV0(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  void store;
  const raw = await readBody(req);
  const text = raw.toString('latin1');
  const wants: string[] = [];
  const haves = new Set<string>();
  let deepen: number | null = null;
  for (const match of text.matchAll(/want ([0-9a-f]{40})/g)) wants.push(match[1] as string);
  for (const match of text.matchAll(/have ([0-9a-f]{40})/g)) haves.add(match[1] as string);
  const deepenMatch = /deepen (\d+)/.exec(text);
  if (deepenMatch !== null) deepen = Number(deepenMatch[1]);
  const { shas, shallow } = fetchObjectSet(repo, wants, haves, deepen, []);
  const pack = buildPack(repo.objects, shas);
  const out: Buffer[] = [];
  for (const sha of shallow) out.push(pktLine(`shallow ${sha}\n`));
  if (shallow.length > 0) out.push(pktLine('----\n'));
  out.push(pktLine('NAK\n'));
  out.push(...sideBandWrap(pack));
  sendRaw(res, 200, Buffer.concat(out), { 'content-type': 'application/x-git-upload-pack-result' });
}

// ---------------------------------------------------------------- receive-pack v0

interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  void store;
  const raw = await readBody(req);
  const { packets, next } = parsePkts(raw);
  const commands: RefCommand[] = [];
  let capabilities = '';
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.trim().split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] as string)) {
      commands.push({ oldSha: parts[0] as string, newSha: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = raw.subarray(next);
  const wantsSideBand = capabilities.includes('side-band-64k');
  const wantsReport = capabilities.includes('report-status');

  // The merged object view: the repository plus everything the pack carries.
  const merged = new Map(repo.objects);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(repo.objects, packBytes);
      for (const [sha, obj] of parsed.objects) merged.set(sha, obj);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (unpackError !== null) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: `unpacker error: ${unpackError}` });
  } else {
    // Persist the pack's objects first: ancestry checks below read the merged view either way,
    // and git keeps the objects even when a ref update is refused.
    for (const [sha, obj] of merged) {
      if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
    }
    const mergedStore: Map<string, GitObject> = merged;
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_SHA;
      if (command.newSha === ZERO_SHA) {
        // Delete.
        if (current === ZERO_SHA) {
          results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true });
        }
        continue;
      }
      const target = mergedStore.get(command.newSha);
      if (target === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'reference is not a commit or tag' });
        continue;
      }
      if (current !== ZERO_SHA && current !== command.oldSha) {
        results.push({ ref: command.ref, ok: false, reason: 'reference was changed' });
        continue;
      }
      if (current !== ZERO_SHA && target.type === 'commit' && !isAncestor(mergedStore, current, command.newSha)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newSha);
      results.push({ ref: command.ref, ok: true });
    }
  }
  repo.updatedAt = store.nowIso();

  if (!wantsReport) {
    sendRaw(res, 200, Buffer.alloc(0), { 'content-type': 'application/x-git-receive-pack-result' });
    return;
  }
  const report: Buffer[] = [];
  report.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack error: ${unpackError}\n`));
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  const inner = Buffer.concat(report);
  if (wantsSideBand) {
    const frames: Buffer[] = [];
    for (let at = 0; at < inner.length; at += SIDEBAND_CHUNK) {
      frames.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, at + SIDEBAND_CHUNK)])));
    }
    frames.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(frames), { 'content-type': 'application/x-git-receive-pack-result' });
    return;
  }
  sendRaw(res, 200, inner, { 'content-type': 'application/x-git-receive-pack-result' });
}

// ---------------------------------------------------------------- entry

/** Handle /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}. */
export async function handleGitHttp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoSegment: string,
  action: string,
  query: URLSearchParams,
): Promise<void> {
  const name = repoSegment.endsWith('.git') ? repoSegment.slice(0, -'.git'.length) : repoSegment;
  const repo = store.resolve(owner, name);
  if (repo === null) {
    sendRaw(res, 404, Buffer.from('repository not found\n'), { 'content-type': 'text/plain' });
    return;
  }
  if (action === 'info/refs') {
    handleInfoRefs(store, req, res, repo, query.get('service'));
    return;
  }
  if (action === 'git-upload-pack') {
    if (isV2(req)) await handleUploadPackV2(store, req, res, repo);
    else await handleUploadPackV0(store, req, res, repo);
    return;
  }
  if (action === 'git-receive-pack') {
    await handleReceivePack(store, req, res, repo);
    return;
  }
  sendRaw(res, 404, Buffer.from('not found\n'), { 'content-type': 'text/plain' });
}
