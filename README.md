# github-core-clone

A standalone GitHub-compatible git forge in one Node process — the entry for
make.fun competition `github-core-clone-01` ($500, deadline 2026-11-21T06:30Z).
No dependencies, no git binary, no network beyond the harness: Node 22+ stdlib
only, all state in memory.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — `git-upload-pack` v2
  (ls-refs, fetch with shallow/deepen, thin packs without deltas) and
  `git-receive-pack` v0 (report-status, side-band-64k, delete-refs).
  Pushed objects are stored verbatim and round-trip byte-exact.
- **REST API v3** at `/api/v3` — repos, branches, commits, contents
  (create/update/delete with real commits), labels, issues, comments,
  pull requests (squash merge with three-way conflict detection),
  `POST /git/refs`, plus the protocol rules: every reply `application/json`,
  `X-GitHub-Request-Id` on every reply, `401` JSON without a token,
  same repo name under another owner → `404` (never `403`).
- **GraphQL** at `/api/graphql` — `viewer`, `repository` (+ `issue`,
  `issues` with cursor pagination and `orderBy`, `pullRequest`,
  `pullRequests`, `files`), `node(id)`, `__type` introspection, batched
  array bodies in order, mutations `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`. Unknown fields
  answer HTTP 200 with an `errors` array naming the field.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, revision `2026-07-28`
  via `server/discover` and the legacy handshake (`initialize` +
  `notifications/initialized`) for revisions `<= 2025-11-25`. Six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — byte-identical `tools/list`,
  unknown tools and missing arguments answer `-32602`.

## Determinism

Every `created_at` / `updated_at` and every git commit author/committer date
comes from `MAKEFUN_TRIAL_NOW` when set, else the fixed epoch
`2025-01-01T00:00:00Z` — `Date.now()` is never used in anything sent.
The authenticated token is treated as the viewer `adaiversen`
(`adaiversen@example.invalid`); the token never encodes a login.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Lifecycle: ephemeral port, `POST $MAKEFUN_ENV_URL/register`, long-poll `GET .../done`, exit 0. |
| `app.ts` | HTTP server, routing, auth, body handling. |
| `store.ts` | In-memory store, global ids, tree/commit helpers, three-way squash merge, PR file diffs. |
| `gitutil.ts` | Git object model, pack codec (plain + OFS/REF delta read), pkt-line framing. |
| `gitproto.ts` | Advertisements, v2 ls-refs/fetch, v0 fetch, receive-pack. |
| `rest.ts` | REST API v3 surface. |
| `graphql.ts` | GraphQL lexer/parser/executor + introspection. |
| `mcp.ts` | MCP Streamable HTTP + the six tools. |

## Run

```bash
node --experimental-strip-types main.ts
```

`MAKEFUN_ENV_URL` must be set (the harness provides it). For local testing,
start the server from a small harness that imports `createApp()` from
`app.ts` and listens on a fixed port, with `MAKEFUN_SHOP_TOKEN` set to the
same token you pass to the kit runner:

```bash
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOKEN
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOKEN --perf
```

## Scoring (per the kit)

Score 0–1,000: feature 600 (120 conformance checks: git 30, repos 15,
issues 15, pulls 20, graphql 20, mcp 15, protocol 5) + agent 200 (15 MCP
checks) + perf 200 (4 workloads: push 200× 1 KiB, clone 50 concurrent
shallow, read 2,000 sequential issue GETs, write 200 issue creates; each
≤ 50 pts, `round(clamp(25 − 12.5·log2(t/T_ref), 0, 50))` against the house
baseline's reference times). A prize needs a score strictly above the
house baseline (reference forge, enters 4 h before the deadline).
