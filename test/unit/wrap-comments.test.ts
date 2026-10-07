// scripts/wrap-comments.mjs: comment wrapping for `npm run format`.
//
// Every case formats twice: output that is formatted again must not change, or
// `npm run format` and `format:check` would disagree.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wrapComments } from "../../scripts/wrap-comments.mjs";

/** Wraps `text`, then wraps the result again and asserts nothing changed. */
function wrap(text: string, width = 40, fileName = "file.ts") {
  const once = wrapComments(text, { width, fileName });
  const twice = wrapComments(once.text, { width, fileName });
  expect(twice.text, "a second pass changed the output").toBe(once.text);
  return once;
}
const src = (...lines: string[]) => lines.join("\n");
const longest = (text: string) =>
  Math.max(...text.split("\n").map((l) => [...l].length));

describe("wrap-comments", () => {
  it("breaks at spaces and never inside a word, URL or path", () => {
    const { text } = wrap(
      src(
        "// see https://example.com/a/very/long/path/x and docs/architecture.md now",
        "x();",
      ),
    );
    expect(text).toBe(
      src(
        "// see",
        "// https://example.com/a/very/long/path/x",
        "// and docs/architecture.md now",
        "x();",
      ),
    );
  });

  it("never breaks inside inline code", () => {
    const { text } = wrap(
      src("// call it with `{ keepalive: true, x: 1 }` now"),
    );
    expect(text).toBe(
      src("// call it with", "// `{ keepalive: true, x: 1 }` now"),
    );
  });

  it("leaves section dividers alone", () => {
    const input = src("// ------------------------------ export / import");
    const { text, problems } = wrap(input);
    expect(text).toBe(input);
    expect(problems.map((p) => p.fatal)).toEqual([false]);
  });

  it("prepends the overflow to the next line instead of adding half lines", () => {
    const input = src(
      "// one two three four five six seven eight",
      "// nine ten",
      "// eleven",
    );
    expect(wrap(input).text).toBe(
      src(
        "// one two three four five six seven",
        "// eight nine ten",
        "// eleven",
      ),
    );
  });

  it("cascades the overflow and adds a line only at the end of the paragraph", () => {
    const input = src(
      "// aaaa bbbb cccc dddd eeee ffff gggg hhhh",
      "// iiii jjjj kkkk llll mmmm nnnn oooo pppp",
    );
    const { text } = wrap(input);
    expect(text).toBe(
      src(
        "// aaaa bbbb cccc dddd eeee ffff gggg",
        "// hhhh iiii jjjj kkkk llll mmmm nnnn",
        "// oooo pppp",
      ),
    );
    expect(longest(text)).toBeLessThanOrEqual(40);
  });

  it("keeps empty lines and never joins across them", () => {
    const input = src(
      "// one two three four five six seven eight",
      "//",
      "// second paragraph",
    );
    expect(wrap(input).text).toBe(
      src(
        "// one two three four five six seven",
        "// eight",
        "//",
        "// second paragraph",
      ),
    );
  });

  it("collapses runs of empty lines and trims them at the ends", () => {
    const input = src(
      "//",
      "// first",
      "//",
      "//",
      "//",
      "// second",
      "//",
      "x();",
      "/**",
      " *",
      " * doc",
      " *",
      " *",
      " * more",
      " *",
      " */",
    );
    expect(wrap(input).text).toBe(
      src(
        "// first",
        "//",
        "// second",
        "x();",
        "/**",
        " * doc",
        " *",
        " * more",
        " */",
      ),
    );
  });

  it("treats only a bare ``` line as a fence, not prose that starts with one", () => {
    const { text } = wrap(
      src("// ```js examples are JavaScript, not TypeScript at all", "x;"),
    );
    expect(text).toBe(
      src(
        "// ```js examples are JavaScript, not",
        "// TypeScript at all",
        "x;",
      ),
    );
  });

  it("keeps empty lines inside code fences", () => {
    const input = src("// ```", "// a();", "//", "//", "// b();", "// ```");
    expect(wrap(input).text).toBe(input);
  });

  it("leaves lines that fit untouched", () => {
    const input = src(
      "// short",
      "//   aligned   on purpose",
      "/** fits */",
      "const s = 1;",
    );
    expect(wrap(input).text).toBe(input);
  });

  it("rewrites an overflowing one-line doc comment as a block", () => {
    const input = src(
      "  /** Resolves with a usable secret and a loaded mirror. */",
      "  x: number;",
    );
    expect(wrap(input).text).toBe(
      src(
        "  /**",
        "   * Resolves with a usable secret and a",
        "   * loaded mirror.",
        "   */",
        "  x: number;",
      ),
    );
  });

  it("keeps the text of a one-line doc comment that only its markers push over", () => {
    // 37 characters of text fit a block line (" * " + text) but not "/** text
    // */".
    const text = "Non-extractable key; stored as itself";
    expect(wrap(src(`/** ${text} */`, "x;")).text).toBe(
      src("/**", ` * ${text}`, " */", "x;"),
    );
  });

  it("wraps the lines of a multi-line doc comment", () => {
    const input = src(
      "/**",
      " * Merges two key directories, keeping the winner",
      " * per key.",
      " */",
    );
    expect(wrap(input).text).toBe(
      src(
        "/**",
        " * Merges two key directories, keeping",
        " * the winner per key.",
        " */",
      ),
    );
  });

  it("hangs list items and does not join into the next item", () => {
    const input = src(
      "// - first item that is far too long to fit",
      "// - second item",
    );
    expect(wrap(input).text).toBe(
      src(
        "// - first item that is far too long to",
        "//   fit",
        "// - second item",
      ),
    );
  });

  it("aligns label rows with their text, as in a definition list", () => {
    const input = src(
      "//   SYNC-10  Greater ts wins and ties break",
      "//            by hash.",
      "//   SYNC-11  Clock skew.",
    );
    expect(wrap(input).text).toBe(
      src(
        "//   SYNC-10  Greater ts wins and ties",
        "//            break by hash.",
        "//   SYNC-11  Clock skew.",
      ),
    );
  });

  it("ignores // inside strings and template literals", () => {
    const input = src(
      'const u = "https://example.com/a/very/long/path/that/is/long";',
      "const t = `",
      "// not a comment, part of a template literal string",
      "`;",
    );
    expect(wrap(input).text).toBe(input);
  });

  it("leaves directives, preformatted lines and code fences alone", () => {
    const input = src(
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "// Example:",
      "//     const value = await burrow.get('key-name-long');",
      "// ```",
      "// await store.set({ aLongKey: 1, anotherLongKey: 2 });",
      "// ```",
    );
    const { text, problems } = wrap(input);
    expect(text).toBe(input);
    expect(problems.every((p) => !p.fatal)).toBe(true);
  });

  it("reports a comment after code that pushes the line over the limit", () => {
    const { text, problems } = wrap(
      src("const x = 1; // explains x at some length"),
    );
    expect(text).toBe("const x = 1; // explains x at some length");
    expect(problems).toEqual([
      { line: 1, message: expect.stringMatching(/own line/), fatal: true },
    ]);
  });

  it("is stable on generated comments of every shape, at any width", () => {
    const word = fc.oneof(
      { weight: 6, arbitrary: fc.stringMatching(/^[a-z]{1,10}[.,;:]?$/) },
      fc.constantFrom("A", "I", "D-5", "SYNC-10", "(see", "it)", "≥", "→"),
      fc.stringMatching(/^[a-z]{2,8}$/).map((w) => `https://ex.com/${w}/x`),
      fc.stringMatching(/^[a-z]{1,8}$/).map((w) => `docs/${w}.md`),
      fc
        .array(fc.stringMatching(/^[a-z]{1,6}$/), {
          minLength: 1,
          maxLength: 4,
        })
        .map((ws) => `\`${ws.join(" ")}\``),
      fc.stringMatching(/^[a-z]{30,90}$/),
    );
    const prose = fc
      .array(word, { minLength: 1, maxLength: 24 })
      .map((ws) => ws.join(" "));
    const line = fc.oneof(
      { weight: 8, arbitrary: prose },
      { weight: 3, arbitrary: fc.constant("") },
      prose.map((p) => `- ${p}`),
      prose.map((p) => `1. ${p}`),
      prose.map((p) => `SYNC-12  ${p}`),
      prose.map((p) => `            ${p}`),
      prose.map((p) => `@param x ${p}`),
      fc.constantFrom("```", "```ts", "---------- section", "| a | b |"),
    );
    const comment = fc.oneof(
      fc
        .tuple(fc.nat(8), fc.array(line, { minLength: 1, maxLength: 8 }))
        .map(([n, ls]) => {
          const pad = " ".repeat(n);
          return ls.map((l) => (l ? `${pad}// ${l}` : `${pad}//`));
        }),
      fc
        .tuple(fc.nat(8), fc.array(line, { minLength: 1, maxLength: 8 }))
        .map(([n, ls]) => {
          const pad = " ".repeat(n);
          const body = ls.map((l) => (l ? `${pad} * ${l}` : `${pad} *`));
          return [`${pad}/**`, ...body, `${pad} */`];
        }),
      fc
        .tuple(fc.nat(8), prose)
        .map(([n, p]) => [`${" ".repeat(n)}/** ${p} */`]),
      prose.map((p) => [`const y = 1; // ${p}`]),
    );
    const file = fc
      .array(comment, { minLength: 1, maxLength: 5 })
      .map((cs) =>
        cs.flatMap((c, i) => [...c, `const x${i} = ${i};`]).join("\n"),
      );

    fc.assert(
      fc.property(file, fc.integer({ min: 20, max: 100 }), (text, width) => {
        wrap(text, width);
      }),
      { numRuns: 500 },
    );
  });

  it("is stable on every source file in the repository, at several widths", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter((f) => /\.[cm]?[jt]s$/.test(f));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files)
      for (const width of [80, 60, 40]) wrap(readFileSync(f, "utf8"), width, f);
  });
});
