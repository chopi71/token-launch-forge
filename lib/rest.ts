// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, in GitHub's shapes and status codes.
// The endpoint contract is the one the conformance suite's header states;
// every handler reads and writes the shared Store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeId, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';
import {
  buildTree,
  flattenTree,
  formatCommit,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  writeObject,
  ZERO_SHA,
} from './git.ts';
import { changedFiles, mergeTrees } from './merge.ts';
import { isRecord, parseJsonBody, readBody, sendJson } from './http.ts';

type Json = Record<string, unknown>;

export interface RestContext {
  store: Store;
  /** Absolute origin of this server as the client addressed it, e.g. http://127.0.0.1:8790. */
  origin: string;
}

// ---------------------------------------------------------------- shapes

export function viewerJson(store: Store): Json {
  const login = store.viewerLogin ?? 'viewer';
  return { login, id: 1, node_id: nodeId('User', 1), type: 'User', site_admin: false };
}

export function repoJson(store: Store, repo: Repo, origin: string): Json {
  const owner = store.ownerOf(repo);
  const fullName = `${owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: { login: owner, id: 1, node_id: nodeId('User', 1), type: 'User', site_admin: false },
    html_url: `${origin}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${fullName}.git`,
    clone_url: `${origin}/${fullName}.git`,
    ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

export function labelJson(repo: Repo, name: string): Json {
  const label = repo.labels.get(name);
  return {
    id: [...repo.labels.keys()].indexOf(name) + 1,
    node_id: nodeId('Label', repo.id * 1000 + [...repo.labels.keys()].indexOf(name) + 1),
    url: '',
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: null,
  };
}

export function issueJson(store: Store, repo: Repo, issue: IssueRec, origin: string): Json {
  const owner = store.ownerOf(repo);
  const base = `${origin}/api/v3/repos/${owner}/${repo.name}`;
  return {
    id: issue.number * 100000 + repo.id,
    node_id: nodeId('Issue', issue.number * 100000 + repo.id),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    html_url: `${origin}/${owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: viewerJson(store),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignees: [],
    comments: issue.comments.length,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    closed_at: issue.state === 'closed' ? repo.updatedAt : null,
    pull_request: issue.isPull ? { url: `${base}/pulls/${issue.number}`, html_url: `${origin}/${owner}/${repo.name}/pull/${issue.number}` } : undefined,
  };
}

