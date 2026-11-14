// graphql.ts — a minimal GraphQL executor for the fixed document subset the
// suite sends (queries, mutations, variables, inline fragments, batch arrays).
// Plain JavaScript syntax in a .ts file (runs under --experimental-strip-types).
import { parseCommit } from './gitutil.ts';
import {
  Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL,
  repoGlobalId, issueGlobalId, prGlobalId, commentGlobalId, parseGlobalId,
  getTip, createCommit, treeWithPath, readPath, commitOf,
  squashMerge, prFiles, prWouldConflict, nowIso, nowEpoch,
  CONFORMANCE_IDENTITY,
} from './store.ts';

// ---------------------------------------------------------------- lexer
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') { i++; continue; }
    if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}():[]!=$'.includes(ch) || ch === '@') {
      if (ch === '$') {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
        tokens.push({ kind: 'var', value: src.slice(i + 1, j) });
        i = j;
        continue;
      }
      tokens.push({ kind: ch, value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      // String with \" and \\ escapes (block strings not needed by the suite).
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= n) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (j < n && src[j] === '.') {
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(kind, what) {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${what || kind}, got ${t.kind} (${t.value})`);
    return t;
  }
  accept(kind) {
    if (this.peek().kind === kind) { this.pos++; return true; }
    return false;
  }
  parseDocument() {
    const doc = { operation: null, fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name', 'on'); // 'on'
        const typeCond = this.expect('name').value;
        const sel = this.parseSelectionSet();
        doc.fragments.set(name, { typeCondition: typeCond, selectionSet: sel });
        continue;
      }
      if (this.peek().kind === '{') {
        doc.operation = { kind: 'query', name: null, variables: {}, selectionSet: this.parseSelectionSet() };
        continue;
      }
      const kw = this.expect('name').value;
      if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') {
        throw new Error(`unexpected operation keyword ${kw}`);
      }
      let name = null;
      if (this.peek().kind === 'name') name = this.next().value;
      let variables = {};
      if (this.peek().kind === '(') variables = this.parseVariableDefinitions();
      const sel = this.parseSelectionSet();
      doc.operation = { kind: kw, name, variables, selectionSet: sel };
    }
    if (!doc.operation) throw new Error('no operation in document');
    return doc;
  }
  parseVariableDefinitions() {
    const vars = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      const v = this.expect('var').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue = undefined;
      if (this.accept('=')) defaultValue = this.parseValue();
      vars[v] = { type, default: defaultValue };
    }
    this.expect(')');
    return vars;
  }
  parseType() {
    let t;
    if (this.accept('[')) {
      const inner = this.parseType();
      this.expect(']');
      t = `[${inner}]`;
    } else {
      t = this.expect('name').value;
    }
    if (this.accept('!')) t += '!';
    return t;
  }
  parseSelectionSet() {
    this.expect('{');
    const fields = [];
    while (this.peek().kind !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField() {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCond = this.expect('name').value;
        return { kind: 'inlineFragment', typeCondition: typeCond, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      return { kind: 'fragmentSpread', name };
    }
    let alias = null;
    let name = this.expect('name').value;
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expect('name').value;
    }
    let args = {};
    if (this.peek().kind === '(') args = this.parseArguments();
    let selectionSet = null;
    if (this.peek().kind === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name, alias: alias || name, args, selectionSet };
  }
  parseArguments() {
    const args = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseValue() {
    const t = this.peek();
    if (t.kind === 'var') { this.next(); return { kind: 'var', name: t.value }; }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'number') {
      this.next();
      return { kind: 'number', value: Number(t.value) };
    }
    if (t.kind === '[') {
      this.next();
      const items = [];
      while (this.peek().kind !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.kind === '{') {
      this.next();
      const fields = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.kind} (${t.value})`);
  }
}

function resolveValue(node, variables) {
  switch (node.kind) {
    case 'var': return variables[node.name];
    case 'string': case 'number': case 'boolean': case 'null': case 'enum': return node.value;
    case 'list': return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
    default: return undefined;
  }
}

