#!/usr/bin/env node
/**
 * Serves a built site the way GitHub Pages serves this project.
 *
 *   npm run dev            # build exactly what gh-pages.yml publishes, then serve it
 *   node etc/serve-gh-pages.ts build/website --port 4000 --base /zcap-spec-examples/
 *
 * A plain static server at `/` hides the bugs that only show up on Pages, so
 * this mimics the parts of Pages' behaviour that matter for this site:
 *
 * - **Project subpath.** Pages serves a project site from `/<repo>/`, not `/`.
 *   A root-absolute link (`/style.css`) works on a naive local server and 404s
 *   in production. Here it 404s locally too. `/` redirects to the base.
 * - **Directory slash redirect.** `/docs` 301s to `/docs/`, so relative links
 *   inside `docs/index.html` resolve the same way they will on Pages.
 * - **`index.html` for directories**, and **`foo` → `foo.html`** fallback.
 * - **`404.html`** at the site root, with status 404, when one exists.
 * - **`Access-Control-Allow-Origin: *`**, so cross-origin `import`s of `/lib/` work.
 *
 * Tooling only, zero dependencies. Binds to 127.0.0.1 by default.
 */
import { createReadStream, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: process.env.PORT ?? "4000" },
    host: { type: "string", default: "127.0.0.1" },
    // Defaults to the package name, which matches the repository name and so
    // the path Pages serves this project from.
    base: { type: "string" },
  },
});

const root = realpathSync(resolve(positionals[0] ?? "build/website"));
const packageName = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { name: string }).name;
const base = `/${(values.base ?? packageName).replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
const port = Number(values.port);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Resolves to a real path inside `root`, or undefined. Follows symlinks, then re-checks containment. */
function inside(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return real === root || real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

type Resolution = { file: string } | { redirect: string } | undefined;

function resolveRequest(sitePath: string): Resolution {
  let decoded: string;
  try {
    decoded = decodeURIComponent(sitePath);
  } catch {
    return undefined;
  }
  // Reject NUL and any `..` segment outright rather than normalising them away.
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return undefined;

  const candidate = join(root, decoded);
  const stats = statOrUndefined(candidate);

  if (stats?.isDirectory()) {
    // `sitePath` is relative to the base, so "" is the site root and already has its slash.
    if (sitePath !== "" && !sitePath.endsWith("/")) return { redirect: `${base}${sitePath}/` };
    const index = inside(join(candidate, "index.html"));
    return index && statOrUndefined(index)?.isFile() ? { file: index } : undefined;
  }
  if (stats?.isFile()) {
    const file = inside(candidate);
    return file ? { file } : undefined;
  }
  if (!extname(decoded) && !decoded.endsWith("/")) {
    const html = inside(`${candidate}.html`);
    if (html && statOrUndefined(html)?.isFile()) return { file: html };
  }
  return undefined;
}

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const status = (code: number) => console.error(`${code} ${method} ${url.pathname}`);

  if (method !== "GET" && method !== "HEAD") {
    status(405);
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  // Outside the project path: Pages would serve the user/org site, which this
  // project does not have. Redirect the bare root for convenience; 404 the rest.
  if (!url.pathname.startsWith(base)) {
    if (url.pathname === "/" || `${url.pathname}/` === base) {
      status(302);
      res.writeHead(302, { Location: base + url.search }).end();
      return;
    }
    return notFound();
  }

  const resolution = resolveRequest(url.pathname.slice(base.length));
  if (resolution && "redirect" in resolution) {
    status(301);
    res.writeHead(301, { Location: resolution.redirect + url.search }).end();
    return;
  }
  if (!resolution) return notFound();

  status(200);
  send(200, resolution.file);

  function send(code: number, file: string) {
    res.writeHead(code, {
      "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": statSync(file).size,
      // Pages caches for 10 minutes; locally, always show the latest build.
      "Cache-Control": "no-store",
      // Pages allows any origin, which is what lets other sites import /lib/.
      "Access-Control-Allow-Origin": "*",
    });
    if (method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  function notFound() {
    status(404);
    const custom = inside(join(root, "404.html"));
    if (custom && statOrUndefined(custom)?.isFile()) return send(404, custom);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found\n");
  }
});

server.listen(port, values.host, () => {
  console.error(`Serving ${root}\n  at http://${values.host === "0.0.0.0" ? "localhost" : values.host}:${port}${base}`);
});
