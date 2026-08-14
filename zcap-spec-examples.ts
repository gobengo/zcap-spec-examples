#!/usr/bin/env node
/**
 * Extract the code examples out of the [zcap-spec](https://w3c-ccg.github.io/zcap-spec/)
 * — or any ReSpec document — as structured data.
 *
 * This module is both a command-line tool and a small library with no runtime
 * dependencies. If you are here to use the JavaScript API, you almost certainly
 * want {@link extractExamples}, and then {@link stripJsonComments} to parse
 * what it gives back.
 *
 * ## Quick start
 *
 * Give {@link extractExamples} a string of HTML and get back an array of
 * {@link ZcapSpecExample} objects:
 *
 * ```js
 * import { extractExamples } from "zcap-spec-examples";
 *
 * const response = await fetch("https://w3c-ccg.github.io/zcap-spec/");
 *
 * for await (const example of extractExamples(response)) {
 *   console.log(example.name);      // "example-1"
 *   console.log(example.url);       // "https://w3c-ccg.github.io/zcap-spec/#example-1"
 *   console.log(example.mediaType); // "application/jsonc"
 * }
 * ```
 *
 * The response body is streamed: each example is yielded as soon as its closing
 * tag arrives, and the document is never held in memory as a whole. Pass a
 * string, a `ReadableStream`, or any async iterable of chunks instead if you
 * prefer. If you already have the HTML as a string and want an array back, use
 * {@link extractExamplesFromHtml}.
 *
 * ## Parsing an example's content
 *
 * Do **not** assume `example.content` is valid JSON. Most zcap-spec examples are
 * annotated with `//` comments, which makes them JSONC, not JSON — that is what
 * the `"application/jsonc"` media type means. Check `mediaType`, and run the
 * content through {@link stripJsonComments} before parsing:
 *
 * ```js
 * import { extractExamples, stripJsonComments } from "zcap-spec-examples";
 *
 * for await (const example of extractExamples(response)) {
 *   if (example.mediaType === "application/json") {
 *     console.log(JSON.parse(example.content));
 *   } else if (example.mediaType === "application/jsonc") {
 *     console.log(JSON.parse(stripJsonComments(example.content)));
 *   }
 *   // anything else is not JSON at all -- e.g. "message/http"
 * }
 * ```
 *
 * ## Where the URLs come from
 *
 * ReSpec runs in the browser, so fetching a ReSpec spec gives you the *source*
 * document: the examples have no `id` attributes yet, but the page still
 * declares where it is published. {@link extractExamples} finds that (see
 * {@link discoverBaseUrl}) and numbers the examples the same way ReSpec will,
 * so `example.url` links to the right place on the rendered page. Pass
 * {@link ExtractExamplesOptions.baseUrl} to override it.
 *
 * @packageDocumentation
 */

/*
 * Implementation notes (not part of the public API):
 *
 * Design:
 *   - `ZcapSpecExamplesCli` contains all the runtime-independent logic
 *     (fetching, parsing, formatting). It never touches `process`,
 *     `fetch`, or any other runtime global directly -- everything it
 *     needs is passed in.
 *   - `NodejsZcapSpecExamplesCli` wraps the Node.js-specific bits
 *     (argv parsing via `node:util`, `process.stdin`/`stdout`/`stderr`)
 *     and delegates to `ZcapSpecExamplesCli`.
 *   - `main()` is only invoked when this file is run as the entrypoint,
 *     and is the only place that reaches for `globalThis.process`.
 *
 * Security: this file has ZERO runtime dependencies. The HTML scanning
 * below is deliberately hand-rolled rather than delegated to a parser
 * library, because the input is untrusted remote HTML. See the "Security"
 * section of README.md for the full rationale.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main } from "./nodejs.ts";

// The public API. Implementations live in the modules below; this file is the
// package entry point and the executable script.
export * from "./examples.ts";
export * from "./ZcapSpecExamplesCli.ts";
export * from "./nodejs.ts";

function isMainModule(): boolean {
  // Node's own answer, when available (Node 22.18+ / 24+). Preferred because it
  // needs no filesystem access, so it keeps working under `node --permission`
  // and correctly reports `true` when invoked through the symlink npm installs
  // for a `bin` -- the case `npx` uses.
  if (typeof import.meta.main === "boolean") return import.meta.main;

  const entry = globalThis.process.argv[1];
  if (!entry) return false;

  let here: string;
  try {
    here = fileURLToPath(import.meta.url);
  } catch {
    return false;
  }

  // Direct invocation: `./zcap-spec-examples.ts`, `node dist/....js`.
  if (here === entry) return true;

  // Older Node: `npx zcap-spec-examples` runs node_modules/.bin/<name>, a
  // symlink to this file, so argv[1] is the link while import.meta.url is the
  // resolved target and a plain comparison misses. realpathSync is a filesystem
  // read, so it is denied under `--permission`; treat that as "not main"
  // rather than crashing.
  try {
    return realpathSync(entry) === here;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
