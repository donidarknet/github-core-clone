// gitproto.ts — git smart-HTTP wire protocol (upload-pack v2, receive-pack v0).
// Plain JavaScript syntax in a .ts file (runs under --experimental-strip-types).
import {
  ZERO_OID, isObjectId, parseTag,
  writePack, readPack, verifyPackChecksum,
  encodePktLine, pktFlush, pktDelim, decodePktLines, splitReceivePackBody,
  PKT_LINE_MAX_PAYLOAD,
} from './gitutil.ts';
import {
  getTip, setRef, peelToCommit, commitOf,
  ancestors, treeEntriesOf,
} from './store.ts';

const AGENT = 'github-core-clone/1.0';

// ---------------------------------------------------------------- advertisements
function refsSorted(repo) {
  const out = [];
  for (const [name, oid] of repo.refs.entries()) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function v2Capabilities() {
  return [
    'agent=' + AGENT,
    'ls-refs=unborn',
    'fetch=shallow filter',
    'object-format=sha1',
  ];
}

// v2 advertisement: opens with 'version 2' (RULES: the v2 advertisement opens
// with 'version 2'), then capability lines, then flush. No '# service=' preamble.
export function advertiseV2() {
  const chunks = [encodePktLine('version 2\n')];
  for (const c of v2Capabilities()) chunks.push(encodePktLine(c + '\n'));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

// v0 advertisement (upload-pack or receive-pack): preamble + ref lines + flush.
// Empty repo: a single `0000... capabilities^{}` line only.
export function advertiseV0(repo, service) {
  const preamble = encodePktLine(`# service=git-${service}\n`);
  const refs = refsSorted(repo);
  const caps = service === 'upload-pack'
    ? 'side-band-64k shallow thin-pack ofs-delta agent=' + AGENT + ' symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  const lines = [preamble];
  if (refs.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    lines.push(pktFlush());
    return Buffer.concat(lines);
  }
  let first = true;
  for (const r of refs) {
    const suffix = first ? `\0${caps}` : '';
    lines.push(encodePktLine(`${r.oid} ${r.name}${suffix}\n`));
    first = false;
    // Peeled line immediately after an annotated tag ref line.
    if (r.name.startsWith('refs/tags/')) {
      const peeled = peelToCommitForAdvertise(repo, r.oid);
      if (peeled && peeled !== r.oid) {
        lines.push(encodePktLine(`${peeled} ${r.name}^{}\n`));
      }
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function peelToCommitForAdvertise(repo, oid) {
  // Local peel without the store wrapper (store is imported, but advertiseV0
  // receives only the repo; peel through repo.objects directly).
  let cur = oid;
  for (let i = 0; i < 8; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
    return null;
  }
  return null;
}

// Objects of one commit: the commit itself + its tree + all blobs under it.
// Parents are NOT included — depth limiting is enforced at the commit-graph
// level (deliverCommits / heldCommits), not here.
function commitObjects(store, repo, commitOid) {
  const out = new Set();
  const c = commitOf(store, repo, commitOid);
  if (!c) return out;
  out.add(commitOid);
  const stack = [c.tree];
  while (stack.length > 0) {
    const treeOid = stack.pop();
    if (!treeOid || out.has(treeOid)) continue;
    out.add(treeOid);
    for (const e of treeEntriesOf(store, repo, treeOid)) {
      if (e.mode === '40000') stack.push(e.oid);
      else if (e.mode !== '160000') out.add(e.oid);
    }
  }
  return out;
}

// Peel a want/have oid to its commit oid; returns the commit oid, or the oid
// itself if it is not a stored object (caller decides). Tag oids are reported
// separately so the tag object itself can be delivered.
function peelWant(store, repo, oid) {
  const obj = store.getObject(repo, oid);
  if (!obj) return { commit: oid, tag: null };
  if (obj.type === 'tag') {
    const c = peelToCommit(store, repo, oid);
    return { commit: c || oid, tag: oid };
  }
  return { commit: oid, tag: null };
}

// ---------------------------------------------------------------- fetch selection
// Walk from wants with a depth limit; subtract what the client already holds
// (haves, stopping at shallow boundaries). Returns objects to send, plus
// shallow/unshallow sets for the shallow-info section.
export function selectFetchObjects(store, repo, opts) {
  const wants = opts.wants || [];
  const haves = opts.haves || [];
  const depth = typeof opts.depth === 'number' ? opts.depth : null;
  const shallowIn = opts.shallow || [];

  // Held set: walk from haves, stopping at shallow boundaries (boundary commit
  // + its tree/blobs are held, parents are not).
  const boundarySet = new Set(shallowIn);
  const held = new Set();
  const heldCommits = new Set();
  const holdQueue = [];
  for (const h of haves) {
    const pw = peelWant(store, repo, h);
    if (pw.tag) held.add(pw.tag);
    holdQueue.push(pw.commit);
  }
  while (holdQueue.length > 0) {
    const oid = holdQueue.pop();
    if (!oid || oid === ZERO_OID || heldCommits.has(oid)) continue;
    heldCommits.add(oid);
    const c = commitOf(store, repo, oid);
    if (!c) continue;
    if (boundarySet.has(oid)) continue; // boundary: do not walk parents
    for (const p of c.parents) holdQueue.push(p);
  }
  // Held objects = per held commit (commit + tree + blobs), NOT ancestors:
  // the parent walk above already decided which commits are held.
  for (const oid of heldCommits) {
    for (const o of commitObjects(store, repo, oid)) held.add(o);
  }

  // Walk from wants with depth limit. Depth N = commits within N generations
  // of a want (depth 1 = tip only).
  const deliverCommits = new Set();
  const deliverTags = new Set();
  const shallowOut = new Set();
  const walkQueue = [];
  for (const w of wants) {
    const pw = peelWant(store, repo, w);
    if (pw.tag) deliverTags.add(pw.tag);
    walkQueue.push({ oid: pw.commit, gen: 1 });
  }
  const seenWalk = new Set();
  while (walkQueue.length > 0) {
    const { oid, gen } = walkQueue.shift();
    if (!oid || oid === ZERO_OID || seenWalk.has(oid)) continue;
    seenWalk.add(oid);
    const c = commitOf(store, repo, oid);
    if (!c) continue;
    deliverCommits.add(oid);
    if (depth !== null && gen >= depth) {
      if (c.parents.length > 0) shallowOut.add(oid);
      continue;
    }
    for (const p of c.parents) walkQueue.push({ oid: p, gen: gen + 1 });
  }

  // Objects to deliver = per delivered commit (commit + tree + blobs) plus
  // any requested tag objects, minus held.
  const deliver = new Set(deliverTags);
  for (const oid of deliverCommits) {
    for (const o of commitObjects(store, repo, oid)) {
      if (!held.has(o)) deliver.add(o);
    }
  }
  // Unshallow: old boundaries whose parents entered the walk.
  const unshallow = new Set();
  for (const b of boundarySet) {
    const c = commitOf(store, repo, b);
    if (!c) continue;
    for (const p of c.parents) {
      if (deliverCommits.has(p)) { unshallow.add(b); break; }
    }
  }
  const objects = [];
  for (const oid of deliver) {
    const obj = store.getObject(repo, oid);
    if (obj) objects.push({ type: obj.type, data: obj.data, oid });
  }
  objects.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return { objects, shallow: [...shallowOut], unshallow: [...unshallow] };
}

// ---------------------------------------------------------------- v2 ls-refs
export function handleLsRefsV2(repo, body) {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes = [];
  for (const pkt of packets) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').trimEnd();
    if (line === 'command=ls-refs') continue;
    if (line === 'peel') { peel = true; continue; }
    if (line === 'symrefs') { symrefs = true; continue; }
    if (line === 'unborn') { unborn = true; continue; }
    if (line.startsWith('ref-prefix ')) { prefixes.push(line.slice('ref-prefix '.length)); continue; }
    // agent=, object-format= : accepted, ignored.
  }
  const refs = refsSorted(repo);
  const out = [];
  const headTip = getTip(repo, 'main');
  // HEAD line first, when it matches the filter (or no filter).
  const headWanted = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (headTip && headWanted) {
    let line = `${headTip} HEAD`;
    if (symrefs) line += ' symref-target:refs/heads/main';
    out.push(encodePktLine(line + '\n'));
  }
  for (const r of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.name.startsWith('refs/tags/')) {
      const peeled = peelToCommitForAdvertise(repo, r.oid);
      if (peeled && peeled !== r.oid) line += ` peeled:${peeled}`;
    }
    out.push(encodePktLine(line + '\n'));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- v2 fetch
// Parse a v2 fetch request body into {wants, haves, shallow, depth, filterLines}.
export function parseFetchV2(body) {
  const packets = decodePktLines(body);
  const req = { wants: [], haves: [], shallow: [], depth: null, deepen: null, filterLines: [], done: false };
  let seenDelim = false;
  for (const pkt of packets) {
    if (pkt.kind === 'delim') { seenDelim = true; continue; }
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').trimEnd();
    if (!seenDelim) {
      if (line === 'command=fetch') continue;
      // agent=, object-format= : accepted, ignored.
      continue;
    }
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line === 'done') { req.done = true; continue; }
    if (line.startsWith('want ')) { req.wants.push(line.slice(5).trim()); continue; }
    if (line.startsWith('have ')) { req.haves.push(line.slice(5).trim()); continue; }
    if (line.startsWith('shallow ')) { req.shallow.push(line.slice(8).trim()); continue; }
    if (line.startsWith('deepen ')) { req.deepen = Number(line.slice(7).trim()); req.depth = req.deepen; continue; }
    if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) { req.deepen = 1; req.depth = 1; continue; }
    if (line.startsWith('filter ')) { req.filterLines.push(line); continue; }
    // Unknown argument lines are ignored (defensive).
  }
  return req;
}

function sidebandPacket(band, payload) {
  // A sideband packet is a pkt-line whose payload is band byte + data.
  const body = Buffer.concat([Buffer.from([band]), Buffer.from(payload)]);
  if (body.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error('sideband chunk too large');
  }
  return encodePktLine(body);
}

export function handleFetchV2(store, repo, body) {
  const req = parseFetchV2(body);
  // Acknowledge common haves that we actually hold.
  const acks = [];
  let nak = true;
  for (const h of req.haves) {
    if (store.getObject(repo, h)) { acks.push(h); nak = false; }
  }
  const sel = selectFetchObjects(store, repo, {
    wants: req.wants,
    haves: req.haves,
    shallow: req.shallow,
    depth: req.depth,
  });
  const pack = writePack(sel.objects.map((o) => ({ type: o.type, data: o.data })));
  const out = [];
  // acknowledgments section
  out.push(encodePktLine('acknowledgments\n'));
  if (nak) {
    out.push(encodePktLine('NAK\n'));
  } else {
    for (const a of acks) out.push(encodePktLine(`ACK ${a}\n`));
    out.push(encodePktLine('ready\n'));
  }
  out.push(pktDelim());
  // shallow-info section (only when non-empty)
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    out.push(encodePktLine('shallow-info\n'));
    for (const s of sel.shallow) out.push(encodePktLine(`shallow ${s}\n`));
    for (const u of sel.unshallow) out.push(encodePktLine(`unshallow ${u}\n`));
    out.push(pktDelim());
  }
  // packfile section: band-1 sideband packets, pack bytes chunked to fit.
  out.push(encodePktLine('packfile\n'));
  const CHUNK = PKT_LINE_MAX_PAYLOAD - 1; // minus band byte
  for (let off = 0; off < pack.length; off += CHUNK) {
    out.push(sidebandPacket(1, pack.subarray(off, Math.min(pack.length, off + CHUNK))));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- v0 fetch
export function handleFetchV0(store, repo, body) {
  // Request: want lines (capabilities on first), shallow/deepen lines, flush,
  // have lines, done, flush. Reply: text lines (NAK/ACK/shallow/unshallow) +
  // sideband packets + flush. Never a 'ready' line (the client throws on it).
  const packets = decodePktLines(body);
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  let seenFlush = false;
  for (const pkt of packets) {
    if (pkt.kind === 'flush') { seenFlush = true; continue; }
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').trimEnd();
    if (!seenFlush) {
      if (line.startsWith('want ')) {
        wants.push(line.slice(5).trim().split(' ')[0]);
        continue;
      }
      if (line.startsWith('shallow ')) { shallow.push(line.slice(8).trim()); continue; }
      if (line.startsWith('deepen ')) { depth = Number(line.slice(7).trim()); continue; }
      if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) { depth = 1; continue; }
      continue;
    }
    if (line.startsWith('have ')) { haves.push(line.slice(5).trim()); continue; }
    // 'done' and capability lines ignored.
  }
  const acks = [];
  let nak = true;
  for (const h of haves) {
    if (store.getObject(repo, h)) { acks.push(h); nak = false; }
  }
  const sel = selectFetchObjects(store, repo, { wants, haves, shallow, depth });
  const pack = writePack(sel.objects.map((o) => ({ type: o.type, data: o.data })));
  const out = [];
  if (nak) out.push(encodePktLine('NAK\n'));
  else for (const a of acks) out.push(encodePktLine(`ACK ${a}\n`));
  for (const s of sel.shallow) out.push(encodePktLine(`shallow ${s}\n`));
  for (const u of sel.unshallow) out.push(encodePktLine(`unshallow ${u}\n`));
  const CHUNK = PKT_LINE_MAX_PAYLOAD - 1;
  for (let off = 0; off < pack.length; off += CHUNK) {
    out.push(sidebandPacket(1, pack.subarray(off, Math.min(pack.length, off + CHUNK))));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- receive-pack
// Parse and apply a receive-pack (v0) request.
// Returns {status, body} where body is the report (sideband-wrapped if the
// client advertised side-band-64k, else raw pkt-lines).
export function handleReceivePack(store, repo, body) {
  let commands;
  let packBuf;
  try {
    const split = splitReceivePackBody(body);
    commands = split.commands;
    packBuf = split.pack;
  } catch (e) {
    return { status: 400, body: Buffer.from('malformed receive-pack body\n', 'utf8'), contentType: 'text/plain' };
  }
  if (commands.length === 0) {
    return { status: 400, body: Buffer.from('empty receive-pack\n', 'utf8'), contentType: 'text/plain' };
  }
  // First command line carries capabilities after NUL.
  const parsed = [];
  let sideband = false;
  commands.forEach((line, i) => {
    let caps = '';
    let cmd = line;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      cmd = line.slice(0, nul);
      caps = line.slice(nul + 1);
    }
    if (i === 0) {
      for (const c of caps.split(' ')) {
        if (c === 'side-band-64k') sideband = true;
      }
    }
    const parts = cmd.trim().split(/\s+/);
    if (parts.length === 3) {
      parsed.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });
  if (parsed.length === 0) {
    return { status: 400, body: Buffer.from('no valid ref updates\n', 'utf8'), contentType: 'text/plain' };
  }

  // Unpack: parse the pack (if any) and store its objects.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const incoming = new Map(); // oid -> {type, data}
  if (packBuf && packBuf.length > 0) {
    try {
      if (!verifyPackChecksum(packBuf)) throw new Error('pack checksum mismatch');
      const parsedPack = readPack(packBuf);
      for (const e of parsedPack.entries) {
        if (!e.data) throw new Error('pack contains unresolved delta');
        incoming.set(e.oid, { type: e.type, data: e.data });
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = String(e.message || 'unpack failed').slice(0, 120);
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of incoming.entries()) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  // Validate each ref update in command order; apply only the ok ones.
  const results = [];
  const lookup = (oid) => {
    const o = repo.objects.get(oid) || incoming.get(oid);
    if (!o) throw new Error(`missing-object ${oid}`);
    return o;
  };
  for (const cmd of parsed) {
    const { oldOid, newOid, ref } = cmd;
    const current = repo.refs.get(ref) || null;
    let ok = true;
    let reason = '';
    if (!unpackOk) {
      ok = false;
      reason = 'unpack failed';
    } else if (oldOid !== (current || ZERO_OID)) {
      ok = false;
      reason = 'old value mismatch';
    } else if (newOid === ZERO_OID) {
      // delete
      if (!current) { ok = false; reason = 'ref does not exist'; }
    } else if (oldOid === ZERO_OID) {
      // create
      if (current) { ok = false; reason = 'ref already exists'; }
      else if (!isObjectId(newOid) || !repo.objects.has(newOid)) { ok = false; reason = 'new object missing'; }
    } else {
      // update: fast-forward required
      const newCommit = peelToCommit(store, repo, newOid);
      if (!newCommit) { ok = false; reason = 'new object missing'; }
      else if (!isAncestorFastForward(store, repo, oldOid, newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    if (ok) {
      if (newOid === ZERO_OID) repo.refs.delete(ref);
      else repo.refs.set(ref, newOid);
      results.push({ ref, ok: true });
    } else {
      results.push({ ref, ok: false, reason });
    }
  }

  // Build the report: pkt-lines inside sideband band 1 when advertised.
  const lines = [];
  lines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const report = Buffer.from(lines.join(''), 'utf8');
  let bodyOut;
  if (sideband) {
    const chunks = [];
    const CHUNK = PKT_LINE_MAX_PAYLOAD - 1;
    for (let off = 0; off < report.length; off += CHUNK) {
      chunks.push(sidebandPacket(1, report.subarray(off, Math.min(report.length, off + CHUNK))));
    }
    chunks.push(pktFlush());
    bodyOut = Buffer.concat(chunks);
  } else {
    const chunks = lines.map((l) => encodePktLine(l));
    chunks.push(pktFlush());
    bodyOut = Buffer.concat(chunks);
  }
  return { status: 200, body: bodyOut, contentType: 'application/x-git-receive-pack-result' };
}

// Fast-forward: old (peeled to commit) must be an ancestor of new (peeled).
function isAncestorFastForward(store, repo, oldOid, newOid) {
  const oldCommit = peelToCommit(store, repo, oldOid);
  const newCommit = peelToCommit(store, repo, newOid);
  if (!oldCommit || !newCommit) return false;
  if (oldCommit === newCommit) return true;
  const set = ancestors(store, repo, newCommit);
  return set.has(oldCommit);
}
