# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

`README.md` is the spec. It is human-authored and takes precedence over this
file and over the existing code. If the code disagrees with the README, the
code is wrong. If a change makes the README inaccurate, update the README in
the same change.

## What this project is

A single-file CLI that extracts the examples from [zcap-spec][] and prints them
as NDJSON. It exists so that spec authors can check every example against a
schema, and so others can build on the examples programmatically.

## Non-negotiables

These are the constraints that shaped the current design. Do not quietly
relax them.

1. **Zero runtime dependencies.** The tool parses untrusted HTML fetched over
   the network. Every runtime dependency is third-party code executing on that
   input. `node-html-parser` was removed for exactly this reason and replaced
   with ~100 lines of in-repo string scanning. Before adding *any* runtime
   dependency, ask whether a modest amount of in-repo code would do. It almost
   always will. Dev-only dependencies that never execute on input (types, the
   type-checker) are acceptable.
2. **No build step to run it.** `./zcap-spec-examples.ts` runs directly on
   Node ≥ 22.18 via type stripping. `npm run build:js` exists for publishing,
   not for development. Never make running or testing require a build.
3. **`ZcapSpecExamplesCli` stays runtime-independent.** No `process`, no
   `fetch`, no `node:*` imports reachable from it. Everything it needs is
   injected via `ZcapSpecExamplesCliDeps`. Node-specific concerns live in
   `NodejsZcapSpecExamplesCli` and `main()`.
4. **No `eval`, no `new Function`, no prototype mutation** anywhere near the
   parsing code.

## Layout

```
zcap-spec-examples.ts        the entire implementation
test/                        tests, found automatically by `node --test`
etc/tsconfig.build.json      emitting build config
etc/zcap-spec-examples/      sample spec HTML for manual runs
```

Root-level files are kept to the minimum that npm and TypeScript resolve by
convention. New config belongs in `etc/`, new tests in `test/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | `node --test` — no path argument, discovery finds `test/` |
| `npm run tsc` | type-check only (`--noEmit`), never emits |
| `npm run build:js` | compile to `dist/` (gitignored) |
| `npm start` | run the CLI from source |
| `npm run start:hardened` | run under `node --permission` |
| `npm run release` | build, then publish (see the publishing trap below) |

## Verify against the real document, not just fixtures

The fixtures in `etc/zcap-spec-examples/` are hand-made and do not capture
everything the real spec does. When changing parsing, extraction, media types,
or URLs, check against the actual document:

```shell
curl -sS https://w3c-ccg.github.io/zcap-spec/ | ./zcap-spec-examples.ts | jq .
```

At time of writing that yields exactly 7 examples: `example-1` through
`example-7`, five `application/jsonc` and two `application/json`. A change that
alters those counts or types needs a deliberate justification.

## Things that are easy to get wrong

Each of these was a real bug found by testing, not a hypothetical.

- **ReSpec runs client-side.** What `curl` fetches is the spec *source*, not
  the rendered page. So the examples are bare `<pre class="example ...">` with
  **no `id` attributes**, and `respecConfig` is still present in the HTML. Do
  not assume the fetched HTML looks like what a browser displays.
- **Example ids are generated, not authored.** ReSpec numbers
  `pre.example`/`aside.example` in document order and calls
  `addId(div, "example", String(n))`, producing `example-1`, `example-2`, …
  Our positional naming deliberately mirrors that so `#example-5` resolves
  against the published page. If ReSpec's scheme changes, ours must follow.
- **The base URL comes from the document.** `respecConfig.edDraftURI` is what
  makes piped input produce absolute URLs. Resolution order is `--base-url` →
  document-declared → fetched URL → bare fragment, and document-declared
  deliberately beats the fetched URL.
- **Stripping JSON comments cannot be a regex.** The examples are full of
  values like `"https://w3id.org/zcap/v1"`; a naive `//` strip truncates every
  URL in the document. `stripJsonComments` is a string-aware scanner and must
  stay one.
- **Broken pipes are normal.** `... | head -1` closes stdout early. The CLI
  swallows `EPIPE` and exits quietly; do not reintroduce an unhandled write.
- **`npx` invokes through a symlink.** `node_modules/.bin/<name>` is a symlink,
  so `process.argv[1]` is the link path while `import.meta.url` is the resolved
  target. Comparing them naively makes `main()` silently never run — the CLI
  prints nothing and exits 0. `isMainModule()` compares realpaths for this
  reason. There is a regression test; keep it.
- **Regexes must not backtrack ambiguously.** The tag scanner uses
  mutually-exclusive alternation (`"[^"]*"|'[^']*'|[^>"']`) so hostile input
  cannot trigger catastrophic backtracking. A test asserts linear behaviour.

## The publishing trap

`.npmrc` sets `ignore-scripts=true` as a supply-chain control. That setting
also disables this package's *own* lifecycle scripts, so `npm publish` will
**not** run `prepack`, and would otherwise ship a tarball with no `dist/` —
producing a package where `npx zcap-spec-examples` silently does nothing.

Always publish with `npm run release`, which builds explicitly first. Verify
before publishing:

```shell
npm pack --dry-run   # must list dist/zcap-spec-examples.js
```

Do not remove `ignore-scripts=true` to "fix" this.

## Testing expectations

- Tests use `node:test` and `node:assert/strict`. No test framework, consistent
  with the zero-dependency rule.
- Test the behaviour that broke, not just the happy path. Process-level
  behaviour (EPIPE, symlinked invocation) is tested by spawning a child
  process; that is deliberate, since neither reproduces in-process.
- Prefer inline HTML fixtures in the test file over new files on disk.
- Keep `npm run tsc` clean. It is separate from `npm test`; run both.

## Style

- Comments explain *why*, especially where the code looks over-complicated —
  the string-aware comment stripper and the realpath check both look like
  overkill until you know what they prevent.
- Keep the CLI a single file. Its size is not currently a problem, and one file
  with no imports is easy to audit.
- Match the surrounding code rather than introducing new patterns.

## Code authorship

Per the README, this code was largely written by LLMs from a human-authored
README. Keep that honest: if you are an agent making substantial changes, the
README's "Code Authorship" section should stay accurate.

[zcap-spec]: https://w3c-ccg.github.io/zcap-spec/