function refJson(store: Store, repo: Repo, refName: string, origin: string): Json {
  const owner = store.ownerOf(repo);
  const sha = repo.refs.get(refName) ?? ZERO_SHA;
  return {
    ref: refName,
    node_id: nodeId('Ref', repo.id),
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/${refName}`,
    object: { type: 'commit', sha, url: `${origin}/api/v3/repos/${owner}/${repo.name}/git/commits/${sha}` },
  };
}

function branchJson(store: Store, repo: Repo, name: string, origin: string): Json {
  const owner = store.ownerOf(repo);
  const sha = repo.refs.get(`refs/heads/${name}`) ?? ZERO_SHA;
  return {
    name,
    commit: { sha, url: `${origin}/api/v3/repos/${owner}/${repo.name}/commits/${sha}` },
    protected: false,
  };
}

export function commitJson(store: Store, repo: Repo, sha: string, origin: string): Json {
  const owner = store.ownerOf(repo);
  const obj = repo.objects.get(sha);
  const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const splitIdentity = (line: string): Json => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: repo.createdAt };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha,
    node_id: nodeId('Commit', repo.id),
    commit: {
      author: info === null ? { name: '', email: '', date: repo.createdAt } : splitIdentity(info.author),
      committer: info === null ? { name: '', email: '', date: repo.createdAt } : splitIdentity(info.committer),
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? ZERO_SHA, url: '' },
      comment_count: 0,
    },
    url: `${origin}/api/v3/repos/${owner}/${repo.name}/commits/${sha}`,
    html_url: `${origin}/${owner}/${repo.name}/commit/${sha}`,
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: `${origin}/api/v3/repos/${owner}/${repo.name}/commits/${parent}` })),
    author: viewerJson(store),
    committer: viewerJson(store),
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRec, origin: string): Json {
  const owner = store.ownerOf(repo);
  const base = `${origin}/api/v3/repos/${owner}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_SHA;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_SHA;
  const mergeable = pull.merged ? true : computeMergeable(repo, pull);
  const issue = repo.issues.get(pull.number);
  return {
    id: pull.number * 100000 + repo.id,
    node_id: nodeId('PullRequest', pull.number * 100000 + repo.id),
    url: `${base}/pulls/${pull.number}`,
    html_url: `${origin}/${owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: viewerJson(store),
    created_at: issue?.seq !== undefined ? repo.createdAt : repo.createdAt,
    updated_at: repo.updatedAt,
    closed_at: pull.state === 'closed' ? repo.updatedAt : null,
    merged_at: pull.merged ? repo.updatedAt : null,
    merge_commit_sha: pull.mergeSha,
    draft: false,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: `${owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: viewerJson(store),
      repo: repoJson(store, repo, origin),
    },
    base: {
      label: `${owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: viewerJson(store),
      repo: repoJson(store, repo, origin),
    },
    _links: {},
  };
}

/** Whether the pull's head merges into its base without a file conflict (null before both exist). */
export function computeMergeable(repo: Repo, pull: PullRec): boolean | null {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  if (isAncestor(repo.objects, headSha, baseSha)) return true;
  const base = mergeBase(repo.objects, baseSha, headSha);
  return !mergeTrees(repo.objects, baseSha, headSha, base).conflict;
}

// ---------------------------------------------------------------- helpers

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message, errors: [{ resource: 'Resource', code: 'custom', field: 'name', message }] });
}

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(res: ServerResponse, origin: string, path: string, query: URLSearchParams, items: T[]): T[] {
  const { page, perPage } = pageOf(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const params = new URLSearchParams(query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    const last = new URLSearchParams(query);
    last.set('page', String(totalPages));
    last.set('per_page', String(perPage));
    res.setHeader(
      'link',
      `<${origin}${path}?${params.toString()}>; rel="next", <${origin}${path}?${last.toString()}>; rel="last"`,
    );
  }
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The identity REST-made commits carry: the token owner, once learned. */
export function forgeIdentity(store: Store): string {
  const login = store.viewerLogin ?? 'viewer';
  return `${login} <${login}@example.invalid>`;
}

/** Commit a new tree on a branch; returns the new commit sha. */
export function commitOnBranch(
  store: Store,
  repo: Repo,
  branch: string,
  treeSha: string,
  message: string,
  extraParents: string[] = [],
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const identity = forgeIdentity(store);
  const stamp = store.nowGitStamp();
  const sha = writeObject(repo.objects, 'commit', formatCommit({
    tree: treeSha,
    parents: [...(parent === undefined ? [] : [parent]), ...extraParents],
    author: `${identity} ${stamp}`,
    committer: `${identity} ${stamp}`,
    message,
  }));
  repo.refs.set(ref, sha);
  repo.updatedAt = store.nowIso();
  return sha;
}

/** Flatten the tree a ref (or the default branch) points at; empty for an unborn branch. */
export function treeFilesOf(repo: Repo, refName: string | null): Map<string, { mode: string; sha: string }> {
  const sha = refName === null ? undefined : repo.refs.get(refName);
  if (sha === undefined) return new Map();
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(obj.data).tree);
}

// ---------------------------------------------------------------- routing

/** Handle one /api/v3 request. `segments` are the decoded path segments after /api/v3. */
export async function handleRest(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  const { store, origin } = ctx;
  const method = req.method ?? 'GET';
  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  let body: Json = {};
  if (raw.length > 0) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    if (isRecord(parsed.value)) body = parsed.value;
  }
  const [head, ...rest] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound(res);
    sendJson(res, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      issue_url: `${origin}/api/v3/repos/{owner}/{repo}/issues`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (head === 'meta' && segments.length === 1) {
    sendJson(res, 200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
    return;
  }
  if (head === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, viewerJson(store));
    return;
  }
  if (head === 'user' && rest[0] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const items = store.repos.map((repo) => repoJson(store, repo, origin));
      sendJson(res, 200, paginate(res, origin, '/api/v3/user/repos', query, items));
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable(res, 'name is required');
      if (store.byName.has(name)) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = store.createRepo(name);
      repo.isPrivate = body.private === true;
      repo.description = typeof body.description === 'string' ? body.description : '';
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (body.auto_init === true) {
        const blob = writeObject(repo.objects, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
        const tree = buildTree(repo.objects, new Map([['README.md', { mode: '100644', sha: blob }]]));
        commitOnBranch(store, repo, repo.defaultBranch, tree, 'Initial commit');
      }
      sendJson(res, 201, repoJson(store, repo, origin));
      return;
    }
    return notFound(res);
  }
  if (head !== 'repos' || rest.length < 2) return notFound(res);
  const owner = rest[0] as string;
  const repoName = rest[1] as string;
  const tail = rest.slice(2);
  const repo = store.resolve(owner, repoName);
  if (repo === null) return notFound(res);
  await handleRepo(ctx, req, res, repo, method, body, tail, query);
}

async function handleRepo(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  method: string,
  body: Json,
  tail: string[],
  query: URLSearchParams,
): Promise<void> {
  const { store, origin } = ctx;
  void req;

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(store, repo, origin));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        store.byName.delete(repo.name);
        (repo as { name: string }).name = body.name;
        store.byName.set(repo.name, repo);
      }
      repo.updatedAt = store.nowIso();
      sendJson(res, 200, repoJson(store, repo, origin));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      sendJson(res, 204, undefined);
      return;
    }
    return notFound(res);
  }

  const [area, ...sub] = tail;

  if (area === 'branches') {
    if (sub.length === 0 && method === 'GET') {
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length));
      sendJson(res, 200, paginate(res, origin, '', query, names.map((name) => branchJson(store, repo, name, origin))));
      return;
    }
    if (sub.length >= 1 && method === 'GET') {
      const name = sub.join('/');
      if (!repo.refs.has(`refs/heads/${name}`)) return notFound(res);
      sendJson(res, 200, branchJson(store, repo, name, origin));
      return;
    }
    return notFound(res);
  }

  if (area === 'git' && sub[0] === 'refs') {
    if (sub.length === 1 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      const target = repo.objects.get(sha);
      if (!ref.startsWith('refs/') || target === undefined) return unprocessable(res, 'Invalid ref or sha');
      repo.refs.set(ref, sha);
      repo.updatedAt = store.nowIso();
      sendJson(res, 201, refJson(store, repo, ref, origin));
      return;
    }
    if (sub.length === 1 && method === 'GET') {
      sendJson(res, 200, [...repo.refs.keys()].map((ref) => refJson(store, repo, ref, origin)));
      return;
    }
    if (sub.length >= 2 && method === 'GET') {
      const ref = `refs/${sub.join('/')}`;
      if (!repo.refs.has(ref)) return notFound(res);
      sendJson(res, 200, refJson(store, repo, ref, origin));
      return;
    }
    if (sub.length >= 2 && method === 'DELETE') {
      const ref = `refs/${sub.join('/')}`;
      if (!repo.refs.delete(ref)) return notFound(res);
      sendJson(res, 204, undefined);
      return;
    }
    return notFound(res);
  }

  if (area === 'commits') {
    if (sub.length === 0 && method === 'GET') {
      const wanted = query.get('sha');
      let tip: string | undefined;
      if (wanted === null || wanted === '') tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      else if (repo.refs.has(`refs/heads/${wanted}`)) tip = repo.refs.get(`refs/heads/${wanted}`);
      else if (repo.refs.has(`refs/tags/${wanted}`)) tip = repo.refs.get(`refs/tags/${wanted}`);
      else if (repo.objects.get(wanted)?.type === 'commit') tip = wanted;
      else if (wanted === repo.defaultBranch) tip = undefined;
      if (tip === undefined) {
        sendJson(res, 200, []);
        return;
      }
      const order: string[] = [];
      const seen = new Set<string>();
      const stack = [tip];
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (seen.has(sha)) continue;
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') continue;
        seen.add(sha);
        order.push(sha);
        const parents = parseCommit(obj.data).parents;
        for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
      }
      const items = order.map((sha) => commitJson(store, repo, sha, origin));
      sendJson(res, 200, paginate(res, origin, '', query, items));
      return;
    }
    if (sub.length === 1 && method === 'GET') {
      const sha = sub[0] as string;
      if (repo.objects.get(sha)?.type !== 'commit') return notFound(res);
      sendJson(res, 200, commitJson(store, repo, sha, origin));
      return;
    }
    return notFound(res);
  }

  if (area === 'contents') {
    await handleContents(ctx, res, repo, method, body, sub.join('/'), query);
    return;
  }

  if (area === 'labels') {
    if (sub.length === 0 && method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable(res, 'name is required');
      if (repo.labels.has(name)) return unprocessable(res, 'already_exists');
      repo.labels.set(name, { name, color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed' });
      sendJson(res, 201, labelJson(repo, name));
      return;
    }
    if (sub.length === 0 && method === 'GET') {
      sendJson(res, 200, paginate(res, origin, '', query, [...repo.labels.keys()].map((name) => labelJson(repo, name))));
      return;
    }
    return notFound(res);
  }

  if (area === 'issues') {
    await handleIssues(ctx, res, repo, method, body, sub, query);
    return;
  }

  if (area === 'pulls') {
    await handlePulls(ctx, res, repo, method, body, sub, query);
    return;
  }

  return notFound(res);
}

// ---------------------------------------------------------------- contents

function resolveRefCommit(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`) as string;
  if (repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

async function handleContents(
  ctx: RestContext,
  res: ServerResponse,
  repo: Repo,
  method: string,
  body: Json,
  path: string,
  query: URLSearchParams,
): Promise<void> {
  const { store, origin } = ctx;
  const owner = store.ownerOf(repo);

  if (method === 'GET') {
    const commitSha = resolveRefCommit(repo, query.get('ref'));
    if (commitSha === null) {
      if (path === '') {
        sendJson(res, 200, []);
        return;
      }
      return notFound(res);
    }
    const commit = repo.objects.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return notFound(res);
    const treeSha = parseCommit(commit.data).tree;
    // Navigate to the requested node inside the tree.
    let nodeSha = treeSha;
    let nodeIsTree = true;
    if (path !== '') {
      nodeIsTree = false;
      let current = treeSha;
      const parts = path.split('/');
      for (let i = 0; i < parts.length; i += 1) {
        const treeObj = repo.objects.get(current);
        if (treeObj === undefined || treeObj.type !== 'tree') return notFound(res);
        const entry = parseTree(treeObj.data).find((candidate) => candidate.name === parts[i]);
        if (entry === undefined) return notFound(res);
        if (i === parts.length - 1) {
          nodeSha = entry.sha;
          nodeIsTree = entry.mode === '40000';
        } else {
          if (entry.mode !== '40000') return notFound(res);
          current = entry.sha;
        }
      }
    }
    if (nodeIsTree) {
      const treeObj = repo.objects.get(nodeSha);
      if (treeObj === undefined || treeObj.type !== 'tree') return notFound(res);
      const entries = parseTree(treeObj.data).map((entry) => {
        const isDir = entry.mode === '40000';
        const blob = repo.objects.get(entry.sha);
        return {
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.sha,
          size: isDir ? 0 : (blob?.data.length ?? 0),
          url: '',
          html_url: '',
          git_url: '',
          download_url: null,
          type: isDir ? 'dir' : 'file',
        };
      });
      sendJson(res, 200, entries);
      return;
    }
    const blob = repo.objects.get(nodeSha);
    if (blob === undefined || blob.type !== 'blob') return notFound(res);
    const base64 = blob.data.toString('base64');
    const wrapped = base64.replace(/(.{60})/g, '$1\n') + (base64.length % 60 === 0 && base64.length > 0 ? '' : '\n');
    sendJson(res, 200, {
      name: path.split('/').pop(),
      path,
      sha: nodeSha,
      size: blob.data.length,
      url: `${origin}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
      html_url: `${origin}/${owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: '',
      download_url: null,
      type: 'file',
      encoding: 'base64',
      content: wrapped,
    });
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const files = treeFilesOf(repo, `refs/heads/${branch}`);
    const existing = files.get(path);
    if (method === 'DELETE' && existing === undefined) return notFound(res);
    if (method === 'PUT') {
      if (existing !== undefined) {
        if (body.sha === undefined) return unprocessable(res, 'sha wasn\'t supplied');
        if (body.sha !== existing.sha) {
          sendJson(res, 409, { message: `${path} does not match ${String(body.sha)}`, documentation_url: 'https://docs.github.com/rest' });
          return;
        }
      }
      const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/\s/g, ''), 'base64') : Buffer.alloc(0);
      const blobSha = writeObject(repo.objects, 'blob', content);
      files.set(path, { mode: '100644', sha: blobSha });
      const tree = buildTree(repo.objects, files);
      const commitSha = commitOnBranch(store, repo, branch, tree, typeof body.message === 'string' ? body.message : '');
      sendJson(res, existing === undefined ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message: typeof body.message === 'string' ? body.message : '', author: { name: ctx.store.viewerLogin ?? 'viewer', email: `${ctx.store.viewerLogin ?? 'viewer'}@example.invalid` }, committer: { name: ctx.store.viewerLogin ?? 'viewer', email: `${ctx.store.viewerLogin ?? 'viewer'}@example.invalid` } },
      });
      return;
    }
    // DELETE
    if (body.sha !== undefined && body.sha !== existing?.sha) {
      sendJson(res, 409, { message: `${path} does not match ${String(body.sha)}` });
      return;
    }
    files.delete(path);
    const tree = buildTree(repo.objects, files);
    const commitSha = commitOnBranch(store, repo, branch, tree, typeof body.message === 'string' ? body.message : '');
    sendJson(res, 200, { content: null, commit: { sha: commitSha } });
    return;
  }

  return notFound(res);
}

// ---------------------------------------------------------------- issues

async function handleIssues(
  ctx: RestContext,
  res: ServerResponse,
  repo: Repo,
  method: string,
  body: Json,
  sub: string[],
  query: URLSearchParams,
): Promise<void> {
  const { store, origin } = ctx;

  if (sub.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return unprocessable(res, 'title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.map((label) => (typeof label === 'string' ? label : isRecord(label) && typeof label.name === 'string' ? label.name : '')) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return unprocessable(res, `Validation Failed: label ${name} does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labelNames,
        isPull: false,
        seq: number,
        comments: [],
      };
      repo.issues.set(number, issue);
      repo.updatedAt = store.nowIso();
      sendJson(res, 201, issueJson(store, repo, issue, origin));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let items = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      const wantedLabels = (query.get('labels') ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
      if (wantedLabels.length > 0) items = items.filter((issue) => wantedLabels.every((name) => issue.labels.includes(name)));
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      sendJson(res, 200, paginate(res, origin, '', query, items.map((issue) => issueJson(store, repo, issue, origin))));
      return;
    }
    return notFound(res);
  }

  const number = Number(sub[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (sub.length === 1) {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') {
      sendJson(res, 200, issueJson(store, repo, issue, origin));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const names = body.labels.map((label) => (typeof label === 'string' ? label : ''));
        for (const name of names) if (!repo.labels.has(name)) return unprocessable(res, `Validation Failed: label ${name} does not exist`);
        issue.labels = names;
      }
      repo.updatedAt = store.nowIso();
      sendJson(res, 200, issueJson(store, repo, issue, origin));
      return;
    }
    return notFound(res);
  }

  if (sub.length === 2 && sub[1] === 'comments') {
    if (issue === undefined) return notFound(res);
    if (method === 'POST') {
      const comment = { id: store.nextCommentId(), body: typeof body.body === 'string' ? body.body : '', seq: issue.comments.length };
      issue.comments.push(comment);
      repo.updatedAt = store.nowIso();
      sendJson(res, 201, {
        id: comment.id,
        node_id: nodeId('IssueComment', comment.id),
        url: '',
        html_url: '',
        body: comment.body,
        user: viewerJson(store),
        created_at: repo.updatedAt,
        updated_at: repo.updatedAt,
      });
      return;
    }
    if (method === 'GET') {
      const items = issue.comments.map((comment) => ({
        id: comment.id,
        node_id: nodeId('IssueComment', comment.id),
        url: '',
        html_url: '',
        body: comment.body,
        user: viewerJson(store),
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
      }));
      sendJson(res, 200, paginate(res, origin, '', query, items));
      return;
    }
    return notFound(res);
  }

  return notFound(res);
}

// ---------------------------------------------------------------- pulls

function branchNameOf(ref: string): string {
  const colon = ref.lastIndexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

async function handlePulls(
  ctx: RestContext,
  res: ServerResponse,
  repo: Repo,
  method: string,
  body: Json,
  sub: string[],
  query: URLSearchParams,
): Promise<void> {
  const { store, origin } = ctx;

  if (sub.length === 0) {
    if (method === 'POST') {
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const baseRaw = typeof body.base === 'string' ? body.base : '';
      const head = branchNameOf(headRaw);
      const base = branchNameOf(baseRaw);
      if (head === '' || base === '') return unprocessable(res, 'head and base are required');
      if (!repo.refs.has(`refs/heads/${head}`)) return unprocessable(res, `Head ref ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return unprocessable(res, `Base ref ${base} does not exist`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergeSha: null,
        seq: number,
      };
      repo.pulls.set(number, pull);
      repo.issues.set(number, {
        number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        labels: [],
        isPull: true,
        seq: number,
        comments: [],
      });
      repo.updatedAt = store.nowIso();
      sendJson(res, 201, pullJson(store, repo, pull, origin));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let items = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      sendJson(res, 200, paginate(res, origin, '', query, items.map((pull) => pullJson(store, repo, pull, origin))));
      return;
    }
    return notFound(res);
  }

  const number = Number(sub[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return notFound(res);

  if (sub.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(store, repo, pull, origin));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') {
        pull.state = body.state;
        const issue = repo.issues.get(pull.number);
        if (issue !== undefined) issue.state = body.state;
      }
      if (typeof body.base === 'string') pull.baseRef = branchNameOf(body.base);
      repo.updatedAt = store.nowIso();
      sendJson(res, 200, pullJson(store, repo, pull, origin));
      return;
    }
    return notFound(res);
  }

  if (sub.length === 2 && sub[1] === 'files' && method === 'GET') {
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const mergeBaseSha = mergeBase(repo.objects, baseSha, headSha) ?? baseSha;
    const files = changedFiles(repo.objects, mergeBaseSha, headSha).map((file) => ({ ...file, sha: '', url: '', contents_url: '' }));
    sendJson(res, 200, paginate(res, origin, '', query, files));
    return;
  }

  if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') {
    if (pull.merged || pull.state !== 'open') {
      sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    const base = mergeBase(repo.objects, baseSha, headSha);
    const merged = mergeTrees(repo.objects, baseSha, headSha, base);
    if (merged.conflict) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' });
      return;
    }
    const treeSha = buildTree(repo.objects, merged.files);
    const method3 = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    const message = typeof body.commit_message === 'string' && body.commit_message !== ''
      ? body.commit_message
      : method3 === 'merge'
        ? `Merge pull request #${pull.number} from ${pull.headRef}`
        : `${pull.title} (#${pull.number})${pull.body === '' ? '' : `\n\n${pull.body}`}`;
    const sha = method3 === 'merge'
      ? commitOnBranch(store, repo, pull.baseRef, treeSha, message, [headSha])
      : commitOnBranch(store, repo, pull.baseRef, treeSha, message);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeSha = sha;
    const issue = repo.issues.get(pull.number);
    if (issue !== undefined) issue.state = 'closed';
    repo.updatedAt = store.nowIso();
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  return notFound(res);
}
