---
name: pr-review
description: Review a Burrow pull request for its author and end with a verdict that decides automatic approval. Use for "review PR N", "@claude review", and the automatic review workflow (.github/workflows/claude-code-review.yml).
---

# Reviewing a Burrow pull request

You are reviewing a pull request for its author, who wants to know what blocks merging, what is
worth a second look, and what nobody has checked. Be specific and brief. Don't praise the change
and don't restate the diff.

The automatic review workflow reads this file from the base branch. Edits to it take effect for
reviews once they are merged, and a PR that edits it is reviewed under the old version.

## Gather

1. `gh pr view <n>` for the title, description and earlier comments, and `gh pr diff <n>` for the
   change. A large diff is saved to a file; read it in parts with `grep`, `head` and Read. You
   may keep notes and a copy of the diff under `/tmp`.
2. Read the surrounding code and docs that the change touches or relies on. The checkout is the
   PR's code, except `CLAUDE.md` and `.claude/`, which come from the base branch.
3. If an earlier review on this PR listed blocking issues, note each one: you will say whether
   this version fixes it.

You can't build, run tests or run the project's scripts. Don't try to work around that.

## Judge

`CLAUDE.md` is the standard. An issue **blocks** merging when it is one of these:

- A bug: wrong results, a crash, a broken error path, a race, lost data. Unsynced writes are never
  dropped (SYNC-9), and local reads and writes never reject for remote reasons (API-3, API-6).
- A broken hard rule from `CLAUDE.md`: a runtime dependency in the core, non-WebCrypto crypto, a
  secret or user value that is sent, logged or persisted, `eval` or inline scripts, a size budget
  that is clearly exceeded.
- A public contract change (the `Envelope` format, salts, info labels, AAD, token formats) that
  is not a major version change, or that lacks its `SECURITY.md` update and `docs/decisions.md`
  entry.
- Behaviour that departs from `SECURITY.md` or `docs/architecture.md` without updating it in the
  same PR and adding a `D-n` decision.
- Docs, README or `docs/api.md` snippets that no longer match `src/types.ts` or the code.
- Changed behaviour with no test, or tests that no longer test what their requirement-id name
  says.
- A renumbered requirement id or decision.

Everything else is non-blocking: naming, structure, small simplifications, wording, a missing
test for an edge case that the PR didn't touch. Don't flag pre-existing problems unless the PR
makes them worse. Don't flag what you aren't confident about as blocking. Put it under
observations and say what would settle it.

## Write

Write the review in this order:

1. **Blocking issues.** For each: where it is, why it blocks, and what would fix it. Write "None."
   if there are none.
2. **Re-review** (only if an earlier review listed blocking issues): each earlier issue, and
   whether this version fixes it.
3. **Observations.** Non-blocking points, one or two lines each.
4. **Not checked.** What you couldn't verify, such as tests, size budgets or `npm run docs:check`.

Add an inline comment for each issue tied to specific lines, as well as listing it in the review.

Comment only. Don't approve, request changes, push or edit files. Approval is decided by the
workflow from your verdict.

End the review with exactly one of these lines, and nothing after it:

**Verdict:** blocking

**Verdict:** no blocking issues

Use `no blocking issues` only when the Blocking issues section is "None.".
