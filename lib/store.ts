// The forge's one store: every surface (git, REST, GraphQL, MCP) reads and
// writes the same objects here, so an issue made over MCP is the issue REST
// returns, byte for byte. All state lives in memory; nothing here reads the
// wall clock — timestamps derive from the trial's fixed opening time plus a
// sequence counter, so two runs of a trial see identical state.

import type { GitObject } from './git.ts';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  isPull: boolean;
  seq: number;
  comments: CommentRec[];
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string; // branch name, as the client named it
  baseRef: string;
  merged: boolean;
  mergeSha: string | null;
  seq: number;
}

export class Repo {
  readonly objects = new Map<string, GitObject>();
  /** Full ref name ('refs/heads/main') -> commit sha. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;
  description = '';
  isPrivate = false;
  defaultBranch = 'main';
  createdAt = '';
  updatedAt = '';
  /** Whole fetch responses by request signature: objects are content-addressed and never
   *  mutate, so a repeated fetch (the clone workload sends 50 identical ones) is one build. */
  readonly fetchCache = new Map<string, Buffer>();
  /** The owner login this repository is bound to; learned from the first addressed read. */
  ownerLogin: string | null;
  readonly id: number;
  readonly name: string;

  constructor(id: number, name: string, ownerLogin: string | null) {
    this.id = id;
    this.name = name;
    this.ownerLogin = ownerLogin;
  }
}

/** The base instant every timestamp derives from: the trial's fixed opening time when the
 *  harness supplies one (MAKEFUN_TRIAL_NOW), else the contest's opening instant. */
function baseTimeMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  const asNumber = Number(raw);
  if (raw !== '' && Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000;
  return Date.parse('2026-11-14T06:30:00.000Z');
}

export class Store {
  /** Repositories by name, in creation order (the token owns every one of them). */
  readonly repos: Repo[] = [];
  readonly byName = new Map<string, Repo>();
  /** The token owner's login once any surface has revealed it; null until then. */
  viewerLogin: string | null = null;
  private repoSeq = 0;
  private commentSeq = 0;
  private issueSeq = 0;
  private tick = 0;
  private readonly baseMs = baseTimeMs();

  /** A deterministic, strictly increasing ISO timestamp (one second per event). */
  nowIso(): string {
    this.tick += 1;
    return new Date(this.baseMs + this.tick * 1000).toISOString();
  }

  /** A deterministic git timestamp line fragment: '<unix> +0000'. */
  nowGitStamp(): string {
    this.tick += 1;
    return `${Math.floor(this.baseMs / 1000) + this.tick} +0000`;
  }

  createRepo(name: string): Repo {
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, name, this.viewerLogin);
    repo.createdAt = this.nowIso();
    repo.updatedAt = repo.createdAt;
    this.repos.push(repo);
    this.byName.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository addressed as /{owner}/{name}. The token owns every repository, so an
   * existing name addressed under any owner binds that owner as the token's login the first
   * time; afterwards the same name under a different owner is a stranger's path and misses.
   */
  resolve(owner: string, name: string): Repo | null {
    const repo = this.byName.get(name);
    if (repo === undefined) return null;
    if (repo.ownerLogin === null) {
      repo.ownerLogin = owner;
      if (this.viewerLogin === null) this.viewerLogin = owner;
      return repo;
    }
    return repo.ownerLogin === owner ? repo : null;
  }

  /** The login to print as a repository's owner right now (learned, or still unknown). */
  ownerOf(repo: Repo): string {
    return repo.ownerLogin ?? this.viewerLogin ?? 'viewer';
  }

  deleteRepo(repo: Repo): void {
    this.byName.delete(repo.name);
    const at = this.repos.indexOf(repo);
    if (at !== -1) this.repos.splice(at, 1);
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** Globally increasing ids for issue and pull-request objects, as the API hands out. */
  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }
}

/** A GitHub-style node id: base64 of '<Type><database id>', as the API hands out. */
export function nodeId(type: string, databaseId: number): string {
  return Buffer.from(`${type}${databaseId}`, 'utf8').toString('base64');
}

/** Parse a node id back to its type and database id, or null when it is not one of ours. */
export function parseNodeId(id: string): { type: string; databaseId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+)(\d+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1] as string, databaseId: Number(match[2]) };
  } catch {
    return null;
  }
}
