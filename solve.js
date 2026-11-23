// A faster drop-in replacement for makefun-site 1.0.0's build: run(input) returns the same
// output object (same paths, same bytes, same key order) as the reference, with far less
// allocation and less per-character work. Dependency-free, Node 22 stdlib only.

// ---------------------------------------------------------------- text rules

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESC_MAP[c]);
}

/** The slug of `text` (NFKD, marks dropped, runs of other chars one "-", 64 max). */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const slugCache = new Map();

/** slugify, memoized (it is a pure function of its string). */
function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    slugCache.set(text, v);
  }
  return v;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

/** A YYYY-MM-DD date in words, memoized. */
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

/** Every character ECMAScript counts as whitespace (the complement of \S). */
function isWsCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8206) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

/** A body's words: its runs of characters other than whitespace, counted without allocating. */
function wordsOf(text) {
  let n = 0;
  let inRun = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inRun = false;
    else if (!inRun) {
      inRun = true;
      n++;
    }
  }
  return n;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
const TAG_ERR = 'key "tags": an empty tag, or one holding " [ or ]';

function isDigitCode(c) {
  return c >= 48 && c <= 57;
}

function isTemplateName(raw) {
  if (raw === '') return false;
  for (let j = 0; j < raw.length; j++) {
    const c = raw.charCodeAt(j);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) for (let j = 0; j < 10; j++) if (j !== 4 && j !== 7 && !isDigitCode(raw.charCodeAt(j))) { ok = false; break; }
      if (!ok) return { error: DATE_ERR };
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: TAG_ERR };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: TAG_ERR };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isTemplateName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug': {
      // /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and at most 64 characters.
      let ok = raw.length > 0 && raw.length <= 64;
      let wantAlnum = true;
      for (let j = 0; ok && j < raw.length; j++) {
        const c = raw.charCodeAt(j);
        if (c === 45) {
          if (wantAlnum) ok = false;
          wantAlnum = true;
        } else if (isDigitCode(c) || (c >= 97 && c <= 122)) wantAlnum = false;
        else ok = false;
      }
      if (wantAlnum) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Only spaces and tabs. */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. The body comes back as a slice: no split of the whole
 * text and no join of the body's lines.
 */
