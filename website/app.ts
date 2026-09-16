/// <reference lib="dom" />
/**
 * The homepage's script: render the examples of whichever spec `?url=` names.
 *
 * - Visiting the homepage with no `?url=` rewrites the address to
 *   `?url=<default spec URL>` (`WEBSITE_DEFAULT_SPEC_URL`, the zcap-spec's
 *   version index, which `website/build.ts` puts in a `<meta>` tag), so every
 *   rendering is a shareable link.
 * - If the fetched document has no examples, it may be a version index that
 *   redirects to the latest version with JavaScript, which `fetch()` does not
 *   run. `findLatestVersionUrl` finds that version in the index's HTML, and
 *   the examples come from there. The address keeps the index URL, so a link
 *   to it always shows the latest version.
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
import { findLatestVersionUrl } from "./latest-version.ts";
import { specUrlFromSearch, specUrlQuery } from "./spec-url.ts";

// Re-exported: these lived here before spec-url.ts, and tests import them from here.
export { specUrlFromSearch, specUrlQuery };

/** Name of the `<meta>` tag carrying the spec URL used when `?url=` is absent. */
export const DEFAULT_URL_META_NAME = "zcap-spec-examples:default-url";

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

  // The document the examples come from: specUrl itself, or, if that is a
  // version index, the latest version it lists.
  let sourceUrl = specUrl;
  let count = 0;
  for (let hop = 0; ; hop++) {
    setStatus(hop ? `${linkTo(specUrl)} lists versions; fetching the latest, ${linkTo(sourceUrl)}…` : `Fetching ${linkTo(sourceUrl)}…`);
    const response = await fetchSpec(sourceUrl);
    if (!response) return;

    // A second reader over the same body, only read if no examples turn up.
    // A version index is small, so buffering it costs little.
    const unread = hop === 0 ? response.clone() : undefined;
    try {
      setStatus(
        `Extracting examples from ${linkTo(sourceUrl)}${hop ? `, the latest version listed at ${linkTo(specUrl)}` : ""}…`,
      );
      for await (const example of extractExamples(response, { fallbackBaseUrl: response.url || sourceUrl })) {
        count++;
        toc.insertAdjacentHTML("beforeend", renderExampleTocItem(example));
        list.insertAdjacentHTML("beforeend", renderExampleSection(example));
      }
    } catch (error) {
      setStatus(
        `Reading ${linkTo(sourceUrl)} failed after ${count} example${count === 1 ? "" : "s"}: ${escapeHtml((error as Error).message)}`,
        true,
      );
      return;
    }
    if (count > 0 || !unread) {
      void unread?.body?.cancel(); // Stop buffering a copy nobody will read.
      break;
    }

    // No examples: maybe a version index, like https://w3c-ccg.github.io/zcap-spec/,
    // whose JavaScript redirect fetch() does not follow. Follow it by hand, once.
    let latest: string | undefined;
    try {
      latest = findLatestVersionUrl(await unread.text(), response.url || sourceUrl);
    } catch {
      latest = undefined;
    }
    if (!latest || latest === sourceUrl || latest === response.url) break;
    sourceUrl = latest;
  }

  const via = sourceUrl === specUrl ? linkTo(specUrl) : `${linkTo(sourceUrl)}, the latest version listed at ${linkTo(specUrl)}`;
  if (count === 0) {
    setStatus(`No examples found in ${via}.`, true);
    return;
  }
  setStatus(
    `${count} example${count === 1 ? "" : "s"} extracted from ${via}. ` +
      `<span class="muted">Descriptions are inferred from each example's own content, not from the spec's prose.</span>`,
  );
}

/** Fetches a spec, or shows why it could not and returns `undefined`. */
async function fetchSpec(url: string): Promise<Response | undefined> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    setStatus(
      `Could not fetch ${linkTo(url)}: ${escapeHtml((error as Error).message)}. ` +
        "The server must be reachable and allow cross-origin requests (CORS).",
      true,
    );
    return undefined;
  }
  if (!response.ok) {
    setStatus(`Fetching ${linkTo(url)} failed: HTTP ${response.status} ${escapeHtml(response.statusText)}.`, true);
    return undefined;
  }
  return response;
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
