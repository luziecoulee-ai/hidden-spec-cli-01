import { readFileSync, writeFileSync, mkdirSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

type Body = { kind: string; text: string; marked?: boolean };
type Chunk = { body: Body[]; anchor?: string; eof?: boolean; at?: number };
type Edit = { kind: string; path: string; dest?: string; chunks?: Chunk[]; lines?: string[]; data?: any };
type FileState = { lines: string[]; br: string; final: boolean };

class ParseFault {
  line: number;
  constructor(line: number) { this.line = line; }
}

function patchLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function readFileState(text: string): FileState {
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  if (!text) return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fileText(file: FileState): string {
  if (!file.lines.length) return '';
  return file.lines.join(file.br) + (file.final ? file.br : '');
}

function fresh(lines: string[], final = true): FileState {
  return { lines: [...lines], br: '\n', final };
}

function trailing(line: string): string { return line.replace(/[ \t]+$/, ''); }
function normalized(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trailing(line);
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
}

function occurrences(lines: string[], old: string[], strict: boolean, start = 0, eof = false): { positions: number[]; tier: number } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const positions: number[] = [];
    for (let i = start; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (old.every((line, j) => normalized(line, tier) === normalized(lines[i + j], tier))) positions.push(i);
    }
    if (positions.length) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}

function oldLines(body: Body[]): string[] {
  return body.filter(item => item.kind === ' ' || item.kind === '-').map(item => item.text);
}

function replacement(body: Body[], matched: string[], tier: number, old: string[]): string[] {
  const result: string[] = [];
  let index = 0;
  const fileIndent = (matched[0] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  const patchIndent = (old[0] ?? '').match(/^[ \t]*/)?.[0] ?? '';
  for (const item of body) {
    if (item.kind === ' ') {
      result.push(matched[index++]);
    } else if (item.kind === '-') {
      index++;
    } else if (item.kind === '+') {
      let line = item.text;
      if (tier === 2 && /\S/.test(line) && line.startsWith(patchIndent)) line = fileIndent + line.slice(patchIndent.length);
      result.push(line);
    }
  }
  return result;
}

function bodyLine(line: string): Body {
  if (!line) return { kind: ' ', text: '' };
  return { kind: line[0], text: line.slice(1) };
}

function detect(lines: string[]): string | undefined {
  const first = lines.find(line => line.trim());
  if (first?.trim() === '*** Begin Patch') return 'v4a';
  if (first && /^[\[{]/.test(first.trimStart())) return 'json';
  if (lines.some(line => trailing(line) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((line, i) => line.startsWith('diff --git ') || (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')))) return 'unified';
}

function parseSearch(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath = '';
  for (let i = 0; i < lines.length; i++) {
    if (trailing(lines[i]) !== '<<<<<<< SEARCH') continue;
    let path = '';
    for (let j = i - 1; j > previousEnd; j--) {
      const candidate = lines[j].trim();
      if (candidate && !candidate.startsWith('```')) { path = candidate; break; }
    }
    path ||= previousPath;
    if (!path) throw new ParseFault(i + 1);
    let middle = i + 1;
    while (middle < lines.length && trailing(lines[middle]) !== '=======') middle++;
    let end = middle + 1;
    while (end < lines.length && trailing(lines[end]) !== '>>>>>>> REPLACE') end++;
    if (middle >= lines.length || end >= lines.length) throw new ParseFault(i + 1);
    edits.push({ kind: 'search', path, lines: lines.slice(i + 1, middle), data: lines.slice(middle + 1, end) });
    previousPath = path;
    previousEnd = end;
    i = end;
  }
  return edits;
}

function headerPath(line: string): string | null {
  let path = line.slice(4).split('\t')[0].trim();
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  return path;
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let section: any = null;
  let header = false;
  function finish() {
    if (!section) return;
    const old = section.pair ? section.pairOld : (section.renameOld ?? section.old);
    const next = section.pair ? section.pairNew : (section.renameNew ?? section.next);
    const kind = section.create || old === null ? 'create-unified' : section.delete || next === null ? 'delete' : old !== next ? 'move-unified' : 'change-unified';
    edits.push({ kind, path: (kind === 'create-unified' ? next : old) ?? '', dest: kind === 'move-unified' ? next : undefined, chunks: section.chunks });
  }
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const pair = line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
    if (line.startsWith('diff --git ')) {
      finish();
      if (!line.startsWith('diff --git a/')) throw new ParseFault(i + 1);
      const rest = line.slice('diff --git a/'.length);
      const split = rest.lastIndexOf(' b/');
      if (split < 0) throw new ParseFault(i + 1);
      section = { old: rest.slice(0, split), next: rest.slice(split + 3), chunks: [] };
      header = true;
      i++;
      continue;
    }
    if (pair && (!section || !header)) {
      finish();
      section = { old: null, next: null, chunks: [], pair: true, pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]) };
      header = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match || !section) throw new ParseFault(i + 1);
      header = false;
      const chunk: Chunk = { at: Number(match[1]), body: [] };
      i++;
      while (i < lines.length) {
        const body = lines[i];
        if (body.startsWith('diff --git ') || (body.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) break;
        if (body && !' +-\\'.includes(body[0])) break;
        if (body.startsWith('\\')) {
          if (chunk.body.length) chunk.body[chunk.body.length - 1].marked = true;
        } else chunk.body.push(bodyLine(body));
        i++;
      }
      while (chunk.body.length && chunk.body[chunk.body.length - 1].text === '' && chunk.body[chunk.body.length - 1].kind === ' ' && !chunk.body[chunk.body.length - 1].marked) chunk.body.pop();
      section.chunks.push(chunk);
      continue;
    }
    if (section && header) {
      if (line.startsWith('--- ')) {
        if (!lines[i + 1]?.startsWith('+++ ')) throw new ParseFault(i + 2);
        section.pair = true;
        section.pairOld = headerPath(line);
        section.pairNew = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (line.startsWith('rename from ')) section.renameOld = line.slice(12).trim();
      if (line.startsWith('rename to ')) section.renameNew = line.slice(10).trim();
      if (line.startsWith('new file mode')) section.create = true;
      if (line.startsWith('deleted file mode')) section.delete = true;
    }
    i++;
  }
  finish();
  return edits;
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex(line => line.trim());
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first < 0 ? 1 : first + 1);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (lines[last]?.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  const sectionStart = (line: string) => /^\*\*\* (Add File|Delete File|Update File): /.test(line);
  let i = first + 1;
  while (i < last) {
    if (!lines[i].trim()) { i++; continue; }
    const match = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(lines[i]);
    if (!match) throw new ParseFault(i + 1);
    const start = i++;
    const path = match[2].trim();
    let end = i;
    while (end < last && !sectionStart(lines[end])) end++;
    let contentEnd = end;
    while (contentEnd > i && !lines[contentEnd - 1].trim()) contentEnd--;
    if (match[1] === 'Add File') {
      const content: string[] = [];
      for (; i < contentEnd; i++) {
        if (lines[i] && !lines[i].startsWith('+')) throw new ParseFault(i + 1);
        content.push(lines[i] ? lines[i].slice(1) : '');
      }
      edits.push({ kind: 'create', path, lines: content });
    } else if (match[1] === 'Delete File') {
      if (i < contentEnd) throw new ParseFault(i + 1);
      edits.push({ kind: 'delete', path });
    } else {
      let dest: string | undefined;
      if (i < contentEnd && lines[i].startsWith('*** Move to: ')) dest = lines[i++].slice(13).trim();
      const chunks: Chunk[] = [];
      while (i < contentEnd) {
        let anchor: string | undefined;
        if (lines[i].startsWith('@@')) anchor = lines[i++].slice(2).trim();
        else if (chunks.length) throw new ParseFault(i + 1);
        const chunk: Chunk = { body: [], anchor };
        while (i < contentEnd && !lines[i].startsWith('@@')) {
          const line = lines[i];
          if (line === '*** End of File') { chunk.eof = true; i++; break; }
          if (line && !' +-'.includes(line[0])) throw new ParseFault(i + 1);
          chunk.body.push(bodyLine(line));
          i++;
        }
        chunks.push(chunk);
      }
      if (!chunks.length && dest === undefined) throw new ParseFault(start + 1);
      edits.push({ kind: 'update', path, dest, chunks });
    }
    i = end;
  }
  return edits;
}

function validJsonEdit(value: any): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.path !== 'string') return false;
  if (value.command === 'create') return typeof value.file_text === 'string';
  if (value.command === 'str_replace') return typeof value.old_str === 'string' && value.old_str.length > 0 && (value.new_str === undefined || typeof value.new_str === 'string');
  if (value.command === 'insert') return Number.isInteger(value.insert_line) && typeof value.new_str === 'string';
  return false;
}

function parseJson(lines: string[]): Edit[] {
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return [];
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let values: any;
    try { values = JSON.parse(lines.join('\n')); } catch { throw new ParseFault(first + 1); }
    if (!Array.isArray(values) || !values.every(validJsonEdit)) throw new ParseFault(first + 1);
    for (const value of values) edits.push({ kind: 'json', path: value.path, data: value });
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let value: any;
      try { value = JSON.parse(lines[i]); } catch { throw new ParseFault(i + 1); }
      if (!validJsonEdit(value)) throw new ParseFault(i + 1);
      edits.push({ kind: 'json', path: value.path, data: value });
    }
  }
  return edits;
}

function safe(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function applyChunks(file: FileState, chunks: Chunk[], strict: boolean, unified: boolean): string | undefined {
  let delta = 0;
  let cursor = 0;
  for (const chunk of chunks) {
    const old = oldLines(chunk.body);
    if (!unified && chunk.anchor) {
      const found = occurrences(file.lines, [chunk.anchor], strict, cursor);
      if (!found.positions.length) return 'no-match';
      cursor = found.positions[0] + 1;
    }
    let position: number;
    let tier = 0;
    if (!old.length) {
      position = unified ? Math.max(0, Math.min(file.lines.length, (chunk.at ?? 0) + delta)) : chunk.eof ? file.lines.length : cursor;
    } else {
      const found = occurrences(file.lines, old, strict, unified ? 0 : cursor, !unified && !!chunk.eof);
      if (!found.positions.length) return 'no-match';
      tier = found.tier;
      if (unified) {
        const target = (chunk.at ?? 0) - 1 + delta;
        position = found.positions.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best);
      } else position = found.positions[0];
    }
    const reachesEnd = position + old.length === file.lines.length;
    const written = replacement(chunk.body, file.lines.slice(position, position + old.length), tier, old);
    file.lines.splice(position, old.length, ...written);
    if (unified && reachesEnd) {
      const last = chunk.body.filter(item => item.kind === ' ' || item.kind === '+').at(-1);
      file.final = !last?.marked;
    }
    delta += written.length - old.length;
    cursor = position + written.length;
  }
}

function run(args: string[]): { exit: number; lines: string[] } {
  let format = 'auto';
  let check = false;
  let strict = false;
  let ended = false;
  let path: string | undefined;
  const seen = new Set<string>();
  for (const arg of args) {
    if (!ended && arg === '--') { ended = true; continue; }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      let key = arg;
      if (arg.startsWith('--format=')) key = '--format';
      if (seen.has(key)) return { exit: 2, lines: ['error: usage'] };
      seen.add(key);
      if (key === '--format') {
        format = arg.slice(9);
        if (!['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(format)) return { exit: 2, lines: ['error: usage'] };
      } else if (key === '--check') check = true;
      else if (key === '--strict') strict = true;
      else return { exit: 2, lines: ['error: usage'] };
    } else {
      if (path !== undefined) return { exit: 2, lines: ['error: usage'] };
      path = arg;
    }
  }
  let text: string;
  try { text = readFileSync(path === undefined || path === '-' ? 0 : path, 'utf8'); }
  catch { return { exit: 2, lines: ['error: no-patch'] }; }
  const lines = patchLines(text);
  if (format === 'auto') {
    const detected = detect(lines);
    if (!detected) return { exit: 2, lines: ['error: format'] };
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearch(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines);
    if (!edits.length) throw new ParseFault(1);
  } catch (error) {
    if (error instanceof ParseFault) return { exit: 2, lines: [`error: parse ${error.line}`] };
    throw error;
  }
  const initial = new Map<string, string | null>();
  const current = new Map<string, string | null>();
  const moves: [string, string][] = [];
  function get(name: string): string | null {
    if (!current.has(name)) {
      let value: string | null;
      try { value = readFileSync(name, 'utf8'); } catch { value = null; }
      current.set(name, value);
      initial.set(name, value);
    }
    return current.get(name)!;
  }
  const errors: string[] = [];
  for (const edit of edits) {
    const paths = edit.dest === undefined ? [edit.path] : [edit.path, edit.dest];
    const unsafe = paths.find(name => !safe(name));
    if (unsafe !== undefined) { errors.push(`error: unsafe ${unsafe}`); continue; }
    const value = get(edit.path);
    const destination = edit.dest === undefined ? null : get(edit.dest);
    let failure: string | undefined;
    let failedPath = edit.path;
    let result: string | null = value;
    const creating = edit.kind === 'create' || edit.kind === 'create-unified' || (edit.kind === 'search' && !edit.lines!.length) || (edit.kind === 'json' && edit.data.command === 'create');
    if (creating && value !== null) failure = 'exists';
    else if (!creating && value === null) failure = 'missing';
    else if (edit.dest !== undefined && destination !== null) { failure = 'exists'; failedPath = edit.dest; }
    else if (edit.kind === 'delete') result = null;
    else if (edit.kind === 'create') result = fileText(fresh(edit.lines!));
    else if (edit.kind === 'create-unified') {
      const additions = edit.chunks!.flatMap(chunk => chunk.body.filter(item => item.kind === '+'));
      result = fileText(fresh(additions.map(item => item.text), !additions.at(-1)?.marked));
    } else if (edit.kind === 'search') {
      if (creating) result = fileText(fresh(edit.data));
      else {
        const file = readFileState(value!);
        const found = occurrences(file.lines, edit.lines!, strict);
        if (!found.positions.length) failure = 'no-match';
        else if (found.positions.length > 1) failure = 'ambiguous';
        else {
          const body: Body[] = edit.data.map((line: string) => ({ kind: '+', text: line }));
          const position = found.positions[0];
          const written = replacement(body, file.lines.slice(position, position + edit.lines!.length), found.tier, edit.lines!);
          file.lines.splice(position, edit.lines!.length, ...written);
          result = fileText(file);
        }
      }
    } else if (edit.kind === 'json') {
      const data = edit.data;
      if (data.command === 'create') result = data.file_text;
      else if (data.command === 'insert') {
        const file = readFileState(value!);
        if (data.insert_line < 0 || data.insert_line > file.lines.length) failure = 'no-match';
        else { file.lines.splice(data.insert_line, 0, ...patchLines(data.new_str)); result = fileText(file); }
      } else {
        const file = readFileState(value!);
        const normalize = (s: string) => file.br === '\r\n' ? s.replace(/\r\n/g, '\n') : s;
        const source = normalize(value!);
        const old = normalize(data.old_str);
        const next = normalize(data.new_str ?? '');
        const first = source.indexOf(old);
        if (first < 0) failure = 'no-match';
        else if (source.indexOf(old, first + 1) >= 0) failure = 'ambiguous';
        else {
          result = source.slice(0, first) + next + source.slice(first + old.length);
          if (file.br === '\r\n') result = result.replace(/\n/g, '\r\n');
        }
      }
    } else {
      const file = readFileState(value!);
      failure = applyChunks(file, edit.chunks ?? [], strict, edit.kind !== 'update');
      if (!failure) result = fileText(file);
    }
    if (failure) { errors.push(`error: ${failure} ${failedPath}`); continue; }
    if (edit.dest !== undefined) {
      current.set(edit.path, null);
      current.set(edit.dest, result);
      moves.push([edit.path, edit.dest]);
    } else current.set(edit.path, result);
  }
  if (errors.length) return { exit: 1, lines: [...errors, `failed: ${errors.length} of ${edits.length} edits`] };
  const changes = new Map<string, string>();
  for (const [name, value] of current) {
    const before = initial.get(name)!;
    if (before === value) continue;
    changes.set(name, before === null ? `A ${name}` : value === null ? `D ${name}` : `M ${name}`);
  }
  for (const [old, next] of moves) {
    if (changes.get(old) === `D ${old}` && changes.get(next) === `A ${next}`) {
      changes.delete(old);
      changes.set(next, `R ${old} -> ${next}`);
    }
  }
  if (!check) {
    for (const [name, value] of current) {
      if (initial.get(name) === value) continue;
      if (value === null) unlinkSync(name);
      else { mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, value); }
    }
  }
  const output = [...changes.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0]))).map(entry => entry[1]);
  output.push(`ok: ${output.length} ${output.length === 1 ? 'file' : 'files'}`);
  return { exit: 0, lines: output };
}

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  const result = run(process.argv.slice(2));
  for (const line of result.lines) writeSync(1, line + '\n');
  process.exitCode = result.exit;
}
