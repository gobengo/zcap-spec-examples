/**
 * Describes and renders zcap-spec examples as HTML.
 *
 * Shared by `website/build.ts`, which renders the bundled snapshot into the
 * static `/examples/` page, and `website/app.ts`, which renders whatever spec
 * the homepage's `?url=` points at, in the browser. So this module must stay
 * pure: no `node:*`, no DOM, no `process`. Its only import is `../examples.ts`.
 *
 * Everything it renders is escaped, and every link it emits is checked with
 * {@link safeHref}, because in the browser the input is an arbitrary document
 * fetched from a user-supplied URL.
 */
import { parseExampleContent, type ZcapSpecExample } from "../examples.ts";

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

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * `url` if it is an absolute http(s) URL, otherwise undefined.
 *
 * Example URLs are resolved against a base the *document* declares
 * (`respecConfig.edDraftURI`, `<base href>`, ...). A hostile document can
 * declare `javascript:...`, and escaping alone does not make that safe in an
 * `href`, so links are only emitted for schemes that navigate.
 */
export function safeHref(url: string): string | undefined {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** One table-of-contents entry: a link to the example's section, and its kind. */
export function renderExampleTocItem(example: ZcapSpecExample): string {
  const { kind } = describeExample(example);
  return `<li><a href="#${escapeHtml(example.name)}">${escapeHtml(example.name)}</a> <span class="muted">${escapeHtml(kind)}</span></li>`;
}

/** One example as a `<section>`, with its description, facts, and source. */
export function renderExampleSection(example: ZcapSpecExample): string {
  const d = describeExample(example);
  const facts = d.facts.length
    ? `<dl>${d.facts
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(v)}</code></dd>`)
        .join("")}</dl>`
    : "";
  const parsed = d.parsed
    ? `<details><summary>Parsed, comments removed</summary><pre><code>${escapeHtml(d.parsed)}</code></pre></details>`
    : "";
  const href = safeHref(example.url);
  const specLink = href
    ? ` · <a href="${escapeHtml(href)}">View in the spec</a>`
    : ` · <code>${escapeHtml(example.url)}</code>`;
  return `
    <section id="${escapeHtml(example.name)}" class="example">
      <h2><a href="#${escapeHtml(example.name)}">${escapeHtml(example.name)}</a>: ${escapeHtml(d.kind)}</h2>
      <p class="meta"><code>${escapeHtml(example.mediaType)}</code>${specLink}</p>
      <p>${escapeHtml(d.summary)}</p>
      ${facts}
      <details open><summary>Source</summary><pre><code>${escapeHtml(example.content)}</code></pre></details>
      ${parsed}
    </section>`;
}
