#!/usr/bin/env node
/**
 * zcap-spec-examples.ts
 *
 * Extracts the examples from https://w3c-ccg.github.io/zcap-spec/ and
 * prints them to stdout. See README.md for the full description.
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
import { parseArgs, type ParseArgsConfig } from "node:util";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export const DEFAULT_ZCAP_SPEC_URL = "https://w3c-ccg.github.io/zcap-spec/";

export interface ZcapSpecExample {
  /** Stable name for this example -- the element's `id` when it has one, else `example-<n>`. */
  name: string;
  /** The example's source text (e.g. a JSON or HTTP snippet), trimmed. */
  content: string;
  /**
   * Link to this example in its source document. Absolute whenever a base URL
   * can be determined -- from `--base-url`, from a URL the document declares
   * about itself (ReSpec's `edDraftURI`, `<base href>`, `<link rel=canonical>`,
   * `og:url`), or from the URL that was fetched. Falls back to a bare fragment
   * (`#example-1`) when none of those are available.
   */
  url: string;
  /** Best-effort media type of `content`, e.g. `"application/json"`. */
  mediaType: string;
}

export type ZcapSpecExamplesOutputFormat = "json" | "text";

export interface ZcapSpecExamplesCliOptions {
  /** Print help text and exit instead of doing anything else. */
  help?: boolean;
  /** URL to fetch zcap-spec HTML from. Ignored if stdin is piped. */
  url?: string;
  /**
   * Base URL used to build absolute example `url`s. Defaults to the URL that
   * was fetched; set this explicitly to get absolute URLs out of stdin input.
   */
  baseUrl?: string;
  /**
   * Output format. `"json"` (the default) prints newline-delimited JSON --
   * one compact `ZcapSpecExample` object per line -- suitable for piping to
   * `jq`. `"text"` prints a human-readable, numbered listing.
   */
  format?: ZcapSpecExamplesOutputFormat;
}

/** Minimal shape of the Fetch API that `ZcapSpecExamplesCli` depends on. */
export type FetchLike = (url: string) => Promise<{ text(): Promise<string> }>;

export interface ZcapSpecExamplesCliDeps {
  fetch: FetchLike;
  /** Resolves the piped stdin content, or `undefined` if none was piped. */
  readStdin: () => Promise<string | undefined>;
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
}

export const HELP_TEXT =
  `
zcap-spec-examples - extract the examples from zcap-spec

Usage:
  zcap-spec-examples [--url=<url>] [--base-url=<url>] [--format=<format>]
  zcap-spec-examples --help

Options:
  -h --help            Show this help text and exit.
  --url=<url>          Fetch zcap-spec HTML from <url> instead of the default
                       [default: ${DEFAULT_ZCAP_SPEC_URL}].
  --base-url=<url>     Base URL used to build absolute example URLs. Overrides
                       the URL the document declares about itself (ReSpec's
                       edDraftURI, <base href>, rel=canonical, og:url), which
                       is detected automatically -- so piping HTML in usually
                       yields absolute URLs without setting this.
  --format=<format>    Output format: "json" or "text" [default: json].
                       "json" prints newline-delimited JSON (one example object
                       per line), e.g. for piping to jq. "text" prints a
                       human-readable listing.

If data is piped to stdin, it is used as the zcap-spec HTML source instead
of fetching a URL, e.g.:

  cat ~/zcap-spec/index.html | ./zcap-spec-examples.ts

Examples:

  ./zcap-spec-examples.ts | jq '.name'
  ./zcap-spec-examples.ts --format=text
  cat index.html | ./zcap-spec-examples.ts --base-url=https://example.org/spec/
`.trim() + "\n";

// ---------------------------------------------------------------------------
// ZcapSpecExamplesCli - runtime-independent
// ---------------------------------------------------------------------------

export class ZcapSpecExamplesCli {
  private readonly deps: ZcapSpecExamplesCliDeps;

