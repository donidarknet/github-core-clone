// gitutil.ts — low-level Git object model, pack codec, and pkt-line framing.
// Plain JavaScript syntax in a .ts file (runs under --experimental-strip-types).
// No store dependency: the store lives in store.ts, the wire protocol in gitproto.ts.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export function isObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function validateOid(v, label) {
  if (!isObjectId(v)) throw new Error(`invalid oid ${label || ''}: ${String(v)}`);
  return v;
}

/** SHA-1 object id of `<type> <size>\0<data>`. */
export function hashObject(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

export function objectStoreBytes(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body]);
}

// ---------------------------------------------------------------- trees
// Entry: { mode: string (octal, e.g. '100644' or '40000'), name: string, oid: string }
export function parseTree(buf) {
  const entries = [];
  let p = 0;
  while (p < buf.length) {
    const sp = buf.indexOf(0x20, p);
    if (sp < 0) throw new Error('bad tree: no space');
    const mode = buf.toString('ascii', p, sp);
    if (!/^[0-7]+$/.test(mode)) throw new Error('bad tree: non-octal mode');
    const nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0) throw new Error('bad tree: no NUL');
    const name = buf.toString('utf8', sp + 1, nul);
    if (nul + 21 > buf.length) throw new Error('bad tree: truncated oid');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    p = nul + 21;
  }
  return entries;
}

// Build tree bytes from entries, applying git tree order (dirs sort as name+'/').
export function buildTree(entries) {
  const sorted = entries.slice().sort((x, y) => {
    const kx = x.name + (x.mode === '40000' ? '/' : '');
    const ky = y.name + (y.mode === '40000' ? '/' : '');
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
  const parts = [];
  for (const e of sorted) {
    const hdr = Buffer.from(`${e.mode} ${e.name}\0`, 'utf8');
    const oid = Buffer.from(e.oid, 'hex');
    parts.push(hdr, oid);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits
export function parseCommit(buf) {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out = { tree: null, parents: [], author: null, committer: null, message, extraHeaders: [] };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
    else if (line.length > 0) out.extraHeaders.push(line);
  }
  return out;
}

// Build commit bytes. Message is used VERBATIM (no trailing-newline normalization):
// the suite asserts message equality for commits made through PUT /contents.
export function buildCommit(opts) {
  const lines = [];
  lines.push(`tree ${opts.tree}`);
  for (const p of opts.parents || []) lines.push(`parent ${p}`);
  const author = opts.author || 'Conformance <conformance@make.fun>';
  const committer = opts.committer || author;
  const ts = typeof opts.timestamp === 'number' ? opts.timestamp : 1735689600;
  lines.push(`author ${author} ${ts} +0000`);
  lines.push(`committer ${committer} ${ts} +0000`);
  if (opts.gpgsig) lines.push(`gpgsig ${opts.gpgsig}`);
  for (const h of opts.extraHeaders || []) lines.push(h);
  return Buffer.from(lines.join('\n') + '\n\n' + (opts.message || ''), 'utf8');
}

// ---------------------------------------------------------------- tags
export function parseTag(buf) {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out = { object: null, type: null, tag: null, tagger: null, message, extraHeaders: [] };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
    else if (line.length > 0) out.extraHeaders.push(line);
  }
  return out;
}

export function buildTag(opts) {
  const lines = [];
  lines.push(`object ${opts.object}`);
  lines.push(`type ${opts.type || 'commit'}`);
  lines.push(`tag ${opts.tag}`);
  const tagger = opts.tagger || 'Conformance <conformance@make.fun>';
  const ts = typeof opts.timestamp === 'number' ? opts.timestamp : 1735689600;
  lines.push(`tagger ${tagger} ${ts} +0000`);
  for (const h of opts.extraHeaders || []) lines.push(h);
  return Buffer.from(lines.join('\n') + '\n\n' + (opts.message || ''), 'utf8');
}

// ---------------------------------------------------------------- reachability
// Walk from roots over commits (tree + parents) and tags (target), collecting
// every reachable oid. lookup(oid) must return {type, data} or throw.
export function collectReachable(roots, lookup, allowMissing = false) {
  const seen = new Set();
  const queue = [];
  const missing = new Set();
  function visit(oid) {
    if (!oid || oid === ZERO_OID || seen.has(oid)) return;
    seen.add(oid);
    queue.push(oid);
  }
  for (const r of roots) visit(r);
  while (queue.length > 0) {
    const oid = queue.pop();
    let obj;
    try {
      obj = lookup(oid);
    } catch (e) {
      if (allowMissing) { missing.add(oid); continue; }
      throw e;
    }
    if (!obj) {
      if (allowMissing) { missing.add(oid); continue; }
      throw new Error(`missing-object ${oid}`);
    }
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) visit(c.tree);
      for (const p of c.parents) visit(p);
      for (const h of c.extraHeaders) {
        if (h.startsWith('mergetag ')) {
          // ignore embedded mergetag objects
        }
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') visit(e.oid); // skip gitlinks
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) visit(t.object);
    }
  }
  return { seen, missing };
}