// ---------------------------------------------------------------- introspection tables
const TYPE_FIELDS = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', '__type', '__schema'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'url'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'files', 'repository', 'url'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  RepositoryOwner: ['id', 'login'],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'],
  CommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------- execution
function wrap(typeName, value) {
  return { __typename: typeName, ...value };
}

function typeError(errors, typeName, fieldName) {
  errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
}

// Execute a parsed operation. Returns {data, errors}.
function execute(store, doc, variables) {
  const errors = [];
  const rootType = doc.operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(store, rootType, {}, doc.operation.selectionSet, variables, doc.fragments, errors, 0);
  return { data, errors };
}

function executeSelectionSet(store, typeName, source, selections, variables, fragments, errors, depth) {
  if (depth > 12) return null;
  const out = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = fragments.get(sel.name);
      if (!frag) { errors.push({ message: `Unknown fragment "${sel.name}".` }); continue; }
      if (frag.typeCondition && frag.typeCondition !== typeName) continue;
      const sub = executeSelectionSet(store, typeName, source, frag.selectionSet, variables, fragments, errors, depth + 1);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== typeName) continue;
      const sub = executeSelectionSet(store, typeName, source, sel.selectionSet, variables, fragments, errors, depth + 1);
      Object.assign(out, sub);
      continue;
    }
    // plain field
    if (sel.name === '__typename') {
      out[sel.alias] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName] && RESOLVERS[typeName][sel.name];
    if (!resolver) {
      typeError(errors, typeName, sel.name);
      out[sel.alias] = null;
      continue;
    }
    const args = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables);
    let value;
    try {
      value = resolver(store, source, args, variables);
    } catch (e) {
      errors.push({ message: e.message || `error resolving ${typeName}.${sel.name}` });
      out[sel.alias] = null;
      continue;
    }
    if (value === null || value === undefined) {
      out[sel.alias] = null;
      continue;
    }
    if (sel.selectionSet) {
      out[sel.alias] = resolveSubSelection(store, value, sel.selectionSet, variables, fragments, errors, depth);
    } else {
      // Scalar leaf: if the resolver returned a wrapped object, that's a bug —
      // guard by returning its string form.
      out[sel.alias] = value && typeof value === 'object' && value.__typename ? value.__typename : value;
    }
  }
  return out;
}

function resolveSubSelection(store, value, selectionSet, variables, fragments, errors, depth) {
  if (Array.isArray(value)) {
    return value.map((v) => resolveSubSelection(store, v, selectionSet, variables, fragments, errors, depth));
  }
  if (value && typeof value === 'object' && value.__typename) {
    return executeSelectionSet(store, value.__typename, value, selectionSet, variables, fragments, errors, depth + 1);
  }
  // Connection objects are plain: {nodes, pageInfo, totalCount}.
  if (value && typeof value === 'object' && 'nodes' in value) {
    return executeSelectionSet(store, 'Connection', value, selectionSet, variables, fragments, errors, depth + 1);
  }
  return value;
}

// Connection helper: order, paginate, cursor = base64url('cursor:<number>').
function encodeCursor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const s = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function paginateConnection(items, args) {
  // items: [{sortKey, number, value}] already in the requested order.
  const afterNum = args.after ? decodeCursor(args.after) : null;
  let list = items;
  if (afterNum !== null) {
    const idx = items.findIndex((i) => i.number === afterNum);
    if (idx >= 0) list = items.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : 10;
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  return {
    __typename: 'Connection',
    nodes: page.map((i) => i.value),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
    },
    totalCount: items.length,
  };
}

