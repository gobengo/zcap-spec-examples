# zcap-spec-examples

This repository contains tools for extracting the examples from [zcap-spec][].

These tools have been useful for the spec authors to quickly ensure that every example in the zcap-spec satisfies a schema of the required properties.

You can use this to build your own scripts and apps that make use of the latest zcap-spec examples, all derived from (whatever you deem to be) the canonical source document zcap-spec.

## Requirements

- [Node.js](https://nodejs.org/) ≥ 22.18.0 (runs TypeScript directly via type stripping)

That is the version where type stripping became the default, so no flag and no
build step are needed. On Node 22.6–22.17 and 23.0–23.5 the same code runs with
`node --experimental-strip-types`.

No other dependencies are required — there are **zero runtime dependencies**.
See [Security](#security) for why that is a deliberate design goal.

## Install

Published to npm, so it can be run without installing anything:

```shell
npx zcap-spec-examples --help
curl -sS https://w3c-ccg.github.io/zcap-spec/ | npx zcap-spec-examples | jq -r .url
```

It can also be run straight from the repository, which builds it on install:

```shell
npx github:gobengo/zcap-spec-examples --help
```

Or install it, as a CLI or as a library:

```shell
npm install zcap-spec-examples
```

```js
import { extractExamples, stripJsonComments } from "zcap-spec-examples";

const response = await fetch("https://w3c-ccg.github.io/zcap-spec/");

for await (const example of extractExamples(response)) {
  console.log(example.name, example.url, example.mediaType);
}
```

`extractExamples` streams: it takes a `Response`, a `ReadableStream`, an async
iterable of chunks, or a plain string, and yields each example as soon as its
closing tag arrives — the document is never buffered in full. When you already
have the HTML as a string and want an array back, `extractExamplesFromHtml`
does that synchronously.

The published package ships compiled JavaScript in `dist/` (plus the original
TypeScript source), so `npx` works on Node ≥ 20 without type stripping. Running
from a clone still needs Node ≥ 22.18, per [Requirements](#requirements).

## Getting Started

```shell
git clone https://github.com/gobengo/zcap-spec-examples.git
cd zcap-spec-examples
./zcap-spec-examples.ts --help
```

If that fails with `permission denied`, the file lost its executable bit
somewhere along the way; restore it with `chmod +x ./zcap-spec-examples.ts`.

## Usage

Running `./zcap-spec-examples.ts` with no arguments fetches the spec from
<https://w3c-ccg.github.io/zcap-spec/>, parses the examples, and prints them
to stdout.

- `--help` shows help text in docopt format.
- `--url <url>` fetches the spec from any fetchable URL instead of the default.
- `--base-url <url>` sets the base URL used to build absolute example `url`s.
  Rarely needed — it overrides the URL the document declares about itself,
  which is detected automatically (see below).
- `--format <format>` selects `json` (indented), `ndjson` (one compact object
  per line), or `text` (a human-readable listing). See below for the default.

If stdin is piped in, it is used as the source of zcap-spec HTML:

```shell
cat ~/zcap-spec/index.html | ./zcap-spec-examples.ts
```

Since it reads stdin, any other tool can supply the HTML — for example `curl`,
so that this script never touches the network itself:

```shell
curl -sS https://w3c-ccg.github.io/zcap-spec/ | ./zcap-spec-examples.ts
```

Piped input still produces **absolute** example URLs. zcap-spec is a ReSpec
document, and ReSpec runs in the browser — so what `curl` fetches is the spec
*source*, which still carries its `respecConfig`. That config's `edDraftURI`
says where the spec is published, so it is used as the base URL:

```shell
curl -sS https://w3c-ccg.github.io/zcap-spec/ | ./zcap-spec-examples.ts | jq -r .url
# https://w3c-ccg.github.io/zcap-spec/#example-1
# https://w3c-ccg.github.io/zcap-spec/#example-2
# ...
```

The base URL is resolved in this order, first match wins:

1. `--base-url`, if given.
2. A URL the document declares about itself: `<base href>`, then
   `respecConfig.edDraftURI`, then `<link rel="canonical">`, then
   `<meta property="og:url">`, then `respecConfig.latestVersion`.
3. The URL the HTML was fetched from (fetch mode only).
4. Nothing — in which case `url` is a bare `#fragment`.

Note that a document-declared URL beats the URL you happened to fetch from, so
pointing `--url` at a mirror still yields links to the canonical spec. Use
`--base-url` to force something else.

> If this prints `zsh: permission denied: ./zcap-spec-examples.ts` followed by
> `curl: (56) Failure writing output to destination`, only the first error is
> real — the curl message is just curl noticing that the pipe closed. Run
> `chmod +x ./zcap-spec-examples.ts`, or invoke it as
> `curl -sS <url> | node ./zcap-spec-examples.ts`.

Each extracted example is printed as a JSON object:

```json
{
  "name": "example-1",
  "content": "{\n  \"@context\": [...],\n  \"id\": \"urn:uuid:...\"\n}",
  "url": "https://w3c-ccg.github.io/zcap-spec/#example-1",
  "mediaType": "application/json"
}
```

- `name` — the example element's `id` when it has one, otherwise a positional
  `example-<n>`. ReSpec numbers examples in document order and assigns
  `id="example-<n>"` when it renders, so the positional name matches the id the
  published page ends up using.
- `url` — a link to the example in its source document, always present.
  Absolute whenever a base URL can be determined (see the resolution order
  above), otherwise a bare `#fragment`. The fragment is `#<name>`, which
  matches the id ReSpec generates client-side, so the link resolves against the
  rendered spec even though the source HTML has no ids yet.
- `mediaType` — non-JSON language hints from the `<pre>`/`<code>` class
  (`http`, `turtle`, `html`) are taken at face value. For the JSON family the
  content itself decides, because a class of `json` or `javascript` says
  nothing about whether the bytes actually parse:

  | Content | `mediaType` |
  | --- | --- |
  | parses as JSON | `application/json` (or `application/ld+json` if the class says JSON-LD) |
  | parses only once comments are removed | `application/jsonc` |
  | neither | `text/plain` |

  Most zcap-spec examples are annotated with `//` commentary, so they come back
  as `application/jsonc` — valid JSON with comments, not valid JSON. To parse
  those, strip the comments first:

  ```js
  import { stripJsonComments } from "./zcap-spec-examples.ts";
  const value = JSON.parse(stripJsonComments(example.content));
  ```

  `stripJsonComments` is string-aware, so `//` inside a value such as
  `"https://w3id.org/zcap/v1"` is left alone — a plain regex would truncate
  every URL in the document.

### Output formats

Output adapts to where it is going, the way `git log` and `ls --color=auto` do:

- **At a terminal** you get indented JSON, so trying the tool out by hand is
  readable.
- **Piped or redirected** you get newline-delimited JSON (NDJSON) — one compact
  object per line — so pipelines and line-based tools are unaffected.

Both are a valid stream of JSON values for `jq`, so this works either way:

```shell
./zcap-spec-examples.ts | jq -r .name
```

Force one with `--format=json`, `--format=ndjson`, or `--format=text`.

## Repository layout

The root is kept deliberately thin: the CLI, and the files that npm and
TypeScript insist on finding there.

```
zcap-spec-examples.ts        entry point: the executable script, and the
                             package's public API (re-exported from below)
nodejs.ts                    Node.js wiring — argv, stdin/stdout, broken pipes
ZcapSpecExamplesCli.ts       what the CLI does, with the runtime injected
examples.ts                  extraction and parsing — pure, zero imports
test/                        tests, discovered automatically by `node --test`
etc/
  tsconfig.build.json        emitting build config (see `npm run build:js`)
  typedoc.json               API docs config (see `npm run docs`)
  zcap-spec-examples/        sample spec HTML for manual runs
dist/                        build output (gitignored)
docs/                        generated API docs (gitignored)
```

The dependency direction is one-way — `examples.ts` → `ZcapSpecExamplesCli.ts`
→ `nodejs.ts` → `zcap-spec-examples.ts` — so the extraction logic and the CLI
behaviour stay usable outside Node. Modules import each other with explicit
`.ts` extensions so the code runs with no build step;
`rewriteRelativeImportExtensions` rewrites those to `.js` when building.

`package.json`, `package-lock.json`, `tsconfig.json`, `.npmrc` and `.gitignore`
stay at the root because their tools resolve them by convention from there.

## Testing

Use `node --test` to run the tests.

If you use npm, `npm test` should run the tests.

`npm run tsc` type-checks the sources. It runs `tsc --noEmit`, so it never
generates JavaScript — type-checking and running are fully decoupled.

`npm run docs` generates API documentation from the JSDoc comments with
TypeDoc, into `docs/` (gitignored):

```shell
npm run docs && open docs/index.html
```

The same output is published to GitHub Pages at
<https://gobengo.github.io/zcap-spec-examples/> by
`.github/workflows/docs.yml`, on every push to `main`.

The workflow builds the docs and uploads them straight to Pages — there is no
`gh-pages` branch and nothing generated is ever committed, which is why `docs/`
stays in `.gitignore`. It uses only first-party `actions/*` steps.

This requires a one-time repository setting: **Settings → Pages → Build and
deployment → Source: GitHub Actions**. If that is left on "Deploy from a
branch", the workflow will run green and publish nothing.

`npm run build:js` compiles to JavaScript when you actually want it, via
`etc/tsconfig.build.json`, emitting `.js`, `.d.ts`, and source maps into
`dist/`:

```shell
npm run build:js
node dist/zcap-spec-examples.js --help
```

`dist/` and any stray compiler output (`*.js`, `*.d.ts`, `*.tsbuildinfo`) are
listed in `.gitignore`, so build artifacts are never committed. The build
excludes the tests, which import `../zcap-spec-examples.ts` by its `.ts`
extension — fine for type stripping, but not emittable.

### Editor setup

`.vscode/settings.json` pins `typescript.tsdk` to the TypeScript in
`node_modules`. Without it, VS Code / VSCodium may type-check with its own
bundled `tsc`, which can be older than the version this project depends on and
can report errors *inside* `node_modules/@types/node` that `npm run tsc` does
not. If your editor still shows those errors, run **TypeScript: Select
TypeScript Version → Use Workspace Version**, then **TypeScript: Restart TS
Server**.

### Publishing

`npm run release` builds and publishes.

> **Do not run a bare `npm publish`.** `.npmrc` sets `ignore-scripts=true` as a
> supply-chain control, and that also disables this package's own lifecycle
> scripts — so `prepare` does not run, and the tarball would ship without
> `dist/`. The result installs fine and then does nothing when invoked. The
> `release` script builds explicitly first, which sidesteps this. Confirm with
> `npm pack --dry-run` that `dist/zcap-spec-examples.js` is listed.

The `prepare` script is what makes `npx github:gobengo/zcap-spec-examples`
work: installing from git gets a clone with no `dist/`, and npm runs `prepare`
(not `prepack`) to build it. Removing `prepare` would silently break git
installs with `command not found`.

## Security

### Threat model

The primary input is **untrusted HTML fetched over the network** from a host
this tool does not control. The secondary concern is the **software supply
chain**: every package in the dependency tree is a party allowed to run code,
at install time or at runtime, on that same untrusted input.

The tool never writes files, never spawns subprocesses, and never evaluates any
part of its input. Its only filesystem call is a `realpathSync` on its own
entry point, used to detect whether it was invoked directly or through the
symlink npm installs for a `bin`; it is wrapped in a `try`/`catch` so that
running under `--permission` with no `--allow-fs-read` still works.

### Dependencies, and why there are so few

Each dependency has to earn its place. The rule applied here: **if a dependency
can be replaced by a modest amount of in-repo code, replace it.**

| Package | Kind | Verdict |
| --- | --- | --- |
| *(none)* | runtime | There are **zero** runtime dependencies. |
| `typescript` | dev only | Kept. Provides `npm run tsc`. Never runs in the code path that touches untrusted input, and emits nothing. |
| `@types/node` | dev only | Kept. Type declarations only — erased before execution, so no `@types/*` package can run anything, at install or at runtime. |
| `typedoc` | dev only | Kept. Generates `npm run docs`. Brings transitive dependencies, but runs only when a maintainer builds docs — never during install, and never on spec input. |

The in-repo scanner is deliberately boring: pure string operations, no `eval`
or `new Function`, no prototype mutation, no filesystem or network access. Its
regexes use mutually-exclusive alternation branches (`"[^"]*"|'[^']*'|[^>"']`)
that cannot backtrack ambiguously, so a hostile document cannot trigger
catastrophic backtracking (ReDoS). A test asserts this stays linear on
adversarial input.

### Supply-chain mitigations

- **Exact version pins.** `devDependencies` are pinned to exact versions (no
  `^` ranges), and `.npmrc` sets `save-exact=true` so future installs stay
  pinned.
- **Committed lockfile, installed with `npm ci`.** Prefer `npm ci` over
  `npm install` for a reproducible tree from `package-lock.json`.
- **Install scripts disabled.** `.npmrc` sets `ignore-scripts=true`, which
  neutralises the `preinstall`/`install`/`postinstall` hooks that are a common
  supply-chain attack vector. Neither remaining dependency uses them, so
  nothing breaks.
- **Zero runtime dependencies** means a compromised registry package cannot
  reach the code path that processes untrusted HTML at all.

### Sandboxing with the Node.js permission model

Node's [permission model][permissions] restricts what a process may do, and
this tool needs very little. Run it with `--permission` and grant nothing:

```shell
# no filesystem, no subprocesses, and no network needed at all
curl -sS https://w3c-ccg.github.io/zcap-spec/ | node --permission ./zcap-spec-examples.ts
```

`npm run start:hardened` runs the fetching mode the same way.

Under `--permission` with no `--allow-*` flags, `fs.readFile`, `fs.writeFile`,
and `child_process` all fail with `ERR_ACCESS_DENIED`, while the tool keeps
working — it only needs stdin, stdout, and (in fetch mode) the network. The
entry-point script is readable by default, so no `--allow-fs-read` is required.

This works when running the script directly, from a clone. It does **not**
compose with `npx`:

- `NODE_OPTIONS=--permission npx ...` hardens `npx` itself — npx is a Node
  program, and it dies trying to read its own files.
- npm installs a `bin` as a symlink, and under `--permission` the module loader
  cannot read through it without an `--allow-fs-read` allowance.

For an installed copy, point Node at the real file and allow reads. Writes,
subprocesses, workers, and addons stay denied:

```shell
node --permission --allow-fs-read='*' \
  "$(npm root)/zcap-spec-examples/dist/zcap-spec-examples.js" --help
```

Three caveats worth knowing:

- **Network access is only gated on Node ≥ 25**, via `--allow-net`. On Node
  22–24, `--permission` covers the filesystem, child processes, workers,
  addons, and WASI, but `fetch` is *not* restricted. To guarantee no network
  access on those versions, use the `curl | ...` stdin form above, or an
  OS-level sandbox, rather than relying on Node alone.
- The permission model is explicitly documented as **not** a defence against
  deliberately malicious code — it is a seat belt against unintended access,
  not a security boundary around a hostile dependency. That is why minimising
  dependencies is the primary control here, and sandboxing is the backstop.

### Handling the output safely

`content` is untrusted text copied out of a remote document. It is emitted via
`JSON.stringify`, so quotes and control characters are escaped and each NDJSON
record stays on exactly one line. Downstream consumers should still treat it as
data — never `eval` it, and never interpolate it into a shell command.

## Design

This section specifies the intended architecture, primarily for contributors and code-generation tools.
End users can stop at [Testing](#testing).

### `ZcapSpecExamplesCli`

`ZcapSpecExamplesCli` should be a class that encapsulates the logic above.
`ZcapSpecExamplesCli` should not have static dependencies on global APIs that are specific to a runtime like node.js. Instead, it should have constructor or method arguments where things like `process.stdin` or `process.stdout` can be injected at runtime.

Internal functions of ZcapSpecExamplesCli may further abstract 'writing to stdout' to an async generator function `yield`s of stdout strings and/or objects that represent effects to write to named stream.

ZcapSpecExamplesCli should write each example using a well-defined JSON format, e.g.
```json
{
    "name": "example-5",
    "content": "<string of example>",
    "url": "https://w3c-ccg.github.io/zcap-spec/#example-1",
    "mediaType": "application/json"
}
```

### `NodejsZcapSpecExamplesCli`

This encapsulates NodeJS-specific static/global dependencies, and delegates to `ZcapSpecExamplesCli` for NodeJS-independent logic.

`NodejsZcapSpecExamplesCli.options` should be configuration describing the CLI arguments. It should use the same format as expected by [NodeJS `util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig), but without a static dependency on `node:util`.

When `./zcap-spec-examples.ts` is invoked as the main script,
a `main` function should run,
which should construct and run a `NodejsZcapSpecExamplesCli`
using `globalThis.process` et al.

[zcap-spec]: https://w3c-ccg.github.io/zcap-spec/
[permissions]: https://nodejs.org/api/permissions.html

## Code Authorship

Commercial LLMs helped write the code based on an initial human-authored README.md.
The LLM providers were helped by training on the work of many many humans.
