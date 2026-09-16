# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

`README.md` is the spec. It is human-authored and takes precedence over this
file and over the existing code. If the code disagrees with the README, the
code is wrong. If a change makes the README inaccurate, update the README in
the same change.

## What this project is

A small CLI that extracts the examples from [zcap-spec][] and prints them
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
3. **The layering must stay one-directional.** `examples.ts` →
   `ZcapSpecExamplesCli.ts` → `nodejs.ts` → `zcap-spec-examples.ts`. The first
   two must have no `process`, no `fetch`, and no `node:*` imports; everything
   they need is injected via `ZcapSpecExamplesCliDeps`. Never import "upward"
   — a cycle here breaks the entry point in ways type-checking will not catch.
4. **No `eval`, no `new Function`, no prototype mutation** anywhere near the
   parsing code.

## Layout

```
zcap-spec-examples.ts        entry point: executable script + public re-exports
nodejs.ts                    Node wiring: argv, stdio, EPIPE, main()
ZcapSpecExamplesCli.ts       CLI behaviour, runtime-independent
examples.ts                  extraction + parsing, pure, no imports at all
fixtures.ts                  GENERATED snapshot of the spec — never hand-edit
test/                        tests, found automatically by `node --test`
etc/tsconfig.build.json      emitting build config
etc/typedoc.json             API docs config
etc/serve-gh-pages.ts        local server that mimics GitHub Pages (`npm run dev`)
etc/zcap-spec-examples/      sample spec HTML for manual runs
.github/workflows/gh-pages.yml  the only Pages publisher: website + docs in one artifact
.github/workflows/docs.yml   checks that the docs build (no publishing)
.github/actions/build-docs/  reusable action: tsc + TypeDoc into a directory
.github/actions/build-website/  reusable action: website/ + /examples/ into a directory
website/                     static site source; build.ts generates /examples/
```

Imports between these use explicit `.ts` extensions so the code runs with no
build step. `rewriteRelativeImportExtensions` in `tsconfig.json` is what lets
`npm run build:js` still emit valid `.js` imports — do not remove it, and do
not "fix" the `.ts` extensions by hand.

Root-level files are kept to the minimum that npm and TypeScript resolve by
convention. New config belongs in `etc/`, new tests in `test/`.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | `node --test` — no path argument, discovery finds `test/` |
| `npm run tsc` | type-check only (`--noEmit`), never emits |
| `npm run build:js` | compile to `dist/` (gitignored) |
| `npm run docs` | TypeDoc API docs into `docs/` (gitignored) |
| `npm run build:gh-pages` | exactly what `gh-pages.yml` publishes, into `build/website/` (gitignored) |
| `npm run dev` | `build:gh-pages`, then serve it like GitHub Pages at `http://127.0.0.1:4000/zcap-spec-examples/` |
| `npm run fixture:update` | re-fetch the spec and regenerate `fixtures.ts` |
| `npm start` | run the CLI from source |
| `npm run start:hardened` | run under `node --permission` |
| `npm run release` | build, then publish (see the publishing trap below) |

## Verify against the real document, not just hand-made fixtures

`fixtures.ts` is a real snapshot of the spec, exported as
`zcap-spec-examples/fixtures`, and the test suite asserts against it — so the
parser is checked against genuine ReSpec output on every `npm test`, offline.
Those assertions (7 examples, five `application/jsonc` and two
`application/json`, absolute URLs from `edDraftURI`) are the guard rail. If a
change breaks them, the change is almost certainly wrong.

`fixtures.ts` is generated. Never hand-edit it; run `npm run fixture:update`,
which also refreshes the recorded `retrievedAt`, `bytes`, and `sha256`. A test
verifies the checksum still matches the embedded HTML, so a hand-edit is caught.

The small fixtures in `etc/zcap-spec-examples/` are hand-made and do not capture
everything the real spec does. To check against the *live* document (in case the
spec itself has changed since the snapshot):

```shell
curl -sS https://w3c-ccg.github.io/zcap-spec/v0.4.0-draft/ | ./zcap-spec-examples.ts | jq .
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
- **`parseExampleContent` is the supported way to read `example.content`.**
  `JSON.parse` alone throws on most real examples, because they carry `//`
  commentary. Keep it forgiving: try a direct parse, then a comment-stripped
  one, and only then throw.
- **Stripping JSON comments cannot be a regex.** The examples are full of
  values like `"https://w3id.org/zcap/v1"`; a naive `//` strip truncates every
  URL in the document. `stripJsonComments` is a string-aware scanner and must
  stay one.
- **Broken pipes are normal.** `... | head -1` closes stdout early. The CLI
  swallows `EPIPE` and exits quietly; do not reintroduce an unhandled write.
- **`build:js` must leave `dist/zcap-spec-examples.js` executable.** `tsc`
  writes files without the executable bit. An installed package is fine (npm
  sets the bit on bins it installs), but `npm link` symlinks straight to
  `dist/`, so a clean rebuild made the linked command fail with
  `Permission denied`. The `chmod` in `build:js` is why; keep it.
