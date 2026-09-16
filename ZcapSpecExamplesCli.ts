/**
 * The command-line behaviour, with no runtime-specific dependencies.
 *
 * {@link ZcapSpecExamplesCli} knows *what* the CLI does -- read input, extract
 * examples, format them -- but nothing about *how* to reach a runtime. Reading
 * stdin, writing stdout, and fetching are all injected via
 * {@link ZcapSpecExamplesCliDeps}, so this file has no `node:*` imports.
 *
 * The Node.js wiring lives in `./nodejs.ts`.
 *
 * @module
 */

import {
  extractExamplesFromHtml,
  formatExample,
  formatExampleAsPrettyJson,
  formatExamplesAsJson,
} from "./examples.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Where the CLI fetches the spec from when given no `--url` and no stdin.
 *
 * Deliberately a versioned path, not the bare `https://w3c-ccg.github.io/zcap-spec/`: that is now
 * a version index which redirects to the latest release with JavaScript, so a
 * plain fetch of it (or `curl`) gets a page with no examples in it.
 */
export const DEFAULT_ZCAP_SPEC_URL = "https://w3c-ccg.github.io/zcap-spec/v0.4.0-draft/";

export type ZcapSpecExamplesOutputFormat = "json" | "ndjson" | "text";

/**
 * @category Running the CLI
 */
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
   * Output format.
   *
   * - `"ndjson"` -- one compact object per line. The default here, and what a
   *   pipeline should see.
   * - `"json"` -- the same objects, indented. Readable by eye; still a valid
   *   stream of JSON values for `jq`.
   * - `"text"` -- a human-readable listing.
   *
   * The CLI picks between `"json"` and `"ndjson"` based on whether stdout is a
   * terminal; see `NodejsZcapSpecExamplesCli`.
   */
  format?: ZcapSpecExamplesOutputFormat;
}

/** Minimal shape of the Fetch API that `ZcapSpecExamplesCli` depends on. */
export type FetchLike = (url: string) => Promise<{ text(): Promise<string> }>;

/**
 * @category Running the CLI
 */
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
  --format=<format>    Output format: "json", "ndjson", or "text".
                       Defaults to "json" (indented, easy to read) when stdout
                       is a terminal, and "ndjson" (one compact object per
                       line) when the output is piped or redirected.
                       Both are valid input for jq. "text" prints a
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

/**
 * The CLI's behaviour, with every runtime detail injected.
 *
 * You only need this if you are embedding the command-line behaviour in
 * something other than Node — a test harness, a worker, a browser. To just get
 * the data, use {@link extractExamples} instead.
 *
 * @example Run the CLI against a string, capturing output
 * ```js
 * let out = "";
 * const cli = new ZcapSpecExamplesCli({
 *   fetch: (url) => fetch(url),
 *   readStdin: async () => html,       // pretend this was piped in
 *   writeStdout: (chunk) => { out += chunk; },
 *   writeStderr: (chunk) => console.error(chunk),
 * });
 * const exitCode = await cli.run({ format: "json" });
 * ```
 *
 * @category Running the CLI
 */
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

    const examples = extractExamplesFromHtml(html, {
      baseUrl: options.baseUrl,
      fallbackBaseUrl,
    });
    if (examples.length === 0) {
      this.deps.writeStderr("No examples found in the given HTML source.\n");
      return 1;
    }

    // Default to the machine-readable form: this class has no idea whether a
    // human is watching. The Node CLI upgrades it to "json" for a terminal.
    const format = options.format ?? "ndjson";
    if (format === "text") {
      for (const example of examples) {
        this.deps.writeStdout(formatExample(example));
      }
    } else if (format === "json") {
      for (const example of examples) {
        this.deps.writeStdout(formatExampleAsPrettyJson(example));
      }
    } else {
      this.deps.writeStdout(formatExamplesAsJson(examples));
    }
    return 0;
  }
}
