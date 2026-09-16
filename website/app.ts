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
 * - ReSpec styles and structures the page. This script sets
 *   `window.respecConfig` (see {@link homepageRespecConfig}), whose
 *   `preProcess` waits until every example is rendered, so ReSpec numbers each
 *   one as a subsection of "Examples" and lists it in the table of contents. If the
 *   spec is too slow, ReSpec goes ahead after {@link EXAMPLES_WAIT_MS}, and
 *   examples that arrive later get a table-of-contents line added by hand.
 *
 * The fetched document is untrusted input chosen by whoever wrote the link.
 * `describe.ts` escapes everything and only links http(s) URLs, and the page's
 * Content-Security-Policy forbids inline script, as a second line of defence.
 * ReSpec then processes the rendered examples like any other markup, which is
 * why they must stay plain escaped text: no `data-include`, no markdown.
 */
import { extractExamples } from "../examples.ts";
import { escapeHtml, renderExampleRespecSection, renderExampleRespecTocItem, safeHref } from "./describe.ts";
import { findLatestVersionUrl } from "./latest-version.ts";
import { specUrlFromSearch, specUrlQuery } from "./spec-url.ts";

// Re-exported: these lived here before spec-url.ts, and tests import them from here.
export { specUrlFromSearch, specUrlQuery };

/** Name of the `<meta>` tag carrying the spec URL used when `?url=` is absent. */
export const DEFAULT_URL_META_NAME = "zcap-spec-examples:default-url";

/**
 * How long ReSpec waits for the examples before formatting the page anyway,
 * so a slow or hanging spec server leaves a usable page rather than a blank one.
 */
export const EXAMPLES_WAIT_MS = 15_000;

/** The subset of ReSpec's configuration this page sets. */
export interface RespecConfig {
  specStatus: string;
  shortName: string;
  subtitle: string;
  editors: Array<{ name: string; url?: string }>;
  github: string;
  latestVersion: string;
  edDraftURI: null;
  lint: Record<string, boolean>;
  maxTocLevel: number;
  highlightVars: boolean;
  preProcess: Array<() => Promise<void>>;
}

declare global {
  interface Window {
    respecConfig?: RespecConfig;
  }
  interface Document {
    /** Set by ReSpec once its script runs. */
    respec?: { ready: Promise<unknown> };
  }
}

/**
 * The homepage's ReSpec configuration.
 *
 * `preProcess` resolves once `examplesRendered` does, or after `waitMs`,
 * whichever is first, and then calls `onGiveUpWaiting` if the examples were
 * not done: ReSpec builds the table of contents right after, so anything
 * rendered later is not in it.
 *
 * @param examplesRendered Settles when every example is in the page (or none will be).
 * @param options.waitMs How long to wait for them. Defaults to {@link EXAMPLES_WAIT_MS}.
 * @param options.onStart Called when ReSpec starts, so `document.respec` exists.
 * @param options.onGiveUpWaiting Called if ReSpec proceeds before the examples are done.
 * @returns The object to assign to `window.respecConfig`.
 */
export function homepageRespecConfig(
  examplesRendered: Promise<unknown>,
  {
    waitMs = EXAMPLES_WAIT_MS,
    onStart,
    onGiveUpWaiting,
  }: { waitMs?: number; onStart?: () => void; onGiveUpWaiting?: () => void } = {},
): RespecConfig {
  return {
    specStatus: "base",
    shortName: "zcap-spec-examples",
    subtitle: "The examples in a ReSpec document, extracted",
    editors: [{ name: "Benjamin Goering", url: "https://bengo.is/" }],
    github: "gobengo/zcap-spec-examples",
    latestVersion: "https://gobengo.github.io/zcap-spec-examples/",
    edDraftURI: null,
    lint: { "no-headingless-sections": false },
    // Top-level sections and each example under "Examples". Usage's
    // subsections are kept out with class="notoc".
    maxTocLevel: 2,
    // Its <var> highlighting is an inline <script>, which the CSP refuses, and
    // nothing here uses <var>.
    highlightVars: false,
    preProcess: [
      async function waitForExamples() {
        onStart?.();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = await Promise.race([
          examplesRendered.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) => (timer = setTimeout(resolve, waitMs, false))),
        ]);
        clearTimeout(timer);
        if (!done) onGiveUpWaiting?.();
      },
    ],
  };
}

let respecStarted!: () => void;
/** Resolves when ReSpec calls `preProcess`, which is only once it has defined `document.respec`. */
const respecStart = new Promise<void>((resolve) => (respecStarted = resolve));

/**
 * Resolves once ReSpec has finished formatting the page. Never resolves if
 * ReSpec never runs (it is a third-party script and may be blocked), in which
 * case there is nothing to wait for or undo.
 */
async function respecReady(): Promise<void> {
  // Not `document.respec` right away: ReSpec defines it after DOMContentLoaded.
  await respecStart;
  await document.respec?.ready.catch(() => undefined);
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

/**
 * `true` once ReSpec has stopped waiting for examples (see
 * {@link homepageRespecConfig}), after which each one also needs its own
 * table-of-contents line.
 */
let tocAlreadyBuilt = false;

async function addTocLine(html: string): Promise<void> {
  await respecReady();
  // Under the "Examples" entry, after the examples ReSpec already listed.
  const entry = document.querySelector('#toc > ol.toc > li:has(> a[href="#examples"])');
  if (!entry) return;
  let list = entry.querySelector(":scope > ol.toc");
  if (!list) {
    entry.insertAdjacentHTML("beforeend", `<ol class="toc"></ol>`);
    list = entry.querySelector(":scope > ol.toc");
  }
  list?.insertAdjacentHTML("beforeend", html);
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
  const title = `Examples in ${specUrl} · zcap-spec-examples`;
  document.title = title;
  // ReSpec sets the title from the <h1>; put this one back once it is done.
  void respecReady().then(() => (document.title = title));

  // Sections go directly before this marker, so they are subsections of the
  // "Examples" section, as siblings of its heading rather than inside a wrapper.
  const marker = element("examples-end");

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
        marker.insertAdjacentHTML("beforebegin", renderExampleRespecSection(example));
        if (tocAlreadyBuilt) void addTocLine(renderExampleRespecTocItem(example));
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
 * rendered above it since (`#cli`, `#web`, or ReSpec's header), moving it out
 * of view.
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

if (typeof document !== "undefined") {
  // Synchronously, at module evaluation: ReSpec reads this when it runs, which
  // is after this module (see the script order in index.html).
  let examplesRendered!: () => void;
  window.respecConfig = homepageRespecConfig(new Promise<void>((resolve) => (examplesRendered = resolve)), {
    onStart: respecStarted,
    onGiveUpWaiting: () => (tocAlreadyBuilt = true),
  });
  void main()
    .finally(examplesRendered)
    .finally(scrollToHash);
  void respecReady().then(scrollToHash);
}
