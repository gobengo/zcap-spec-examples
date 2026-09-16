/**
 * Finding the latest version of a spec from its version index.
 *
 * https://w3c-ccg.github.io/zcap-spec/ is no longer the spec itself but a page
 * listing its published versions (`v0.4.0-rc.3/`, `v0.3.0/`, ...), which sends
 * browsers on to the newest with JavaScript. A `fetch()` does not run that
 * script, so it gets the index, with no examples in it. {@link findLatestVersionUrl}
 * reads the index's HTML and works out where that redirect would have gone.
 *
 * Pure, with no DOM, so it runs in the browser and under `node --test` alike.
 */
import { getAttribute } from "../examples.ts";

/** A version directory name, like `v0.3.0` or `0.4.0-rc.3`: semver, with an optional `v`. */
const VERSION_SEGMENT = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** A parsed version, for ordering. */
export interface Version {
  core: [number, number, number];
  prerelease: string[];
}

/** The version a directory name denotes, or `undefined` if it is not one. */
export function parseVersionSegment(segment: string): Version | undefined {
  const m = VERSION_SEGMENT.exec(segment);
  if (!m) return undefined;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/**
 * Semver precedence: negative if `a` is older than `b`. A release outranks its
 * prereleases, and prerelease identifiers compare numerically when both are
 * numbers, so `rc.10` > `rc.9` > `rc.1` > `rc` > `draft`.
 */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! - b.core[i]!;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return (a.prerelease.length ? -1 : 0) - (b.prerelease.length ? -1 : 0);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `url` as an http(s) URL resolved against `base`, or `undefined`. */
function resolveHttpUrl(url: string, base: string): URL | undefined {
  try {
    const resolved = new URL(url.trim(), base);
    return resolved.protocol === "https:" || resolved.protocol === "http:" ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** The URL of a `<meta http-equiv="refresh" content="0; url=...">`, if any. */
function metaRefreshUrl(html: string, pageUrl: string): string | undefined {
  for (const [, attrs] of html.matchAll(/<meta\b([^>]*)>/gi)) {
    if (getAttribute(attrs!, "http-equiv")?.toLowerCase() !== "refresh") continue;
    const target = /url\s*=\s*['"]?([^'"]+)/i.exec(getAttribute(attrs!, "content") ?? "")?.[1];
    const resolved = target ? resolveHttpUrl(target, pageUrl) : undefined;
    if (resolved) return resolved.href;
  }
  return undefined;
}

/**
 * The URL of the latest version listed on a version index page, or `undefined`
 * if the page does not look like one.
 *
 * In order of preference:
 *
 * 1. The target of a `<meta http-equiv="refresh">`, since that is a redirect
 *    the page states outright.
 * 2. Of the links to a version directory directly under the index -- for the
 *    index `https://w3c-ccg.github.io/zcap-spec/`, links like `v0.3.0/` or
 *    `https://w3c-ccg.github.io/zcap-spec/v0.4.0-rc.3/` -- the highest version
 *    by semver precedence. Links elsewhere, and to anything that is not a
 *    version, are ignored.
 *
 * Only call this on a page that has no examples of its own: a spec's own
 * header links to other versions of it too, and those are not a redirect.
 *
 * @param html - The index page's HTML.
 * @param pageUrl - The URL it was fetched from, which relative links resolve against.
 */
export function findLatestVersionUrl(html: string, pageUrl: string): string | undefined {
  const refresh = metaRefreshUrl(html, pageUrl);
  if (refresh && refresh !== pageUrl) return refresh;

  const page = resolveHttpUrl(pageUrl, pageUrl);
  if (!page) return undefined;
  // The directory the index is in: /zcap-spec/ for /zcap-spec/ and /zcap-spec/index.html.
  const indexDir = page.pathname.slice(0, page.pathname.lastIndexOf("/") + 1);
  const baseHref = getAttribute(/<base\b([^>]*)>/i.exec(html)?.[1] ?? "", "href");
  const base = (baseHref && resolveHttpUrl(baseHref, page.href)) || page;

  let latest: { url: string; version: Version } | undefined;
  for (const [, attrs] of html.matchAll(/<a\b([^>]*)>/gi)) {
    const href = getAttribute(attrs!, "href");
    const url = href ? resolveHttpUrl(href, base.href) : undefined;
    if (!url || url.origin !== page.origin || !url.pathname.startsWith(indexDir)) continue;
    // Exactly one directory below the index: "v0.3.0/", optionally "v0.3.0/index.html".
    const rest = url.pathname.slice(indexDir.length).replace(/\/(?:index\.html?)?$/i, "");
    if (rest.includes("/")) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rest);
    } catch {
      continue;
    }
    const version = parseVersionSegment(segment);
    if (!version) continue;
    if (!latest || compareVersions(version, latest.version) > 0) {
      url.hash = "";
      url.search = "";
      latest = { url: url.href, version };
    }
  }
  return latest?.url;
}
