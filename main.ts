// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

type Body = { kind: string; text: string; no?: boolean; blankRaw?: boolean };
type Chunk = { body: Body[]; anchor?: string; eof?: boolean; a?: number };
function model(text: string) {
  const n = text.indexOf('\n');
  const br = n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function render(lines: string[], br: string, final: boolean): string {
  return lines.length ? lines.join(br) + (final ? br : '') : '';
}
function occurrences(lines: string[], old: string[], strict: boolean, start = 0, eof = false): { tier: number; positions: number[] } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const norm = (s: string) => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/g, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
    const o = old.map(norm), f = lines.map(norm), positions: number[] = [];
    for (let i = start; i + o.length <= f.length; i++) {
      if (eof && i + o.length !== f.length) continue;
      if (o.every((v, j) => v === f[i + j])) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  return { tier: 0, positions: [] };
}
function replaceChunk(lines: string[], body: Body[], at: number, tier: number): number {
  const old = body.filter(x => x.kind !== '+').map(x => x.text);
  const F = (lines[at] ?? '').match(/^[ \t]*/ )![0], P = (old[0] ?? '').match(/^[ \t]*/ )![0];
  let oi = 0;
  const out: string[] = [];
  for (const x of body) {
    if (x.kind === '-') { oi++; continue; }
    if (x.kind === ' ') { out.push(lines[at + oi]!); oi++; continue; }
    let t = x.text;
    if (tier === 2 && /[^ \t]/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  lines.splice(at, old.length, ...out);
  return out.length;
}
function checkPaths(...paths: string[]) { for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p); }
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = []; let previous = '', boundary = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const start = i; let p = '';
    for (let j = i - 1; j >= boundary; j--) if (!blank(lines[j]!) && !lines[j]!.trim().startsWith('```')) { p = lines[j]!.trim(); break; }
    p ||= previous;
    if (!p) throw new Exit2(`error: parse ${start + 1}`);
    let sep = i + 1; while (sep < lines.length && lines[sep]!.trimEnd() !== '=======') sep++;
    let end = sep + 1; while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end++;
    if (sep >= lines.length || end >= lines.length) throw new Exit2(`error: parse ${start + 1}`);
    const old = lines.slice(i + 1, sep), added = lines.slice(sep + 1, end), path = p;
    edits.push(tree => {
      checkPaths(path); const text = tree.get(path);
      if (!old.length) { if (text !== null) throw new Fail('exists', path); tree.now.set(path, render(added, '\n', true)); return; }
      if (text === null) throw new Fail('missing', path);
      const m = model(text), found = occurrences(m.lines, old, strict);
      if (!found.positions.length) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      replaceChunk(m.lines, [...old.map(text => ({kind:'-', text})), ...added.map(text => ({kind:'+', text}))], found.positions[0]!, found.tier);
      tree.now.set(path, render(m.lines, m.br, m.final));
    });
    previous = p; boundary = end + 1; i = end;
  }
  return edits;
}
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex(l => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1; while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]?.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = []; const section = (s: string) => /^\*\*\* (Add|Delete|Update) File: /.test(s);
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const header = lines[i]!, match = header.match(/^\*\*\* (Add|Delete|Update) File: (.*)$/);
    if (!match) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1, kind = match[1]!, path = match[2]!.trim(); let end = i + 1;
    while (end < last && !section(lines[end]!)) end++;
    let stop = end; while (stop > i + 1 && blank(lines[stop - 1]!)) stop--;
    let j = i + 1; let move: string | undefined; const chunks: Chunk[] = []; const add: string[] = [];
    if (kind === 'Update' && j < stop && lines[j]!.startsWith('*** Move to: ')) { move = lines[j]!.slice(13).trim(); j++; }
    if (kind === 'Add') {
      for (; j < stop; j++) { const l = lines[j]!; if (l === '') add.push(''); else if (l.startsWith('+')) add.push(l.slice(1)); else throw new Exit2(`error: parse ${j + 1}`); }
    } else if (kind === 'Delete') {
      if (j < stop) throw new Exit2(`error: parse ${j + 1}`);
    } else {
      let current: Chunk | undefined;
      for (; j < stop; j++) {
        const l = lines[j]!;
        if (l.startsWith('@@')) { current = {body: [], anchor: l.slice(2).trim()}; chunks.push(current); }
        else if (l === '*** End of File' && current) { current.eof = true; current = undefined; }
        else if (l === '' || ' +-'.includes(l[0]!)) {
          if (!current) { if (chunks.length) throw new Exit2(`error: parse ${j + 1}`); current = {body: []}; chunks.push(current); }
          current.body.push({kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1)});
        } else throw new Exit2(`error: parse ${j + 1}`);
      }
      if (!chunks.length && move === undefined) throw new Exit2(`error: parse ${headerLine}`);
    }
    edits.push(tree => {
      checkPaths(...(move === undefined ? [path] : [path, move])); const text = tree.get(path);
      if (kind === 'Add') { if (text !== null) throw new Fail('exists', path); tree.now.set(path, render(add, '\n', true)); return; }
      if (text === null) throw new Fail('missing', path);
      if (kind === 'Delete') { tree.now.set(path, null); return; }
      if (move !== undefined && tree.get(move) !== null) throw new Fail('exists', move);
      const m = model(text); let cursor = 0;
      for (const c of chunks) {
        if (c.anchor) { const f = occurrences(m.lines, [c.anchor], strict, cursor); if (!f.positions.length) throw new Fail('no-match', path); cursor = f.positions[0]! + 1; }
        const old = c.body.filter(x => x.kind !== '+').map(x => x.text); let at: number, tier = 0;
        if (!old.length) at = c.eof ? m.lines.length : cursor;
        else { const f = occurrences(m.lines, old, strict, cursor, c.eof); if (!f.positions.length) throw new Fail('no-match', path); at = f.positions[0]!; tier = f.tier; }
        cursor = at + replaceChunk(m.lines, c.body, at, tier);
      }
      const dest = move ?? path; tree.now.set(dest, render(m.lines, m.br, m.final));
      if (move !== undefined) { tree.now.set(path, null); tree.moves.push([path, move]); }
    });
    i = end;
  }
  return edits;
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type Section = { old?: string | null; dest?: string | null; gitOld?: string; gitNew?: string; renameOld?: string; renameNew?: string; create?: boolean; delete?: boolean; hunks: Chunk[]; pair?: boolean };
  const sections: Section[] = []; let s: Section | undefined; let i = 0;
  const pair = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  const path = (l: string) => { const p = l.slice(4).split('\t')[0]!.trim(); return p === '/dev/null' ? null : p.replace(/^[ab]\//, ''); };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const prefix = 'diff --git a/';
      const rest = l.startsWith(prefix) ? l.slice(prefix.length) : '';
      const separator = rest.lastIndexOf(' b/');
      if (separator <= 0 || separator + 3 === rest.length) throw new Exit2(`error: parse ${i + 1}`);
      s = {gitOld:rest.slice(0, separator), gitNew:rest.slice(separator + 3), hunks:[]}; sections.push(s); i++; continue;
    }
    if (pair(i) && (!s || s.pair || s.hunks.length)) { s = {hunks:[]}; sections.push(s); }
    if (pair(i) && s && !s.hunks.length) { s.old = path(l); s.dest = path(lines[i + 1]!); s.pair = true; i += 2; continue; }
    if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/);
      if (!m || !s) throw new Exit2(`error: parse ${i + 1}`);
      const c: Chunk = {a:Number(m[1]), body:[]}; s.hunks.push(c); i++;
      while (i < lines.length) {
        const b = lines[i]!; if (b.startsWith('diff --git ') || pair(i) || !(b === '' || ' +-\\'.includes(b[0]!))) break;
        if (b.startsWith('\\')) { if (c.body.length) c.body[c.body.length - 1]!.no = true; }
        else c.body.push({kind:b === '' ? ' ' : b[0]!, text:b === '' ? '' : b.slice(1), blankRaw: b === ''});
        i++;
      }
      while (c.body.length && c.body[c.body.length - 1]!.blankRaw && !c.body[c.body.length - 1]!.no) c.body.pop();
      continue;
    }
    if (s && !s.hunks.length) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) s.renameOld = l.slice(12);
      else if (l.startsWith('rename to ')) s.renameNew = l.slice(10);
      else if (l.startsWith('new file mode')) s.create = true;
      else if (l.startsWith('deleted file mode')) s.delete = true;
    }
    i++;
  }
  return sections.map(sec => {
    const old = sec.pair ? sec.old : sec.renameOld ?? sec.gitOld, dest = sec.pair ? sec.dest : sec.renameNew ?? sec.gitNew;
    const create = sec.create || old === null, del = sec.delete || dest === null;
    const op = old ?? sec.gitOld ?? '', np = dest ?? sec.gitNew ?? '';
    return tree => {
      checkPaths(...[old, dest].filter((p): p is string => p !== null && p !== undefined));
      if (old === undefined && !create) checkPaths(op);
      if (dest === undefined && !del) checkPaths(np);
      if (create) {
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const added = sec.hunks.flatMap(h => h.body.filter(x => x.kind === '+')); const last = added[added.length - 1];
        tree.now.set(np, render(added.map(x => x.text), '\n', !last?.no)); return;
      }
      const text = tree.get(op); if (text === null) throw new Fail('missing', op);
      if (del) { tree.now.set(op, null); return; }
      if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
      const m = model(text); let delta = 0;
      for (const h of sec.hunks) {
        const oldLines = h.body.filter(x => x.kind !== '+').map(x => x.text); let at: number, tier = 0;
        if (!oldLines.length) at = Math.max(0, Math.min(m.lines.length, h.a! + delta));
        else { const f = occurrences(m.lines, oldLines, strict); if (!f.positions.length) throw new Fail('no-match', op); tier = f.tier; const target = h.a! - 1 + delta; at = f.positions.reduce((a,b) => Math.abs(b-target) < Math.abs(a-target) ? b : a); }
        const ends = at + oldLines.length === m.lines.length;
        const written = replaceChunk(m.lines, h.body, at, tier); delta += written - oldLines.length;
        if (ends) { const last = h.body.filter(x => x.kind !== '-').at(-1); m.final = !last?.no; }
      }
      tree.now.set(np, render(m.lines, m.br, m.final));
      if (op !== np) { tree.now.set(op, null); tree.moves.push([op, np]); }
    };
  });
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renamed = new Map<string, string>(); const suppressed = new Set<string>();
  for (const [old, dest] of tree.moves) {
    if (!suppressed.has(old) && !suppressed.has(dest) && tree.original(old) !== null && tree.get(old) === null && tree.original(dest) === null && tree.get(dest) !== null) {
      renamed.set(dest, old); suppressed.add(old); suppressed.add(dest);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renamed.has(p)) rows.push(`R ${renamed.get(p)} -> ${p}`);
    else if (!suppressed.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
