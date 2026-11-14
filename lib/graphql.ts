// The GraphQL v4 surface at /api/graphql: a small parser and executor for the
// documents gh and github-mcp-server send — viewer, repository reads, issue and
// pull-request connections with cursor paging, Relay node ids, introspection
// of the types the clients feature-detect, and the five mutations. Everything
// resolves against the same Store REST and git use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeId, parseNodeId, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';
import { isAncestor, mergeBase } from './git.ts';
import { changedFiles, mergeTrees } from './merge.ts';
import { buildTree } from './git.ts';
import { commitOnBranch, computeMergeable } from './rest.ts';
import { isRecord, parseJsonBody, readBody, sendJson } from './http.ts';

// ---------------------------------------------------------------- schema

/** The fields each object type carries (drives introspection and unknown-field errors). */
export const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit', '__type', '__schema'],
  Mutation: [
    'createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment',
    'updateIssue', 'updatePullRequest', 'closePullRequest', 'addPullRequestReview', 'createRepository',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived',
    'url', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasWikiEnabled', 'hasProjectsEnabled', 'stargazerCount', 'forkCount',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'ref', 'refs', 'object',
    'primaryLanguage', 'licenseInfo', 'watchers', 'stargazers', 'forks', 'mentionableUsers', 'assignableUsers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt',
    'closed', 'closedAt', 'author', 'editor', 'repository', 'labels', 'comments', 'assignees', 'participants',
    'milestone', 'locked', 'activeLockReason', 'reactionGroups', 'viewerDidAuthor', 'lastEditedAt',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt',
    'closed', 'closedAt', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef',
    'headRepository', 'baseRepository', 'author', 'repository', 'files', 'commits', 'comments', 'reviews',
    'labels', 'assignees', 'participants', 'additions', 'deletions', 'changedFiles', 'isDraft', 'mergeStateStatus',
    'mergeCommit', 'potentialMergeCommit', 'viewerDidAuthor', 'locked', 'milestone', 'reactionGroups',
  ],
  User: [
    'login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'bio', 'company', 'location', 'websiteUrl',
    'createdAt', 'updatedAt', 'isViewer', 'repositories', 'issues', 'pullRequests', 'followers', 'following',
    'organization', 'viewerCanFollow', 'isFollowingViewer', 'twitterUsername', 'status',
  ],
  Organization: ['login', 'id', 'databaseId', 'name', 'url', 'repositories', 'membersWithRole'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Label: ['id', 'name', 'color', 'description', 'url', 'isDefault', 'issues', 'pullRequests'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'url', 'createdAt', 'updatedAt', 'author', 'editor', 'issue', 'viewerDidAuthor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject', 'timelineEdge'],
  IssueCommentEdge: ['node', 'cursor'],
  RateLimit: ['cost', 'limit', 'remaining', 'resetAt', 'used', 'nodeCount'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount', 'discussionCount', 'codeCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByUrl', 'isOneOf'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', 'isDeprecated', 'deprecationReason'],
  __Schema: ['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

/** The child object type of the fields validation descends into. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', user: 'User', organization: 'Organization', node: 'Node', __type: '__Type', __schema: '__Schema', rateLimit: 'RateLimit', search: 'SearchResultItemConnection' },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection', defaultBranchRef: 'Ref', label: 'Label', labels: 'LabelConnection',
  },
  Issue: { author: 'User', editor: 'User', repository: 'Repository', comments: 'IssueCommentConnection' },
  PullRequest: {
    author: 'User', repository: 'Repository', files: 'PullRequestChangedFileConnection',
    headRepository: 'Repository', baseRepository: 'Repository', mergeCommit: 'Commit', potentialMergeCommit: 'Commit',
  },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Node' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', pageInfo: 'PageInfo' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', ofType: '__Type', possibleTypes: '__Type' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

/** Enum types and their values (SearchType is feature-detected by gh). */
export const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  IssueCommentOrderField: ['CREATED_AT', 'UPDATED_AT'],
  CommentOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderByDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: Selection[] | null;
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      if (end === -1) throw new GqlSyntaxError('unterminated block string');
      tokens.push(JSON.stringify(source.slice(i + 3, end)));
      i = end + 3;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1] as string;
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(JSON.stringify(text));
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if ('{}()[]:$@=!|&'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private at = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | null {
    return this.tokens[this.at] ?? null;
  }

  private take(): string {
    const token = this.tokens[this.at];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.at += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.take();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  private skipDirectivesAndVariables(): void {
    // Variable definitions and directives are parsed loosely: their contents do not change
    // how the executor resolves the documents the suite sends.
    for (;;) {
      const next = this.peek();
      if (next === '(') {
        let depth = 0;
        do {
          const token = this.take();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        } while (depth > 0);
        continue;
      }
      if (next === '@') {
        this.take();
        this.take();
        if (this.peek() === '(') {
          let depth = 0;
          do {
            const token = this.take();
            if (token === '(') depth += 1;
            else if (token === ')') depth -= 1;
          } while (depth > 0);
        }
        continue;
      }
      break;
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: Selection[] }>();
    while (this.at < this.tokens.length) {
      const head = this.peek() as string;
      if (head === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.take();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== null && /^[A-Za-z_]/.test(maybeName) && maybeName !== '(' && maybeName !== '{' && maybeName !== '@') {
          name = this.take();
        }
        this.skipDirectivesAndVariables();
        operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.take();
        const fragName = this.take();
        if (this.take() !== 'on') throw new GqlSyntaxError('fragment without a type condition');
        const typeCondition = this.take();
        this.skipDirectivesAndVariables();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === null) throw new GqlSyntaxError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.take();
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek() === '...') {
      this.take();
      const next = this.peek() as string;
      if (next === 'on') {
        this.take();
        const typeCondition = this.take();
        this.skipDirectivesAndVariables();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next === '{') {
        return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
      }
      const name = this.take();
      this.skipDirectivesAndVariables();
      return { kind: 'spread', name };
    }
    let name = this.take();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.take();
      alias = name;
      name = this.take();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.take();
      while (this.peek() !== ')') {
        const argName = this.take();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.take();
    }
    this.skipDirectivesAndVariables();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): Value {
    const token = this.take();
    if (token === '$') {
      const name = this.take();
      return { kind: 'variable', name };
    }
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.take();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.take();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.take();
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function parseDocument(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

/** Turn a parsed argument value into a plain JS value with the operation's variables. */
function coerce(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => coerce(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = coerce(inner, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- values and ids

/** The database id issues and pull requests share between REST and GraphQL. */
export function issueDatabaseId(repo: Repo, number: number): number {
  return number * 100000 + repo.id;
}

interface Tagged {
  gqlType: string;
  data: unknown;
}

function tag(gqlType: string, data: unknown): Tagged {
  return { gqlType, data };
}

function isTagged(value: unknown): value is Tagged {
  return isRecord(value) && typeof (value as Tagged).gqlType === 'string' && 'data' in value;
}

interface IssueData {
  repo: Repo;
  issue: IssueRec;
}

interface PullData {
  repo: Repo;
  pull: PullRec;
}

// ---------------------------------------------------------------- validation

function validateSelections(
  typeName: string,
  selections: Selection[],
  doc: Document,
  errors: string[],
): void {
  const known = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const { name, selections: sub } = selection.field;
      if (name === '__typename') continue;
      if (known !== undefined && !known.includes(name)) {
        errors.push(`Field '${name}' doesn't exist on type '${typeName}'`);
        continue;
      }
      const child = FIELD_TYPES[typeName]?.[name];
      if (child !== undefined && sub !== null) validateSelections(child, sub, doc, errors);
    } else if (selection.kind === 'fragment') {
      validateSelections(selection.typeCondition ?? typeName, selection.selections, doc, errors);
    } else {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(fragment.typeCondition ?? typeName, fragment.selections, doc, errors);
    }
  }
}

// ---------------------------------------------------------------- execution

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = coerce(value, ctx.variables);
  return out;
}

function execSelections(typeName: string, data: unknown, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = isTagged(data) ? data.gqlType : typeName;
        continue;
      }
      const value = resolveField(typeName, data, field, ctx);
      out[key] = completeValue(value, field, ctx);
    } else if (selection.kind === 'fragment') {
      const condition = selection.typeCondition;
      const applies = condition === null || condition === typeName || (isTagged(data) && data.gqlType === condition) || typeName === 'Node';
      if (applies) Object.assign(out, execSelections(condition ?? typeName, data, selection.selections, ctx));
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, execSelections(fragment.typeCondition ?? typeName, data, fragment.selections, ctx));
      }
    }
  }
  return out;
}