  constructor(deps: ZcapSpecExamplesCliDeps) {
    this.deps = deps;
  }

  async run(options: ZcapSpecExamplesCliOptions): Promise<number> {
    if (options.help) {
      this.deps.writeStdout(HELP_TEXT);
      return 0;
    }

    let html: string;
    // Piped HTML has no URL of its own, but the document usually declares one
    // (ReSpec's edDraftURI, <base href>, rel=canonical, og:url) -- extractExamples
    // discovers that. This is only the last-resort fallback, used when nothing
    // in the document says where it lives.
    let fallbackBaseUrl: string | undefined;

    const stdinContent = await this.deps.readStdin();
    if (stdinContent !== undefined && stdinContent.length > 0) {
      html = stdinContent;
    } else {
      const url = options.url ?? DEFAULT_ZCAP_SPEC_URL;
      fallbackBaseUrl = url;
      try {
        const response = await this.deps.fetch(url);
        html = await response.text();
      } catch (err) {
        this.deps.writeStderr(
          `Failed to fetch ${url}: ${(err as Error).message}\n`,
        );
        return 1;
      }
    }

    const examples = extractExamples(html, {
      baseUrl: options.baseUrl,
      fallbackBaseUrl,
    });
    if (examples.length === 0) {
      this.deps.writeStderr("No examples found in the given HTML source.\n");
      return 1;
    }

    const format = options.format ?? "json";
    if (format === "text") {
      for (const example of examples) {
        this.deps.writeStdout(formatExample(example));
      }
    } else {
      this.deps.writeStdout(formatExamplesAsJson(examples));
    }
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Minimal HTML scanning
//
// This replaces what was previously `node-html-parser` (+10 transitive
// packages). We need only four things from an HTML "parser" here: find
// elements carrying class="example", read a couple of their attributes,
// find a nested <pre>, and flatten an element's descendants to text. That
// is a far smaller job than general HTML5 parsing, and doing it in-repo
// removes a third-party package from the code path that touches untrusted
// remote input. Everything below is pure string scanning: no eval, no
// prototype mutation, no network, no fs.
// ---------------------------------------------------------------------------

/** Matches the remainder of a tag, tolerating `>` inside quoted attribute values. */
const TAG_REST = `(?:"[^"]*"|'[^']*'|[^>"'])*`;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes the named and numeric character references that appear in spec markup. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(cp);
        } catch {
          return whole;
        }
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    },
  );
}

/** Reads one attribute out of a raw attribute string, decoding entities. */
export function getAttribute(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Flattens an HTML fragment to its text content, dropping tags and comments. */
export function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(new RegExp(`<${TAG_REST}>`, "g"), ""),
  );
}

interface RawElement {
  tagName: string;
  attrs: string;
  inner: string;
}

