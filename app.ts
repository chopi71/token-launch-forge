// Token Launch Forge — the server. One process, four surfaces over one store:
// git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL v4 at
// /api/graphql and MCP at /mcp. Everything speaks JSON (git speaks pkt-lines),
// every surface but the boot probe requires the shop token as a bearer, and
// anything unknown answers GitHub's JSON 404, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleGitHttp } from './lib/githttp.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { authorized, sendJson } from './lib/http.ts';

function pathSegments(req: IncomingMessage): { segments: string[]; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    return { segments, query: url.searchParams };
  } catch {
    return { segments: [], query: new URLSearchParams() };
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { segments, query } = pathSegments(req);
        const method = req.method ?? 'GET';
        const path = `/${segments.join('/')}`;

        // The env's boot probe takes no token.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Every other surface requires the shop token; a missing or wrong one is a 401.
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest({ store, origin: originOf(req) }, req, res, segments.slice(2), query);
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphQL(store, req, res);
          return;
        }
        if (path === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
          await handleMcp(store, req, res);
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
        const gitAction =
          segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs'
            ? 'info/refs'
            : segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
              ? segments[2]
              : null;
        if (gitAction !== null) {
          await handleGitHttp(store, req, res, segments[0] as string, segments[1] as string, gitAction, query);
          return;
        }
        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
        } else {
          res.end();
        }
      }
    })();
  });
}
