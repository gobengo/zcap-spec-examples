/// <reference lib="dom" />
/**
 * The `/diff/` page's script (experimental): compare the examples of two
 * versions of a spec.
 *
 * - `?from=` and `?to=` name the two spec URLs. With neither, the address is
 *   rewritten to the defaults in the page's `<meta>` tags, so every comparison
 *   is a shareable link, as on the homepage.
 * - `?view=parsed` compares JSON with comments removed and formatting
 *   normalized; `?unchanged=show` lists unchanged examples too;
 *   `?context=full` shows every line instead of just the lines near a change;
 *   `?whitespace=ignore` ignores whitespace and line breaks when diffing.
 *   Changing these re-renders without fetching again.
 * - Both specs are fetched in parallel by the browser, so their servers must
 *   allow cross-origin requests. GitHub Pages does.
 *
 * Both documents are untrusted input chosen by whoever wrote the link.
 * `diff.ts` escapes everything and only links http(s) URLs, and the page's
 * Content-Security-Policy forbids inline script as a second line of defence.
 */
import { extractExamples, type ZcapSpecExample } from "../examples.ts";
import { escapeHtml, safeHref } from "./describe.ts";
import { compareExamples, renderDiff, type DiffView } from "./diff.ts";
import { readableQueryValue, specUrlFromSearch } from "./spec-url.ts";

/** Names of the `<meta>` tags carrying the spec URLs used when the query names none. */
export const DEFAULT_FROM_META_NAME = "zcap-spec-examples:diff-default-from";
export const DEFAULT_TO_META_NAME = "zcap-spec-examples:diff-default-to";

/** Display options, all of which live in the query string. */
export interface DiffDisplayOptions {
  view: DiffView;
  showUnchanged: boolean;
  fullContext: boolean;
  ignoreWhitespace: boolean;
}

/**
 * The query string for comparing `from` with `to`, with the URLs kept
 * readable. Default display options are left out.
 */
export function diffQuery(from: string, to: string, options: Partial<DiffDisplayOptions> = {}): string {
  let query = `?from=${readableQueryValue(from)}&to=${readableQueryValue(to)}`;
  if (options.view === "parsed") query += "&view=parsed";
  if (options.showUnchanged) query += "&unchanged=show";
  if (options.fullContext) query += "&context=full";
  if (options.ignoreWhitespace) query += "&whitespace=ignore";
  return query;
}

/** Display options from a page's `location.search`; anything unrecognized means the default. */
export function diffOptionsFromSearch(search: string): DiffDisplayOptions {
  const params = new URLSearchParams(search);
  return {
    view: params.get("view") === "parsed" ? "parsed" : "source",
    showUnchanged: params.get("unchanged") === "show",
    fullContext: params.get("context") === "full",
    ignoreWhitespace: params.get("whitespace") === "ignore",
  };
}

/**
 * A short name for a spec URL: its last path segment, e.g. `v0.3.0` for
 * `https://w3c-ccg.github.io/zcap-spec/v0.3.0/`, or the host if there is none.
 */
export function versionLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const segments = parsed.pathname.split("/").filter((s) => s !== "" && !/^index\.html?$/i.test(s));
  const last = segments.at(-1);
  if (!last) return parsed.host;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

function setStatus(html: string, isError = false): void {
  const status = element("diff-status");
  status.innerHTML = html;
  status.classList.toggle("error", isError);
}

function linkTo(url: string): string {
  const href = safeHref(url);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>` : `<code>${escapeHtml(url)}</code>`;
}

/** Fetches a spec and extracts its examples, linking each to *that* version rather than the editor's draft. */
async function loadExamples(url: string): Promise<ZcapSpecExample[]> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Could not fetch ${url}: ${(error as Error).message}. The server must be reachable and allow cross-origin requests (CORS).`,
    );
  }
  if (!response.ok) throw new Error(`Fetching ${url} failed: HTTP ${response.status} ${response.statusText}.`);
  const examples: ZcapSpecExample[] = [];
  // baseUrl, not fallbackBaseUrl: the zcap-spec declares its editor's draft as
  // its URL, so without this every version's examples would link to the same page.
  for await (const example of extractExamples(response, { baseUrl: response.url || url })) examples.push(example);
  return examples;
}