/** Finds the index of the close tag matching an already-open `tagName`, honouring nesting. */
function findCloseIndex(html: string, tagName: string, from: number): number {
  const re = new RegExp(`<(/?)${tagName}\\b${TAG_REST}>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return html.length;
}

/** Finds elements whose tag is one of `tagNames` and whose raw attributes satisfy `attrFilter`. */
function findElements(
  html: string,
  tagNames: string[],
  attrFilter: (attrs: string) => boolean = () => true,
): RawElement[] {
  const open = new RegExp(`<(${tagNames.join("|")})\\b(${TAG_REST})>`, "gi");
  const found: RawElement[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(html)) !== null) {
    const attrs = m[2];
    // Check the cheap filter before doing the O(rest-of-document) close-tag scan.
    if (!attrFilter(attrs)) continue;
    const bodyStart = m.index + m[0].length;
    const end = findCloseIndex(html, m[1].toLowerCase(), bodyStart);
    found.push({ tagName: m[1].toLowerCase(), attrs, inner: html.slice(bodyStart, end) });
    open.lastIndex = end;
  }
  return found;
}

const HAS_EXAMPLE_CLASS = /\bclass\s*=\s*(?:"[^"]*\bexample\b[^"]*"|'[^']*\bexample\b[^']*'|example\b)/i;

/** Attribute strings of opening tags, for void elements that have no close tag. */
function findTagAttrs(html: string, tagNames: string[]): string[] {
  const open = new RegExp(`<(?:${tagNames.join("|")})\\b(${TAG_REST})>`, "gi");
  const attrs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(html)) !== null) attrs.push(m[1]);
  return attrs;
}

/** Reads a quoted string value for `key` out of a JS object literal (e.g. respecConfig). */
function readConfigString(html: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(html);
  return m ? (m[1] ?? m[2]) : undefined;
}

// ---------------------------------------------------------------------------
// Base URL discovery
// ---------------------------------------------------------------------------

/**
 * Find a URL that the document declares about itself, so that piped input
 * (`curl ... | zcap-spec-examples`) can still produce absolute example URLs.
 *
 * zcap-spec is a ReSpec document, and ReSpec runs in the browser -- so the
 * HTML you get over the wire is the *source*, which still carries its
 * `respecConfig`. That config's `edDraftURI` is where the spec is published,
 * which is exactly the base we want. Checked in order:
 *
 *   1. `<base href>`          -- the standard HTML mechanism, so it wins.
 *   2. `respecConfig.edDraftURI`
 *   3. `<link rel="canonical" href>`
 *   4. `<meta property="og:url" content>`
 *   5. `respecConfig.latestVersion`
 *
 * Returns `undefined` when the document says nothing about where it lives.
 */
export function discoverBaseUrl(html: string): string | undefined {
  const candidates: (string | undefined)[] = [];

  for (const attrs of findTagAttrs(html, ["base"])) {
    candidates.push(getAttribute(attrs, "href"));
  }

  candidates.push(readConfigString(html, "edDraftURI"));

  for (const attrs of findTagAttrs(html, ["link"])) {
    if (/\brel\s*=\s*(?:"canonical"|'canonical'|canonical\b)/i.test(attrs)) {
      candidates.push(getAttribute(attrs, "href"));
    }
  }

  for (const attrs of findTagAttrs(html, ["meta"])) {
    if (/\b(?:property|name)\s*=\s*(?:"og:url"|'og:url')/i.test(attrs)) {
      candidates.push(getAttribute(attrs, "content"));
    }
  }

  candidates.push(readConfigString(html, "latestVersion"));

  for (const candidate of candidates) {
    // Only accept something that is actually usable as a base URL.
    if (!candidate) continue;
    try {
      return new URL(candidate).href;
    } catch {
      continue;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractExamplesOptions {
  /**
   * Explicit base URL to resolve each example's fragment against. Overrides
   * any URL the document declares about itself.
   */
  baseUrl?: string;
  /**
   * Base URL used only when `baseUrl` is unset and the document declares no
   * URL of its own -- e.g. the URL the HTML was actually fetched from.
   */
  fallbackBaseUrl?: string;
}

/**
 * Extract examples from zcap-spec HTML.
 *
 * zcap-spec is built with ReSpec, which (depending on version) marks examples
 * up as `<aside class="example">`, `<div class="example">`, or a bare
 * `<pre class="example">`, so we accept any of those.
 */
export function extractExamples(
  html: string,
  options: ExtractExamplesOptions = {},
): ZcapSpecExample[] {
  const containers = findElements(
    html,
    ["aside", "div", "figure", "pre"],
    (attrs) => HAS_EXAMPLE_CLASS.test(attrs),
  );

  const baseUrl =
    options.baseUrl ?? discoverBaseUrl(html) ?? options.fallbackBaseUrl;

  return containers.map((el, i) => {
    const pre =
      el.tagName === "pre" ? el : (findElements(el.inner, ["pre"])[0] ?? null);
    const content = toText(pre ? pre.inner : el.inner).trim();

    // An authored id wins. Otherwise use the positional name, which matches
    // the id ReSpec generates client-side: it numbers pre.example/aside.example
    // in document order and calls addId(div, "example", String(n)) -> example-n.
    const name = getAttribute(el.attrs, "id") ?? `example-${i + 1}`;

    return {
      name,
      content,
      url: buildExampleUrl(name, baseUrl),
      mediaType: guessMediaType(pre, content),
    };
  });
}

/**
 * Absolute URL to the example when a base URL is known, else a bare fragment.
 * A malformed base URL degrades to the fragment rather than throwing.
 */
function buildExampleUrl(name: string, baseUrl?: string): string {
  const fragment = `#${name}`;
  if (!baseUrl) return fragment;
  try {
    return new URL(fragment, baseUrl).href;
  } catch {
    return fragment;
  }
}

/**
 * Remove `//` line comments and block comments from JSON-with-comments,
 * leaving everything else byte-for-byte intact.
 *
 * This has to be string-aware rather than a regex: spec examples are full of
 * values like `"https://w3id.org/zcap/v1"`, and a naive `//` strip would
 * truncate every one of them. Comment starts are only recognised outside of
 * string literals, with backslash escapes honoured.
 *
 * Exported so consumers can do `JSON.parse(stripJsonComments(example.content))`
 * on examples reported as `application/jsonc`.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n"; // keep line structure so error offsets stay sane
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // step onto the closing "/", the loop's i++ moves past it
      out += " ";
      continue;
    }

    out += ch;
  }

  return out;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort media type of an example's content.
 *
 * Non-JSON language hints from the `<pre>`/`<code>` class (as ReSpec/
 * highlight.js emit) are taken at face value. For the JSON family the content
 * itself decides, because a class of `json` or `javascript` says nothing about
 * whether the bytes actually parse:
 *
 *   - parses as JSON                     -> application/json
 *                                           (application/ld+json if the class
 *                                           says so)
 *   - parses only once comments are gone -> application/jsonc
 *   - neither                            -> text/plain
 */
function guessMediaType(pre: RawElement | null, content: string): string {
  const codeAttrs = pre ? (findElements(pre.inner, ["code"])[0]?.attrs ?? "") : "";
  const classAttr = `${pre?.attrs ?? ""} ${codeAttrs}`.toLowerCase();

  if (/\bhttp\b/.test(classAttr)) return "message/http";
  if (/\bturtle\b/.test(classAttr)) return "text/turtle";
  if (/\bhtml\b/.test(classAttr)) return "text/html";

  if (isJson(content)) {
    return /\bjson-?ld\b/.test(classAttr)
      ? "application/ld+json"
      : "application/json";
  }
  // Many spec examples are annotated with `//` commentary, which is not JSON
  // but is JSONC. Report that rather than the uselessly vague text/plain.
  if (isJson(stripJsonComments(content))) return "application/jsonc";

  return "text/plain";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatExample(example: ZcapSpecExample): string {
  const label = `${example.name} (${example.mediaType})`;
  const divider = "-".repeat(label.length);
  const location = example.url ? `${example.url}\n` : "";
  return `${label}\n${divider}\n${location}${example.content}\n\n`;
}

/**
 * Renders all examples as newline-delimited JSON (one compact JSON object
 * per line), e.g. for piping to `jq` -- `jq .` and friends read an NDJSON
 * stream as a sequence of values without needing `-s`/`--slurp`.
 */
export function formatExamplesAsJson(examples: ZcapSpecExample[]): string {
  return examples.map((example) => JSON.stringify(example)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// NodejsZcapSpecExamplesCli - Node.js-specific
// ---------------------------------------------------------------------------

/**
 * Config for these CLI options, in the same shape expected by Node's
 * `util.parseArgs`. Kept as a plain object literal (rather than importing
 * `node:util`'s types at the top level of the runtime-independent class)
 * so `ZcapSpecExamplesCli` above stays free of Node-specific imports.
 */
export const NODEJS_CLI_PARSE_ARGS_OPTIONS = {
  help: { type: "boolean", short: "h" },
  url: { type: "string" },
  "base-url": { type: "string" },
  format: { type: "string" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

export class NodejsZcapSpecExamplesCli {
  static readonly options = NODEJS_CLI_PARSE_ARGS_OPTIONS;

  private readonly proc: NodeJS.Process;
  private readonly cli: ZcapSpecExamplesCli;

  constructor(proc: NodeJS.Process) {
    this.proc = proc;

    // A downstream consumer may close the pipe before we finish writing --
    // `... | head -1`, `... | jq -e 'first(...)'`, a user quitting a pager.
    // That is normal for a CLI, so stop writing and finish quietly instead of
    // dying with an unhandled EPIPE.
    let stdoutOpen = true;
    const onStdoutError = (err: NodeJS.ErrnoException) => {
      stdoutOpen = false;
      if (err.code !== "EPIPE") {
        proc.exitCode = 1;
        try {
          proc.stderr.write(`stdout error: ${err.message}\n`);
        } catch {
          // stderr is gone too; nothing useful left to do.
        }
      }
    };
    proc.stdout.on("error", onStdoutError);

    this.cli = new ZcapSpecExamplesCli({
      fetch: (url) => globalThis.fetch(url),
      readStdin: () => readAllStdin(proc),
      writeStdout: (chunk) => {
        if (!stdoutOpen) return;
        try {
          proc.stdout.write(chunk);
        } catch {
          stdoutOpen = false;
        }
      },
      writeStderr: (chunk) => {
        try {
          proc.stderr.write(chunk);
        } catch {
          // Ignore: a closed stderr must not mask the real result.
        }
      },
    });
  }

  /** `argv` should already have the node binary and script path stripped, e.g. `process.argv.slice(2)`. */
  async run(argv: string[]): Promise<number> {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: argv,
        options: NodejsZcapSpecExamplesCli.options,
        allowPositionals: false,
      });
    } catch (err) {
      this.proc.stderr.write(`${(err as Error).message}\n\n`);
      this.proc.stderr.write(HELP_TEXT);
      return 1;
    }

    const rawFormat = parsed.values.format as string | undefined;
    if (rawFormat !== undefined && rawFormat !== "json" && rawFormat !== "text") {
      this.proc.stderr.write(
        `Invalid --format "${rawFormat}": expected "json" or "text".\n\n`,
      );
      this.proc.stderr.write(HELP_TEXT);
      return 1;
    }

    return this.cli.run({
      help: parsed.values.help as boolean | undefined,
      url: parsed.values.url as string | undefined,
      baseUrl: parsed.values["base-url"] as string | undefined,
      format: rawFormat as ZcapSpecExamplesOutputFormat | undefined,
    });
  }
}

async function readAllStdin(proc: NodeJS.Process): Promise<string | undefined> {
  if (proc.stdin.isTTY) {
    // Nothing piped in; don't block waiting for input that will never come.
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of proc.stdin) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const cli = new NodejsZcapSpecExamplesCli(globalThis.process);
  const exitCode = await cli.run(globalThis.process.argv.slice(2));
  globalThis.process.exitCode = exitCode;
}

function isMainModule(): boolean {
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

  // Installed from npm: `npx zcap-spec-examples` runs node_modules/.bin/<name>,
  // which is a symlink to this file -- so argv[1] is the link while
  // import.meta.url is the resolved target, and a plain comparison misses.
  //
  // realpathSync is a filesystem read, denied under `node --permission` with no
  // --allow-fs-read. That combination only arises for direct invocation, which
  // the check above already handled, so the throw is safely treated as "not main".
  try {
    return realpathSync(entry) === here;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
