import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  ZcapSpecExamplesCli,
  decodeEntities,
  discoverBaseUrl,
  extractExamples,
  extractExamplesFromHtml,
  formatExample,
  formatExamplesAsJson,
  getAttribute,
  stripJsonComments,
  toText,
  HELP_TEXT,
} from "../zcap-spec-examples.ts";

function parseNdjson(text: string): any[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const FIXTURE_HTML = `
<aside class="example" id="example-1">
  <div class="marker"><a href="#example-1">Example 1</a></div>
  <pre>{"id": "urn:zcap:root"}</pre>
</aside>
<aside class="example" id="example-2">
  <div class="marker"><a href="#example-2">Example 2</a></div>
  <pre>{"id": "urn:zcap:delegated"}</pre>
</aside>
`;

// ---------------------------------------------------------------------------
// HTML scanning primitives (these replace what node-html-parser used to do)
// ---------------------------------------------------------------------------

test("decodeEntities handles named, decimal, and hex character references", () => {
  assert.equal(
    decodeEntities("5 &lt; 10 &amp;&amp; 10 &gt; 5 &quot;q&quot; &#8212; &#x2713;"),
    '5 < 10 && 10 > 5 "q" — ✓',
  );
  // Unknown entities are left intact rather than silently dropped.
  assert.equal(decodeEntities("&bogus; &#x110000;"), "&bogus; &#x110000;");
});

test("getAttribute reads quoted and unquoted attribute values", () => {
  assert.equal(getAttribute('id="example-5" class="example"', "id"), "example-5");
  assert.equal(getAttribute("id='e-1'", "id"), "e-1");
  assert.equal(getAttribute("id=e-2 class=x", "id"), "e-2");
  assert.equal(getAttribute('class="example"', "id"), undefined);
});

test("toText strips tags and comments, then decodes entities", () => {
  assert.equal(
    toText('<span class="hljs-attr">&quot;a&quot;</span><!-- note -->: 1'),
    '"a": 1',
  );
  // A ">" inside a quoted attribute value must not terminate the tag early.
  assert.equal(toText('<a title="a > b">x</a>'), "x");
});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test("extractExamples assigns name/content/mediaType from example elements", () => {
  const examples = extractExamplesFromHtml(FIXTURE_HTML);
  assert.equal(examples.length, 2);
  assert.equal(examples[0].name, "example-1");
  assert.match(examples[0].content, /urn:zcap:root/);
  assert.equal(examples[0].mediaType, "application/json");
  assert.equal(examples[1].name, "example-2");
});

test("extractExamples ignores non-example elements and lookalike class names", () => {
  const html = `
    <div class="note"><pre>not an example</pre></div>
    <div class="exampleish"><pre>also not an example</pre></div>
    <aside class="example" id="real"><pre>yes</pre></aside>
  `;
  const examples = extractExamplesFromHtml(html);
  assert.equal(examples.length, 1);
  assert.equal(examples[0].content, "yes");
});

test("extractExamples flattens markup nested inside <pre>", () => {
  const html = `<aside class="example" id="e"><pre><code><span>{"a": </span><span>1}</span></code></pre></aside>`;
  const examples = extractExamplesFromHtml(html);
  assert.equal(examples[0].content, '{"a": 1}');
});

test("extractExamples falls back to a positional name when there is no id", () => {
  const html = `<aside class="example"><pre>a</pre></aside><aside class="example"><pre>b</pre></aside>`;
  const examples = extractExamplesFromHtml(html);
  // Matches the ids ReSpec generates client-side: example-1, example-2, ...
  assert.deepEqual(examples.map((e) => e.name), ["example-1", "example-2"]);
  assert.deepEqual(examples.map((e) => e.url), ["#example-1", "#example-2"]);
});

test("extractExamples infers mediaType from a language class, else by sniffing", () => {
  const asHttp = extractExamplesFromHtml(
    `<aside class="example" id="a"><pre class="http">GET / HTTP/1.1</pre></aside>`,
  );
  assert.equal(asHttp[0].mediaType, "message/http");

  const asJsonLd = extractExamplesFromHtml(
    `<aside class="example" id="b"><pre><code class="language-jsonld">{}</code></pre></aside>`,
  );
  assert.equal(asJsonLd[0].mediaType, "application/ld+json");

  // No class hint: sniffed as JSON because it parses.
  const sniffed = extractExamplesFromHtml(
    `<aside class="example" id="c"><pre>{"ok": true}</pre></aside>`,
  );
  assert.equal(sniffed[0].mediaType, "application/json");

  // JSON with a comment is not valid JSON, but it is valid JSONC.
  const withComment = extractExamplesFromHtml(
    `<aside class="example" id="d"><pre>{\n // hi\n "ok": true\n}</pre></aside>`,
  );
  assert.equal(withComment[0].mediaType, "application/jsonc");

  // Neither JSON nor JSONC.
  const prose = extractExamplesFromHtml(
    `<aside class="example" id="e"><pre>just some prose</pre></aside>`,
  );
  assert.equal(prose[0].mediaType, "text/plain");

  // A `json` class does not make unparseable content JSON.
  const lying = extractExamplesFromHtml(
    `<aside class="example" id="f"><pre class="json">not json at all</pre></aside>`,
  );
  assert.equal(lying[0].mediaType, "text/plain");
});

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

test("stripJsonComments does not touch // inside string values", () => {
  // The whole reason this cannot be a regex: spec examples are full of URLs.
  const src = `{"@context": "https://w3id.org/zcap/v1", // a comment
  "id": "https://example.com/foo"}`;
  const stripped = stripJsonComments(src);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed["@context"], "https://w3id.org/zcap/v1");
  assert.equal(parsed.id, "https://example.com/foo");
});

