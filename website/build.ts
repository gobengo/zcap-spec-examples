#!/usr/bin/env node
/**
 * Builds the static website into an output directory.
 *
 * ```shell
 * node website/build.ts --out build/website [--clean] [--site-url <url>]
 * ```
 *
 * It does four things:
 *
 * 1. Copies every file in `website/` except `.ts` sources (so `index.html`,
 *    `style.css`, ... are served as-is), then fills `%ZCAP_SPEC_URL%` in
 *    `index.html` with the CLI's default spec URL.
 * 2. Generates `examples/index.html`, describing each example extracted from
 *    the bundled zcap-spec snapshot in `fixtures.ts`.
 * 3. Compiles the library's browser-safe modules (`examples.ts`,
 *    `fixtures.ts`) to ES modules in `lib/`, importable from any web page,
 *    and fills `%LIBRARY_SNIPPET%` in `index.html` with a script that does so.
 * 4. Compiles the homepage's script, `website/app.ts`, into `app/`. It reads
 *    `?url=` (defaulting it to the CLI's spec URL), fetches that spec in the
 *    browser, and renders its examples with the same code as `/examples/`.
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

import { extractExamplesFromHtml, type ZcapSpecExample } from "../examples.ts";
import { zcapSpecSnapshot } from "../fixtures.ts";
import { DEFAULT_ZCAP_SPEC_URL } from "../ZcapSpecExamplesCli.ts";
import { escapeHtml, renderExampleSection, renderExampleTocItem } from "./describe.ts";

// Kept exported from here too, for anything that already imported them from build.ts.
export { describeExample, type ExampleDescription } from "./describe.ts";

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
  compile("etc/tsconfig.website.json", resolve(out, "lib"));
}

/**
 * Compiles the homepage script into `<out>/app/`. Separate from `lib/`
 * because `lib/` is a public API and the app is not: the app gets its own copy
 * of `examples.js` rather than adding `website/*.js` to what others import.
 */
function buildApp(out: string): void {
  compile("etc/tsconfig.website-app.json", resolve(out, "app"));
}

function compile(project: string, outDir: string): void {
  // Resolved from the repo, so this needs `npm ci` but never a global tsc.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(
    process.execPath,
    [tsc, "--project", resolve(repoRoot, project), "--outDir", outDir],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`tsc failed building ${outDir}`);
}

// ---------------------------------------------------------------------------
// The static /examples/ page
// ---------------------------------------------------------------------------

export function renderExamplesPage(examples: ZcapSpecExample[]): string {
  const snapshot = zcapSpecSnapshot;
  const toc = examples.map(renderExampleTocItem).join("\n        ");
  const sections = examples.map(renderExampleSection).join("\n");

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
  buildApp(out);

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
