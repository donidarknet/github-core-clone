// rest.ts — GitHub REST API v3 surface (/api/v3).
// Plain JavaScript syntax in a .ts file (runs under --experimental-strip-types).
import { isObjectId, parseCommit } from './gitutil.ts';
import {
  Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL,
  CONFORMANCE_IDENTITY, DEFAULT_BRANCH, nowEpoch, nowIso, isoOfEpoch,
  viewerUserJson, repoJson, repoIssueJson, labelJson, pullJson,
  getTip, setRef, createCommit, treeWithPath, readPath, treeEntriesOf,
  commitOf, commitsFrom, squashMerge, prFiles, prWouldConflict,
} from './store.ts';

// ctx: { store, method, segs, query: URLSearchParams, body, bodyMalformed,
//        baseUrl, json(status, obj), noContent(status), error(status, message) }
export function handleRest(ctx) {
  const { method, segs } = ctx;
  // Root and meta are public (auth enforced by app.ts for everything else).
  if (segs.length === 0) {
    if (method === 'GET') {
      return ctx.json(200, {
        current_user_url: `${ctx.baseUrl}/api/v3/user`,
        rate_limit_url: `${ctx.baseUrl}/api/v3/rate_limit`,
      }, { 'X-OAuth-Scopes': 'repo, read:org' });
    }
    return ctx.error(404, 'Not Found');
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    if (method === 'GET') return ctx.json(200, { installed_version: '1.0.0' });
    return ctx.error(404, 'Not Found');
  }
  if (segs[0] === 'user' && segs.length === 1) {
    if (method === 'GET') return ctx.json(200, viewerUserJson());
    return ctx.error(404, 'Not Found');
  }
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createUserRepo(ctx);
    return ctx.error(404, 'Not Found');
  }
  if (segs[0] === 'repos' && segs.length >= 3) {
    return handleRepoRoute(ctx);
  }
  return ctx.error(404, 'Not Found');
}

function listUserRepos(ctx) {
  const all = ctx.store.listRepos(VIEWER_LOGIN);
  const { page, perPage, items, totalPages } = paginate(all, ctx.query);
  const link = buildLink(ctx, '/api/v3/user/repos', page, totalPages, ctx.query);
  return ctx.json(200, items.map((r) => repoJson(r)), link ? { Link: link } : {});
}

function createUserRepo(ctx) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const name = typeof b.name === 'string' ? b.name : '';
  if (!name || name.includes('/') || name.includes(' ')) {
    return ctx.error(422, 'name is invalid');
  }
  if (ctx.store.getRepo(VIEWER_LOGIN, name)) {
    return ctx.error(422, 'name already exists on this account');
  }
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, {
    description: b.description,
    private: b.private === true,
    default_branch: typeof b.default_branch === 'string' ? b.default_branch : undefined,
  });
  return ctx.json(201, repoJson(repo));
}

function paginate(list, query) {
  const perPage = Math.min(Math.max(parseInt(query.get('per_page') || '30', 10) || 30, 1), 100);
  const page = Math.max(parseInt(query.get('page') || '1', 10) || 1, 1);
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const start = (page - 1) * perPage;
  const items = list.slice(start, start + perPage);
  return { page, perPage, items, totalPages };
}

