/// <reference lib="dom" />
/**
 * The homepage's script: render the examples of whichever spec `?url=` names.
 *
 * - Visiting the homepage with no `?url=` rewrites the address to
 *   `?url=<default spec URL>` (the CLI's `DEFAULT_ZCAP_SPEC_URL`, which
 *   `website/build.ts` puts in a `<meta>` tag), so every rendering is a
 *   shareable link.
 * - The spec is fetched by the browser, so the server must allow cross-origin
 *   requests. GitHub Pages, where the zcap-spec lives, does.
 * - Examples are streamed with `extractExamples` and rendered as they arrive,
 *   by the same `describe.ts` that renders the static `/examples/` page.
 *
 * The fetched document is untrusted input chosen by whoever wrote the link.
 * `describe.ts` escapes everything and only links http(s) URLs, and the page's
 * Content-Security-Policy forbids inline script, as a second line of defence.
 */
import { extractExamples } from "../examples.ts";
import { escapeHtml, renderExampleSection, renderExampleTocItem, safeHref } from "./describe.ts";

/** Name of the `<meta>` tag carrying the spec URL used when `?url=` is absent. */
export const DEFAULT_URL_META_NAME = "zcap-spec-examples:default-url";

/**
 * The query string `?url=<specUrl>`, keeping `:` and `/` readable
 * (`?url=https://...` rather than `?url=https%3A%2F%2F...`). Both are legal in
 * a query; everything that is not (`&`, `#`, `+`, spaces, ...) stays encoded.
 */
export function specUrlQuery(specUrl: string): string {
  return `?url=${encodeURIComponent(specUrl).replaceAll("%3A", ":").replaceAll("%2F", "/")}`;
}

/**
 * The spec URL to load, from a page's `location.search`: `?url=` resolved
 * against the page (so a relative URL works), or `undefined` if absent/empty.
 *
 * @throws if the value is not an http(s) URL.
 */
export function specUrlFromSearch(search: string, pageUrl: string): string | undefined {
  const raw = new URLSearchParams(search).get("url")?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    throw new Error(`?url= is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`?url= must be an http(s) URL: ${raw}`);
  }
  return url.href;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

function setStatus(html: string, isError = false): void {
  const status = element("spec-status");
  status.innerHTML = html;
  status.classList.toggle("error", isError);
}

function linkTo(url: string): string {
  const href = safeHref(url);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>` : `<code>${escapeHtml(url)}</code>`;
}

async function main(): Promise<void> {
  const defaultUrl = document.querySelector<HTMLMetaElement>(`meta[name="${DEFAULT_URL_META_NAME}"]`)?.content;
  const form = element<HTMLFormElement>("spec-form");
  const input = element<HTMLInputElement>("spec-url");

  // Submit with the same readable encoding the redirect uses.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value) location.assign(specUrlQuery(value));
  });

  let specUrl: string | undefined;
  try {
    specUrl = specUrlFromSearch(location.search, location.href);
  } catch (error) {
    input.value = new URLSearchParams(location.search).get("url") ?? "";
    setStatus(escapeHtml((error as Error).message), true);
    return;
  }
  if (!specUrl) {
    if (!defaultUrl) {
      setStatus("Enter the URL of a spec to extract its examples.");
      return;
    }
    // replaceState, not a reload: same address a redirect would produce, with
    // no second page load and no extra history entry.
    history.replaceState(null, "", specUrlQuery(defaultUrl) + location.hash);
    specUrl = defaultUrl;
  }
  input.value = specUrl;
  document.title = `Examples in ${specUrl} · zcap-spec-examples`;

  const toc = element<HTMLOListElement>("examples-toc");
  const list = element("examples");
  setStatus(`Fetching ${linkTo(specUrl)}…`);

  let response: Response;
  try {
    response = await fetch(specUrl);
  } catch (error) {
    setStatus(
      `Could not fetch ${linkTo(specUrl)}: ${escapeHtml((error as Error).message)}. ` +
        "The server must be reachable and allow cross-origin requests (CORS).",
      true,
    );
    return;
  }
  if (!response.ok) {
    setStatus(`Fetching ${linkTo(specUrl)} failed: HTTP ${response.status} ${escapeHtml(response.statusText)}.`, true);
    return;
  }

  let count = 0;
  try {
    setStatus(`Extracting examples from ${linkTo(specUrl)}…`);
    for await (const example of extractExamples(response, { fallbackBaseUrl: response.url || specUrl })) {
      count++;
      toc.insertAdjacentHTML("beforeend", renderExampleTocItem(example));
      list.insertAdjacentHTML("beforeend", renderExampleSection(example));
    }
  } catch (error) {
    setStatus(
      `Reading ${linkTo(specUrl)} failed after ${count} example${count === 1 ? "" : "s"}: ${escapeHtml((error as Error).message)}`,
      true,
    );
    return;
  }

  if (count === 0) {
    const hint =
      defaultUrl && specUrl !== defaultUrl
        ? ` A version index such as https://w3c-ccg.github.io/zcap-spec/ only redirects with JavaScript; try a specific version, e.g. <a href="${escapeHtml(specUrlQuery(defaultUrl))}">${escapeHtml(defaultUrl)}</a>.`
        : "";
    setStatus(`No examples found in ${linkTo(specUrl)}.${hint}`, true);
    return;
  }
  setStatus(
    `${count} example${count === 1 ? "" : "s"} extracted from ${linkTo(specUrl)}. ` +
      `<span class="muted">Descriptions are inferred from each example's own content, not from the spec's prose.</span>`,
  );
}

/**
 * Scrolls to the element `location.hash` names. The browser already tried, on
 * load, but either the target did not exist yet (`#example-3`) or content
 * rendered above it since (`#cli`, `#web`), moving it out of view.
 */
function scrollToHash(): void {
  if (!location.hash) return;
  let id: string;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  document.getElementById(id)?.scrollIntoView();
}

if (typeof document !== "undefined") void main().finally(scrollToHash);
