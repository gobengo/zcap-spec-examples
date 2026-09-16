#!/usr/bin/env node
/**
 * Builds the static website into an output directory.
 *
 * ```shell
 * node website/build.ts --out build/website [--clean] [--site-url <url>]
 * ```
 *
 * It does two things:
 *
 * 1. Copies every file in `website/` except `.ts` sources (so `index.html`,
 *    `style.css`, ... are served as-is), then fills `%ZCAP_SPEC_URL%` in
 *    `index.html` with the CLI's default spec URL.
 * 2. Generates `examples/index.html`, describing each example extracted from
 *    the bundled zcap-spec snapshot in `fixtures.ts`.
 * 3. Compiles the library's browser-safe modules (`examples.ts`,
 *    `fixtures.ts`) to ES modules in `lib/`, importable from any web page,
 *    and fills `%LIBRARY_SNIPPET%` in `index.html` with a script that does so.
 *
 * `--site-url` is the absolute URL the site will be served from, used in that
 * snippet. It defaults to the GitHub Pages URL derived from `repository` in
 * package.json; gh-pages.yml passes the real one from `configure-pages`.
 *
 * The TypeDoc API docs are *not* built here; the `build-website` action (and
 * `npm run build:website`) writes them into `<out>/docs/` with TypeDoc's own
 * `--out`, so that TypeDoc stays a dev dependency this script never imports.
 *
 * Zero dependencies, runs via type stripping, same as the CLI.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  extractExamplesFromHtml,
  parseExampleContent,
  type ZcapSpecExample,
} from "../examples.ts";
import { zcapSpecSnapshot } from "../fixtures.ts";
import { DEFAULT_ZCAP_SPEC_URL } from "../ZcapSpecExamplesCli.ts";

const websiteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(websiteDir, "..");

/**
 * `https://<owner>.github.io/<repo>/` from package.json `repository`, which is
 * where GitHub Pages serves a project site.
 */
export function defaultSiteUrl(): string {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    repository?: string | { url?: string };
  };
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const match = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(repository ?? "");
  if (!match) throw new Error("package.json repository is not a GitHub URL; pass --site-url");
  return `https://${match[1]!.toLowerCase()}.github.io/${match[2]}/`;
}

/** The snippet shown on the homepage: import the hosted library and log each example. */
export function librarySnippet(siteUrl: string, specUrl: string): string {
  const base = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
  return `<script type="module">
  import { extractExamples } from "${new URL("lib/examples.js", base)}";

  const response = await fetch("${specUrl}");
  for await (const example of extractExamples(response)) {
    console.log(example.name, example);
  }
</script>`;
}

/** Compiles the browser-safe library modules into `<out>/lib/` with the repo's TypeScript. */
function buildLibrary(out: string): void {
  // Resolved from the repo, so this needs `npm ci` but never a global tsc.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [tsc, "--project", resolve(repoRoot, "etc/tsconfig.website.json"), "--outDir", resolve(out, "lib")],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`tsc failed building ${resolve(out, "lib")}`);
}

// ---------------------------------------------------------------------------
// Describing an example
//
// These are heuristics over the *parsed* example, not over prose in the spec:
// the extractor deliberately returns only name/content/url/mediaType, so what
// we can say about an example is what its own content says about itself.
// ---------------------------------------------------------------------------

