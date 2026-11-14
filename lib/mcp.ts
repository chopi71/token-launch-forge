// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking both
// protocol eras the suite accepts — the 2026-07-28 revision (server/discover,
// no handshake) and the handshake revisions (initialize + notifications/
// initialized). The tools act on the same store as REST, so an object made
// here reads back over /api/v3 unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { mergePull } from './graphql.ts';
import { isRecord, readBody, sendJson } from './http.ts';

type Json = Record<string, unknown>;

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'token-launch-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

/** The tool table: fixed at module load, so two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the token user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    required: ['owner', 'repo', 'issue_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, newest first.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
  },
];

const TOOLS_LIST_RESULT: Json = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: false,
    },
  })),
};

// ---------------------------------------------------------------- tool calls

interface ToolOutcome {
  result: Json;
  isError: boolean;
}

function toolText(payload: unknown, isError = false): ToolOutcome {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  const result: Json = { content: [{ type: 'text', text }], isError };
  if (!isError && isRecord(payload)) result.structuredContent = payload;
  return { result, isError };
}

function toolError(message: string): ToolOutcome {
  return toolText(message, true);
}

function originOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? '127.0.0.1'}`;
}

function callTool(store: Store, req: IncomingMessage, name: string, args: Json): ToolOutcome {
  const origin = originOf(req);
  const tool = TOOLS.find((candidate) => candidate.name === name.toLowerCase());
  if (tool === undefined) {
    return { result: {}, isError: true }; // replaced by a JSON-RPC error by the caller
  }
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  switch (tool.name) {
    case 'create_repo': {
      const repoNameNew = String(args.name);
      const existing = store.byName.get(repoNameNew);
      if (existing !== undefined) return toolText(repoJson(store, existing, origin));
      const repo = store.createRepo(repoNameNew);
      repo.description = typeof args.description === 'string' ? args.description : '';
      repo.isPrivate = args.private === true;
      return toolText(repoJson(store, repo, origin));
    }
    case 'get_repo': {
      const repo = store.resolve(owner, repoName);
      return repo === null ? toolError(`repository ${owner}/${repoName} not found`) : toolText(repoJson(store, repo, origin));
    }
    case 'create_issue': {
      const repo = store.resolve(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [] as string[],
        isPull: false,
        seq: number,
        comments: [],
      };
      repo.issues.set(number, issue);
      repo.updatedAt = store.nowIso();
      return toolText(issueJson(store, repo, issue, origin));
    }
    case 'list_issues': {
      const repo = store.resolve(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
      let items = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => b.seq - a.seq);
      return toolText({ issues: items.map((issue) => issueJson(store, repo, issue, origin)), total_count: items.length });
    }
    case 'get_issue': {
      const repo = store.resolve(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = repo.issues.get(Number(args.issue_number));
      return issue === undefined ? toolError(`issue ${String(args.issue_number)} not found`) : toolText(issueJson(store, repo, issue, origin));
    }
    case 'create_pull_request': {
      const repo = store.resolve(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const head = String(args.head).split(':').pop() as string;
      const base = String(args.base).split(':').pop() as string;
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull = {
        number,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        merged: false,
        mergeSha: null,
        seq: number,
      };
      repo.pulls.set(number, pull);
      repo.issues.set(number, { number, title: pull.title, body: pull.body, state: 'open', labels: [], isPull: true, seq: number, comments: [] });
      repo.updatedAt = store.nowIso();
      return toolText(pullJson(store, repo, pull, origin));
    }
    case 'list_pull_requests': {
      const repo = store.resolve(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'all';
      let items = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => b.seq - a.seq);
      return toolText({ pull_requests: items.map((pull) => pullJson(store, repo, pull, origin)), total_count: items.length });
    }
    case 'merge_pull_request': {
      const repo = store.resolve(owner, repoName);
      if (repo === null) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolError(`pull request ${String(args.pull_number)} not found`);
      try {
        mergePull(store, repo, pull, 'SQUASH');
      } catch (err) {
        return toolError(err instanceof Error ? err.message : 'merge failed');
      }
      return toolText(pullJson(store, repo, pull, origin));
    }
    default:
      return toolError(`unhandled tool ${tool.name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleRpc(store: Store, req: IncomingMessage, message: Json): RpcResponse | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = 'id' in message ? message.id : null;
  const isNotification = !('id' in message) || message.id === undefined;
  if (method.startsWith('notifications/')) return null;
  const params = isRecord(message.params) ? message.params : {};

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
        supportedVersions: SUPPORTED_VERSIONS,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (!TOOLS.some((tool) => tool.name === toolName.toLowerCase())) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      const outcome = callTool(store, req, toolName, args);
      return rpcResult(id, outcome.result);
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** POST /mcp (and the transports' other verbs, answered plainly). */
export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed: POST only' } });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // A body that is not JSON is a JSON-RPC parse error, answered HTTP 400 with -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const responses = parsed
      .map((entry) => (isRecord(entry) ? handleRpc(store, req, entry) : rpcError(null, -32600, 'Invalid Request')))
      .filter((response) => response !== null);
    sendJson(res, 200, responses);
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const response = handleRpc(store, req, parsed);
  if (response === null) {
    // A notification: accepted, no body (Streamable HTTP answers 202).
    res.writeHead(202, { 'x-github-request-id': 'F0RGE-MCP' });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}
