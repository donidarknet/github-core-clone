// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp).
// Supports revision 2026-07-28 via server/discover and the legacy handshake
// (initialize + notifications/initialized, revisions <= 2025-11-25).
// Plain JavaScript syntax in a .ts file (runs under --experimental-strip-types).
import {
  Store, VIEWER_LOGIN, VIEWER_ID, repoJson, repoIssueJson, pullJson,
  getTip, squashMerge, nowIso,
} from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Repository owner login' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function normalizeToolName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTool(name) {
  const norm = normalizeToolName(name);
  for (const t of TOOLS) {
    const tn = normalizeToolName(t.name);
    if (tn === norm || tn.endsWith(norm) || norm.endsWith(tn)) return t;
  }
  return null;
}

function repoWithFullName(repo) {
  return { ...repoJson(repo), full_name: `${repo.owner}/${repo.name}` };
}

function callTool(store, name, args) {
  const tool = findTool(name);
  if (!tool) {
    return { error: { code: -32602, message: `Method not found: ${name}` } };
  }
  const a = args && typeof args === 'object' ? args : {};
  // Missing required argument -> JSON-RPC -32602 (or isError:true; the suite
  // accepts either; -32602 is the simpler shape).
  for (const req of tool.inputSchema.required || []) {
    if (a[req] === undefined || a[req] === null || a[req] === '') {
      return { error: { code: -32602, message: `Missing required argument: ${req}` } };
    }
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const owner = typeof a.owner === 'string' ? a.owner : VIEWER_LOGIN;
        let repo = store.getRepo(owner, a.name);
        if (!repo) {
          repo = store.createRepo(owner, a.name, { description: a.description, private: a.private === true });
        }
        if (!repo) return { error: { code: -32602, message: 'Repository already exists' } };
        return { result: repoWithFullName(repo) };
      }
      case 'get_repo': {
        const repo = store.getRepo(a.owner, a.repo);
        if (!repo) return { error: { code: -32602, message: `Repository not found: ${a.owner}/${a.repo}` } };
        return { result: repoWithFullName(repo) };
      }
      case 'create_issue': {
        const repo = store.getRepo(a.owner, a.repo);
        if (!repo) return { error: { code: -32602, message: `Repository not found: ${a.owner}/${a.repo}` } };
        const now = nowIso();
        const number = repo.nextNumber++;
        const issue = {
          id: repo.databaseId * 1000000 + number,
          number,
          title: a.title,
          body: typeof a.body === 'string' ? a.body : '',
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
        const out = repoIssueJson(repo, issue);
        return { result: { ...out, full_name: `${repo.owner}/${repo.name}` } };
      }
      case 'list_issues': {
        const repo = store.getRepo(a.owner, a.repo);
        if (!repo) return { error: { code: -32602, message: `Repository not found: ${a.owner}/${a.repo}` } };
        const state = typeof a.state === 'string' ? a.state : 'open';
        let list = repo.issues.slice();
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((x, y) => x.number - y.number);
        const arr = list.map((i) => repoIssueJson(repo, i));
        return { result: { issues: arr }, text: JSON.stringify(arr) };
      }
      case 'create_pull_request': {
        const repo = store.getRepo(a.owner, a.repo);
        if (!repo) return { error: { code: -32602, message: `Repository not found: ${a.owner}/${a.repo}` } };
        const headSha = getTip(repo, a.head);
        const baseSha = getTip(repo, a.base);
        if (!headSha) return { error: { code: -32602, message: `head branch does not exist: ${a.head}` } };
        if (!baseSha) return { error: { code: -32602, message: `base branch does not exist: ${a.base}` } };
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === a.head && p.baseRef === a.base);
        if (dup) return { result: { ...pullJson(repo, dup), full_name: `${repo.owner}/${repo.name}` } };
        const now = nowIso();
        const pr = {
          id: repo.databaseId * 1000000 + repo.nextNumber,
          number: repo.nextNumber++,
          title: a.title,
          body: typeof a.body === 'string' ? a.body : '',
          state: 'open',
          headRef: a.head,
          baseRef: a.base,
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
        const out = pullJson(repo, pr);
        return { result: { ...out, full_name: `${repo.owner}/${repo.name}` } };
      }
      case 'merge_pull_request': {
        const repo = store.getRepo(a.owner, a.repo);
        if (!repo) return { error: { code: -32602, message: `Repository not found: ${a.owner}/${a.repo}` } };
        const num = Number(a.pull_number);
        const pr = repo.pulls.find((p) => p.number === num);
        if (!pr) return { error: { code: -32602, message: `Pull request not found: ${num}` } };
        if (pr.state === 'closed') {
          if (pr.merged) return { result: { merged: true, sha: pr.mergeCommitSha, number: num } };
          return { error: { code: -32602, message: 'Pull request is closed' } };
        }
        const res = squashMerge(store, repo, pr);
        if (!res || res.conflict) {
          return { error: { code: -32602, message: 'Merge conflict' } };
        }
        pr.merged = true;
        pr.state = 'closed';
        pr.mergedAt = nowIso();
        pr.closedAt = pr.mergedAt;
        pr.mergeCommitSha = res.sha;
        pr.updatedAt = pr.mergedAt;
        return { result: { merged: true, sha: res.sha, number: num } };
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${name}` } };
    }
  } catch (e) {
    return { error: { code: -32602, message: String(e.message || 'tool failed') } };
  }
}

// ---------------------------------------------------------------- entry point
// Handle one POST /mcp body. Returns {status, body, contentType}.
// body may be a JSON string (MCP JSON) or an object for 202/empty replies.
export function handleMcp(store, bodyText, headers) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      contentType: 'application/json',
    };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  for (const req of requests) {
    const r = handleOne(store, req, headers);
    if (r !== null) results.push(r);
  }
  if (results.length === 0) {
    // Notifications only: 202 with an empty body.
    return { status: 202, body: null, contentType: 'application/json' };
  }
  const out = Array.isArray(parsed) ? results : results[0];
  return { status: 200, body: out, contentType: 'application/json' };
}

function handleOne(store, req, headers) {
  if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id: req && req.id !== undefined ? req.id : null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const id = req.id !== undefined ? req.id : null;
  const isNotification = id === null || id === undefined;
  const method = req.method;
  const params = req.params && typeof req.params === 'object' ? req.params : {};

  if (method.startsWith('notifications/')) {
    // Notifications have no response.
    return null;
  }

  if (method === 'server/discover') {
    const meta = params._meta || {};
    const requested = meta['io.modelcontextprotocol/protocolVersion']
      || headers['mcp-protocol-version']
      || '2026-07-28';
    if (!SUPPORTED_VERSIONS.includes(requested)) {
      return {
        jsonrpc: '2.0', id,
        error: { code: -32022, message: `Unsupported protocol version: ${requested}`, data: { supported: ['2026-07-28', '2025-11-25'] } },
      };
    }
    return {
      jsonrpc: '2.0', id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      },
    };
  }

  if (method === 'initialize') {
    const requested = params.protocolVersion || '2025-11-25';
    if (!SUPPORTED_VERSIONS.includes(requested)) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unsupported protocol version: ${requested}` } };
    }
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    const out = callTool(store, name, args);
    if (out.error) {
      return { jsonrpc: '2.0', id, error: out.error };
    }
    const text = out.text !== undefined ? out.text : JSON.stringify(out.result);
    return {
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text }],
        structuredContent: out.result,
      },
    };
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }
  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}