function parseFrontMatter(text) {
  const nl1 = text.indexOf('\n');
  const first = nl1 === -1 ? text : text.slice(0, nl1);
  if (first !== '---') return { error: 'no front matter' };
  if (nl1 === -1) return { error: 'the front matter is not closed' };
  let close = -1;
  let bodyStart = -1;
  {
    let p = nl1 + 1;
    let i = 1;
    for (;;) {
      const n2 = text.indexOf('\n', p);
      const line = n2 === -1 ? text.slice(p) : text.slice(p, n2);
      if (line === '---') {
        close = i;
        bodyStart = n2 === -1 ? text.length : n2 + 1;
        break;
      }
      if (n2 === -1) break;
      i++;
      p = n2 + 1;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  {
    let q = nl1 + 1;
    for (let k = 1; k < close; k++) {
      const n3 = text.indexOf('\n', q);
      const line = text.slice(q, n3 === -1 ? undefined : n3);
      q = n3 + 1;
      if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
      let e = 0;
      const L = line.length;
      while (e < L) {
        const c = line.charCodeAt(e);
        if ((c >= 97 && c <= 122) || c === 95) e++;
        else break;
      }
      let raw;
      if (e === 0 || line.charCodeAt(e) !== 58) raw = null;
      else if (e === L - 1) raw = '';
      else if (line.charCodeAt(e + 1) === 32) raw = line.slice(e + 2);
      else raw = null;
      if (raw === null) return { error: `line ${k + 1} is not "key: value"` };
      let end = raw.length;
      while (end > 0) {
        const c = raw.charCodeAt(end - 1);
        if (c === 32 || c === 9) end--;
        else break;
      }
      if (end !== raw.length) raw = raw.slice(0, end);
      const key = line.slice(0, e);
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  const len = line.length;
  while (a < len) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  let e = len;
  while (e > a) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return a === 0 && e === len ? line : line.slice(a, e);
}

function isBlank(line) {
  return line.length === 0 || isBlankLine(line);
}

/** A fence's language, or null when the line opens no fence. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  const len = line.length;
  let j = 3;
  while (j < len) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const langEnd = j;
  while (j < len) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return line.slice(3, langEnd);
}

function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let t = h;
  const len = line.length;
  while (t < len) {
    const cc = line.charCodeAt(t);
    if (cc === 32 || cc === 9) t++;
    else break;
  }
  let e = len;
  while (e > t) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e === t) return null;
  return { depth: h, text: line.slice(t, e) };
}

function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (!((c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) || (c0 === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isQuote(line) {
  return line.charCodeAt(0) === 62;
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let n = 0;
  const len = line.length;
  while (n < len && isDigitCode(line.charCodeAt(n))) n++;
  if (n < 1 || n > 9) return null;
  if (line.charCodeAt(n) !== 46 || line.charCodeAt(n + 1) !== 32) return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** A line of two or more spaces then a non-space continues a list item. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  if (line.length === 2) return false;
  return !isWsCode(line.charCodeAt(2));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** `src`'s block tokens, in order. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHR(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (isQuote(line)) {
      const body = [];
      while (i < n && isQuote(lines[i])) {
        const l = lines[i++];
        const stripped = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (stripped !== '') body.push(stripped);
      }
      tokens.push({ type: 'blockquote', lines: body });
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
            continue;
          }
        } else {
          const b = bulletOf(l);
          if (b !== null) {
            items.push([trimLine(b)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const texts = items.map((parts) => parts.join('\n'));
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? ordered.start : 1, items: texts });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
function isEscapableCode(c) {
  switch (c) {
    case 92: // backslash
    case 96: // backtick
    case 42: // *
    case 95: // _
    case 91: // [
    case 93: // ]
    case 40: // (
    case 41: // )
    case 35: // #
    case 43: // +
    case 45: // -
    case 46: // .
    case 33: // !
    case 62: // >
      return true;
    default:
      return false;
  }
}

/** The first `**` from `from` outside a backslash escape, or -1. */
function findUnescapedStars(s, from) {
  const lim = s.length - 2;
  for (let j = from; j <= lim; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
        j++;
        continue;
      }
    } else if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first `]` from `from` outside a backslash escape, or -1. */
function findUnescapedBracket(s, from) {
  const lim = s.length - 1;
  for (let j = from; j <= lim; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < s.length && isEscapableCode(s.charCodeAt(j + 1))) {
        j++;
        continue;
      }
    } else if (c === 93) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < len && isEscapableCode(s.charCodeAt(j + 1))) j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Whether a link target holds whitespace (it must not). */
function hasWs(target) {
  for (let j = 0; j < target.length; j++) if (isWsCode(target.charCodeAt(j))) return true;
  return false;
}

const SPECIAL_RE = /[\\`*[]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped in chunks. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const len = s.length;
  for (;;) {
    SPECIAL_RE.lastIndex = i;
    const hit = SPECIAL_RE.exec(s);
    if (hit === null) {
      out += escapeHtml(s.slice(i));
      return out;
    }
    const j = hit.index;
    if (j > i) {
      out += escapeHtml(s.slice(i, j));
      i = j;
    }
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < len && isEscapableCode(s.charCodeAt(i + 1))) {
        const n = s[i + 1];
        out += n === '>' ? '&gt;' : n;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const j2 = s.indexOf('`', i + 1);
      if (j2 > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j2))}</code>`;
        i = j2 + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j2 = findUnescapedStars(s, i + 2);
        if (j2 > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j2), env)}</strong>`;
          i = j2 + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j2 = findSingleStar(s, i + 1);
        if (j2 > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j2), env)}</em>`;
          i = j2 + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    // '['
    const k = findUnescapedBracket(s, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWs(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = m + 1;
    } else {
      out += '[';
      i++;
    }
  }
}

/** `src` rendered: its HTML (a "\n" after each block), its toc (levels 2 and 3) and its excerpt. */
function renderMarkdown(src, env) {
  const ids = new Set();
  let out = '';
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        out += `<h${t.depth} id="${id}">${html}</h${t.depth}>\n`;
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const lang = t.lang;
        out += `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
        for (const l of t.lines) out += `${escapeHtml(l)}\n`;
        out += '</code></pre>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += t.lines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>\n`;
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        out += `${t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`}\n`;
        for (const item of t.items) out += `<li>${inline(item, env)}</li>\n`;
        out += `</${tag}>\n`;
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        out += `<p>${html}</p>\n`;
        break;
      }
    }
  }
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number's digits, true or false, an array joined ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A node list compiled to render functions, or null when it is empty. */
function compileList(nodes) {
  const n = nodes.length;
  if (n === 0) return null;
  const fns = new Array(n);
  for (let i = 0; i < n; i++) fns[i] = compileNode(nodes[i]);
  return fns;
}

/** All compiled fns of a list run in order, their outputs joined. */
function runList(fns, scope, ctx, depth) {
  if (fns === null) return '';
  let out = '';
  for (let i = 0; i < fns.length; i++) out += fns[i](scope, ctx, depth);
  return out;
}

/** One node compiled to a function of (scope, ctx, depth) returning its text. */
function compileNode(n) {
  switch (n.kind) {
    case 'text': {
      const t = n.text;
      return () => t;
    }
    case 'var': {
      const p = n.path;
      return (scope) => escapeHtml(textOf(lookup(scope, p)));
    }
    case 'raw': {
      const p = n.path;
      return (scope) => textOf(lookup(scope, p));
    }
    case 'if': {
      const p = n.path;
      const not = n.not;
      const thenF = compileList(n.then);
      const elseF = n.else === null ? null : compileList(n.else);
      return (scope, ctx, depth) => {
        const b = truthy(lookup(scope, p)) !== not ? thenF : elseF;
        return b === null ? '' : runList(b, scope, ctx, depth);
      };
    }
    case 'for': {
      const name = n.name;
      const p = n.path;
      const bodyF = compileList(n.body);
      return (scope, ctx, depth) => {
        const xs = lookup(scope, p);
        if (!Array.isArray(xs)) return '';
        const L = xs.length;
        let out = '';
        // The scope is reused across iterations: a body is rendered before the next begins.
        const vars = {};
        const loop = {};
        const child = { vars, parent: scope };
        for (let k = 0; k < L; k++) {
          vars[name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === L - 1;
          loop.length = L;
          out += runList(bodyF, child, ctx, depth);
        }
        return out;
      };
    }
    case 'include': {
      const nm = n.name;
      return (scope, ctx, depth) => {
        const t = ctx.templates.get(nm);
        return t !== undefined && depth < INCLUDE_DEPTH ? runList(t, scope, ctx, depth + 1) : '';
      };
    }
  }
}

/** A template compiled: its nodes as functions, or its TemplateError message. */
function compileTemplate(name, src) {
  try {
    return { ok: true, fns: compileList(parseTemplate(name, src)) };
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    return { ok: false, msg: err.message };
  }
}

const templateCache = new Map();

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether a link target opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let j = 1; j < t.length; j++) {
    const c = t.charCodeAt(j);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (built directly, without an intermediate card). */
function pageOf(s) {
  const data = s.data;
  const date = data.date;
  const tocOut = [];
  const tocIn = s.toc;
  for (let k = 0; k < tocIn.length; k++) {
    const h = tocIn[k];
    tocOut.push({ level: h.level, id: h.id, html: h.html });
  }
  return {
    title: data.title,
    url: s.url,
    date: date ?? '',
    date_long: date === undefined ? '' : longDate(date),
    summary: data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: tocOut,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** makefun-site 1.0.0's answer for one case's input: its output tree, path -> text. */
export function run(input) {
  // Templates: every template compiled, in code-unit order of its name; one that does not
  // parse is reported and left out, as if it were not there. Compilations are memoized
  // across cases (a parse is a pure function of name and source).
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    const src = input.templates[name];
    let sub = templateCache.get(name);
    if (sub === undefined) {
      sub = new Map();
      templateCache.set(name, sub);
    }
    let entry = sub.get(src);
    if (entry === undefined) {
      entry = compileTemplate(name, src);
      sub.set(src, entry);
    }
    if (entry.ok) templates.set(name, entry.fns);
    else report.push(entry.msg);
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  const broken = new Set();
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  for (const s of kept) {
    const dir = dirOf(s.path);
    const path0 = s.path;
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const hit = bySource.get(path);
          if (hit !== undefined) return `${hit.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${path0} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = bySlug.get(slug);
      s.tagRefs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const fns = templates.get(name);
    return fns === undefined ? null : runList(fns, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse.
  const lines = report.concat([...broken]).sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