/** A human-readable summary of one example. */
export interface ExampleDescription {
  /** Short classification, e.g. "Delegated capability". */
  kind: string;
  /** One sentence on what that kind is. */
  summary: string;
  /** Notable fields, in display order. Values are plain text. */
  facts: Array<[label: string, value: string]>;
  /** The content with comments stripped, when that differs from the source. */
  parsed?: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Json | undefined): Json[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Renders a scalar or list of scalars as text; ids of embedded objects stand in for the objects. */
function show(value: Json | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = asArray(value).map((item) =>
    isObject(item) ? (typeof item.id === "string" ? item.id : "(embedded object)") : String(item),
  );
  return parts.length ? parts.join(", ") : undefined;
}

function push(facts: ExampleDescription["facts"], label: string, value: Json | undefined): void {
  const text = show(value);
  if (text !== undefined) facts.push([label, text]);
}

export function describeExample(example: ZcapSpecExample): ExampleDescription {
  const mediaType = (example.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "message/http") return describeHttp(example.content);

  let value: unknown;
  try {
    value = parseExampleContent(example);
  } catch (error) {
    return {
      kind: "Unparsed example",
      summary: `Not readable as structured data: ${(error as Error).message}`,
      facts: [],
    };
  }

  const parsed = JSON.stringify(value, null, 2);
  let strictJson = true;
  try {
    JSON.parse(example.content);
  } catch {
    strictJson = false;
  }
  const described = isObject(value)
    ? describeJsonObject(value)
    : { kind: "JSON value", summary: "A JSON value that is not an object.", facts: [] };
  return strictJson ? described : { ...described, parsed };
}

function describeJsonObject(doc: { [key: string]: Json }): ExampleDescription {
  const facts: ExampleDescription["facts"] = [];
  const proofs = asArray(doc.proof).filter(isObject);
  const purposes = new Set(proofs.map((p) => p.proofPurpose));

  if (purposes.has("capabilityInvocation")) {
    const proof = proofs.find((p) => p.proofPurpose === "capabilityInvocation")!;
    push(facts, "Invocation id", doc.id);
    push(facts, "Action", doc.action ?? proof.capabilityAction);
    push(facts, "Invocation target", proof.invocationTarget ?? doc.invocationTarget);
    push(facts, "Capability invoked", proof.capability);
    push(facts, "Signed by", proof.verificationMethod);
    push(facts, "Cryptosuite", proof.cryptosuite);
    return {
      kind: "Capability invocation",
      summary:
        "A request to exercise a capability, proven with a capabilityInvocation proof that references the capability being used.",
      facts,
    };
  }

  if (typeof doc.id === "string" && doc.id.startsWith("urn:zcap:root:")) {
    push(facts, "Id", doc.id);
    push(facts, "Invocation target", doc.invocationTarget);
    push(facts, "Controller", doc.controller);
    return {
      kind: "Root capability",
      summary:
        "The start of a capability chain. It carries no proof: its authority comes from the invocation target recognizing the controller.",
      facts,
    };
  }

  if (doc.parentCapability !== undefined) {
    const delegation = proofs.find((p) => p.proofPurpose === "capabilityDelegation");
    push(facts, "Id", doc.id);
    push(facts, "Parent capability", doc.parentCapability);
    push(facts, "Controller", doc.controller);
    push(facts, "Invocation target", doc.invocationTarget);
    push(facts, "Allowed actions", doc.allowedAction);
    push(facts, "Expires", doc.expires);
    push(
      facts,
      "Caveats",
      asArray(doc.caveat).map((c) => (isObject(c) && typeof c.type === "string" ? c.type : String(c))),
    );
    if (delegation) {
      push(facts, "Delegated by", delegation.verificationMethod);
      const chain = asArray(delegation.capabilityChain);
      if (chain.length) facts.push(["Capability chain length", String(chain.length)]);
    }
    return {
      kind: "Delegated capability",
      summary:
        "A capability derived from a parent, granting authority to a new controller and signed with a capabilityDelegation proof.",
      facts,
    };
  }

  if (doc.capabilityDelegation !== undefined) {
    push(facts, "Id", doc.id);
    push(facts, "Delegation keys", doc.capabilityDelegation);
    return {
      kind: "Resource with delegation keys",
      summary:
        "An object that names, via capabilityDelegation, the keys allowed to delegate authority over it: the source of authority for a root capability.",
      facts,
    };
  }

  push(facts, "Id", doc.id);
  facts.push(["Top-level properties", Object.keys(doc).join(", ")]);
  return { kind: "JSON document", summary: "A JSON object the heuristics here do not classify.", facts };
}

function describeHttp(content: string): ExampleDescription {
  const lines = content.split(/\r?\n/);
  const facts: ExampleDescription["facts"] = [];
  const requestLine = lines[0] ?? "";
  facts.push(["Request line", requestLine]);

  // Header-looking lines anywhere in the message, so trailers (which follow
  // the chunked body) are found as well as ordinary headers.
  const names = new Set<string>();
  let blankSeen = false;
  const trailerNames = new Set<string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === "") {
      blankSeen = true;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):\s/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    (blankSeen ? trailerNames : names).add(name);
  }
  facts.push(["Headers", [...names].join(", ")]);
  if (trailerNames.size) facts.push(["Trailers", [...trailerNames].join(", ")]);

  const all = new Set([...names, ...trailerNames].map((n) => n.toLowerCase()));
  const invokes = all.has("capability-invocation");
  const inTrailers = [...trailerNames].some((n) => n.toLowerCase() === "capability-invocation");
  return {
    kind: invokes ? "HTTP capability invocation" : "HTTP message",
    summary: invokes
      ? `An HTTP request that invokes a capability via the Capability-Invocation header and an HTTP Message Signature${
          inTrailers ? ", sent as trailers after a chunked body" : ""
        }.`
      : "An HTTP message.",
    facts,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderExamplesPage(examples: ZcapSpecExample[]): string {
  const snapshot = zcapSpecSnapshot;
  const toc = examples
    .map((example) => {
      const { kind } = describeExample(example);
      return `<li><a href="#${escapeHtml(example.name)}">${escapeHtml(example.name)}</a> <span class="muted">${escapeHtml(kind)}</span></li>`;
    })
    .join("\n        ");

  const sections = examples
    .map((example) => {
      const d = describeExample(example);
      const facts = d.facts.length
        ? `<dl>${d.facts
            .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(v)}</code></dd>`)
            .join("")}</dl>`
        : "";
      const parsed = d.parsed
        ? `<details><summary>Parsed, comments removed</summary><pre><code>${escapeHtml(d.parsed)}</code></pre></details>`
        : "";
      return `
    <section id="${escapeHtml(example.name)}" class="example">
      <h2><a href="#${escapeHtml(example.name)}">${escapeHtml(example.name)}</a>: ${escapeHtml(d.kind)}</h2>
      <p class="meta"><code>${escapeHtml(example.mediaType)}</code> · <a href="${escapeHtml(example.url)}">View in the spec</a></p>
      <p>${escapeHtml(d.summary)}</p>
      ${facts}
      <details open><summary>Source</summary><pre><code>${escapeHtml(example.content)}</code></pre></details>
      ${parsed}
    </section>`;
    })
    .join("\n");

  // Links are relative: project Pages serve from /zcap-spec-examples/.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>zcap-spec examples</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <header>
    <nav><a href="../">zcap-spec-examples</a> · <a href="./">Examples</a> · <a href="../docs/">API docs</a></nav>
    <h1>Examples in the zcap-spec</h1>
    <p>
      ${examples.length} examples extracted from the bundled snapshot of
      <a href="${escapeHtml(snapshot.sourceUrl)}">${escapeHtml(snapshot.sourceUrl)}</a>,
      retrieved ${escapeHtml(snapshot.retrievedAt)}
      (<abbr title="SHA-256 of the snapshot">sha256</abbr> <code class="hash">${escapeHtml(snapshot.sha256)}</code>).
    </p>
    <p class="muted">Descriptions are inferred from each example's own content, not from the spec's prose.</p>
  </header>
  <main>
    <nav aria-label="Examples">
      <ol>
        ${toc}
      </ol>
    </nav>
${sections}
  </main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

export function build(
  outDir: string,
  { clean = false, siteUrl = defaultSiteUrl() }: { clean?: boolean; siteUrl?: string } = {},
): void {
  const out = resolve(outDir);
  // Copying website/ into a directory inside website/ would recurse forever.
  if (isInside(out, websiteDir)) {
    throw new Error(`--out must not be inside ${websiteDir}: ${out}`);
  }
  if (clean) {
    // Refuse to delete anything that contains the sources (e.g. `--out .`).
    if (isInside(websiteDir, out)) {
      throw new Error(`refusing to --clean ${out}: it contains ${websiteDir}`);
    }
    // Start empty, as CI does, so files removed from website/ don't linger.
    rmSync(out, { recursive: true, force: true });
  }

  mkdirSync(out, { recursive: true });
  cpSync(websiteDir, out, {
    recursive: true,
    filter: (source) => extname(source) !== ".ts",
  });

  // Use the CLI's default URL, not the bare https://w3c-ccg.github.io/zcap-spec/:
  // that is a version index which redirects with JavaScript, so piping it
  // through the CLI yields nothing. One constant keeps the two in step.
  const indexPath = resolve(out, "index.html");
  let index = readFileSync(indexPath, "utf8");
  const placeholders: Record<string, string> = {
    "%ZCAP_SPEC_URL%": escapeHtml(DEFAULT_ZCAP_SPEC_URL),
    "%LIBRARY_SNIPPET%": escapeHtml(librarySnippet(siteUrl, DEFAULT_ZCAP_SPEC_URL)),
  };
  for (const [placeholder, value] of Object.entries(placeholders)) {
    if (!index.includes(placeholder)) {
      throw new Error(`${indexPath}: expected a ${placeholder} placeholder`);
    }
    index = index.replaceAll(placeholder, value);
  }
  writeFileSync(indexPath, index);

  buildLibrary(out);

  const examples = extractExamplesFromHtml(zcapSpecSnapshot.html);
  mkdirSync(resolve(out, "examples"), { recursive: true });
  writeFileSync(resolve(out, "examples", "index.html"), renderExamplesPage(examples));
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      clean: { type: "boolean", default: false },
      "site-url": { type: "string" },
    },
  });
  if (!values.out) {
    console.error("usage: node website/build.ts --out <directory> [--clean] [--site-url <url>]");
    process.exit(2);
  }
  // An empty --site-url (an unset CI input) means "use the default".
  build(values.out, { clean: values.clean, siteUrl: values["site-url"] || defaultSiteUrl() });
  console.error(`website built in ${resolve(values.out)}`);
}
