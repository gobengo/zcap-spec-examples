/**
 * Extracting examples from ReSpec/zcap-spec HTML.
 *
 * Pure and runtime-independent: no `process`, no `fetch`, no `node:*` imports,
 * and no third-party dependencies. Everything here operates on strings, so it
 * runs unchanged in Node, a browser, or a worker.
 *
 * @module
 */

/**
 * A single example extracted from a spec document.
 *
 * This is what {@link extractExamples} returns, and exactly what the CLI prints
 * as one line of NDJSON.
 *
 * @category Extracting examples
 */
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

/** Decodes the named and numeric character references that appear in spec markup.  *
 * @category HTML scanning internals
 */
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

/** Reads one attribute out of a raw attribute string, decoding entities.  *
 * @category HTML scanning internals
 */
export function getAttribute(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Flattens an HTML fragment to its text content, dropping tags and comments.  *
 * @category HTML scanning internals
 */
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
 * You rarely need to call this yourself — {@link extractExamples} already does.
 * It is exported for when you want to know the spec's own URL.
 *
 * @param html - The HTML document to inspect.
 * @returns An absolute URL, or `undefined` if the document declares none.
 *
 * @example
 * ```js
 * discoverBaseUrl(html); // "https://w3c-ccg.github.io/zcap-spec/"
 * ```
 *
 * @category Extracting examples
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

/**
 * Options for {@link extractExamples}. Both fields are about one thing: what to
 * resolve each example's `#fragment` against.
 *
 * @category Extracting examples
 */
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
 * Extract every example from a ReSpec/zcap-spec HTML document.
 *
 * This is the main entry point of the library. Pass it HTML as a string —
 * fetched, read from disk, whatever — and it returns one
 * {@link ZcapSpecExample} per example block, in document order.
 *
 * Examples are recognised by a `class="example"` on an `<aside>`, `<div>`,
 * `<figure>`, or `<pre>`, which covers the shapes different ReSpec versions
 * produce. Markup nested inside the example (syntax-highlighting `<span>`s and
 * the like) is flattened away and HTML entities are decoded, so `content` is
 * the example text as an author would write it.
 *
 * @param html - A complete HTML document, or any fragment containing examples.
 * @param options - Optional base-URL control; see {@link ExtractExamplesOptions}.
 * @returns One object per example, in document order. Empty if none are found.
 *
 * @example Extract examples from the live spec
 * ```js
 * const html = await (await fetch("https://w3c-ccg.github.io/zcap-spec/")).text();
 * const examples = extractExamples(html);
 * console.log(examples.length); // 7
 * console.log(examples[0].url); // "https://w3c-ccg.github.io/zcap-spec/#example-1"
 * ```
 *
 * @example Point the links somewhere else
 * ```js
 * const examples = extractExamples(html, { baseUrl: "https://my-mirror.example/spec/" });
 * console.log(examples[0].url); // "https://my-mirror.example/spec/#example-1"
 * ```
 *
 * @category Extracting examples
 */
/** Builds one {@link ZcapSpecExample} from a matched container element. */
function toExample(
  el: RawElement,
  index: number,
  baseUrl: string | undefined,
): ZcapSpecExample {
  const pre =
    el.tagName === "pre" ? el : (findElements(el.inner, ["pre"])[0] ?? null);
  const content = toText(pre ? pre.inner : el.inner).trim();

  // An authored id wins. Otherwise use the positional name, which matches
  // the id ReSpec generates client-side: it numbers pre.example/aside.example
  // in document order and calls addId(div, "example", String(n)) -> example-n.
  const name = getAttribute(el.attrs, "id") ?? `example-${index + 1}`;

  return {
    name,
    content,
    url: buildExampleUrl(name, baseUrl),
    mediaType: guessMediaType(pre, content),
  };
}

/**
 * Extract every example from an HTML string you already hold in memory.
 *
 * The synchronous counterpart to {@link extractExamples}. Use this when you
 * have the whole document as a string anyway; prefer {@link extractExamples}
 * when reading from the network or a file, so the document never has to be
 * buffered in full.
 *
 * @param html - A complete HTML document, or any fragment containing examples.
 * @param options - Optional base-URL control; see {@link ExtractExamplesOptions}.
 * @returns One object per example, in document order. Empty if none are found.
 *
 * @example
 * ```js
 * const examples = extractExamplesFromHtml(await readFile("index.html", "utf8"));
 * ```
 *
 * @category Extracting examples
 */
export function extractExamplesFromHtml(
  html: string,
  options: ExtractExamplesOptions = {},
): ZcapSpecExample[] {
  const containers = findElements(
    html,
    EXAMPLE_TAGS,
    (attrs) => HAS_EXAMPLE_CLASS.test(attrs),
  );

  const baseUrl =
    options.baseUrl ?? discoverBaseUrl(html) ?? options.fallbackBaseUrl;

  return containers.map((el, i) => toExample(el, i, baseUrl));
}

/** Tags that can carry `class="example"`. */
const EXAMPLE_TAGS = ["aside", "div", "figure", "pre"];

/**
 * Anything {@link extractExamples} can read HTML out of: a string, a `Response`,
 * a `ReadableStream`, or any async iterable of chunks (such as a Node stream).
 *
 * @category Extracting examples
 */
export type HtmlSource =
  | string
  | { body: ReadableStream<Uint8Array> | null }
  | ReadableStream<Uint8Array | string>
  | AsyncIterable<Uint8Array | string>;

/** Normalises any {@link HtmlSource} into a sequence of decoded string chunks. */
async function* toChunks(source: HtmlSource): AsyncGenerator<string> {
  if (typeof source === "string") {
    yield source;
    return;
  }

  // A Response (or anything Response-shaped) -- read its body.
  let stream: unknown = source;
  if (typeof source === "object" && source !== null && "body" in source) {
    const body = (source as { body: unknown }).body;
    if (body === null || body === undefined) {
      throw new TypeError("extractExamples: the response has no body to read");
    }
    stream = body;
  }

  // Decode incrementally: a multi-byte character can straddle a chunk boundary,
  // and `stream: true` makes TextDecoder hold the partial sequence until the
  // rest arrives instead of emitting U+FFFD.
  const decoder = new TextDecoder();
  const decode = (chunk: Uint8Array | string): string =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

  const asIterable = stream as AsyncIterable<Uint8Array | string>;
  const asStream = stream as ReadableStream<Uint8Array | string>;

  if (typeof asIterable?.[Symbol.asyncIterator] === "function") {
    // Node streams, and ReadableStream on runtimes where it is async-iterable.
    for await (const chunk of asIterable) yield decode(chunk);
  } else if (typeof asStream?.getReader === "function") {
    // ReadableStream where it is not (notably browsers).
    const reader = asStream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) yield decode(value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    throw new TypeError(
      "extractExamples: expected a string, Response, ReadableStream, or async iterable",
    );
  }

  // Flush any character left pending in the decoder.
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * Bytes kept while no example is part-way through. Only needs to span a single
 * opening tag, so this is generous.
 */
const SCAN_TAIL_LIMIT = 1 << 16;

/** Prefix retained for base-URL discovery. A spec's `<head>` is far smaller. */
const HEAD_LIMIT = 1 << 20;

/**
 * Like {@link findCloseIndex} but reports "not here yet" instead of assuming
 * end-of-input, which is the distinction that makes streaming possible.
 */
function findCloseIndexOrNull(
  html: string,
  tagName: string,
  from: number,
): number | null {
  const re = new RegExp(`<(/?)${tagName}\\b${TAG_REST}>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return null;
}

/**
 * Extract every example from a ReSpec/zcap-spec document, streaming.
 *
 * This is the main entry point of the library. It accepts a `Response`, a
 * `ReadableStream`, any async iterable of chunks, or a plain string, and yields
 * one {@link ZcapSpecExample} at a time, in document order.
 *
 * Nothing accumulates: each example is emitted as soon as its closing tag
 * arrives and is then dropped, so memory stays flat regardless of document
 * size. You never have to hold the whole spec as a string.
 *
 * Examples are recognised by a `class="example"` on an `<aside>`, `<div>`,
 * `<figure>`, or `<pre>`, which covers the shapes different ReSpec versions
 * produce. Markup nested inside the example (syntax-highlighting `<span>`s and
 * the like) is flattened away and HTML entities are decoded, so `content` is
 * the example text as an author would write it.
 *
 * @param source - Where to read HTML from; see {@link HtmlSource}.
 * @param options - Optional base-URL control; see {@link ExtractExamplesOptions}.
 * @returns An async iterable of examples, in document order.
 *
 * @example Stream straight from a fetch, without buffering the document
 * ```js
 * const response = await fetch("https://w3c-ccg.github.io/zcap-spec/");
 *
 * for await (const example of extractExamples(response)) {
 *   console.log(example.name, example.url, example.mediaType);
 * }
 * ```
 *
 * @example Collect them all anyway
 * ```js
 * const examples = await Array.fromAsync(extractExamples(response));
 * ```
 *
 * @example Read from a file without loading it into memory
 * ```js
 * import { createReadStream } from "node:fs";
 * for await (const example of extractExamples(createReadStream("index.html"))) {
 *   // ...
 * }
 * ```
 *
 * @category Extracting examples
 */
export async function* extractExamples(
  source: HtmlSource,
  options: ExtractExamplesOptions = {},
): AsyncGenerator<ZcapSpecExample> {
  let buffer = "";
  let head = "";
  let headFull = false;
  let baseUrl: string | undefined;
  let baseResolved = false;
  let count = 0;

  // Resolved once, at the first example, so every example in a run shares one
  // base URL. Everything a document says about its own location (<base href>,
  // respecConfig.edDraftURI, rel=canonical, og:url) lives in <head>, which the
  // stream delivers before any example.
  const resolveBase = (): string | undefined => {
    if (!baseResolved) {
      baseUrl = options.baseUrl ?? discoverBaseUrl(head) ?? options.fallbackBaseUrl;
      baseResolved = true;
      head = ""; // no longer needed; let it go
    }
    return baseUrl;
  };

  const open = new RegExp(`<(${EXAMPLE_TAGS.join("|")})\\b(${TAG_REST})>`, "gi");

  function* drain(final: boolean): Generator<ZcapSpecExample> {
    for (;;) {
      open.lastIndex = 0;
      let found: RegExpExecArray | null = null;
      let m: RegExpExecArray | null;
      while ((m = open.exec(buffer)) !== null) {
        if (HAS_EXAMPLE_CLASS.test(m[2])) {
          found = m;
          break;
        }
      }

      if (!found) {
        // No example is in progress, so all but a tag-sized tail is garbage.
        if (!final && buffer.length > SCAN_TAIL_LIMIT) {
          buffer = buffer.slice(-SCAN_TAIL_LIMIT);
        }
        return;
      }

      const tagName = found[1].toLowerCase();
      const bodyStart = found.index + found[0].length;
      const closeIndex = findCloseIndexOrNull(buffer, tagName, bodyStart);

      if (closeIndex === null) {
        if (!final) {
          // Incomplete: keep from the opening tag and wait for more input.
          buffer = buffer.slice(found.index);
          return;
        }
        // Truncated document: treat the remainder as the body, which is what
        // the synchronous path does too.
        const el: RawElement = {
          tagName,
          attrs: found[2],
          inner: buffer.slice(bodyStart),
        };
        buffer = "";
        yield toExample(el, count++, resolveBase());
        return;
      }

      const el: RawElement = {
        tagName,
        attrs: found[2],
        inner: buffer.slice(bodyStart, closeIndex),
      };
      buffer = buffer.slice(closeIndex);
      yield toExample(el, count++, resolveBase());
    }
  }

  for await (const chunk of toChunks(source)) {
    buffer += chunk;
    if (!headFull && !baseResolved) {
      head += chunk;
      if (head.length >= HEAD_LIMIT) headFull = true;
    }
    yield* drain(false);
  }
  yield* drain(true);
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
 * Use this on any example whose `mediaType` is `"application/jsonc"`.
 *
 * @param text - JSON text that may contain `//` or block comments.
 * @returns The same text with comments replaced by whitespace, ready for `JSON.parse`.
 *
 * @example Parse a commented example
 * ```js
 * const example = extractExamples(html)[0];
 * // example.mediaType === "application/jsonc"
 * const value = JSON.parse(stripJsonComments(example.content));
 * console.log(value["@context"]); // ["https://w3id.org/zcap/v1", ...]
 * ```
 *
 * @category Working with example content
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

/**
 * Media types whose content is JSON of some flavour, and so has an object
 * representation. Covers any `+json` structured suffix, so `application/ld+json`
 * and friends are handled without listing each one.
 */
function isJsonMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    mediaType === "application/jsonc" ||
    mediaType.endsWith("+json")
  );
}

/**
 * Parse an example's `content` into a JavaScript value.
 *
 * Saves callers from having to care whether a given example is strict JSON or
 * JSON-with-comments, and from pulling in a JSONC parser to find out. Most
 * zcap-spec examples are annotated with `//` commentary and so are *not* valid
 * JSON — `JSON.parse(example.content)` throws on them, which is the trap this
 * exists to remove.
 *
 * Handles `application/json`, `application/jsonc`, and any `+json` type such as
 * `application/ld+json`. Media-type parameters (`; charset=utf-8`) are ignored.
 * Comments are stripped only if a direct parse fails, so a correctly-labelled
 * document is never rewritten unnecessarily — and a mislabelled one still parses.
 *
 * @param example - Any object with `content` and `mediaType`, such as a
 * {@link ZcapSpecExample}.
 * @typeParam T - What you expect back. Unchecked, exactly like `JSON.parse`;
 * defaults to `unknown` so the cast is your decision.
 * @returns The parsed value.
 * @throws {TypeError} If the media type has no object representation (for
 * example `message/http` or `text/plain`) — read `example.content` instead.
 * @throws {SyntaxError} If the content is that media type but does not parse.
 *
 * @example Parse every example, whatever flavour it is
 * ```js
 * for (const example of extractExamplesFromHtml(zcapSpecHtml)) {
 *   const value = parseExampleContent(example);
 *   console.log(value["@context"]);
 * }
 * ```
 *
 * @example Tell TypeScript what you expect
 * ```ts
 * const capability = parseExampleContent<{ "@context": string | string[] }>(example);
 * ```
 *
 * @category Working with example content
 */
export function parseExampleContent<T = unknown>(
  example: Pick<ZcapSpecExample, "content" | "mediaType">,
): T {
  const mediaType = (example.mediaType.split(";")[0] ?? "").trim().toLowerCase();

  if (!isJsonMediaType(mediaType)) {
    throw new TypeError(
      `parseExampleContent: "${example.mediaType}" has no object representation; ` +
        "read example.content directly",
    );
  }

  try {
    return JSON.parse(example.content) as T;
  } catch (directError) {
    // Not strict JSON. The usual reason is `//` commentary, so try again
    // without it before giving up.
    try {
      return JSON.parse(stripJsonComments(example.content)) as T;
    } catch {
      throw new SyntaxError(
        `parseExampleContent: content labelled "${example.mediaType}" did not parse ` +
          `as JSON, with or without comments: ${(directError as Error).message}`,
      );
    }
  }
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

/**
 * Render one example as the human-readable block the CLI prints for
 * `--format=text`.
 *
 * @category Formatting output
 */
export function formatExample(example: ZcapSpecExample): string {
  const label = `${example.name} (${example.mediaType})`;
  const divider = "-".repeat(label.length);
  const location = example.url ? `${example.url}\n` : "";
  return `${label}\n${divider}\n${location}${example.content}\n\n`;
}

/**
 * Renders one example as indented, human-readable JSON.
 *
 * This is what the CLI prints when stdout is a terminal, so that trying it out
 * by hand produces something readable rather than one very long line.
 *
 * @category Formatting output
 */
export function formatExampleAsPrettyJson(example: ZcapSpecExample): string {
  return JSON.stringify(example, null, 2) + "\n";
}

/**
 * Renders all examples as newline-delimited JSON (one compact JSON object
 * per line), e.g. for piping to `jq` -- `jq .` and friends read an NDJSON
 * stream as a sequence of values without needing `-s`/`--slurp`.
 *
 * This is the CLI's default output format.
 *
 * @example
 * ```js
 * process.stdout.write(formatExamplesAsJson(extractExamples(html)));
 * ```
 *
 * @category Formatting output
 */
export function formatExamplesAsJson(examples: ZcapSpecExample[]): string {
  return examples.map((example) => JSON.stringify(example)).join("\n") + "\n";
}