- **`npx` invokes through a symlink.** `node_modules/.bin/<name>` is a symlink,
  so `process.argv[1]` is the link path while `import.meta.url` is the resolved
  target. Comparing them naively makes `main()` silently never run — the CLI
  prints nothing and exits 0. `isMainModule()` compares realpaths for this
  reason. There is a regression test; keep it.
- **`files` in package.json lists source explicitly.** Adding a new source
  module means adding it there, or the published tarball ships an incomplete
  `.ts` source tree alongside `dist/`.
- **`extractExamples` streams; `extractExamplesFromHtml` does not.** The
  streaming path keeps only a bounded buffer, resolves the base URL once from
  the `<head>` seen before the first example, and drops each example after
  yielding it. A test asserts heap growth stays far below input size — do not
  "simplify" it into something that concatenates the whole document.
- **Output format depends on whether stdout is a TTY.** Pretty JSON for a
  human, compact NDJSON when piped. The TTY check lives in `nodejs.ts`;
  `ZcapSpecExamplesCli` defaults to `ndjson` because it cannot know. Never make
  pretty-printing the default for piped output — it would break line-based
  consumers.
- **Regexes must not backtrack ambiguously.** The tag scanner uses
  mutually-exclusive alternation (`"[^"]*"|'[^']*'|[^>"']`) so hostile input
  cannot trigger catastrophic backtracking. A test asserts linear behaviour.

## Packaging traps

`dist/` is gitignored but is the published `bin` target, so anything that
skips the build produces a package that installs cleanly and then does
nothing. Three separate mechanisms have to keep working:

1. **`prepare` builds on git install.** `npx github:gobengo/zcap-spec-examples`
   clones the repo, which has no `dist/`. npm runs `prepare` — *not* `prepack`
   — for git dependencies. Removing `prepare` breaks git installs with
   `sh: zcap-spec-examples: command not found`.
2. **`.npmrc` sets `ignore-scripts=true`**, which also disables this package's
   *own* lifecycle scripts. So a bare `npm publish` skips `prepare` and ships
   a tarball with no `dist/`. Always publish with `npm run release`, which
   builds explicitly first. Do not remove `ignore-scripts=true` to "fix" this.
3. **`files` beats `.gitignore`.** `dist/` is gitignored yet still packed,
   because the `files` allowlist takes precedence. Verify before publishing:

```shell
npm pack --dry-run   # must list dist/zcap-spec-examples.js
```

## `--permission` does not compose with `npx`

The README encourages `node --permission ./zcap-spec-examples.ts`, which works
with *zero* allowances when run directly from a clone. It does not survive
`npx`, for two independent reasons, both verified:

- `NODE_OPTIONS=--permission npx ...` hardens npx itself, which then cannot
  read its own files.
- npm installs a `bin` as a symlink, and the module loader cannot read through
  it without `--allow-fs-read`.

So the installed-package recipe needs `--permission --allow-fs-read='*'` and a
real path. Do not "simplify" the README by claiming plain `--permission` works
under `npx`; it does not.

Related: `isMainModule()` prefers `import.meta.main` precisely because it needs
no filesystem access, so it keeps working under `--permission`. The
`realpathSync` branch is only a fallback for Node versions without it.

## Publishing to GitHub Pages

`.github/workflows/gh-pages.yml` builds the site with the `build-website`
action into `build/website/`, the `build-docs` action into
`build/website/docs/`, and uploads that one directory to Pages on every push to
`main`. `docs.yml` runs `build-docs` only as a check. Things to preserve:

- **Only `gh-pages.yml` uploads to Pages.** A deployment replaces the whole
  site, so a second publisher would silently overwrite the first. New content
  goes into the site via a build action, not a new deploy.
- **Build actions don't know about Pages.** They take an `output-directory`
  and write there; where it is served is the workflow's decision.
- **`npm run build:gh-pages` mirrors `gh-pages.yml`.** Change one, change the
  other, so `npm run dev` keeps previewing what actually ships.
- **Pass action inputs to `run:` through `env`**, never `${{ }}` inside the
  script, so a path cannot inject shell.
- **`docs/` and `build/` stay gitignored.** Nothing generated is committed, and
  there is no `gh-pages` branch.
- **`npm ci` does not build `dist/`** in CI, because `.npmrc` sets
  `ignore-scripts=true` and so `prepare` is skipped. That is fine — TypeDoc
  and `website/build.ts` read the `.ts` sources. Do not add a build step to
  "fix" it.
- **Keep all site links relative.** Project Pages serve from
  `/zcap-spec-examples/`, so a root-absolute path would 404. TypeDoc's default
  output is relative; verify with a subpath server if you change the theme.
- Only first-party `actions/*` are used. Prefer keeping it that way, and
  SHA-pin them if you want to match the npm pinning strictness.

## Testing expectations

- Tests use `node:test` and `node:assert/strict`. No test framework, consistent
  with the zero-dependency rule.
- Public API changes should come with JSDoc a newcomer can follow: a sentence
  on what it does, `@param`/`@returns`, an `@example`, and an `@category` that
  matches `etc/typedoc.json`. Run `npm run docs` and look at the result.
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