test("stripJsonComments handles block comments, escapes, and comment-like strings", () => {
  assert.equal(JSON.parse(stripJsonComments('{"a": /* mid */ 1}')).a, 1);
  // An escaped quote must not end the string early.
  assert.deepEqual(
    JSON.parse(stripJsonComments('{"a": "he said \\"hi\\" // not a comment"}')),
    { a: 'he said "hi" // not a comment' },
  );
  // A block-comment opener inside a string is just text.
  assert.deepEqual(JSON.parse(stripJsonComments('{"a": "/* literal */"}')), {
    a: "/* literal */",
  });
});

test("stripJsonComments leaves comment-free JSON byte-identical", () => {
  const src = '{"a":1,"b":["x","y"],"c":{"d":null}}';
  assert.equal(stripJsonComments(src), src);
});

test("examples annotated with comments round-trip through stripJsonComments", () => {
  const html = `<pre class="example">{
  "@context": ["https://w3id.org/zcap/v1"],
  // Since this is the first delegated capability, the parentCapability
  // points to the target this capability will operate against
  "parentCapability": "https://whatacar.example/a-fancy-car",
  /* block form too */
  "controller": "https://social.example/alyssa#key-for-car"
}</pre>`;
  const [example] = extractExamplesFromHtml(html);
  assert.equal(example.mediaType, "application/jsonc");
  const parsed = JSON.parse(stripJsonComments(example.content));
  assert.deepEqual(parsed["@context"], ["https://w3id.org/zcap/v1"]);
  assert.equal(parsed.parentCapability, "https://whatacar.example/a-fancy-car");
  assert.equal(parsed.controller, "https://social.example/alyssa#key-for-car");
});

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

test("extractExamples emits a bare fragment url when no base URL is known", () => {
  const examples = extractExamplesFromHtml(FIXTURE_HTML);
  assert.equal(examples[0].url, "#example-1");
  assert.equal(examples[1].url, "#example-2");
});

test("extractExamples resolves an absolute url against a base URL", () => {
  const examples = extractExamplesFromHtml(FIXTURE_HTML, {
    baseUrl: "https://w3c-ccg.github.io/zcap-spec/",
  });
  assert.equal(examples[0].url, "https://w3c-ccg.github.io/zcap-spec/#example-1");
});

