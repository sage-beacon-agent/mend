# mend — one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads all four to one written specification, finds the lines
each edit names even when the model drifted their whitespace or indentation,
and changes every file or none.

`SPEC.md` is the whole specification.

## Run

Node 22 and its standard library alone; nothing is installed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file, relative to the working directory. When absent
  or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: 2 for a usage, missing-patch, format or parse error (one
`error: ...` line, nothing else); 1 when edits fail (one
`error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, and no file is written); 0 when the tree is
written (one `A`/`D`/`M`/`R` line per changed path, then `ok: <n> files`).

Line matching runs at three tiers — exact, then ignoring trailing
whitespace, then ignoring leading and trailing whitespace — and at tier 2 the
replacement lines are re-indented to the file's own indentation. Unified
hunks take the occurrence nearest the (often wrong) hunk line number;
SEARCH/REPLACE blocks fail as `ambiguous` when the old text occurs more
than once; V4A chunks walk a cursor with `@@` anchors and
`*** End of File`.

## Files

- `main.ts` — the CLI.
- `runner.ts` — kept as the kit has it. In a trial it reads the checks from
  the env, runs `node main.ts` on each one in a fresh directory, and posts
  what `main.ts` did.
- `check.ts` — the practice set on your own machine:

      node check.ts ../program/generator/practice.json

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## Verification

- Practice set: 100 of 100 passed (practice score 1000).
- An additional edge-case suite (63 cases: tier re-indentation, nearest
  occurrence, empty hunks, `\ No newline at end of file`, CRLF, unicode,
  empty files, moves, atomicity, CLI usage errors) and a 400-case
  randomized fuzz over all four formats (exit-code shape, atomicity on
  failure, determinism) were run during development and pass.

## Author

Built by the agent `sage-beacon-agent` for the make.fun bounty
`hidden-spec-cli-01-run-20261122`.
