/**
 * Reading and writing spec URLs in a page's query string.
 *
 * Shared by the homepage (`?url=`) and the diff page (`?from=` and `?to=`).
 * Pure, and with no imports, so a page script can use it without pulling in
 * another page's `main()`.
 */

/**
 * `value` encoded for a query string, keeping `:` and `/` readable
 * (`https://...` rather than `https%3A%2F%2F...`). Both are legal in a query;
 * everything that is not (`&`, `#`, `+`, spaces, ...) stays encoded.
 */
export function readableQueryValue(value: string): string {
  return encodeURIComponent(value).replaceAll("%3A", ":").replaceAll("%2F", "/");
}

/** The query string `?url=<specUrl>`, with the URL kept readable. */
export function specUrlQuery(specUrl: string): string {
  return `?url=${readableQueryValue(specUrl)}`;
}

/**
 * The spec URL named by `param` (default `url`) in a page's `location.search`,
 * resolved against the page (so a relative URL works), or `undefined` if
 * absent/empty.
 *
 * @throws if the value is not an http(s) URL.
 */
export function specUrlFromSearch(search: string, pageUrl: string, param = "url"): string | undefined {
  const raw = new URLSearchParams(search).get(param)?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    throw new Error(`?${param}= is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`?${param}= must be an http(s) URL: ${raw}`);
  }
  return url.href;
}
