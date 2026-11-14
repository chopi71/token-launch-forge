// Shared HTTP plumbing for the four surfaces: JSON replies that always carry
// the request-id header, body reading, and the bearer-token check.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** Every reply the forge sends carries a non-empty X-GitHub-Request-Id. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  requestSeq += 1;
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `F0RGE-${requestSeq.toString(16).toUpperCase().padStart(6, '0')}`,
    ...headers,
  });
  res.end(text);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  data: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-length': data.length,
    'x-github-request-id': `F0RGE-${requestSeq.toString(16).toUpperCase().padStart(6, '0')}`,
    ...headers,
  });
  res.end(data);
}

/** Read a whole request body (uploads and packs included), capped well above any suite payload. */
export function readBody(req: IncomingMessage, cap = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** The bearer token the suite presents; null when the header is absent or names another token. */
export function presentedToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^[Bb]earer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string);
}

/** True when the request carries exactly the shop token this process was given. */
export function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = presentedToken(req);
  return presented !== null && presented === expected;
}

/** Parse a JSON request body; {ok:false} for malformed JSON, which the contract answers 400. */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
