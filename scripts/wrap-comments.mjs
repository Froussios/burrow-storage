#!/usr/bin/env node
// Wraps comment text at Prettier's printWidth. Prettier formats code but never
// reflows comments, so `npm run format` runs this after it and
// `npm run format:check` runs it with --check.
//
// - Breaks only at spaces, so URLs, file paths and other unbroken tokens stay
//   whole, and never inside `inline code` or {@link ...}. A token wider than
//   the limit is left whole and reported.
// - The overflow of a line is prepended to the next line of the same paragraph,
//   which may then overflow in turn. A new line is added only at the end of a
//   paragraph, so wrapping does not leave a trail of half-filled lines.
// - Empty comment lines separate paragraphs. Runs of them collapse to one, and
//   none are kept at the start or end of a comment (code fences excepted).
// - List items, `@tags`, table rows and code fences start a new paragraph and
//   are never joined into. Indented lines that do not continue a list item are
//   preformatted, and so are section dividers (`// ---- name`) and directives
//   (eslint-, @ts-, prettier-ignore, ///): all are left alone.
// - A comment after code cannot be wrapped. When it pushes its line past the
//   limit it is reported as an error: move it onto its own line.
//
// Comments are found with the TypeScript parser, so a `//` inside a string, a
// URL or a template literal is never mistaken for one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const EXTENSIONS = /\.[cm]?[jt]s$/;
const DIRECTIVE =
  /^(\/|\s*(eslint[- ]|@ts-|prettier-ignore|c8 |istanbul |#region|#endregion|[@#]__PURE__))/;
/** A list marker: `- `, `* `, `+ `, `1. `, `1) `. */
const MARKER = /^([-*+]|\d+[.)]) +/;
/**
 * Starts a new paragraph: a list item, tag, table row, code fence or divider.
 */
const NEW_ITEM = /^(([-*+]|\d+[.)]) |@\w|\||```[\w-]*$|[-=*#_~]{4,})/;
/**
 * A definition-list row, `SYNC-10  text`: continuation lines align with text.
 */
const LABEL = /^\S{1,20} {2,}(?=\S)/;
/**
 * A code fence: three backticks and an optional language, alone on the line.
 */
const FENCE = /^```[\w-]*$/;
/** A section divider, `// ------------ name`. */
const DIVIDER = /^[-=*#_~]{4,}/;

const widthOf = (s) => [...s].length;
const indentOf = (s) => s.length - s.trimStart().length;

/**
 * Wraps the comments in one source file. Returns the new text and the problems
 * found; a `fatal` problem cannot be fixed automatically.
 */
export function wrapComments(text, { width = 80, fileName = "file.ts" } = {}) {
  const kind = /\.[cm]?js$/.test(fileName)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const lines = text.split("\n");
  const starts = sf.getLineStarts();
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const problems = [];
  const note = (line, message, fatal = false) =>
    problems.push({ line: line + 1, message, fatal });

  const singles = [];
  const edits = [];
  const afterCode = new Set();
  for (const r of collectComments(sf, text)) {
    const line = lineOf(r.pos);
    const endLine = lineOf(r.end);
    const before = text.slice(starts[line], r.pos);
    const after = lines[endLine].slice(r.end - starts[endLine]);
    const body = text.slice(r.pos, r.end);
    if (before.trim() || after.trim()) {
      const code = (before.trim() ? before : after).trimEnd();
      if (
        widthOf(lines[line]) > width &&
        widthOf(code) <= width &&
        !afterCode.has(line)
      ) {
        afterCode.add(line);
        note(
          line,
          "comment after code exceeds the limit; move it to its own line",
          true,
        );
      }
    } else if (r.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      singles.push({ line, indent: before.length, body });
    } else {
      const edit = wrapBlock(
        lines,
        line,
        endLine,
        before.length,
        body,
        width,
        note,
      );
      if (edit) edits.push(edit);
    }
  }

  // Consecutive `//` lines at the same indentation form one comment.
  for (let i = 0; i < singles.length;) {
    const first = singles[i];
    const group = [first];
    if (!DIRECTIVE.test(first.body.slice(2))) {
      while (
        singles[i + group.length]?.line === first.line + group.length &&
        singles[i + group.length].indent === first.indent &&
        !DIRECTIVE.test(singles[i + group.length].body.slice(2))
      )
        group.push(singles[i + group.length]);
      const pad = " ".repeat(first.indent);
      const items = group.map(({ line, body }) => {
        const rest = body.slice(2);
        if (rest.trim() === "") return { line, raw: lines[line], inner: "" };
        if (rest[0] === " ")
          return { line, raw: lines[line], inner: rest.slice(1) };
        return { line, raw: lines[line], opaque: true };
      });
      const out = reflow(items, widthOf(pad + "// "), width, note);
      if (edited(out, items))
        edits.push({
          start: first.line,
          end: first.line + group.length - 1,
          lines: out.map((it) => emit(it, pad + "// ")),
        });
    }
    i += group.length;
  }

  for (const { start, end, lines: repl } of edits.sort(
    (a, b) => b.start - a.start,
  ))
    lines.splice(start, end - start + 1, ...repl);
  const out = lines.join("\n");
  // Wrapping only moves whitespace and comment markers; anything else is a bug.
  if (essence(out) !== essence(text))
    throw new Error(`${fileName}: wrapping would change more than layout`);
  return {
    text: out,
    problems: problems.sort((a, b) => a.line - b.line),
  };
}

const essence = (s) => s.replace(/\/\/|\/\*|\*\/|\*|\s+/g, "");

/**
 * Every comment in the file, found from the token boundaries of the syntax
 * tree.
 */
function collectComments(sf, text) {
  const found = new Map();
  const add = (ranges) => ranges?.forEach((r) => found.set(r.pos, r));
  const visit = (node) => {
    if (
      node.kind >= ts.SyntaxKind.FirstJSDocNode &&
      node.kind <= ts.SyntaxKind.LastJSDocNode
    )
      return;
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

/** Wraps a `/* *\/` or `/** *\/` comment that sits on lines of its own. */
function wrapBlock(lines, start, end, indent, body, width, note) {
  const pad = " ".repeat(indent);
  const prefix = pad + " * ";
  if (start === end) {
    // `/** text */` on one line: rewrite it as a block only when it overflows.
    const m = /^\/\*(\*?) (.*?) *\*\/$/.exec(body);
    if (!m || widthOf(lines[start]) <= width) return null;
    if (DIRECTIVE.test(m[2]) || m[2].startsWith("*")) {
      note(start, "comment exceeds the limit and is not wrapped");
      return null;
    }
    const out = reflow(
      [{ line: start, inner: m[2] }],
      widthOf(prefix),
      width,
      note,
    );
    return {
      start,
      end,
      lines: [
        `${pad}/*${m[1]}`,
        ...out.map((it) => emit(it, prefix)),
        `${pad} */`,
      ],
    };
  }
  const open = lines[start].trim();
  const middle = [];
  for (let l = start + 1; l < end; l++) {
    const m = /^( *) \*(?: (.*))?$/.exec(lines[l]);
    if (!m || m[1].length !== indent)
      return unwrapped(lines, start, end, width, note);
    middle.push({
      line: l,
      raw: lines[l],
      inner: (m[2] ?? "").trimEnd() === "" ? "" : m[2],
    });
  }
  if ((open !== "/*" && open !== "/**") || lines[end].trim() !== "*/")
    return unwrapped(lines, start, end, width, note);
  const out = reflow(middle, widthOf(prefix), width, note);
  if (!edited(out, middle)) return null;
  return {
    start: start + 1,
    end: end - 1,
    lines: out.map((it) => emit(it, prefix)),
  };
}

function unwrapped(lines, start, end, width, note) {
  for (let l = start; l <= end; l++)
    if (widthOf(lines[l]) > width)
      note(l, "comment exceeds the limit and is not wrapped");
  return null;
}

const edited = (out, items) =>
  out.length !== items.length || out.some((it) => it.changed);

// A line is re-emitted when it changed or has no original text (a new line).
const emit = (it, prefix) =>
  !it.changed && it.raw !== undefined
    ? it.raw
    : it.inner === ""
      ? prefix.trimEnd()
      : prefix + it.inner;

/**
 * Drops empty lines at the start and end of a comment and collapses runs of
 * them to one. Empty lines inside code fences are kept.
 */
function squeeze(items) {
  const out = [];
  let fence = false;
  for (const it of items) {
    const t = it.opaque ? null : it.inner.trim();
    if (t !== null && FENCE.test(t)) fence = !fence;
    const empty = t === "" && !fence;
    if (empty && (out.length === 0 || out.at(-1).empty)) continue;
    out.push({ ...it, empty });
  }
  while (out.at(-1)?.empty) out.pop();
  return out;
}

/**
 * Wraps the lines of one comment, given their text without the comment prefix.
 * Returns the new lines; `changed` marks the ones to re-emit.
 */
function reflow(items, prefixWidth, width, note) {
  const avail = width - prefixWidth;
  const out = squeeze(items);
  let fence = false;
  let example = false;
  let hang = -1; // where continuation lines of the current paragraph start
  for (let i = 0; i < out.length; i++) {
    const it = out[i];
    if (it.opaque) {
      hang = -1;
      continue;
    }
    const s = it.inner;
    const t = s.trimStart();
    const k = indentOf(s);
    if (FENCE.test(t)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (t === "") {
      hang = -1;
      example = false;
      continue;
    }
    if (/^@\w/.test(t)) example = t.startsWith("@example");
    else if (example) continue;

    if (DIVIDER.test(t)) {
      if (widthOf(s) > avail)
        note(it.line, "comment divider exceeds the limit");
      hang = -1;
      continue;
    }
    let cont;
    let m;
    if (it.carried) cont = k;
    else if ((m = MARKER.exec(t))) cont = k + m[0].length;
    else if (/^@\w/.test(t)) cont = k + 2;
    else if ((m = LABEL.exec(t))) cont = k + m[0].length;
    else if (k === 0 || k === hang) cont = k;
    else {
      if (widthOf(s) > avail)
        note(it.line, "preformatted comment line exceeds the limit");
      continue;
    }
    hang = cont;
    if (widthOf(s) <= avail) continue;
    if (t.startsWith("|")) {
      note(it.line, "comment table row exceeds the limit");
      continue;
    }

    const cut = findCut(s, avail, cont);
    if (!cut) {
      note(it.line, "comment has no space to break at");
      continue;
    }
    if (widthOf(cut.head) > avail)
      note(it.line, "comment word is wider than the limit");
    it.inner = cut.head;
    it.changed = true;
    const tail = " ".repeat(cont) + cut.tail;
    const next = out[i + 1];
    const nt = next?.inner?.trimStart();
    if (
      next &&
      !next.opaque &&
      nt &&
      indentOf(next.inner) === cont &&
      !NEW_ITEM.test(nt) &&
      !LABEL.test(nt)
    ) {
      next.inner = `${tail} ${nt}`;
      next.changed = true;
      next.carried = true;
    } else {
      out.splice(i + 1, 0, {
        line: it.line,
        inner: tail,
        changed: true,
        carried: true,
      });
    }
  }
  return out;
}

/**
 * The last space at which `s` can break so that the head fits in `avail`, or,
 * if none fits, the first one. Never breaks before `from` (a list marker or a
 * label), inside `inline code` or `{@link ...}`, or where the tail would read
 * as a new item.
 */
function findCut(s, avail, from) {
  const chars = [...s];
  const guarded = new Array(chars.length).fill(false);
  const runAt = (i) => {
    let n = 0;
    while (chars[i + n] === "`") n++;
    return n;
  };
  for (let i = 0; i < chars.length; i++) {
    let close = -1;
    if (chars[i] === "`") {
      // A code span closes with a run of as many backticks as opened it.
      const n = runAt(i);
      for (let j = i + n; j < chars.length; j++) {
        if (chars[j] !== "`") continue;
        const m = runAt(j);
        if (m === n) {
          close = j + n - 1;
          break;
        }
        j += m - 1;
      }
      if (close < 0) {
        i += n - 1;
        continue;
      }
    } else if (chars[i] === "{" && chars[i + 1] === "@") {
      close = chars.indexOf("}", i + 1);
    }
    if (close < 0) continue;
    guarded.fill(true, i, close + 1);
    i = close;
  }
  let best = -1;
  let first = -1;
  for (let i = from + 1; i < chars.length; i++) {
    if (chars[i] !== " " || chars[i - 1] === " " || guarded[i]) continue;
    const tail = chars.slice(i).join("").trimStart();
    if (!tail || NEW_ITEM.test(tail)) continue;
    if (first < 0) first = i;
    if (i <= avail) best = i;
  }
  const at = best >= 0 ? best : first;
  if (at < 0) return null;
  return {
    head: chars.slice(0, at).join("").trimEnd(),
    tail: chars.slice(at).join("").trimStart(),
  };
}

function main(args) {
  const check = args.includes("--check");
  const named = args.filter((a) => !a.startsWith("--"));
  const files = named.length
    ? named
    : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
        .split("\0")
        .filter((f) => EXTENSIONS.test(f) && existsSync(f));
  let width = 80;
  if (existsSync(".prettierrc.json"))
    width =
      JSON.parse(readFileSync(".prettierrc.json", "utf8")).printWidth ?? width;

  const unwrapped = [];
  let errors = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const out = wrapComments(text, { width, fileName: file });
    for (const p of out.problems) {
      console.error(
        `${file}:${p.line}: ${p.fatal ? "error" : "note"}: ${p.message}`,
      );
      if (p.fatal) errors++;
    }
    if (out.text === text) continue;
    unwrapped.push(file);
    if (!check) writeFileSync(file, out.text);
  }
  if (check && unwrapped.length) {
    for (const file of unwrapped)
      console.error(`${file}: comments need wrapping`);
    console.error("Run `npm run format` to wrap them.");
  } else if (!check && unwrapped.length) {
    console.log(`Wrapped comments in ${unwrapped.length} file(s).`);
  }
  if (errors || (check && unwrapped.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