test("extractExamples degrades to a fragment when the base URL is malformed", () => {
  const examples = extractExamplesFromHtml(FIXTURE_HTML, { baseUrl: "not a url" });
  assert.equal(examples[0].url, "#example-1");
});

// ---------------------------------------------------------------------------
// Base URL discovery
//
// zcap-spec is a ReSpec document and ReSpec runs client-side, so the HTML you
// get over the wire is the *source*: it still carries respecConfig, and the
// examples are bare `<pre class="example ...">` with no ids yet.
// ---------------------------------------------------------------------------

const RESPEC_SOURCE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <script class="remove">
    var respecConfig = {
      specStatus: "CG-DRAFT",
      shortName: "zcap-spec",
      edDraftURI: "https://w3c-ccg.github.io/zcap-spec/",
    };
  </script>
</head>
<body>
  <pre class="example highlight javascript">{"a": 1}</pre>
  <pre class="example highlight javascript">{"b": 2}</pre>
</body>
</html>
`;

test("discoverBaseUrl reads respecConfig.edDraftURI", () => {
  assert.equal(
    discoverBaseUrl(RESPEC_SOURCE_HTML),
    "https://w3c-ccg.github.io/zcap-spec/",
  );
});

test("discoverBaseUrl prefers <base href>, then falls back through canonical and og:url", () => {
  assert.equal(
    discoverBaseUrl(`<base href="https://base.example/s/"><script>var respecConfig={edDraftURI:"https://ed.example/"}</script>`),
    "https://base.example/s/",
  );
  assert.equal(
    discoverBaseUrl(`<link rel="canonical" href="https://canonical.example/s/">`),
    "https://canonical.example/s/",
  );
  assert.equal(
    discoverBaseUrl(`<meta property="og:url" content="https://og.example/s/">`),
    "https://og.example/s/",
  );
});

test("discoverBaseUrl returns undefined when the document declares no URL", () => {
  assert.equal(discoverBaseUrl("<html><body><p>nothing</p></body></html>"), undefined);
  // A non-absolute value is not usable as a base and must be skipped.
  assert.equal(discoverBaseUrl(`<base href="/relative/">`), undefined);
});

test("extractExamples builds absolute urls from a ReSpec source document", () => {
  const examples = extractExamplesFromHtml(RESPEC_SOURCE_HTML);
  assert.deepEqual(examples.map((e) => e.url), [
    "https://w3c-ccg.github.io/zcap-spec/#example-1",
    "https://w3c-ccg.github.io/zcap-spec/#example-2",
  ]);
});

test("explicit baseUrl beats the document, which beats fallbackBaseUrl", () => {
  // Document-declared edDraftURI wins over the URL we happened to fetch from.
  assert.equal(
    extractExamplesFromHtml(RESPEC_SOURCE_HTML, { fallbackBaseUrl: "https://mirror.example/" })[0].url,
    "https://w3c-ccg.github.io/zcap-spec/#example-1",
  );
  // An explicit --base-url overrides everything.
  assert.equal(
    extractExamplesFromHtml(RESPEC_SOURCE_HTML, {
      baseUrl: "https://override.example/",
      fallbackBaseUrl: "https://mirror.example/",
    })[0].url,
    "https://override.example/#example-1",
  );
  // fallbackBaseUrl is used only when the document says nothing.
  assert.equal(
    extractExamplesFromHtml(`<pre class="example">x</pre>`, { fallbackBaseUrl: "https://mirror.example/" })[0].url,
    "https://mirror.example/#example-1",
  );
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("formatExample includes the name, media type, and url", () => {
  const out = formatExample({
    name: "example-3",
    content: "bar",
    url: "https://example.org/#example-3",
    mediaType: "text/plain",
  });
  assert.match(out, /^example-3 \(text\/plain\)\n-+\nhttps:\/\/example\.org\/#example-3\nbar\n\n$/);
});

test("formatExamplesAsJson prints one compact JSON object per line (NDJSON)", () => {
  const examples = extractExamplesFromHtml(FIXTURE_HTML);
  const out = formatExamplesAsJson(examples);
  const lines = out.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2);
  // Each line must be its own valid, single-line JSON value, matching the
  // { name, content, url, mediaType } shape described in README.md.
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(parsed[0]).sort(), [
    "content",
    "mediaType",
    "name",
    "url",
  ]);
  assert.equal(parsed[0].name, "example-1");
  assert.equal(parsed[1].name, "example-2");
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("ZcapSpecExamplesCli prefers stdin over fetching a URL, and defaults to JSON output", async () => {
  let fetchCalled = false;
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => {
      fetchCalled = true;
      return { text: async () => "" };
    },
    readStdin: async () => FIXTURE_HTML,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  const code = await cli.run({});
  assert.equal(code, 0);
  assert.equal(fetchCalled, false);
  const parsed = parseNdjson(written.join(""));
  assert.equal(parsed.length, 2);
  // No base URL is available for stdin input, so urls stay relative.
  assert.equal(parsed[0].url, "#example-1");
});

test("ZcapSpecExamplesCli uses --base-url to absolutise urls from stdin input", async () => {
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => ({ text: async () => "" }),
    readStdin: async () => FIXTURE_HTML,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  const code = await cli.run({ baseUrl: "https://example.org/spec/" });
  assert.equal(code, 0);
  assert.equal(parseNdjson(written.join(""))[0].url, "https://example.org/spec/#example-1");
});

test("ZcapSpecExamplesCli uses the fetched URL as the default base URL", async () => {
  let fetchedUrl: string | undefined;
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async (url) => {
      fetchedUrl = url;
      return { text: async () => FIXTURE_HTML };
    },
    readStdin: async () => undefined,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  const code = await cli.run({ url: "https://example.org/spec.html" });
  assert.equal(code, 0);
  assert.equal(fetchedUrl, "https://example.org/spec.html");
  const parsed = parseNdjson(written.join(""));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, "https://example.org/spec.html#example-1");
});

test("ZcapSpecExamplesCli --format=json pretty-prints, and stays valid for jq", async () => {
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => ({ text: async () => "" }),
    readStdin: async () => FIXTURE_HTML,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  assert.equal(await cli.run({ format: "json" }), 0);
  const out = written.join("");
  assert.match(out, /^\{\n  "name": "example-1",\n/);
  // Indented output is still a concatenated stream of JSON values, which is
  // what jq consumes -- each record just spans several lines.
  const records = out.trimEnd().split(/\n(?=\{)/).map((r) => JSON.parse(r));
  assert.equal(records.length, 2);
  assert.equal(records[1].name, "example-2");
});

test("ZcapSpecExamplesCli defaults to compact NDJSON, not pretty", async () => {
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => ({ text: async () => "" }),
    readStdin: async () => FIXTURE_HTML,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  assert.equal(await cli.run({}), 0);
  const lines = written.join("").trimEnd().split("\n");
  assert.equal(lines.length, 2, "one line per example");
  lines.forEach((line) => JSON.parse(line));
});

test("ZcapSpecExamplesCli --format=text prints the human-readable listing", async () => {
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => ({ text: async () => "" }),
    readStdin: async () => FIXTURE_HTML,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  const code = await cli.run({ format: "text" });
  assert.equal(code, 0);
  assert.equal(written.length, 2);
  assert.match(written[0], /^example-1 \(application\/json\)/);
});

test("ZcapSpecExamplesCli --help prints help text without fetching", async () => {
  let fetchCalled = false;
  const written: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => {
      fetchCalled = true;
      return { text: async () => "" };
    },
    readStdin: async () => undefined,
    writeStdout: (chunk) => written.push(chunk),
    writeStderr: () => {},
  });

  const code = await cli.run({ help: true });
  assert.equal(code, 0);
  assert.equal(fetchCalled, false);
  assert.equal(written.join(""), HELP_TEXT);
});

test("ZcapSpecExamplesCli reports an error when no examples are found", async () => {
  const errors: string[] = [];
  const cli = new ZcapSpecExamplesCli({
    fetch: async () => ({ text: async () => "<html></html>" }),
    readStdin: async () => undefined,
    writeStdout: () => {},
    writeStderr: (chunk) => errors.push(chunk),
  });

  const code = await cli.run({ url: "https://example.org/spec.html" });
  assert.equal(code, 1);
  assert.match(errors.join(""), /No examples found/);
});

// ---------------------------------------------------------------------------
// Robustness against hostile input
// ---------------------------------------------------------------------------

test("extractExamples stays linear on adversarial input (no catastrophic backtracking)", () => {
  // Patterns designed to blow up an ambiguous regex: long unterminated quotes,
  // dense angle brackets, and deeply repeated attribute-like text.
  const hostile = [
    `<aside class="example" id="x" ${'a="'.repeat(20000)}>`,
    "<".repeat(50000),
    `<aside class="example" id="y"><pre>${"&".repeat(50000)}</pre></aside>`,
    `<aside class="example" id="z"><pre>${'<span class="a">'.repeat(20000)}ok</pre></aside>`,
  ].join("\n");

  const started = process.hrtime.bigint();
  const examples = extractExamplesFromHtml(hostile);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(Array.isArray(examples));
  // Generous bound: catastrophic backtracking would hang for many seconds.
  assert.ok(elapsedMs < 2000, `took ${elapsedMs.toFixed(1)}ms, expected < 2000ms`);
});

test("extractExamples tolerates unterminated and malformed elements", () => {
  assert.deepEqual(extractExamplesFromHtml("<aside class=\"example\" id=\"a\"><pre>unclosed")[0]?.content, "unclosed");
  assert.equal(extractExamplesFromHtml("<html><body>no examples</body></html>").length, 0);
  assert.equal(extractExamplesFromHtml("").length, 0);
});

// ---------------------------------------------------------------------------
// Process-level behaviour
// ---------------------------------------------------------------------------

test("CLI exits quietly when the consumer closes the pipe early (EPIPE)", async () => {
  const { spawn } = await import("node:child_process");
  const script = fileURLToPath(new URL("../zcap-spec-examples.ts", import.meta.url));

  // Enough output to overflow the pipe buffer, so closing the read end really
  // does produce EPIPE mid-write rather than the child finishing first.
  const big = Array.from(
    { length: 3000 },
    (_, i) => `<pre class="example">{"n": ${i}, "pad": "${"x".repeat(200)}"}</pre>`,
  ).join("\n");

  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(big);
  child.stdout.once("data", () => child.stdout.destroy());

  const code = await new Promise<number | null>((resolve) =>
    child.on("close", (c) => resolve(c)),
  );

  assert.equal(stderr, "", `expected no stderr, got: ${stderr.slice(0, 400)}`);
  assert.equal(code, 0);
});

test("CLI runs when invoked through a symlink, as `npx` / node_modules/.bin does", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const script = fileURLToPath(new URL("../zcap-spec-examples.ts", import.meta.url));
  // npm installs a bin as a symlink, so argv[1] is the link path while
  // import.meta.url resolves to the real file. A naive equality check between
  // the two silently skips main(), producing no output and exit code 0.
  const link = join(mkdtempSync(join(tmpdir(), "zcap-bin-")), "zcap-spec-examples");
  symlinkSync(script, link);

  const child = spawn(process.execPath, [link, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));

  assert.equal(stderr, "");
  assert.equal(code, 0);
  assert.match(stdout, /zcap-spec-examples - extract the examples/);
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** A ReadableStream of `html` cut into `size`-byte pieces, as a network would. */
function byteStream(html: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(html);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return void controller.close();
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
}

const STREAM_HTML = `
<html><head>
  <script>var respecConfig = { edDraftURI: "https://w3c-ccg.github.io/zcap-spec/" };</script>