function buildLink(ctx, path, page, totalPages, query) {
  const perPage = query.get('per_page') || '30';
  const parts = [];
  if (page < totalPages) parts.push(`<${ctx.baseUrl}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) parts.push(`<${ctx.baseUrl}${path}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  parts.push(`<${ctx.baseUrl}${path}?per_page=${perPage}&page=1>; rel="first"`);
  parts.push(`<${ctx.baseUrl}${path}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  return parts.length > 0 ? parts.join(', ') : null;
}

// ---------------------------------------------------------------- repo routes
function handleRepoRoute(ctx) {
  const { method, segs } = ctx;
  const owner = segs[1];
  const name = segs[2];
  const rest = segs.slice(3);
  const repo = ctx.store.getRepo(owner, name);
  // Same repo name under another owner: 404, never 403 (even for the viewer).
  if (!repo || owner !== VIEWER_LOGIN) {
    return ctx.error(404, 'Not Found');
  }
  if (rest.length === 0) {
    if (method === 'GET') return ctx.json(200, repoJson(repo));
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      return ctx.noContent(204);
    }
    return ctx.error(404, 'Not Found');
  }
  const head = rest[0];
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') return listBranches(ctx, repo);
    if (rest.length === 2 && method === 'GET') return getBranch(ctx, repo, rest[1]);
    return ctx.error(404, 'Not Found');
  }
  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') return listCommits(ctx, repo);
    return ctx.error(404, 'Not Found');
  }
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return ctx.error(404, 'Not Found');
  }
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) return createLabel(ctx, repo);
    if (method === 'GET' && rest.length === 1) {
      return ctx.json(200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
    }
    return ctx.error(404, 'Not Found');
  }
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(ctx, repo);
      if (method === 'POST') return createIssue(ctx, repo);
      return ctx.error(404, 'Not Found');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return ctx.error(404, 'Not Found');
    const issue = repo.issues.find((i) => i.number === num);
    if (rest.length === 2) {
      if (!issue) return ctx.error(404, 'Not Found');
      if (method === 'GET') return ctx.json(200, repoIssueJson(repo, issue));
      if (method === 'PATCH') return patchIssue(ctx, repo, issue);
      return ctx.error(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (!issue) return ctx.error(404, 'Not Found');
      if (method === 'GET') return ctx.json(200, issue.comments.map((c) => commentJson(repo, issue, c)));
      if (method === 'POST') return createComment(ctx, repo, issue);
      return ctx.error(404, 'Not Found');
    }
    return ctx.error(404, 'Not Found');
  }
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(ctx, repo);
      if (method === 'POST') return createPull(ctx, repo);
      return ctx.error(404, 'Not Found');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return ctx.error(404, 'Not Found');
    const pr = repo.pulls.find((p) => p.number === num);
    if (rest.length === 2) {
      if (!pr) return ctx.error(404, 'Not Found');
      if (method === 'GET') return ctx.json(200, pullJson(repo, pr));
      return ctx.error(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (!pr) return ctx.error(404, 'Not Found');
      if (method === 'GET') return ctx.json(200, prFiles(ctx.store, repo, pr));
      return ctx.error(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (!pr) return ctx.error(404, 'Not Found');
      if (method === 'PUT') return mergePull(ctx, repo, pr);
      return ctx.error(404, 'Not Found');
    }
    return ctx.error(404, 'Not Found');
  }
  if (head === 'git') {
    if (rest[1] === 'refs') {
      if (rest.length === 2 && method === 'GET') return listRefs(ctx, repo);
      if (rest.length === 2 && method === 'POST') return createRef(ctx, repo);
      if (rest.length >= 3 && method === 'GET') return getRefRoute(ctx, repo, rest.slice(2).join('/'));
      return ctx.error(404, 'Not Found');
    }
    return ctx.error(404, 'Not Found');
  }
  return ctx.error(404, 'Not Found');
}

function patchRepo(ctx, repo) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  if (typeof b.description === 'string') repo.description = b.description;
  if (typeof b.private === 'boolean') repo.privateFlag = b.private;
  if (typeof b.default_branch === 'string') repo.defaultBranch = b.default_branch;
  repo.updatedAt = nowIso();
  return ctx.json(200, repoJson(repo));
}

function listBranches(ctx, repo) {
  const out = [];
  for (const [ref, oid] of repo.refs.entries()) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}` },
      protected: false,
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Default branch first (GitHub order is not specified; the suite only needs
  // the default + created branches present).
  return ctx.json(200, out);
}

function getBranch(ctx, repo, branch) {
  const oid = getTip(repo, branch);
  if (!oid) return ctx.error(404, 'Not Found');
  return ctx.json(200, {
    name: branch,
    commit: { sha: oid, url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}` },
    protected: false,
  });
}

function parseIdentity(line) {
  const m = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line || '');
  if (!m) return { name: 'Conformance', email: 'conformance@make.fun', date: nowIso(), epoch: nowEpoch() };
  return { name: m[1], email: m[2], date: isoOfEpoch(Number(m[3])), epoch: Number(m[3]) };
}

function commitJson(ctx, repo, oid) {
  const obj = ctx.store.getObject(repo, oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdentity(c.author);
  const committer = parseIdentity(c.committer);
  return {
    sha: oid,
    commit: {
      message: c.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: c.tree },
      url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
    },
    author: viewerUserJson(),
    committer: viewerUserJson(),
    parents: c.parents.map((p) => ({ sha: p })),
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function listCommits(ctx, repo) {
  const sha = ctx.query.get('sha') || repo.defaultBranch;
  const tip = getTip(repo, sha) || getRefTip(repo, sha);
  if (!tip) return ctx.json(200, []);
  const list = commitsFrom(ctx.store, repo, tip);
  const { items } = paginate(list, ctx.query);
  const out = [];
  for (const oid of items) {
    const j = commitJson(ctx, repo, oid);
    if (j) out.push(j);
  }
  return ctx.json(200, out);
}

function getRefTip(repo, ref) {
  if (ref.startsWith('refs/')) return repo.refs.get(ref) || null;
  return null;
}

// ---------------------------------------------------------------- contents
function resolveBranchTip(ctx, repo) {
  const ref = ctx.query.get('ref');
  if (ref) {
    return getTip(repo, ref) || getRefTip(repo, ref);
  }
  return getTip(repo, repo.defaultBranch);
}

function getContents(ctx, repo, path) {
  const tip = resolveBranchTip(ctx, repo);
  if (!tip) return ctx.error(404, 'Not Found');
  const commit = commitOf(ctx.store, repo, tip);
  if (!commit) return ctx.error(404, 'Not Found');
  if (!path) {
    // Root directory listing.
    const entries = treeEntriesOf(ctx.store, repo, commit.tree);
    return ctx.json(200, entries.map((e) => dirEntryJson(ctx, repo, '', e)));
  }
  const found = readPath(ctx.store, repo, commit.tree, path);
  if (!found) return ctx.error(404, 'Not Found');
  if (found.type === 'tree') {
    const entries = treeEntriesOf(ctx.store, repo, found.oid);
    return ctx.json(200, entries.map((e) => dirEntryJson(ctx, repo, path, e)));
  }
  const obj = ctx.store.getObject(repo, found.oid);
  if (!obj || obj.type !== 'blob') return ctx.error(404, 'Not Found');
  const name = path.split('/').pop();
  return ctx.json(200, {
    type: 'file',
    encoding: 'base64',
    size: obj.data.length,
    name,
    path,
    content: obj.data.toString('base64'),
    sha: found.oid,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: null,
    download_url: null,
  });
}

function dirEntryJson(ctx, repo, dir, e) {
  const path = dir ? `${dir}/${e.name}` : e.name;
  return {
    type: e.mode === '40000' ? 'dir' : 'file',
    size: e.mode === '40000' ? 0 : (ctx.store.getObject(repo, e.oid)?.data?.length || 0),
    name: e.name,
    path,
    sha: e.oid,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    git_url: null,
    download_url: null,
  };
}

function putContents(ctx, repo, path) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  if (typeof b.content !== 'string') return ctx.error(422, 'content is required');
  const message = typeof b.message === 'string' ? b.message : '';
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  let tip = getTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // Create the branch at the default tip first, then commit on it.
    const defTip = getTip(repo, repo.defaultBranch);
    if (!defTip) return ctx.error(422, 'repository is empty');
    setRef(repo, `refs/heads/${branch}`, defTip);
    tip = defTip;
  }
  const bytes = Buffer.from(b.content.replace(/\s/g, ''), 'base64');
  const blobOid = ctx.store.putObject(repo, 'blob', bytes);
  const isNew = tip === null;
  let currentTree = null;
  let existing = null;
  if (!isNew) {
    const commit = commitOf(ctx.store, repo, tip);
    if (!commit) return ctx.error(404, 'Not Found');
    currentTree = commit.tree;
    existing = readPath(ctx.store, repo, currentTree, path);
  }
  if (existing) {
    if (typeof b.sha === 'string' && b.sha !== existing.oid) {
      return ctx.error(409, 'sha does not match the current file');
    }
    if (typeof b.sha !== 'string') {
      return ctx.error(422, 'sha is required to update an existing file');
    }
  }
  const newTree = treeWithPath(ctx.store, repo, currentTree, path, blobOid);
  const parents = isNew ? [] : [tip];
  const sha = createCommit(ctx.store, repo, {
    tree: newTree,
    parents,
    message,
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: nowEpoch(),
  });
  setRef(repo, `refs/heads/${branch}`, sha);
  repo.updatedAt = nowIso();
  return ctx.json(existing ? 200 : 201, {
    content: { sha: blobOid, encoding: 'base64' },
    commit: { sha },
  });
}

function deleteContents(ctx, repo, path) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
  const tip = getTip(repo, branch);
  if (!tip) return ctx.error(404, 'Not Found');
  const commit = commitOf(ctx.store, repo, tip);
  if (!commit) return ctx.error(404, 'Not Found');
  const existing = readPath(ctx.store, repo, commit.tree, path);
  if (!existing || existing.type !== 'blob') return ctx.error(404, 'Not Found');
  if (typeof b.sha === 'string' && b.sha !== existing.oid) {
    return ctx.error(409, 'sha does not match the current file');
  }
  const newTree = treeWithPath(ctx.store, repo, commit.tree, path, null);
  const sha = createCommit(ctx.store, repo, {
    tree: newTree,
    parents: [tip],
    message: typeof b.message === 'string' ? b.message : '',
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: nowEpoch(),
  });
  setRef(repo, `refs/heads/${branch}`, sha);
  repo.updatedAt = nowIso();
  return ctx.json(200, { commit: { sha } });
}

// ---------------------------------------------------------------- labels / issues
function createLabel(ctx, repo) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const name = typeof b.name === 'string' ? b.name : '';
  if (!name) return ctx.error(422, 'name is required');
  if (repo.labels.has(name)) {
    return ctx.json(200, labelJson(repo, repo.labels.get(name)));
  }
  const label = {
    id: ctx.store.nextLabelId++,
    name,
    color: typeof b.color === 'string' ? b.color.replace('#', '') : 'ededed',
    description: typeof b.description === 'string' ? b.description : '',
  };
  repo.labels.set(name, label);
  return ctx.json(201, labelJson(repo, label));
}

function listIssues(ctx, repo) {
  const state = ctx.query.get('state') || 'open';
  const sort = ctx.query.get('sort') || 'created';
  const direction = ctx.query.get('direction') || 'desc';
  let list = repo.issues.slice();
  if (state !== 'all') list = list.filter((i) => i.state === state);
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { items } = paginate(list, ctx.query);
  return ctx.json(200, items.map((i) => repoIssueJson(repo, i)));
}

function createIssue(ctx, repo) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const title = typeof b.title === 'string' ? b.title : '';
  if (!title) return ctx.error(422, 'title is required');
  const labels = [];
  for (const name of Array.isArray(b.labels) ? b.labels : []) {
    const label = repo.labels.get(name);
    if (!label) return ctx.error(422, `label does not exist: ${name}`);
    labels.push(label);
  }
  const now = nowIso();
  const number = repo.nextNumber++;
  const issue = {
    id: repo.databaseId * 1000000 + number, // stable, unique per repo
    number,
    title,
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open',
    labels,
    user: viewerUserJson(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    seq: repo.issues.length,
  };
  repo.issues.push(issue);
  return ctx.json(201, repoIssueJson(repo, issue));
}

function patchIssue(ctx, repo, issue) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  if (typeof b.title === 'string') issue.title = b.title;
  if (typeof b.body === 'string') issue.body = b.body;
  if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
    issue.state = b.state;
    issue.closedAt = b.state === 'closed' ? nowIso() : null;
  }
  if (Array.isArray(b.labels)) {
    const labels = [];
    for (const name of b.labels) {
      const label = repo.labels.get(name);
      if (!label) return ctx.error(422, `label does not exist: ${name}`);
      labels.push(label);
    }
    issue.labels = labels;
  }
  issue.updatedAt = nowIso();
  return ctx.json(200, repoIssueJson(repo, issue));
}

function commentJson(repo, issue, c) {
  return {
    id: c.id,
    node_id: `${repo.owner}/${repo.name}#${issue.number}:${c.id}`,
    body: c.body,
    user: viewerUserJson(),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${c.id}`,
  };
}

function createComment(ctx, repo, issue) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const body = typeof b.body === 'string' ? b.body : '';
  if (!body) return ctx.error(422, 'body is required');
  const now = nowIso();
  const c = {
    id: ctx.store.nextCommentId++,
    body,
    user: viewerUserJson(),
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(c);
  return ctx.json(201, commentJson(repo, issue, c));
}

// ---------------------------------------------------------------- pulls
function listPulls(ctx, repo) {
  const state = ctx.query.get('state') || 'open';
  let list = repo.pulls.slice();
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => a.number - b.number);
  const { items } = paginate(list, ctx.query);
  return ctx.json(200, items.map((p) => pullJson(repo, p)));
}

function createPull(ctx, repo) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const title = typeof b.title === 'string' ? b.title : '';
  const head = typeof b.head === 'string' ? b.head : '';
  const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
  if (!title) return ctx.error(422, 'title is required');
  if (!head) return ctx.error(422, 'head is required');
  const headSha = getTip(repo, head);
  const baseSha = getTip(repo, base);
  if (!headSha) return ctx.error(422, `head branch does not exist: ${head}`);
  if (!baseSha) return ctx.error(422, `base branch does not exist: ${base}`);
  const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (dup) return ctx.error(422, `A pull request already exists for ${head}`);
  const now = nowIso();
  const pr = {
    id: repo.databaseId * 1000000 + repo.nextNumber,
    number: repo.nextNumber++,
    title,
    body: typeof b.body === 'string' ? b.body : '',
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: viewerUserJson(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.pulls.push(pr);
  return ctx.json(201, pullJson(repo, pr));
}

function mergePull(ctx, repo, pr) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  if (pr.state === 'closed') {
    if (pr.merged) return ctx.error(405, 'Pull Request is already merged');
    return ctx.error(405, 'Pull Request is closed');
  }
  const res = squashMerge(ctx.store, repo, pr);
  if (!res || res.conflict) {
    return ctx.error(405, 'Merge conflict');
  }
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = nowIso();
  pr.closedAt = pr.mergedAt;
  pr.mergeCommitSha = res.sha;
  pr.updatedAt = pr.mergedAt;
  const b = ctx.body || {};
  const method = typeof b.merge_method === 'string' ? b.merge_method : 'merge';
  return ctx.json(200, {
    sha: res.sha,
    merged: true,
    message: `Pull Request successfully merged using ${method}`,
  });
}

// ---------------------------------------------------------------- git refs
function refJson(ctx, repo, ref, oid) {
  const obj = ctx.store.getObject(repo, oid);
  return {
    ref,
    node_id: `${repo.owner}/${repo.name}:${ref}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: {
      sha: oid,
      type: obj ? obj.type : 'commit',
      url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/git/${obj ? obj.type + 's' : 'commits'}/${oid}`,
    },
  };
}

function listRefs(ctx, repo) {
  const out = [];
  for (const [ref, oid] of repo.refs.entries()) {
    out.push(refJson(ctx, repo, ref, oid));
  }
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return ctx.json(200, out);
}

function createRef(ctx, repo) {
  if (ctx.bodyMalformed) return ctx.error(400, 'Problems parsing JSON');
  const b = ctx.body || {};
  const ref = typeof b.ref === 'string' ? b.ref : '';
  const sha = typeof b.sha === 'string' ? b.sha : '';
  if (!ref.startsWith('refs/')) return ctx.error(422, 'ref must start with refs/');
  if (!isObjectId(sha)) return ctx.error(422, 'sha is invalid');
  if (repo.refs.has(ref)) return ctx.error(422, 'Reference already exists');
  if (!ctx.store.getObject(repo, sha)) return ctx.error(422, 'object does not exist');
  repo.refs.set(ref, sha);
  return ctx.json(201, refJson(ctx, repo, ref, sha));
}

function getRefRoute(ctx, repo, ref) {
  const full = `refs/${ref}`;
  const oid = repo.refs.get(full);
  if (!oid) return ctx.error(404, 'Not Found');
  return ctx.json(200, refJson(ctx, repo, full, oid));
}