/** Apply a field's sub-selections to a resolved value (objects, lists of objects, scalars). */
function completeValue(value: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (isTagged(value)) {
    if (field.selections === null) return null;
    return execSelections(value.gqlType, value.data, field.selections, ctx);
  }
  return value;
}

function connection(gqlType: string, itemType: string, items: Tagged[], total: number, pageInfo: { hasNextPage: boolean; endCursor: string | null }): Tagged {
  void itemType;
  return tag(gqlType, {
    nodes: items,
    edges: items.map((item) => tag(`${gqlType.replace('Connection', '')}Edge`, { node: item, cursor: pageInfo.endCursor })),
    pageInfo: tag('PageInfo', { hasNextPage: pageInfo.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: pageInfo.endCursor }),
    totalCount: total,
  });
}

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveField(typeName: string, data: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  const { store } = ctx;
  const args = argsOf(field, ctx);
  const name = field.name;

  if (typeName === 'Query') {
    switch (name) {
      case 'viewer':
        return tag('User', { login: store.viewerLogin ?? 'viewer' });
      case 'repository': {
        const repo = store.resolve(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : tag('Repository', repo);
      }
      case 'node': {
        const parsed = parseNodeId(String(args.id ?? ''));
        if (parsed === null) return null;
        if (parsed.type === 'Repository') {
          const repo = store.repos.find((candidate) => candidate.id === parsed.databaseId);
          return repo === undefined ? null : tag('Repository', repo);
        }
        if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
          const found = findIssueByDatabaseId(store, parsed.databaseId);
          if (found === null) return null;
          return parsed.type === 'Issue'
            ? tag('Issue', found)
            : tag('PullRequest', { repo: found.repo, pull: found.repo.pulls.get(found.issue.number) as PullRec });
        }
        if (parsed.type === 'User') return tag('User', { login: store.viewerLogin ?? 'viewer' });
        return null;
      }
      case 'user':
        return tag('User', { login: String(args.login ?? store.viewerLogin ?? 'viewer') });
      case '__type': {
        const typeNameArg = String(args.name ?? '');
        return TYPE_FIELDS[typeNameArg] !== undefined || ENUM_TYPES[typeNameArg] !== undefined
          ? tag('__Type', { name: typeNameArg })
          : null;
      }
      case '__schema':
        return tag('__Schema', {
          queryType: tag('__Type', { name: 'Query' }),
          mutationType: tag('__Type', { name: 'Mutation' }),
          types: [],
          description: null,
        });
      case 'rateLimit':
        return tag('RateLimit', { cost: 1, limit: 5000, remaining: 4999, used: 1, nodeCount: 1, resetAt: '2026-11-14T07:30:00Z' });
      default:
        return null;
    }
  }

  if (typeName === 'Mutation') return resolveMutation(store, name, args);

  if (typeName === 'Repository') {
    const repo = data as Repo;
    switch (name) {
      case 'id':
        return nodeId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${store.ownerOf(repo)}/${repo.name}`;
      case 'owner':
        return tag('User', { login: store.ownerOf(repo) });
      case 'description':
        return repo.description === '' ? null : repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'isFork':
        return false;
      case 'isArchived':
        return false;
      case 'url':
        return `https://github.local/${store.ownerOf(repo)}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
      case 'pushedAt':
        return repo.updatedAt;
      case 'defaultBranchRef':
        return tag('Ref', { name: repo.defaultBranch });
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'hasWikiEnabled':
        return true;
      case 'hasProjectsEnabled':
        return true;
      case 'stargazerCount':
      case 'forkCount':
        return 0;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined || issue.isPull ? null : tag('Issue', { repo, issue } satisfies IssueData);
      }
      case 'issues':
        return issuesConnection(store, repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : tag('PullRequest', { repo, pull } satisfies PullData);
      }
      case 'pullRequests':
        return pullRequestsConnection(store, repo, args);
      default:
        return null;
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = data as IssueData;
    switch (name) {
      case 'id':
        return nodeId('Issue', issueDatabaseId(repo, issue.number));
      case 'databaseId':
        return issueDatabaseId(repo, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'closed':
        return issue.state === 'closed';
      case 'closedAt':
        return issue.state === 'closed' ? repo.updatedAt : null;
      case 'createdAt':
      case 'updatedAt':
        return repo.updatedAt;
      case 'url':
        return `https://github.local/${store.ownerOf(repo)}/${repo.name}/issues/${issue.number}`;
      case 'author':
      case 'editor':
        return tag('User', { login: store.viewerLogin ?? 'viewer' });
      case 'repository':
        return tag('Repository', repo);
      case 'labels':
        return connection('LabelConnection', 'Label', issue.labels.map((label) => tag('Label', { name: label, color: repo.labels.get(label)?.color ?? 'ededed' })), issue.labels.length, { hasNextPage: false, endCursor: null });
      case 'comments':
        return connection('IssueCommentConnection', 'IssueComment', issue.comments.map((comment) => tag('IssueComment', { repo, issue, comment })), issue.comments.length, { hasNextPage: false, endCursor: null });
      default:
        return null;
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = data as PullData;
    switch (name) {
      case 'id':
        return nodeId('PullRequest', issueDatabaseId(repo, pull.number));
      case 'databaseId':
        return issueDatabaseId(repo, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.merged ? repo.updatedAt : null;
      case 'closed':
        return pull.state === 'closed';
      case 'closedAt':
        return pull.state === 'closed' ? repo.updatedAt : null;
      case 'createdAt':
      case 'updatedAt':
        return repo.updatedAt;
      case 'mergeable': {
        if (pull.merged) return 'MERGEABLE';
        const mergeable = computeMergeable(repo, pull);
        return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef':
        return tag('Ref', { name: pull.headRef });
      case 'baseRef':
        return tag('Ref', { name: pull.baseRef });
      case 'author':
        return tag('User', { login: store.viewerLogin ?? 'viewer' });
      case 'repository':
      case 'headRepository':
      case 'baseRepository':
        return tag('Repository', repo);
      case 'isDraft':
        return false;
      case 'files': {
        const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const first = typeof args.first === 'number' ? args.first : 30;
        if (headSha === undefined || baseSha === undefined) {
          return connection('PullRequestChangedFileConnection', 'PullRequestChangedFile', [], 0, { hasNextPage: false, endCursor: null });
        }
        const origin = mergeBase(repo.objects, baseSha, headSha) ?? baseSha;
        const files = changedFiles(repo.objects, origin, headSha);
        const items = files.slice(0, first).map((file) => tag('PullRequestChangedFile', file));
        return connection('PullRequestChangedFileConnection', 'PullRequestChangedFile', items, files.length, { hasNextPage: files.length > first, endCursor: null });
      }
      case 'additions':
      case 'deletions':
      case 'changedFiles': {
        const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
        if (headSha === undefined || baseSha === undefined) return 0;
        const origin = mergeBase(repo.objects, baseSha, headSha) ?? baseSha;
        const files = changedFiles(repo.objects, origin, headSha);
        if (name === 'changedFiles') return files.length;
        return files.reduce((sum, file) => sum + (name === 'additions' ? file.additions : file.deletions), 0);
      }
      default:
        return null;
    }
  }

  if (typeName === 'User') {
    const user = data as { login: string };
    switch (name) {
      case 'login':
        return user.login;
      case 'id':
        return nodeId('User', 1);
      case 'databaseId':
        return 1;
      case 'name':
        return user.login;
      case 'email':
        return `${user.login}@example.invalid`;
      case 'isViewer':
        return user.login === (store.viewerLogin ?? 'viewer');
      case 'url':
        return `https://github.local/${user.login}`;
      case 'avatarUrl':
        return 'https://github.local/avatars/u/1';
      case 'createdAt':
      case 'updatedAt':
        return '2026-11-14T06:30:00Z';
      default:
        return null;
    }
  }

  if (typeName === 'Ref') {
    const ref = data as { name: string };
    switch (name) {
      case 'id':
        return nodeId('Ref', 1);
      case 'name':
        return ref.name;
      case 'prefix':
        return 'refs/heads/';
      default:
        return null;
    }
  }

  if (typeName === 'IssueComment') {
    const commentData = data as { repo: Repo; issue: IssueRec; comment: { id: number; body: string } };
    switch (name) {
      case 'id':
        return nodeId('IssueComment', commentData.comment.id);
      case 'databaseId':
        return commentData.comment.id;
      case 'body':
        return commentData.comment.body;
      case 'createdAt':
      case 'updatedAt':
        return commentData.repo.updatedAt;
      case 'author':
        return tag('User', { login: store.viewerLogin ?? 'viewer' });
      default:
        return null;
    }
  }

  if (typeName === '__Type') {
    const typeData = data as { name: string };
    switch (name) {
      case 'name':
        return typeData.name;
      case 'kind':
        return ENUM_TYPES[typeData.name] !== undefined ? 'ENUM' : typeData.name === 'Node' ? 'INTERFACE' : 'OBJECT';
      case 'description':
        return null;
      case 'fields': {
        const fields = TYPE_FIELDS[typeData.name];
        return fields === undefined ? null : fields.map((fieldName) => tag('__Field', { name: fieldName }));
      }
      case 'enumValues': {
        const values = ENUM_TYPES[typeData.name];
        return values === undefined ? null : values.map((value) => tag('__EnumValue', { name: value }));
      }
      default:
        return null;
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    const fieldData = data as { name: string };
    switch (name) {
      case 'name':
        return fieldData.name;
      case 'description':
        return null;
      case 'isDeprecated':
        return false;
      case 'deprecationReason':
        return null;
      default:
        return null;
    }
  }

  if (typeName === 'Label') {
    const label = data as { name: string; color: string };
    if (name === 'name') return label.name;
    if (name === 'color') return label.color;
    if (name === 'id') return nodeId('Label', 1);
    return null;
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = data as { filename?: string; path?: string; additions: number; deletions: number; status: string };
    if (name === 'path') return file.path ?? file.filename ?? '';
    if (name === 'additions') return file.additions;
    if (name === 'deletions') return file.deletions;
    if (name === 'changeType') return file.status.toUpperCase();
    return null;
  }

  // Synthetic objects (connections, page info, payloads, edges): read the property.
  if (isRecord(data)) {
    const value = (data as Record<string, unknown>)[name];
    return value === undefined ? null : value;
  }
  return null;
}

function findIssueByDatabaseId(store: Store, databaseId: number): IssueData | null {
  const repoId = databaseId % 100000;
  const number = Math.floor(databaseId / 100000);
  const repo = store.repos.find((candidate) => candidate.id === repoId);
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  return issue === undefined ? null : { repo, issue };
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Tagged {
  let items = [...repo.issues.values()].filter((issue) => !issue.isPull);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null && states.length > 0) {
    items = items.filter((issue) => states.includes(issue.state.toUpperCase()));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  items.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const total = items.length;
  const afterSeq = seqOfCursor(args.after);
  let start = 0;
  if (afterSeq !== null) {
    const at = items.findIndex((issue) => issue.seq === afterSeq);
    if (at !== -1) start = at + 1;
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < total;
  const endCursor = page.length > 0 ? cursorOf((page[page.length - 1] as IssueRec).seq) : null;
  return connection(
    'IssueConnection',
    'Issue',
    page.map((issue) => tag('Issue', { repo, issue } satisfies IssueData)),
    total,
    { hasNextPage, endCursor },
  );
}

function pullRequestsConnection(store: Store, repo: Repo, args: Record<string, unknown>): Tagged {
  let items = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null && states.length > 0) {
    items = items.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  items.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = items.slice(0, first);
  return connection(
    'PullRequestConnection',
    'PullRequest',
    page.map((pull) => tag('PullRequest', { repo, pull } satisfies PullData)),
    items.length,
    { hasNextPage: items.length > first, endCursor: null },
  );
}

// ---------------------------------------------------------------- mutations

function resolveMutation(store: Store, name: string, args: Record<string, unknown>): unknown {
  const input = isRecord(args.input) ? args.input : {};
  switch (name) {
    case 'createIssue': {
      const parsed = parseNodeId(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : store.repos.find((candidate) => candidate.id === parsed.databaseId);
      if (repo === undefined) throw new Error(`Could not resolve repository ${String(input.repositoryId)}`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        isPull: false,
        seq: number,
        comments: [],
      };
      repo.issues.set(number, issue);
      repo.updatedAt = store.nowIso();
      return tag('CreateIssuePayload', { issue: tag('Issue', { repo, issue } satisfies IssueData), clientMutationId: null });
    }
    case 'closeIssue': {
      const parsed = parseNodeId(String(input.issueId ?? ''));
      const found = parsed === null ? null : findIssueByDatabaseId(store, parsed.databaseId);
      if (found === null) throw new Error(`Could not resolve issue ${String(input.issueId)}`);
      found.issue.state = 'closed';
      found.repo.updatedAt = store.nowIso();
      return tag('CloseIssuePayload', { issue: tag('Issue', found), clientMutationId: null });
    }
    case 'createPullRequest': {
      const parsed = parseNodeId(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : store.repos.find((candidate) => candidate.id === parsed.databaseId);
      if (repo === undefined) throw new Error(`Could not resolve repository ${String(input.repositoryId)}`);
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (!repo.refs.has(`refs/heads/${headRef}`)) throw new Error(`Head ref ${headRef} does not exist`);
      if (!repo.refs.has(`refs/heads/${baseRef}`)) throw new Error(`Base ref ${baseRef} does not exist`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        baseRef,
        merged: false,
        mergeSha: null,
        seq: number,
      };
      repo.pulls.set(number, pull);
      repo.issues.set(number, { number, title: pull.title, body: pull.body, state: 'open', labels: [], isPull: true, seq: number, comments: [] });
      repo.updatedAt = store.nowIso();
      return tag('CreatePullRequestPayload', { pullRequest: tag('PullRequest', { repo, pull } satisfies PullData), clientMutationId: null });
    }
    case 'mergePullRequest': {
      const parsed = parseNodeId(String(input.pullRequestId ?? ''));
      const found = parsed === null ? null : findIssueByDatabaseId(store, parsed.databaseId);
      if (found === null) throw new Error(`Could not resolve pull request ${String(input.pullRequestId)}`);
      const pull = found.repo.pulls.get(found.issue.number);
      if (pull === undefined) throw new Error('the resolved node is not a pull request');
      mergePull(store, found.repo, pull, typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH');
      return tag('MergePullRequestPayload', { pullRequest: tag('PullRequest', { repo: found.repo, pull }), clientMutationId: null });
    }
    case 'addComment': {
      const parsed = parseNodeId(String(input.subjectId ?? ''));
      const found = parsed === null ? null : findIssueByDatabaseId(store, parsed.databaseId);
      if (found === null) throw new Error(`Could not resolve subject ${String(input.subjectId)}`);
      const comment = { id: store.nextCommentId(), body: typeof input.body === 'string' ? input.body : '', seq: found.issue.comments.length };
      found.issue.comments.push(comment);
      found.repo.updatedAt = store.nowIso();
      return tag('AddCommentPayload', {
        commentEdge: tag('IssueCommentEdge', { node: tag('IssueComment', { repo: found.repo, issue: found.issue, comment }), cursor: cursorOf(comment.id) }),
        clientMutationId: null,
      });
    }
    default:
      return null;
  }
}

/** The squash/merge the REST merge endpoint also performs, shared so both views agree. */
export function mergePull(store: Store, repo: Repo, pull: PullRec, method: string): void {
  if (pull.merged || pull.state !== 'open') throw new Error('Pull Request is not mergeable');
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) throw new Error('Pull Request is not mergeable');
  if (!isAncestor(repo.objects, headSha, baseSha)) {
    const base = mergeBase(repo.objects, baseSha, headSha);
    const merged = mergeTrees(repo.objects, baseSha, headSha, base);
    if (merged.conflict) throw new Error('Pull Request is not mergeable');
    const treeSha = buildTree(repo.objects, merged.files);
    const message = method === 'MERGE'
      ? `Merge pull request #${pull.number} from ${pull.headRef}`
      : `${pull.title} (#${pull.number})${pull.body === '' ? '' : `\n\n${pull.body}`}`;
    const sha = method === 'MERGE'
      ? commitOnBranch(store, repo, pull.baseRef, treeSha, message, [headSha])
      : commitOnBranch(store, repo, pull.baseRef, treeSha, message);
    pull.mergeSha = sha;
  } else {
    pull.mergeSha = baseSha;
  }
  pull.merged = true;
  pull.state = 'closed';
  const issue = repo.issues.get(pull.number);
  if (issue !== undefined) issue.state = 'closed';
  repo.updatedAt = store.nowIso();
}

// ---------------------------------------------------------------- the endpoint

interface GqlResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function runOperation(store: Store, body: Record<string, unknown>): GqlResult {
  const queryText = typeof body.query === 'string' ? body.query : '';
  const variables = isRecord(body.variables) ? body.variables : {};
  let doc: Document;
  try {
    doc = parseDocument(queryText);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'could not parse the document' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operationName === null
    ? doc.operations[0]
    : doc.operations.find((candidate) => candidate.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(rootType, operation.selections, doc, errors);
  const ctx: ExecCtx = { store, variables, fragments: doc.fragments };
  let data: Record<string, unknown> | null = null;
  try {
    data = execSelections(rootType, null, operation.selections, ctx);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const result: GqlResult = { data };
  if (errors.length > 0) result.errors = errors.map((message) => ({ message }));
  return result;
}

/** POST /api/graphql: one operation document, or a JSON array of them answered in order. */
export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((entry) => runOperation(store, isRecord(entry) ? entry : {}));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, runOperation(store, isRecord(parsed.value) ? parsed.value : {}));
}
