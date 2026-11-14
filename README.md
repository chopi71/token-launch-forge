# Token Launch Forge

A standalone, GitHub-compatible git forge in one Node 22 process, built for
make.fun's "Build a GitHub-compatible git forge" bounty. It serves four
surfaces from one in-memory store, standard library only — no git binary, no
packages, no outside service:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 ls-refs and fetch
  (with shallow/deepen semantics and side-band-64k pack framing) and v0
  receive-pack with report-status, fast-forward enforcement and per-ref
  `ok`/`ng` lines. Packfiles are built and parsed in `lib/git.ts`, including
  OFS/REF delta resolution.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash/merge merges computed
  by a three-way tree merge (`lib/merge.ts`).
- **GraphQL v4** at `/api/graphql` — a small parser and executor for the
  documents gh and github-mcp-server send: viewer, repository reads, issue and
  pull-request connections with cursor paging, Relay node ids, introspection
  of Issue/PullRequest/Repository/SearchType, and the createIssue, closeIssue,
  createPullRequest, mergePullRequest and addComment mutations. Batched
  operation arrays answer in order.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP in both protocol eras
  (2026-07-28 `server/discover` and the `initialize` handshake revisions), with
  eight tools over the same store: create_repo, get_repo, create_issue,
  list_issues, get_issue, create_pull_request, list_pull_requests and
  merge_pull_request.

State is deterministic: timestamps derive from the trial's fixed opening time
plus a sequence counter, object ids are content hashes, and repeated fetches
are served from a per-repository response cache (objects are immutable), which
keeps the timed workloads fast. `main.ts` is the harness lifecycle (bind an
ephemeral port, register it, poll until done); `app.ts` builds the server.
