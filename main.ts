// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md in full: the command line, output and exit codes, safe
// paths, format detection, three-tier line matching, unified diffs,
// SEARCH/REPLACE blocks, V4A patches, JSON edits, and all-or-nothing writes.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines plus its own line break and final-break flag (SPEC section 3). */
interface FileModel {
  br: string;
  lines: string[];
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { br, lines: parts, ends };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

// ---- Section 5: matching lines at three tiers ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const n = o.length;
  const res: number[] = [];
  if (n === 0) return res;
  const oNorm = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(fileLines[i + j]!, tier) !== oNorm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t++) {
    const positions = findOccurrences(fileLines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of N: a context line (the file's own matched line) or an added line. */
type NItem = { ctx: true; oi: number } | { ctx: false; text: string };

function resolveNItems(items: NItem[], fileLines: string[], at: number, o: string[], tier: number): string[] {
  const lead = (s: string): string => {
    const m = /^[ \t]*/.exec(s);
    return m ? m[0] : '';
  };
  const p = tier === 2 && o.length > 0 ? lead(o[0]!) : '';
  const f = tier === 2 ? lead(fileLines[at] ?? '') : '';
  return items.map((it) => {
    if (it.ctx) return fileLines[at + it.oi]!;
    if (tier === 2) {
      const t = it.text;
      if (t === '' || /^[ \t]+$/.test(t)) return t;
      if (t.startsWith(p)) return f + t.slice(p.length);
      return t;
    }
    return it.text;
  });
}

// ---- Section 9: JSON edits ----

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
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile({ br: f.br, lines, ends: f.ends }));
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

// ---- Section 6: unified diffs ----

interface BodyLine {
  t: ' ' | '-' | '+';
  text: string;
  empty: boolean; // true when the patch line itself was empty (a context line with empty text)
}

interface Hunk {
  a: number;
  body: BodyLine[];
  noNL: boolean; // a `\` line follows the hunk's last context or `+` line
  plusNoNL: boolean; // a `\` line follows the hunk's last `+` line
}

interface Section {
  oldP: string | null; // null: /dev/null (no file)
  newP: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function diffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseHunkBody(lines: string[], j0: number): { body: BodyLine[]; next: number; noNL: boolean; plusNoNL: boolean } {
  const body: BodyLine[] = [];
  const flagged = new Set<number>();
  let j = j0;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ t: ' ', text: '', empty: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ t: c, text: l.slice(1), empty: false });
      j++;
      continue;
    }
    if (c === '\\') {
      if (body.length > 0) flagged.add(body.length - 1);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, i) => {
    if (b.t === ' ' || b.t === '+') lastCtxPlus = i;
    if (b.t === '+') lastPlus = i;
  });
  return {
    body,
    next: j,
    noNL: lastCtxPlus >= 0 && flagged.has(lastCtxPlus),
    plusNoNL: lastPlus >= 0 && flagged.has(lastPlus),
  };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let havePair = false;
  const pushCur = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
    havePair = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      pushCur();
      cur = { oldP: m[1]!, newP: m[2]!, newFile: false, delFile: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || havePair) {
        pushCur();
        cur = { oldP: null, newP: null, newFile: false, delFile: false, hunks: [] };
        inHeader = true;
      }
      cur.oldP = diffPath(line.slice(4));
      cur.newP = diffPath(lines[i + 1]!.slice(4));
      havePair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: parseInt(m[1]!, 10), body: parsed.body, noNL: parsed.noNL, plusNoNL: parsed.plusNoNL });
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.oldP = line.slice(12).split('\t')[0]!.trim();
      else if (line.startsWith('rename to ')) cur.newP = line.slice(10).split('\t')[0]!.trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  pushCur();
  return sections;
}

/** Split a hunk body into its O lines and its N items. */
function hunkON(h: Hunk): { o: string[]; items: NItem[] } {
  const o: string[] = [];
  const items: NItem[] = [];
  for (const b of h.body) {
    if (b.t === ' ') {
      items.push({ ctx: true, oi: o.length });
      o.push(b.text);
    } else if (b.t === '-') {
      o.push(b.text);
    } else {
      items.push({ ctx: false, text: b.text });
    }
  }
  return { o, items };
}

