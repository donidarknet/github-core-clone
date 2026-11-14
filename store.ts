// store.ts — in-memory state for one forge process.
// Viewer (authenticated user) is hardcoded: the trial token never encodes a login,
// and the suite's scenario defines the viewer as adaiversen.
import {
  ZERO_OID, isObjectId, hashObject, parseTree, buildTree, parseCommit, buildCommit,
  parseTag, collectReachable,
} from './gitutil.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@make.fun>';
export const DEFAULT_BRANCH = 'main';
export const TRIAL_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

// Deterministic "now": MAKEFUN_TRIAL_NOW if set (ISO string or epoch seconds),
// else the fixed trial epoch. Never Date.now() in anything sent.
export function nowEpoch() {
  const v = process.env.MAKEFUN_TRIAL_NOW;
  if (v !== undefined && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return TRIAL_EPOCH;
}

export function nowIso() {
  const d = new Date(nowEpoch() * 1000);
  return d.toISOString().replace('.000Z', 'Z');
}

export function isoOfEpoch(sec) {
  return new Date(sec * 1000).toISOString().replace('.000Z', 'Z');
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function repoGlobalId(owner, name) {
  return 'R_' + b64url(`repo:${owner}/${name}`);
}
export function issueGlobalId(owner, name, number) {
  return 'I_' + b64url(`issue:${owner}/${name}#${number}`);
}
export function prGlobalId(owner, name, number) {
  return 'P_' + b64url(`pr:${owner}/${name}#${number}`);
}
export function commentGlobalId(owner, name, issueNumber, commentId) {
  return 'C_' + b64url(`comment:${owner}/${name}#${issueNumber}:${commentId}`);
}
export function labelGlobalId(owner, name, labelName) {
  return 'L_' + b64url(`label:${owner}/${name}:${labelName}`);
}

// Parse an opaque global id back into its parts. Returns null on mismatch.
export function parseGlobalId(id) {
  if (typeof id !== 'string' || id.length < 3) return null;
  const kind = id[0];
  const rest = id.slice(2);
  let decoded;
  try {
    decoded = Buffer.from(rest, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (kind === 'R') {
    const m = /^repo:([^/]+)\/(.+)$/.exec(decoded);
    if (!m) return null;
    return { kind: 'repo', owner: m[1], name: m[2] };
  }
  if (kind === 'I') {
    const m = /^issue:([^/]+)\/(.+)#(\d+)$/.exec(decoded);
    if (!m) return null;
    return { kind: 'issue', owner: m[1], name: m[2], number: Number(m[3]) };
  }
  if (kind === 'P') {
    const m = /^pr:([^/]+)\/(.+)#(\d+)$/.exec(decoded);
    if (!m) return null;
    return { kind: 'pr', owner: m[1], name: m[2], number: Number(m[3]) };
  }
  if (kind === 'C') {
    const m = /^comment:([^/]+)\/(.+)#(\d+):(\d+)$/.exec(decoded);
    if (!m) return null;
    return { kind: 'comment', owner: m[1], name: m[2], number: Number(m[3]), commentId: Number(m[4]) };
  }
  if (kind === 'L') {
    const m = /^label:([^/]+)\/(.+):(.+)$/.exec(decoded);
    if (!m) return null;
    return { kind: 'label', owner: m[1], name: m[2], labelName: m[3] };
  }
  return null;
}

export function viewerUserJson() {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

// ---------------------------------------------------------------- store
export class Store {
  constructor() {
    // key `${owner}/${name}` -> Repo
    this.repos = new Map();
    this.nextDbId = 1;
    this.nextCommentId = 1;
    this.nextLabelId = 1;
  }

  createRepo(owner, name, extra = {}) {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const now = nowIso();
    const repo = {
      owner,
      name,
      description: extra.description || '',
      privateFlag: extra.private === true,
      defaultBranch: extra.default_branch || DEFAULT_BRANCH,
      databaseId: this.nextDbId++,
      createdAt: now,
      updatedAt: now,
      objects: new Map(), // oid -> {type, data: Buffer}
      refs: new Map(), // refname -> oid
      labels: new Map(), // name -> Label
      issues: [],
      pulls: [],
      nextNumber: 1, // issues and PRs share one per-repo counter (GitHub-faithful)
      commitSeq: 0, // creation order for commits (GET /commits listing)
      commitOrder: new Map(), // commit oid -> sequence
      repoSeq: this.repos.size,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner, name) {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner, name) {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(owner) {
    const out = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out.sort((a, b) => a.repoSeq - b.repoSeq);
  }

  putObject(repo, type, data) {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: Buffer.from(data) });
    return oid;
  }

  getObject(repo, oid) {
    return repo.objects.get(oid);
  }
}

// ---------------------------------------------------------------- git helpers on a repo
export function refExists(repo, ref) {
  return repo.refs.has(ref);
}

export function getTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) || null;
}

export function getRef(repo, ref) {
  return repo.refs.get(ref) || null;
}

export function setRef(repo, ref, oid) {
  repo.refs.set(ref, oid);
}

export function deleteRef(repo, ref) {
  return repo.refs.delete(ref);
}

// Resolve a ref oid to its commit oid (peel annotated tags).
export function peelToCommit(store, repo, oid) {
  let cur = oid;
  for (let i = 0; i < 8; i++) {
    const obj = store.getObject(repo, cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

export function commitOf(store, repo, oid) {
  const c = peelToCommit(store, repo, oid);
  if (!c) return null;
  const obj = store.getObject(repo, c);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

// Create a commit object, record its creation sequence, return its oid.
export function createCommit(store, repo, opts) {
  const bytes = buildCommit({
    tree: opts.tree,
    parents: opts.parents || [],
    message: opts.message || '',
    author: opts.author || CONFORMANCE_IDENTITY,
    committer: opts.committer || opts.author || CONFORMANCE_IDENTITY,
    timestamp: typeof opts.timestamp === 'number' ? opts.timestamp : nowEpoch(),
  });
  const oid = store.putObject(repo, 'commit', bytes);
  if (!repo.commitOrder.has(oid)) repo.commitOrder.set(oid, ++repo.commitSeq);
  return oid;
}

export function treeEntriesOf(store, repo, treeOid) {
  if (!treeOid) return [];
  const obj = store.getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

// Build (or rebuild) a tree with `path` set to blobOid (null = delete).
// Returns the new tree oid. Missing intermediate dirs are created.
export function treeWithPath(store, repo, treeOid, path, blobOid) {
  const segs = path.split('/').filter((s) => s.length > 0);
  return treeWithPathRec(store, repo, treeOid, segs, 0, blobOid);
}

function treeWithPathRec(store, repo, treeOid, segs, depth, blobOid) {
  const entries = treeEntriesOf(store, repo, treeOid);
  const name = segs[depth];
  const last = depth === segs.length - 1;
  const idx = entries.findIndex((e) => e.name === name);
  let next = entries.slice();
  if (last) {
    if (blobOid === null) {
      if (idx >= 0) next.splice(idx, 1);
    } else {
      const rec = { mode: '100644', name, oid: blobOid };
      if (idx >= 0) next[idx] = rec;
      else next.push(rec);
    }
  } else {
    const childTree = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    const newChild = treeWithPathRec(store, repo, childTree, segs, depth + 1, blobOid);
    const rec = { mode: '40000', name, oid: newChild };
    if (idx >= 0) next[idx] = rec;
    else next.push(rec);
  }
  const bytes = buildTree(next);
  return store.putObject(repo, 'tree', bytes);
}

// Read a path from a tree. Returns {oid, type:'blob'|'tree'} or null.
export function readPath(store, repo, treeOid, path) {
  const segs = path.split('/').filter((s) => s.length > 0);
  let curTree = treeOid;
  for (let i = 0; i < segs.length; i++) {
    const entries = treeEntriesOf(store, repo, curTree);
    const e = entries.find((x) => x.name === segs[i]);
    if (!e) return null;
    if (i === segs.length - 1) {
      return { oid: e.oid, type: e.mode === '40000' ? 'tree' : 'blob' };
    }
    if (e.mode !== '40000') return null;
    curTree = e.oid;
  }
  return null;
}

// Flatten a tree into Map<path, blobOid>.
export function flattenTree(store, repo, treeOid, prefix = '', out = new Map()) {
  for (const e of treeEntriesOf(store, repo, treeOid)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(store, repo, e.oid, p, out);
    else if (e.mode !== '160000') out.set(p, e.oid);
  }
  return out;
}

// Ancestor set of a commit oid (following parents), including itself.
export function ancestors(store, repo, tip) {
  const seen = new Set();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop();
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const c = commitOf(store, repo, oid);
    if (!c) continue;
    for (const p of c.parents) queue.push(p);
  }
  return seen;
}

export function isAncestor(store, repo, ancestor, descendant) {
  if (ancestor === descendant) return true;
  return ancestors(store, repo, descendant).has(ancestor);
}

// First (newest) common ancestor of two commits, via BFS from `a` into `b`'s set.
export function mergeBase(store, repo, a, b) {
  const bSet = ancestors(store, repo, b);
  const queue = [a];
  const seen = new Set();
  while (queue.length > 0) {
    const oid = queue.shift();
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (bSet.has(oid)) return oid;
    const c = commitOf(store, repo, oid);
    if (!c) continue;
    for (const p of c.parents) queue.push(p);
  }
  return null;
}

// Commits reachable from tip, newest-first by creation sequence.
export function commitsFrom(store, repo, tip) {
  const set = ancestors(store, repo, tip);
  const list = [...set];
  list.sort((a, b) => (repo.commitOrder.get(b) || 0) - (repo.commitOrder.get(a) || 0));
  return list;
}

// ---------------------------------------------------------------- line diff
// LCS-based line diff (files here are small; scenario blobs are a few hundred bytes).
export function diffLines(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Drop a single trailing empty element produced by a trailing newline: the
  // client's diff counts lines, and a trailing newline does not add a line.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length, m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------- issues / pulls
export function repoIssueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => labelJson(repo, l)),
    user: viewerUserJson(),
    assignee: null,
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function labelJson(repo, label) {
  return {
    id: label.id,
    node_id: labelGlobalId(repo.owner, repo.name, label.name),
    name: label.name,
    color: label.color,
    description: label.description || '',
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function pullJson(repo, pr) {
  return {
    id: pr.id,
    node_id: prGlobalId(repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    user: viewerUserJson(),
    head: {
      ref: pr.headRef,
      sha: pr.headSha,
      label: `${repo.owner}:${pr.headRef}`,
      user: viewerUserJson(),
      repo: repoJson(repo),
    },
    base: {
      ref: pr.baseRef,
      sha: pr.baseSha,
      label: `${repo.owner}:${pr.baseRef}`,
      user: viewerUserJson(),
      repo: repoJson(repo),
    },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    draft: false,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    html_url: `/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

export function repoJson(repo) {
  const now = nowIso();
  return {
    id: repo.databaseId,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: viewerUserJson(),
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: now,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.privateFlag ? 'private' : 'public',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    language: null,
    topics: [],
    license: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
  };
}

// ---------------------------------------------------------------- merge / PR files
// Three-way squash merge of a PR onto its base branch tip.
// Returns {ok:true, sha} or {conflict:true} (caller answers 405).
export function squashMerge(store, repo, pr) {
  const baseTip = getTip(repo, pr.baseRef);
  const headTip = getTip(repo, pr.headRef);
  if (!baseTip || !headTip) return { conflict: true };
  const base = mergeBase(store, repo, headTip, baseTip);
  const baseTree = base ? commitOf(store, repo, base).tree : null;
  const headTree = commitOf(store, repo, headTip).tree;
  const tipTree = commitOf(store, repo, baseTip).tree;
  const baseFlat = flattenTree(store, repo, baseTree);
  const headFlat = flattenTree(store, repo, headTree);
  const tipFlat = flattenTree(store, repo, tipTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  let mergedTree = tipTree;
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    const headChanged = h !== b;
    const tipChanged = t !== b;
    if (!headChanged) continue;
    if (tipChanged && t !== h) return { conflict: true };
    // Apply head's change onto the merged tree.
    mergedTree = treeWithPath(store, repo, mergedTree, path, h === undefined ? null : h);
  }
  const msg = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
  const sha = createCommit(store, repo, {
    tree: mergedTree,
    parents: [baseTip],
    message: msg,
    author: CONFORMANCE_IDENTITY,
    committer: CONFORMANCE_IDENTITY,
    timestamp: nowEpoch(),
  });
  setRef(repo, `refs/heads/${pr.baseRef}`, sha);
  return { ok: true, sha };
}

// File list of a PR: diff of merge-base tree vs head-tip tree.
export function prFiles(store, repo, pr) {
  const baseTip = getTip(repo, pr.baseRef);
  const headTip = getTip(repo, pr.headRef);
  if (!baseTip || !headTip) return [];
  const base = mergeBase(store, repo, headTip, baseTip);
  const baseTree = base ? commitOf(store, repo, base).tree : null;
  const headTree = commitOf(store, repo, headTip).tree;
  const baseFlat = flattenTree(store, repo, baseTree);
  const headFlat = flattenTree(store, repo, headTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out = [];
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b === h) continue;
    let status;
    if (b === undefined) status = 'added';
    else if (h === undefined) status = 'removed';
    else status = 'modified';
    const oldText = b === undefined ? '' : (store.getObject(repo, b)?.data?.toString('utf8') || '');
    const newText = h === undefined ? '' : (store.getObject(repo, h)?.data?.toString('utf8') || '');
    const d = diffLines(oldText, newText);
    out.push({
      filename: path,
      status,
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
      sha: h || b,
    });
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

// Does a conflict exist between head and base-tip vs their merge base?
export function prWouldConflict(store, repo, pr) {
  const baseTip = getTip(repo, pr.baseRef);
  const headTip = getTip(repo, pr.headRef);
  if (!baseTip || !headTip) return false;
  const base = mergeBase(store, repo, headTip, baseTip);
  const baseTree = base ? commitOf(store, repo, base).tree : null;
  const headTree = commitOf(store, repo, headTip).tree;
  const tipTree = commitOf(store, repo, baseTip).tree;
  const baseFlat = flattenTree(store, repo, baseTree);
  const headFlat = flattenTree(store, repo, headTree);
  const tipFlat = flattenTree(store, repo, tipTree);
  for (const path of new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()])) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const t = tipFlat.get(path);
    if (h !== b && t !== b && t !== h) return true;
  }
  return false;
}