function gqlIssueState(restState) {
  return restState === 'closed' ? 'CLOSED' : 'OPEN';
}
function gqlPrState(pr) {
  if (pr.merged) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueValue(repo, issue) {
  return wrap('Issue', {
    repo, issue,
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: gqlIssueState(issue.state),
  });
}
function prValue(repo, pr) {
  return wrap('PullRequest', {
    repo, pr,
    id: prGlobalId(repo.owner, repo.name, pr.number),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: gqlPrState(pr),
    merged: pr.merged,
  });
}
function repoValue(repo) {
  return wrap('Repository', {
    repo,
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
  });
}

// ---------------------------------------------------------------- resolvers
const RESOLVERS = {
  Query: {
    viewer: () => wrap('User', {
      id: String(VIEWER_ID), databaseId: VIEWER_ID,
      login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL,
    }),
    repository: (store, _src, args) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = store.getRepo(args.owner, args.name);
      if (!repo || args.owner !== VIEWER_LOGIN) return null;
      return repoValue(repo);
    },
    node: (store, _src, args) => {
      const parsed = parseGlobalId(args.id);
      if (!parsed) return null;
      const repo = store.getRepo(parsed.owner, parsed.name);
      if (!repo || parsed.owner !== VIEWER_LOGIN) return null;
      if (parsed.kind === 'repo') return repoValue(repo);
      if (parsed.kind === 'issue') {
        const issue = repo.issues.find((i) => i.number === parsed.number);
        return issue ? issueValue(repo, issue) : null;
      }
      if (parsed.kind === 'pr') {
        const pr = repo.pulls.find((p) => p.number === parsed.number);
        return pr ? prValue(repo, pr) : null;
      }
      return null;
    },
    __type: (_store, _src, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name]) {
        return wrap('__Type', {
          name,
          kind: 'OBJECT',
          description: null,
          fields: TYPE_FIELDS[name].map((f) => wrap('__Field', { name: f, description: null, args: [] })),
          enumValues: null,
        });
      }
      if (ENUM_VALUES[name]) {
        return wrap('__Type', {
          name,
          kind: 'ENUM',
          description: null,
          fields: null,
          enumValues: ENUM_VALUES[name].map((v) => wrap('__EnumValue', { name: v, description: null })),
        });
      }
      return null;
    },
    __schema: () => wrap('__Schema', {
      queryType: wrap('__Type', { name: 'Query', kind: 'OBJECT' }),
      mutationType: wrap('__Type', { name: 'Mutation', kind: 'OBJECT' }),
      types: Object.keys(TYPE_FIELDS).map((n) => wrap('__Type', { name: n, kind: 'OBJECT' })),
    }),
  },
  Mutation: {
    createIssue: (store, _src, args) => {
      const input = args.input || {};
      const parsed = parseGlobalId(input.repositoryId);
      if (!parsed || parsed.kind !== 'repo') throw new Error('repositoryId is invalid');
      const repo = store.getRepo(parsed.owner, parsed.name);
      if (!repo) throw new Error('repository not found');
      const now = nowIso();
      const number = repo.nextNumber++;
      const issue = {
        id: repo.databaseId * 1000000 + number,
        number,
        title: input.title || '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
        seq: repo.issues.length,
      };
      repo.issues.push(issue);
      return wrap('CreateIssuePayload', { issue: issueValue(repo, issue) });
    },
    closeIssue: (store, _src, args) => {
      const input = args.input || {};
      const parsed = parseGlobalId(input.issueId);
      if (!parsed || parsed.kind !== 'issue') throw new Error('issueId is invalid');
      const repo = store.getRepo(parsed.owner, parsed.name);
      if (!repo) throw new Error('repository not found');
      const issue = repo.issues.find((i) => i.number === parsed.number);
      if (!issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedAt = nowIso();
      issue.updatedAt = nowIso();
      return wrap('CloseIssuePayload', { issue: issueValue(repo, issue) });
    },
    createPullRequest: (store, _src, args) => {
      const input = args.input || {};
      const parsed = parseGlobalId(input.repositoryId);
      if (!parsed || parsed.kind !== 'repo') throw new Error('repositoryId is invalid');
      const repo = store.getRepo(parsed.owner, parsed.name);
      if (!repo) throw new Error('repository not found');
      const head = input.headRefName;
      const base = input.baseRefName;
      const headSha = getTip(repo, head);
      const baseSha = getTip(repo, base);
      if (!headSha) throw new Error(`head branch does not exist: ${head}`);
      if (!baseSha) throw new Error(`base branch does not exist: ${base}`);
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup) return wrap('CreatePullRequestPayload', { pullRequest: prValue(repo, dup) });
      const now = nowIso();
      const pr = {
        id: repo.databaseId * 1000000 + repo.nextNumber,
        number: repo.nextNumber++,
        title: input.title || '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.pulls.push(pr);
      return wrap('CreatePullRequestPayload', { pullRequest: prValue(repo, pr) });
    },
    mergePullRequest: (store, _src, args) => {
      const input = args.input || {};
      const parsed = parseGlobalId(input.pullRequestId);
      if (!parsed || parsed.kind !== 'pr') throw new Error('pullRequestId is invalid');
      const repo = store.getRepo(parsed.owner, parsed.name);
      if (!repo) throw new Error('repository not found');
      const pr = repo.pulls.find((p) => p.number === parsed.number);
      if (!pr) throw new Error('pull request not found');
      if (pr.state === 'closed') {
        return wrap('MergePullRequestPayload', { pullRequest: prValue(repo, pr) });
      }
      const res = squashMerge(store, repo, pr);
      if (!res || res.conflict) throw new Error('Merge conflict');
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = nowIso();
      pr.closedAt = pr.mergedAt;
      pr.mergeCommitSha = res.sha;
      pr.updatedAt = pr.mergedAt;
      return wrap('MergePullRequestPayload', { pullRequest: prValue(repo, pr) });
    },
    addComment: (store, _src, args) => {
      const input = args.input || {};
      const parsed = parseGlobalId(input.subjectId);
      if (!parsed) throw new Error('subjectId is invalid');
      const repo = store.getRepo(parsed.owner, parsed.name);
      if (!repo) throw new Error('repository not found');
      const target = parsed.kind === 'issue'
        ? repo.issues.find((i) => i.number === parsed.number)
        : parsed.kind === 'pr' ? repo.pulls.find((p) => p.number === parsed.number) : null;
      if (!target) throw new Error('subject not found');
      const now = nowIso();
      const comment = {
        id: store.nextCommentId++,
        body: input.body || '',
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        createdAt: now,
        updatedAt: now,
      };
      if (parsed.kind === 'issue') target.comments.push(comment);
      else {
        if (!target.comments) target.comments = [];
        target.comments.push(comment);
      }
      const node = wrap('Comment', {
        id: commentGlobalId(repo.owner, repo.name, parsed.number, comment.id),
        databaseId: comment.id,
        body: comment.body,
      });
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', { node, cursor: encodeCursor(comment.id) }),
        comment: node,
      });
    },
  },
  Repository: {
    id: (_s, src) => src.id,
    databaseId: (_s, src) => src.databaseId,
    name: (_s, src) => src.name,
    nameWithOwner: (_s, src) => src.nameWithOwner,
    owner: () => wrap('RepositoryOwner', { id: String(VIEWER_ID), login: VIEWER_LOGIN }),
    defaultBranchRef: (store, src) => {
      const tip = getTip(src.repo, src.repo.defaultBranch);
      if (!tip) return null;
      return wrap('Ref', { id: `R_${src.repo.defaultBranch}`, name: src.repo.defaultBranch, prefix: 'refs/heads/' });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_s, src) => src.repo.description,
    isPrivate: (_s, src) => src.repo.privateFlag,
    createdAt: (_s, src) => src.repo.createdAt,
    updatedAt: (_s, src) => src.repo.updatedAt,
    url: (_s, src) => `/${src.repo.owner}/${src.repo.name}`,
    issue: (_s, src, args) => {
      const issue = src.repo.issues.find((i) => i.number === args.number);
      return issue ? issueValue(src.repo, issue) : null;
    },
    issues: (_s, src, args) => {
      const states = Array.isArray(args.states) ? args.states : null;
      const orderBy = args.orderBy || {};
      const dir = orderBy.direction === 'ASC' ? 1 : -1;
      let list = src.repo.issues.slice();
      if (states) {
        list = list.filter((i) => states.includes(gqlIssueState(i.state)));
      }
      list.sort((a, b) => dir * (a.number - b.number));
      return paginateConnection(list.map((i) => ({ number: i.number, value: issueValue(src.repo, i) })), args);
    },
    pullRequest: (_s, src, args) => {
      const pr = src.repo.pulls.find((p) => p.number === args.number);
      return pr ? prValue(src.repo, pr) : null;
    },
    pullRequests: (_s, src, args) => {
      const states = Array.isArray(args.states) ? args.states : null;
      let list = src.repo.pulls.slice();
      if (states) list = list.filter((p) => states.includes(gqlPrState(p)));
      list.sort((a, b) => a.number - b.number);
      return paginateConnection(list.map((p) => ({ number: p.number, value: prValue(src.repo, p) })), args);
    },
    labels: (_s, src, args) => {
      const list = [...src.repo.labels.values()].map((l) => wrap('Label', {
        id: l.id, name: l.name, color: l.color, description: l.description,
      }));
      return paginateConnection(list.map((v, i) => ({ number: i + 1, value: v })), args);
    },
  },
  Issue: {
    id: (_s, src) => src.id,
    databaseId: (_s, src) => src.databaseId,
    number: (_s, src) => src.number,
    title: (_s, src) => src.title,
    body: (_s, src) => src.body,
    state: (_s, src) => src.state,
    createdAt: (_s, src) => src.issue.createdAt,
    updatedAt: (_s, src) => src.issue.updatedAt,
    closedAt: (_s, src) => src.issue.closedAt,
    author: () => wrap('User', { id: String(VIEWER_ID), databaseId: VIEWER_ID, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL }),
    labels: (_s, src, args) => {
      const list = src.issue.labels.map((l) => wrap('Label', {
        id: l.id, name: l.name, color: l.color, description: l.description,
      }));
      return paginateConnection(list.map((v, i) => ({ number: i + 1, value: v })), args);
    },
    comments: (_s, src, args) => {
      const list = src.issue.comments.map((c) => wrap('Comment', {
        id: commentGlobalId(src.repo.owner, src.repo.name, src.issue.number, c.id),
        databaseId: c.id, body: c.body,
      }));
      return paginateConnection(list.map((v, i) => ({ number: i + 1, value: v })), args);
    },
    repository: (_s, src) => repoValue(src.repo),
    url: (_s, src) => `/${src.repo.owner}/${src.repo.name}/issues/${src.number}`,
  },
  PullRequest: {
    id: (_s, src) => src.id,
    databaseId: (_s, src) => src.databaseId,
    number: (_s, src) => src.number,
    title: (_s, src) => src.title,
    body: (_s, src) => src.body,
    state: (_s, src) => src.state,
    merged: (_s, src) => src.merged,
    mergeable: (store, src) => (prWouldConflict(store, src.repo, src.pr) ? 'CONFLICTING' : 'MERGEABLE'),
    headRefName: (_s, src) => src.pr.headRef,
    baseRefName: (_s, src) => src.pr.baseRef,
    headRefOid: (_s, src) => src.pr.headSha,
    baseRefOid: (_s, src) => src.pr.baseSha,
    createdAt: (_s, src) => src.pr.createdAt,
    updatedAt: (_s, src) => src.pr.updatedAt,
    closedAt: (_s, src) => src.pr.closedAt,
    mergedAt: (_s, src) => src.pr.mergedAt,
    mergeCommit: (store, src) => {
      if (!src.pr.mergeCommitSha) return null;
      const obj = store.getObject(src.repo, src.pr.mergeCommitSha);
      if (!obj) return null;
      const c = parseCommit(obj.data);
      return wrap('Commit', { oid: src.pr.mergeCommitSha, message: c ? c.message : '' });
    },
    author: () => wrap('User', { id: String(VIEWER_ID), databaseId: VIEWER_ID, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL }),
    files: (store, src, args) => {
      const files = prFiles(store, src.repo, src.pr);
      const list = files.map((f, i) => wrap('PullRequestFile', {
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      return paginateConnection(list.map((v, i) => ({ number: i + 1, value: v })), args);
    },
    repository: (_s, src) => repoValue(src.repo),
    url: (_s, src) => `/${src.repo.owner}/${src.repo.name}/pull/${src.number}`,
  },
  User: {
    id: (_s, src) => src.id,
    databaseId: (_s, src) => src.databaseId,
    login: (_s, src) => src.login,
    name: (_s, src) => src.name,
    email: (_s, src) => src.email,
  },
  RepositoryOwner: {
    id: (_s, src) => src.id,
    login: (_s, src) => src.login,
  },
  Ref: {
    id: (_s, src) => src.id,
    name: (_s, src) => src.name,
    prefix: (_s, src) => src.prefix,
    target: (store, src) => null,
  },
  Connection: {
    nodes: (_s, src) => src.nodes,
    edges: (_s, src) => src.nodes.map((n, i) => wrap('Edge', { node: n, cursor: encodeCursor(i + 1) })),
    pageInfo: (_s, src) => src.pageInfo,
    totalCount: (_s, src) => src.totalCount,
  },
  PageInfo: {
    hasNextPage: (_s, src) => src.hasNextPage,
    hasPreviousPage: (_s, src) => src.hasPreviousPage,
    startCursor: (_s, src) => src.startCursor,
    endCursor: (_s, src) => src.endCursor,
  },
  Comment: {
    id: (_s, src) => src.id,
    databaseId: (_s, src) => src.databaseId,
    body: (_s, src) => src.body,
    author: () => wrap('User', { id: String(VIEWER_ID), databaseId: VIEWER_ID, login: VIEWER_LOGIN, name: VIEWER_NAME, email: VIEWER_EMAIL }),
    createdAt: (_s, src) => src.createdAt || null,
    updatedAt: (_s, src) => src.updatedAt || null,
  },
  Label: {
    id: (_s, src) => src.id,
    name: (_s, src) => src.name,
    color: (_s, src) => src.color,
    description: (_s, src) => src.description,
  },
  PullRequestFile: {
    path: (_s, src) => src.path,
    additions: (_s, src) => src.additions,
    deletions: (_s, src) => src.deletions,
    changeType: (_s, src) => src.changeType,
  },
  CreateIssuePayload: {
    issue: (_s, src) => src.issue,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (_s, src) => src.issue,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_s, src) => src.pullRequest,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (_s, src) => src.pullRequest,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (_s, src) => src.commentEdge,
    comment: (_s, src) => src.comment,
    clientMutationId: () => null,
  },
  IssueCommentEdge: {
    node: (_s, src) => src.node,
    cursor: (_s, src) => src.cursor,
  },
  Edge: {
    node: (_s, src) => src.node,
    cursor: (_s, src) => src.cursor,
  },
  __Type: {
    name: (_s, src) => src.name,
    kind: (_s, src) => src.kind,
    description: (_s, src) => src.description || null,
    fields: (_s, src) => src.fields || null,
    enumValues: (_s, src) => src.enumValues || null,
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => [],
  },
  __Field: {
    name: (_s, src) => src.name,
    description: (_s, src) => src.description || null,
    args: (_s, src) => src.args || [],
    type: (_s, src) => wrap('__Type', { name: 'String', kind: 'SCALAR' }),
  },
  __EnumValue: {
    name: (_s, src) => src.name,
    description: (_s, src) => src.description || null,
  },
  __Schema: {
    queryType: (_s, src) => src.queryType,
    mutationType: (_s, src) => src.mutationType,
    types: (_s, src) => src.types,
  },
  Commit: {
    oid: (_s, src) => src.oid,
    message: (_s, src) => src.message,
  },
};

// ---------------------------------------------------------------- entry point
// Handle one POST /api/graphql body. Returns {status, body} (body is a JSON
// value; arrays stay arrays for batched requests).
export function handleGraphQL(store, bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON.' }] } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  for (const req of requests) {
    results.push(executeOne(store, req));
  }
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}

function executeOne(store, req) {
  if (!req || typeof req.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query is required.' }] };
  }
  let doc;
  try {
    const tokens = tokenize(req.query);
    doc = new Parser(tokens).parseDocument();
  } catch (e) {
    return { errors: [{ message: String(e.message || 'GraphQL parse error') }] };
  }
  const variables = {};
  // Defaults from variable definitions, then the supplied variables.
  for (const [name, def] of Object.entries(doc.operation.variables || {})) {
    if (def.default !== undefined) variables[name] = resolveValue(def.default, {});
  }
  if (req.variables && typeof req.variables === 'object') {
    Object.assign(variables, req.variables);
  }
  const { data, errors } = execute(store, doc, variables);
  const out = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}