function applyHunks(f: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let lines = [...f.lines];
  let ends = f.ends;
  let d = 0;
  for (const h of hunks) {
    const { o, items } = hunkON(h);
    if (o.length === 0) {
      const nLines = items.map((it) => (it.ctx ? '' : it.text));
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...nLines);
      if (atEnd) ends = !h.noNL;
      d += nLines.length;
    } else {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.positions) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          best = p;
          bd = dd;
        }
      }
      const at = best;
      const runsToEnd = at + o.length === lines.length;
      const nLines = resolveNItems(items, lines, at, o, found.tier);
      lines.splice(at, o.length, ...nLines);
      if (runsToEnd) ends = !h.noNL;
      d += nLines.length - o.length;
    }
  }
  return { br: f.br, lines, ends };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree): void => {
      const oldP = sec.oldP;
      const newP = sec.newP;
      const isCreate = oldP === null || sec.newFile;
      const isDelete = !isCreate && (newP === null || sec.delFile);
      if (isCreate) {
        const p = newP === null ? '/dev/null' : newP;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plusLines: string[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.t === '+') plusLines.push(b.text);
        let ends = false;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          if (sec.hunks[k]!.body.some((b) => b.t === '+')) {
            ends = !sec.hunks[k]!.plusNoNL;
            break;
          }
        }
        tree.now.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (ends ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const p = oldP!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const p = oldP!;
      const isMove = oldP !== newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const res = applyHunks(parseFile(cur), sec.hunks, strict, p);
      const text = serializeFile(res);
      if (isMove) {
        tree.now.set(p, null);
        tree.now.set(newP!, text);
        tree.moves.push([p, newP!]);
      } else {
        tree.now.set(p, text);
      }
    };
  });
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const searchIdx: number[] = [];
  lines.forEach((l, i) => {
    if (l.trimEnd() === '<<<<<<< SEARCH') searchIdx.push(i);
  });
  if (searchIdx.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (const s of searchIdx) {
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const t = lines[k]!;
      if (t.trim() === '') continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((pp, oo, nn) => {
      return (tree: Tree): void => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (oo.length === 0) {
          if (tree.get(pp) !== null) throw new Fail('exists', pp);
          tree.now.set(pp, nn.length === 0 ? '' : nn.join('\n') + '\n');
          return;
        }
        const cur = tree.get(pp);
        if (cur === null) throw new Fail('missing', pp);
        const f = parseFile(cur);
        const found = findTier(f.lines, oo, strict);
        if (found === null) throw new Fail('no-match', pp);
        if (found.positions.length > 1) throw new Fail('ambiguous', pp);
        const at = found.positions[0]!;
        const items: NItem[] = nn.map((t) => ({ ctx: false, text: t }));
        const nLines = resolveNItems(items, f.lines, at, oo, found.tier);
        const nl = [...f.lines];
        nl.splice(at, oo.length, ...nLines);
        tree.now.set(pp, serializeFile({ br: f.br, lines: nl, ends: f.ends }));
      };
    })(path, oldLines, newLines));
    prevEnd = rep;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  body: Array<{ t: ' ' | '-' | '+'; text: string }>;
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; fileLines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headLine = i + 1;
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    // Blank lines at the end of a section are not part of it.
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end--;
    const raw = lines.slice(i + 1, end);
    if (kind === 'add') {
      const fileLines: string[] = [];
      raw.forEach((l, k) => {
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      });
      sections.push({ kind: 'add', path, fileLines });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${i + 2}`);
      sections.push({ kind: 'delete', path });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice(13).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      const pushChunk = (): void => {
        if (curChunk !== null) chunks.push(curChunk);
        curChunk = null;
      };
      for (; k < raw.length; k++) {
        const l = raw[k]!;
        if (l.startsWith('@@')) {
          pushChunk();
          curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), body: [], eof: false };
        } else if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          curChunk.eof = true;
          pushChunk();
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) curChunk = { anchor: null, body: [], eof: false };
          curChunk.body.push({ t: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
      }
      pushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    return (tree: Tree): void => {
      if (sec.kind === 'add') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
        return;
      }
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      const cur = tree.get(sec.path);
      if (cur === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null) {
        if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
        if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      }
      const f = parseFile(cur);
      let lines = [...f.lines];
      let cursor = 0;
      for (const ch of sec.chunks) {
        let atCursor = cursor;
        if (ch.anchor !== null) {
          let foundIdx = -1;
          const maxTier = strict ? 0 : 2;
          for (let t = 0; t <= maxTier && foundIdx < 0; t++) {
            for (let k = atCursor; k < lines.length; k++) {
              if (normLine(lines[k]!, t) === normLine(ch.anchor!, t)) {
                foundIdx = k;
                break;
              }
            }
          }
          if (foundIdx < 0) throw new Fail('no-match', sec.path);
          atCursor = foundIdx + 1;
        }
        const o: string[] = [];
        const items: NItem[] = [];
        for (const b of ch.body) {
          if (b.t === ' ') {
            items.push({ ctx: true, oi: o.length });
            o.push(b.text);
          } else if (b.t === '-') {
            o.push(b.text);
          } else {
            items.push({ ctx: false, text: b.text });
          }
        }
        if (o.length === 0) {
          const nLines = items.map((it) => (it.ctx ? '' : it.text));
          const pos = ch.eof ? lines.length : atCursor;
          lines.splice(pos, 0, ...nLines);
          cursor = pos + nLines.length;
        } else {
          let found: { tier: number; pos: number } | null = null;
          const maxTier = strict ? 0 : 2;
          for (let t = 0; t <= maxTier && found === null; t++) {
            const positions = findOccurrences(lines, o, t, atCursor);
            for (const p of positions) {
              if (ch.eof && p + o.length !== lines.length) continue;
              found = { tier: t, pos: p };
              break;
            }
          }
          if (found === null) throw new Fail('no-match', sec.path);
          const nLines = resolveNItems(items, lines, found.pos, o, found.tier);
          lines.splice(found.pos, o.length, ...nLines);
          cursor = found.pos + nLines.length;
        }
      }
      const text = serializeFile({ br: f.br, lines, ends: f.ends });
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, text);
        tree.moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

// ---- Sections 1, 2 and 10: invocation, output, order and atomicity ----

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: Array<{ key: string; line: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) && was !== null && now === null) continue;
    if (rNew.has(p) && was === null && now !== null) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
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
