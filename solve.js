// A faster drop-in for makefun-site 1.0.0, written for make.fun's
// "Build a static site faster, 22 November 2026" bounty.
//
// run(input) returns exactly makefun-site 1.0.0's build of the input: the same
// front matter, permalinks, Markdown dialect, template dialect, collections,
// tags and build report, byte for byte. The implementation is my own, built
// for speed: slugs are memoised per build, the Markdown pass classifies lines
// by their first character instead of stacked regex tests, inline rendering
// scans a string once and escapes whole literal runs at a time, and every
// template is compiled once into a JavaScript function that appends to an
// array instead of walking a node tree per page.
//
// Dependency-free ES module: run(input) -> { outputPath: text }.

// ---------------------------------------------------------------- text rules

const hasOwn = Object.hasOwn;

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped; the text itself when there is nothing to escape. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(text);
  if (m === null) return text;
  let out = text.slice(0, m.index) + ESC_MAP[m[0]];
  let last = m.index + 1;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESC_MAP[m[0]];
    last = m.index + 1;
  }
  return out + text.slice(last);
}

const SLUG_MAX = 64;

/**
 * The slug of `text` before memoisation: NFKD, combining marks dropped, A-Z
 * lowered, each run of characters other than a-z and 0-9 one "-", none at
 * either end, at most 64 characters (a "-" left at the cut dropped),
 * "untitled" when nothing is left. Pure-ASCII text is already NFKD-stable
 * and holds no marks, so it skips the normaliser.
 */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** A slugifier with a per-build memo: tag names, titles and headings repeat a lot inside one site. */
