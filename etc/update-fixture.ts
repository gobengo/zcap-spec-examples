#!/usr/bin/env node
/**
 * Regenerates `fixtures.ts` from the live zcap-spec.
 *
 *   npm run fixture:update
 *
 * The snapshot is embedded as a string rather than shipped as an .html file so
 * that consuming it needs no filesystem access -- `fixtures.ts` stays as pure
 * and portable as the rest of the library, and works in a browser or worker.
 *
 * This script is tooling, not part of the package: it lives in `etc/`, is not
 * listed in `files`, and is the only place that writes to disk.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DEFAULT_ZCAP_SPEC_URL } from "../ZcapSpecExamplesCli.ts";

// The CLI's default, so the snapshot and a bare `zcap-spec-examples` run agree.
const CANONICAL_URL = DEFAULT_ZCAP_SPEC_URL;

const { values } = parseArgs({
  options: {
    // Where the document lives. Recorded in the snapshot as its identity.
    "source-url": { type: "string" },
    // Where to actually fetch the bytes from, if that differs (a mirror, a
    // local checkout served over HTTP). Defaults to --source-url.
    "fetch-url": { type: "string" },
    // ISO date to record. Defaults to today. Pass it to keep regeneration
    // deterministic in a test.
    "retrieved-at": { type: "string" },
  },
});

const sourceUrl = values["source-url"] ?? CANONICAL_URL;
const fetchUrl = values["fetch-url"] ?? sourceUrl;
const retrievedAt = values["retrieved-at"] ?? new Date().toISOString().slice(0, 10);

const response = await fetch(fetchUrl);
if (!response.ok) {
  throw new Error(`Failed to fetch ${fetchUrl}: HTTP ${response.status}`);
}
const html = await response.text();

const bytes = new TextEncoder().encode(html).length;
const sha256 = createHash("sha256").update(html, "utf8").digest("hex");

const out = `/**
 * A snapshot of the zcap-spec, embedded as a string.
 *
 * GENERATED FILE -- do not edit by hand. Regenerate with:
 *
 * \`\`\`shell
 * npm run fixture:update
 * \`\`\`
 *
 * Exists so that tests and scratch scripts have a realistic document to work
 * with, offline and without hitting the network:
 *
 * \`\`\`js
 * import { extractExamplesFromHtml } from "zcap-spec-examples";
 * import { zcapSpecHtml } from "zcap-spec-examples/fixtures";
 *
 * const examples = extractExamplesFromHtml(zcapSpecHtml);
 * \`\`\`
 *
 * It is a real ReSpec *source* document, so it exercises the things a
 * hand-written fixture tends to miss: \`respecConfig.edDraftURI\`,
 * \`<pre class="example ...">\` blocks with no \`id\` attributes, HTML entities,
 * and JSON-with-comments example bodies.
 *
 * @module
 */

/** Where this snapshot came from, and what exactly it is. */
export interface ZcapSpecSnapshot {
  /** Canonical location of the document. */
  sourceUrl: string;
  /** ISO date (UTC) the snapshot was taken. */
  retrievedAt: string;
  /** Byte length of {@link ZcapSpecSnapshot.html} encoded as UTF-8. */
  bytes: number;
  /** SHA-256 of the UTF-8 bytes, so a copy can be checked against the original. */
  sha256: string;
  /** The document itself. */
  html: string;
}

/**
 * The zcap-spec HTML, exactly as served at the time of the snapshot.
 *
 * Annotated as \`string\` rather than left to inference, so the type is not the
 * entire ${bytes}-character literal.
 *
 * @example Extract examples from the snapshot, offline
 * \`\`\`js
 * import { extractExamplesFromHtml } from "zcap-spec-examples";
 * import { zcapSpecHtml } from "zcap-spec-examples/fixtures";
 *
 * const examples = extractExamplesFromHtml(zcapSpecHtml);
 * console.log(examples.length); // 7
 * \`\`\`
 */
export const zcapSpecHtml: string = ${JSON.stringify(html)};

/** Provenance for {@link zcapSpecHtml}. */
export const zcapSpecSnapshot: ZcapSpecSnapshot = {
  sourceUrl: ${JSON.stringify(sourceUrl)},
  retrievedAt: ${JSON.stringify(retrievedAt)},
  bytes: ${bytes},
  sha256: ${JSON.stringify(sha256)},
  html: zcapSpecHtml,
};
`;

const target = fileURLToPath(new URL("../fixtures.ts", import.meta.url));
writeFileSync(target, out);
console.error(
  `wrote ${target}\n  source: ${sourceUrl}\n  fetched: ${fetchUrl}\n  bytes: ${bytes}\n  sha256: ${sha256}`,
);