</head><body>
  <p>prose between examples</p>
  <pre class="example">{"a": 1}</pre>
  <p>more prose</p>
  <pre class="example">{"b": 2} // note</pre>
  <div class="note"><pre>not an example</pre></div>
  <aside class="example" id="named"><pre>&quot;three&quot; &#x2713;</pre></aside>
</body></html>`;

test("extractExamples accepts a string and yields the same as the sync version", async () => {
  const streamed = await Array.fromAsync(extractExamples(STREAM_HTML));
  assert.deepEqual(streamed, extractExamplesFromHtml(STREAM_HTML));
});

test("extractExamples accepts a Response and streams its body", async () => {
  const response = new Response(byteStream(STREAM_HTML, 64));
  const examples = await Array.fromAsync(extractExamples(response));
  assert.deepEqual(examples, extractExamplesFromHtml(STREAM_HTML));
});

test("extractExamples accepts a ReadableStream and an async iterable", async () => {
  const fromStream = await Array.fromAsync(extractExamples(byteStream(STREAM_HTML, 32)));
  assert.deepEqual(fromStream, extractExamplesFromHtml(STREAM_HTML));

  async function* chunks() {
    yield STREAM_HTML.slice(0, 100);
    yield STREAM_HTML.slice(100);
  }
  assert.deepEqual(
    await Array.fromAsync(extractExamples(chunks())),
    extractExamplesFromHtml(STREAM_HTML),
  );
});

test("extractExamples is unaffected by where chunk boundaries fall", async () => {
  const expected = extractExamplesFromHtml(STREAM_HTML);
  // Sizes chosen to split mid-tag, mid-attribute, and mid-content.
  for (const size of [1, 2, 3, 7, 13, 64, 1024]) {
    const got = await Array.fromAsync(extractExamples(byteStream(STREAM_HTML, size)));
    assert.deepEqual(got, expected, `chunk size ${size} changed the result`);
  }
});

test("extractExamples decodes multi-byte characters split across chunks", async () => {
  // "✓" is three UTF-8 bytes; a 1-byte chunking guarantees it is torn apart.
  const html = `<pre class="example">{"ok": "✓ — é"}</pre>`;
  const [example] = await Array.fromAsync(extractExamples(byteStream(html, 1)));
  assert.match(example.content, /✓ — é/);
  assert.ok(!example.content.includes("�"), "should not contain replacement chars");
});

test("extractExamples finds the base URL from the head before emitting examples", async () => {
  const examples = await Array.fromAsync(extractExamples(byteStream(STREAM_HTML, 16)));
  assert.equal(examples[0].url, "https://w3c-ccg.github.io/zcap-spec/#example-1");
  assert.equal(examples[2].url, "https://w3c-ccg.github.io/zcap-spec/#named");
});

test("extractExamples yields each example before the stream has finished", async () => {
  // Prove it is incremental: the second half is withheld until the first
  // example has already been handed to the consumer.
  let released!: () => void;
  const gate = new Promise<void>((resolve) => (released = resolve));

  async function* chunks() {
    yield `<pre class="example">{"first": 1}</pre>`;
    await gate;
    yield `<pre class="example">{"second": 2}</pre>`;
  }

  const iterator = extractExamples(chunks())[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.match(first.value.content, /first/);

  released(); // only now can the rest arrive
  const second = await iterator.next();
  assert.match(second.value.content, /second/);
  assert.equal((await iterator.next()).done, true);
});

test("extractExamples keeps memory flat on input far larger than the examples", async () => {
  // 40 MB of filler around a handful of examples. If anything accumulated the
  // whole document, heap growth would track input size.
  const filler = "<p>" + "x".repeat(1 << 20) + "</p>\n";
  async function* chunks() {
    yield `<html><head><base href="https://example.org/s/"></head><body>`;
    for (let i = 0; i < 40; i++) {
      yield filler;
      yield `<pre class="example">{"n": ${i}}</pre>`;
    }
    yield "</body></html>";
  }

  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  let seen = 0;
  for await (const example of extractExamples(chunks())) {
    seen++;
    assert.match(example.content, /"n":/);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }

  assert.equal(seen, 40);
  const grewMb = (peak - before) / 1024 / 1024;
  // ~42 MB streamed through. Buffering it all would show up here immediately.
  assert.ok(grewMb < 12, `heap grew ${grewMb.toFixed(1)} MB, expected well under input size`);
});