// ---------------------------------------------------------------- pack codec
const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

// Serialize plain (non-delta) objects into a pack. Caller decides the order;
// fetch handlers pass oid-sorted objects for determinism.
export function writePack(objects) {
  const chunks = [];
  const hdr = Buffer.alloc(12);
  hdr.write('PACK', 0, 'ascii');
  hdr.writeUInt32BE(2, 4);
  hdr.writeUInt32BE(objects.length, 8);
  chunks.push(hdr);
  for (const obj of objects) {
    const data = obj.data;
    const typeCode = TYPE_CODE[obj.type];
    const bytes = [];
    // varint: low 4 bits in first byte, then 7 bits per byte, MSB continuation.
    let size = data.length;
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      bytes.push(b);
    }
    chunks.push(Buffer.from(bytes));
    chunks.push(deflateSync(data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readOfsOffset(buf, start) {
  // OFS_DELTA base offset: big-endian with low 7 bits of first byte + continuation.
  let b = buf[start];
  let offset = b & 0x7f;
  let p = start + 1;
  while (b & 0x80) {
    b = buf[p++];
    offset = ((offset + 1) << 7) | (b & 0x7f);
  }
  return { offset, next: p };
}

function applyDelta(base, delta) {
  // Delta header: source size varint, target size varint, then copy/insert ops.
  let p = 0;
  function readVarint() {
    let shift = 0;
    let v = 0;
    let b;
    do {
      b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  }
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = [];
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      // copy
      let off = 0, len = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) len = delta[p++];
      if (op & 0x20) len |= delta[p++] << 8;
      if (op & 0x40) len |= delta[p++] << 16;
      if (len === 0) len = 0x10000;
      out.push(base.subarray(off, off + len));
    } else if (op !== 0) {
      // insert
      out.push(delta.subarray(p, p + op));
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

// Parse a pack buffer. Returns {version, count, entries:[{type,oid,data}], deltaCount}
// plus trailer verification via verifyPackChecksum().
export function readPack(pack) {
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const entries = []; // {type, oid, data, dataStart}
  const byOid = new Map();
  const byOffset = new Map();
  let p = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i++) {
    const entryStart = p;
    const typeCode = (pack[p] >> 4) & 0x07;
    let size = pack[p] & 0x0f;
    let shift = 4;
    let cont = pack[p] & 0x80;
    p++;
    while (cont) {
      if (p >= pack.length) throw new Error('pack truncated in size varint');
      size |= (pack[p] & 0x7f) << shift;
      shift += 7;
      cont = pack[p] & 0x80;
      p++;
    }
    let baseOid = null;
    let baseOffset = -1;
    if (typeCode === 6) {
      const r = readOfsOffset(pack, p);
      baseOffset = entryStart - r.offset;
      p = r.next;
      deltaCount++;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(p, p + 20).toString('hex');
      p += 20;
      deltaCount++;
    }
    const { buffer: inflated, engine } = inflateSync(pack.subarray(p), { info: true });
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    // engine.bytesWritten = exact number of input bytes the deflate stream consumed.
    p += engine.bytesWritten;
    const typeName = CODE_TYPE[typeCode];
    if (!typeName) throw new Error(`unknown pack type ${typeCode}`);
    if (typeCode === 6 || typeCode === 7) {
      entries.push({ type: typeName, delta: inflated, baseOid, baseOffset, entryStart, oid: null, data: null });
    } else {
      const oid = hashObject(typeName, inflated);
      const rec = { type: typeName, oid, data: inflated, entryStart };
      entries.push(rec);
      byOid.set(oid, rec);
      byOffset.set(entryStart, rec);
    }
  }
  // Trailer must start exactly at p: 20 bytes.
  if (p + 20 !== pack.length) throw new Error('pack has stray bytes before trailer');
  // Resolve deltas (may reference entries later in the pack; iterate to fixpoint).
  let progress = true;
  const resolved = new Map(byOid);
  let guard = entries.length + 2;
  while (progress && guard-- > 0) {
    progress = false;
    for (const e of entries) {
      if (e.data) continue;
      const base = e.baseOid ? resolved.get(e.baseOid) : byOffset.get(e.baseOffset);
      if (!base || !base.data) continue;
      const data = applyDelta(base.data, e.delta);
      e.type = base.type;
      e.data = data;
      e.oid = hashObject(base.type, data);
      resolved.set(e.oid, e);
      progress = true;
    }
  }
  const unresolved = entries.filter((e) => !e.data);
  if (unresolved.length > 0) {
    // A delta whose base is not in this pack (thin pack): caller may resolve via
    // resolveBase. Keep the entry unresolved and let the caller retry.
    for (const e of unresolved) { e.unresolved = true; }
  }
  return { version, count, entries, deltaCount, trailer: pack.subarray(p), trailerStart: p };
}

export function verifyPackChecksum(pack) {
  if (pack.length < 32) return false;
  const expect = pack.subarray(pack.length - 20);
  const got = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  return expect.equals(got);
}

// ---------------------------------------------------------------- pkt-lines
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = 65516;

export function encodePktLine(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (body.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload too large: ${body.length}`);
  const len = body.length + 4;
  const hdr = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([hdr, body]);
}

export function pktFlush() { return Buffer.from('0000', 'ascii'); }
export function pktDelim() { return Buffer.from('0001', 'ascii'); }
export function pktResponseEnd() { return Buffer.from('0002', 'ascii'); }

// Decode all pkt-lines in a complete Buffer. Returns an array of packets:
// {kind:'data', payload:Buffer, raw:Buffer} | {kind:'flush'} | {kind:'delim'} |
// {kind:'response-end'} | {kind:'raw', payload:Buffer} (for non-pkt bytes, e.g. a pack).
// Throws on malformed framing.
export function decodePktLines(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    if (buf.length - p < 4) throw new Error('truncated pkt-line header');
    const hdr = buf.toString('ascii', p, p + 4);
    if (hdr === '0000') { out.push({ kind: 'flush', raw: buf.subarray(p, p + 4) }); p += 4; continue; }
    if (hdr === '0001') { out.push({ kind: 'delim', raw: buf.subarray(p, p + 4) }); p += 4; continue; }
    if (hdr === '0002') { out.push({ kind: 'response-end', raw: buf.subarray(p, p + 4) }); p += 4; continue; }
    if (hdr === '0003') throw new Error('invalid pkt-line length 0003');
    if (!/^[0-9a-fA-F]{4}$/.test(hdr)) {
      // Not a pkt-line header: the remaining bytes are a pack (receive-pack) or raw data.
      out.push({ kind: 'raw', payload: buf.subarray(p), raw: buf.subarray(p) });
      return out;
    }
    const len = parseInt(hdr, 16);
    if (len < 4) throw new Error(`invalid pkt-line length ${len}`);
    if (p + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(p + 4, p + len), raw: buf.subarray(p, p + len) });
    p += len;
  }
  return out;
}

// Split a receive-pack body into command pkt-lines (up to the first flush) and
// the pack bytes that follow. Returns {commands: string[], pack: Buffer|null}.
export function splitReceivePackBody(buf) {
  const packets = decodePktLines(buf);
  const commands = [];
  let pack = null;
  let seenFlush = false;
  for (const pkt of packets) {
    if (pkt.kind === 'flush') { seenFlush = true; continue; }
    if (!seenFlush) {
      if (pkt.kind !== 'data') throw new Error('unexpected non-data packet before flush in receive-pack');
      commands.push(pkt.payload.toString('utf8'));
    } else {
      if (pkt.kind === 'raw') pack = Buffer.from(pkt.payload);
      else if (pkt.kind === 'data') pack = Buffer.concat([pack || Buffer.alloc(0), pkt.payload]);
    }
  }
  return { commands, pack };
}