async function main(): Promise<void> {
  const form = element<HTMLFormElement>("diff-form");
  const fromInput = element<HTMLInputElement>("diff-from");
  const toInput = element<HTMLInputElement>("diff-to");
  const viewParsed = element<HTMLInputElement>("diff-view-parsed");
  const viewSource = element<HTMLInputElement>("diff-view-source");
  const showUnchanged = element<HTMLInputElement>("diff-show-unchanged");
  const fullContext = element<HTMLInputElement>("diff-full-context");
  const ignoreWhitespace = element<HTMLInputElement>("diff-ignore-whitespace");
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;

  const initial = diffOptionsFromSearch(location.search);
  viewParsed.checked = initial.view === "parsed";
  viewSource.checked = initial.view !== "parsed";
  showUnchanged.checked = initial.showUnchanged;
  fullContext.checked = initial.fullContext;
  ignoreWhitespace.checked = initial.ignoreWhitespace;
  const currentOptions = (): DiffDisplayOptions => ({
    view: viewParsed.checked ? "parsed" : "source",
    showUnchanged: showUnchanged.checked,
    fullContext: fullContext.checked,
    ignoreWhitespace: ignoreWhitespace.checked,
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const from = fromInput.value.trim();
    const to = toInput.value.trim();
    if (from && to) location.assign(diffQuery(from, to, currentOptions()));
  });
  element<HTMLButtonElement>("diff-swap").addEventListener("click", () => {
    [fromInput.value, toInput.value] = [toInput.value, fromInput.value];
  });

  const params = new URLSearchParams(location.search);
  let from: string | undefined;
  let to: string | undefined;
  try {
    from = specUrlFromSearch(location.search, location.href, "from");
    to = specUrlFromSearch(location.search, location.href, "to");
  } catch (error) {
    fromInput.value = params.get("from") ?? "";
    toInput.value = params.get("to") ?? "";
    setStatus(escapeHtml((error as Error).message), true);
    return;
  }
  if (!from && !to) {
    const defaultFrom = meta(DEFAULT_FROM_META_NAME);
    const defaultTo = meta(DEFAULT_TO_META_NAME);
    if (!defaultFrom || !defaultTo) {
      setStatus("Enter the URLs of two versions of a spec to compare their examples.");
      return;
    }
    history.replaceState(null, "", diffQuery(defaultFrom, defaultTo, initial) + location.hash);
    from = defaultFrom;
    to = defaultTo;
  }
  fromInput.value = from ?? "";
  toInput.value = to ?? "";
  if (!from || !to) {
    setStatus(`Enter a spec URL for ${from ? "“To”" : "“From”"} too.`, true);
    return;
  }

  let beforeLabel = versionLabel(from);
  let afterLabel = versionLabel(to);
  if (beforeLabel === afterLabel) {
    beforeLabel = from;
    afterLabel = to;
  }
  document.title = `Examples from ${beforeLabel} to ${afterLabel} · zcap-spec-examples`;
  setStatus(`Fetching ${linkTo(from)} and ${linkTo(to)}…`);

  let before: ZcapSpecExample[];
  let after: ZcapSpecExample[];
  try {
    [before, after] = await Promise.all([loadExamples(from), loadExamples(to)]);
  } catch (error) {
    setStatus(escapeHtml((error as Error).message), true);
    return;
  }
  const empty = [before.length ? undefined : from, after.length ? undefined : to].filter(Boolean) as string[];
  if (empty.length) {
    setStatus(
      `No examples found in ${empty.map(linkTo).join(" or ")}. A version index such as ` +
        `https://w3c-ccg.github.io/zcap-spec/ only redirects with JavaScript; use a specific version.`,
      true,
    );
    return;
  }

  const summary = element("diff-summary");
  const toc = element<HTMLOListElement>("diff-toc");
  const sections = element("diff-sections");
  const render = () => {
    const options = currentOptions();
    const changes = compareExamples(before, after, { view: options.view, ignoreWhitespace: options.ignoreWhitespace });
    const rendered = renderDiff(changes, {
      beforeLabel,
      afterLabel,
      showUnchanged: options.showUnchanged,
      context: options.fullContext ? Infinity : 3,
      ignoreWhitespace: options.ignoreWhitespace,
    });
    summary.innerHTML = rendered.summary;
    toc.innerHTML = rendered.toc;
    sections.innerHTML = rendered.sections;
  };
  render();
  for (const control of [viewParsed, viewSource, showUnchanged, fullContext, ignoreWhitespace]) {
    control.addEventListener("change", () => {
      history.replaceState(null, "", diffQuery(from, to, currentOptions()) + location.hash);
      render();
    });
  }

  setStatus(
    `Compared ${before.length} example${before.length === 1 ? "" : "s"} in ${linkTo(from)} ` +
      `with ${after.length} in ${linkTo(to)}. ` +
      `<span class="muted">Examples are matched by content, not by number, since inserting one renumbers the rest.</span>`,
  );
}

/** As on the homepage: the target of `location.hash` only exists once rendered. */
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