function makeSlugifier() {
  const cache = new Map();
  return (text) => {
    let slug = cache.get(text);
    if (slug === undefined) {
      slug = slugifyRaw(text);
      cache.set(text, slug);
    }
    return slug;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace (the \s set), counted in one scan. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws =
      c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function fmDaysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
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

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > fmDaysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked by
 * offset; only the front-matter lines are ever sliced out.
 */
function parseFrontMatter(text) {
  // The line spans up to the closing "---": spans[k] is line k (the opening
  // "---" is line 0), each [start, end) with the "\n" excluded.
  const spans = [];
  let close = -1;
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    spans.push([start, end]);
    if (spans.length === 1) {
      if (text.slice(start, end) !== '---') return { error: 'no front matter' };
    } else if (text.slice(start, end) === '---') {
      close = spans.length - 1;
      break;
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = text.slice(spans[i][0], spans[i][1]);
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  const bodyStart = Math.min(spans[close][1] + 1, text.length);
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** A line of nothing but spaces and tabs (or nothing). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `s` over [a, b) is only spaces and tabs. */
function isSpaceTabOnly(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opening line's language, or null: three backticks, a language of A-Z a-z 0-9 _ + -, then blanks. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const langChar = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!langChar) break;
    i++;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A fence closing line: three backticks, then blanks only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  return isSpaceTabOnly(line, 3, line.length);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6 || hashes >= line.length) return null;
  const c = line.charCodeAt(hashes);
  if (c !== 32 && c !== 9) return null;
  let a = hashes;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: hashes, text: line.slice(a, b) };
}

/** A thematic break line: "---" or "***", then blanks only. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  return isSpaceTabOnly(line, 3, line.length);
}

/** A bullet item line's text after "- " or "* ", or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line's number and text after "N. ", or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 10) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

const CONTINUED = /^ {2,}\S/;

/** A line as it is rendered inside a block: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** The characters a backslash escapes, by char code. */
const ESCAPABLE_CC = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE_CC[ch.charCodeAt(0)] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const wlen = what.length;
  const w0 = what.charCodeAt(0);
  const w1 = wlen > 1 ? what.charCodeAt(1) : -1;
  for (let j = from; j <= n - wlen; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE_CC[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c === w0 && (wlen === 1 || s.charCodeAt(j + 1) === w1)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && ESCAPABLE_CC[s.charCodeAt(j + 1)] === 1) {
      j++;
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

/** Finds the next inline special (backslash, backtick, star, open bracket) from a position. */
const INLINE_SPECIAL = /[\\`*\[]/g;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Literal text is
 * gathered in runs and escaped whole; only the four special characters are
 * ever looked at one by one.
 */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let lit = 0;
  let i = 0;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) break;
    i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash
      if (i + 1 < n && ESCAPABLE_CC[s.charCodeAt(i + 1)] === 1) {
        if (i > lit) out += escapeHtml(s.slice(lit, i));
        out += s.charCodeAt(i + 1) === 62 ? '&gt;' : s[i + 1];
        i += 2;
        lit = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      // backtick: a code span to the next backtick, at least one character between
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > lit) out += escapeHtml(s.slice(lit, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      // star: strong on **, emphasis on a single *
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > lit) out += escapeHtml(s.slice(lit, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          lit = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > lit) out += escapeHtml(s.slice(lit, i));
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
          lit = i;
        } else i++;
      }
      continue;
    }
    // open bracket: a link, [text](target)
    const k = findUnescaped(s, ']', i + 1);
    const close = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = close === -1 ? '' : s.slice(k + 2, close);
    if (target !== '' && !/\s/.test(target)) {
      if (i > lit) out += escapeHtml(s.slice(lit, i));
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = close + 1;
      lit = i;
    } else i++;
  }
  if (n > lit) out += escapeHtml(s.slice(lit, n));
  return out;
}

/**
 * `src` rendered in one pass over its lines: its HTML (each block followed by
 * "\n"), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c = line.charCodeAt(0);
    if ((c === 32 || c === 9) && isBlankLine(line)) {
      i++;
      continue;
    }
    if (c === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        let inner = '';
        for (const l of body) inner += `${escapeHtml(l)}\n`;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        parts.push(`<pre><code${cls}>${inner}</code></pre>\n`);
        continue;
      }
    }
    if (c === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(env.slugify(heading.text), ids);
        const html = inline(heading.text, env);
        parts.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    }
    if ((c === 45 || c === 42) && isHr(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (c === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i++];
        const stripped = raw.length > 1 && raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
      }
      parts.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = c === 45 || c === 42 ? bulletOf(line) : null;
    const ordered = bullet === null && c >= 48 && c <= 57 ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.num : 1;
      const items = [[trimLine(isOrdered ? ordered.text : bullet)]];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const lc = l.charCodeAt(0);
        const m = isOrdered ? (lc >= 48 && lc <= 57 ? orderedOf(l) : null) : lc === 45 || lc === 42 ? bulletOf(l) : null;
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (CONTINUED.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const partsOfItem of items) html += `<li>${inline(partsOfItem.join('\n'), env)}</li>\n`;
      parts.push(`${html}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push(`<p>${html}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template error, flagged so the build can tell it from a bug. */
function templateError(message) {
  const e = new Error(message);
  e.isTemplateError = true;
  return e;
}

/** The path `text` names, split at its dots, or a template error. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw templateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if (close === -1) throw templateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw templateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaceTabOnly(src, lineStart, open) && isSpaceTabOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a template error when it does not parse). */
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
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw templateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw templateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw templateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw templateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The scope chain is an array of variable objects, innermost last. A lookup
// reads a path's first name from the innermost scope holding it, then walks
// own properties.

function lookupBase(sc, a) {
  for (let i = sc.length - 1; i >= 0; i--) {
    const vars = sc[i];
    if (hasOwn(vars, a)) return vars[a];
  }
  return undefined;
}

function lookup1(sc, a) {
  return lookupBase(sc, a);
}

function lookup2(sc, a, b) {
  const v = lookupBase(sc, a);
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  return v[b];
}

function lookup3(sc, a, b, c) {
  let v = lookupBase(sc, a);
  if (v === null || typeof v !== 'object' || !hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !hasOwn(v, c)) return undefined;
  return v[c];
}

function lookupN(sc, path) {
  let v = lookupBase(sc, path[0]);
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** A value as {{ }} writes it: its text, HTML-escaped (one call, for compiled templates). */
function escValue(v) {
  return escapeHtml(typeof v === 'string' ? v : textOf(v));
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The generated-code lookup call for a parsed path. */
function lookupCall(path) {
  const args = path.map((p) => JSON.stringify(p)).join(',');
  if (path.length === 1) return `lk1(sc,${args})`;
  if (path.length === 2) return `lk2(sc,${args})`;
  if (path.length === 3) return `lk3(sc,${args})`;
  return `lkN(sc,[${args}])`;
}

/** Emits the body of a compiled template for `nodes` into `out` (an array of code lines). */
function genNodes(nodes, out, gen) {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.push(`o.push(${JSON.stringify(node.text)});`);
        break;
      case 'var':
        out.push(`o.push(ev(${lookupCall(node.path)}));`);
        break;
      case 'raw':
        out.push(`o.push(tx(${lookupCall(node.path)}));`);
        break;
      case 'if':
        out.push(`if (tr(${lookupCall(node.path)}) !== ${node.not}) {`);
        genNodes(node.then, out, gen);
        if (node.else !== null) {
          out.push('} else {');
          genNodes(node.else, out, gen);
        }
        out.push('}');
        break;
      case 'for': {
        const id = gen.next++;
        out.push(
          `{ const xs${id} = ${lookupCall(node.path)}; if (Array.isArray(xs${id})) { const ln${id} = xs${id}.length; ` +
            `for (let k${id} = 0; k${id} < ln${id}; k${id}++) { const vs${id} = Object.create(null); ` +
            `vs${id}[${JSON.stringify(node.name)}] = xs${id}[k${id}]; ` +
            `vs${id}.loop = { index: k${id} + 1, first: k${id} === 0, last: k${id} === ln${id} - 1, length: ln${id} }; sc.push(vs${id});`,
        );
        genNodes(node.body, out, gen);
        out.push(`sc.pop(); } } }`);
        break;
      }
      case 'include':
        out.push(`{ const f = fns.get(${JSON.stringify(node.name)}); if (f !== undefined && depth < ${INCLUDE_DEPTH}) f(sc, depth + 1, o); }`);
        break;
    }
  }
}

/**
 * A parsed template compiled to a function (sc, depth, o) that appends its
 * rendering to the array `o`, where sc is the scope chain. The helpers and
 * the template map are bound once, when the factory is applied in the build,
 * so a render call is just the scope, the include depth and the output.
 */
function compileTemplate(nodes) {
  const lines = [];
  genNodes(nodes, lines, { next: 0 });
  return new Function(
    'esc', 'tx', 'ev', 'tr', 'lk1', 'lk2', 'lk3', 'lkN', 'fns',
    `return function (sc, depth, o) {\n${lines.join('\n')}\n};`,
  );
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugifier();
  const report = [];

  // Every template is parsed and compiled, in code-unit order of its name;
  // one that does not parse is reported and left out.
  const fns = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const factory = compileTemplate(parseTemplate(name, input.templates[name]));
      fns.set(name, factory(escapeHtml, textOf, escValue, truthy, lookup1, lookup2, lookup3, lookupN, fns));
    } catch (err) {
      if (!err || err.isTemplateError !== true) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // The sources, in code-unit order of their paths, line ends made "\n"; a
  // source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Each source's front matter: a refused source is reported and dropped,
  // and so is a draft. The checks run in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!fns.has(layout)) {
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

  // Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
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

  // Each body's Markdown, its links resolved to the pages and static files
  // they name. A resolution depends only on the link's directory and target,
  // so it is memoised; a broken link is still reported per source.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      slugify,
      link: (target) => {
        if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const key = `${dir}\n${target}`;
        let hit = linkCache.get(key);
        if (hit === undefined) {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) hit = { href: `${bySource.get(path).url}${frag}`, broken: false };
          else if (path !== null && staticPaths.has(path)) hit = { href: `${base}/${path}${frag}`, broken: false };
          else hit = { href: target, broken: true };
          linkCache.set(key, hit);
        }
        if (hit.broken) broken.add(`broken-link ${s.path} -> ${target}`);
        return hit.href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest first and then by slug; each post's newer and older
  // neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
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
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tagList = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates read.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Every page through its layout, the index pages and the tag pages
  // through theirs; then each static file at its own path.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    const rootVars = { site, tags: allTags, recent };
    for (const k of Object.keys(vars)) rootVars[k] = vars[k];
    const o = [];
    fn([rootVars], 0, o);
    return o.join('');
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
  for (const t of tagList) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
