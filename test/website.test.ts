import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExamplesFromHtml } from "../examples.ts";
import {
  renderExampleRespecSection,
  renderExampleRespecTocItem,
  renderExampleSection,
  safeHref,
} from "../website/describe.ts";
import { homepageRespecConfig, specUrlFromSearch, specUrlQuery } from "../website/app.ts";

const page = "https://gobengo.github.io/zcap-spec-examples/";

test("specUrlQuery keeps the spec URL readable in the address bar", () => {
  assert.equal(
    specUrlQuery("https://w3c-ccg.github.io/zcap-spec/v0.4.0-draft/"),
    "?url=https://w3c-ccg.github.io/zcap-spec/v0.4.0-draft/",
  );
  // Characters that would change the query's meaning stay encoded.
  assert.equal(specUrlQuery("https://a.example/?x=1&y=2#z"), "?url=https://a.example/%3Fx%3D1%26y%3D2%23z");
});

test("specUrlFromSearch round-trips specUrlQuery", () => {
  const url = "https://a.example/spec/?x=1&y=2";
  assert.equal(specUrlFromSearch(specUrlQuery(url), page), url);
});

test("specUrlFromSearch: absent or empty ?url= means use the default", () => {
  assert.equal(specUrlFromSearch("", page), undefined);
  assert.equal(specUrlFromSearch("?url=", page), undefined);
  assert.equal(specUrlFromSearch("?other=1", page), undefined);
});

test("specUrlFromSearch resolves relative URLs against the page", () => {
  assert.equal(specUrlFromSearch("?url=spec.html", page), "https://gobengo.github.io/zcap-spec-examples/spec.html");
});

test("specUrlFromSearch rejects non-http(s) URLs", () => {
  assert.throws(() => specUrlFromSearch("?url=javascript:alert(1)", page), /http\(s\)/);
  assert.throws(() => specUrlFromSearch("?url=data:text/html,hi", page), /http\(s\)/);
});

test("safeHref only allows http(s)", () => {
  assert.equal(safeHref("https://a.example/#x"), "https://a.example/#x");
  assert.equal(safeHref("javascript:alert(1)//#example-1"), undefined);
  assert.equal(safeHref("#example-1"), undefined);
});

test("renderExampleSection escapes a hostile document and does not link javascript: URLs", () => {
  const html = `<html><head><script>var respecConfig = { edDraftURI: "javascript:alert(1)//" };</script></head><body>
    <pre class="example">{"id": "&lt;img src=x onerror=alert(2)&gt;"}</pre></body></html>`;
  const [example] = extractExamplesFromHtml(html);
  assert.ok(example);
  assert.match(example.url, /^javascript:/);
  const section = renderExampleSection(example);
  assert.doesNotMatch(section, /<img/);
  assert.doesNotMatch(section, /href="javascript:/);
});

test("renderExampleRespecSection is a subsection ReSpec can number, keeping the example's id", () => {
  const html = `<html><head><script>var respecConfig = { edDraftURI: "javascript:alert(1)//" };</script></head><body>
    <pre class="example">{"id": "&lt;img src=x onerror=alert(2)&gt;"}</pre></body></html>`;
  const [example] = extractExamplesFromHtml(html);
  assert.ok(example);
  const section = renderExampleRespecSection(example);
  assert.match(section, /^\s*<section id="example-1" class="zcap-example">\s*<h3>example-1: [^<]+<\/h3>/);
  // ReSpec adds the heading's self-link, and would rename a pre.example's id.
  assert.doesNotMatch(section, /<h3><a/);
  assert.doesNotMatch(section, /class="example"/);
  assert.doesNotMatch(section, /<img/);
  assert.doesNotMatch(section, /href="javascript:/);
  assert.doesNotMatch(renderExampleRespecTocItem(example), /<img/);
});

test("homepageRespecConfig: preProcess waits for the examples, then lets ReSpec run", async () => {
  let rendered!: () => void;
  let gaveUp = false;
  const config = homepageRespecConfig(new Promise<void>((resolve) => (rendered = resolve)), {
    waitMs: 10_000,
    onGiveUpWaiting: () => (gaveUp = true),
  });
  assert.equal(config.maxTocLevel, 2);
  let finished = false;
  const running = Promise.all(config.preProcess.map((step) => step())).then(() => (finished = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false, "preProcess must not resolve before the examples are rendered");
  rendered();
  await running;
  assert.equal(gaveUp, false);
});

test("homepageRespecConfig: preProcess gives up after waitMs, rather than leave the page unformatted", async () => {
  let gaveUp = false;
  const config = homepageRespecConfig(new Promise<void>(() => {}), { waitMs: 10, onGiveUpWaiting: () => (gaveUp = true) });
  await Promise.all(config.preProcess.map((step) => step()));
  assert.equal(gaveUp, true);
});

test("homepageRespecConfig: a failed render still lets ReSpec run", async () => {
  let gaveUp = false;
  const config = homepageRespecConfig(Promise.reject(new Error("boom")), { waitMs: 10_000, onGiveUpWaiting: () => (gaveUp = true) });
  await Promise.all(config.preProcess.map((step) => step()));
  assert.equal(gaveUp, false);
});

test("the homepage loads app.js before ReSpec, and its CSP still forbids inline script", () => {
  const index = readFileSync(new URL("../website/index.html", import.meta.url), "utf8");
  const app = index.indexOf(`<script type="module" src="app/website/app.js">`);
  const respec = index.indexOf(`src="https://www.w3.org/Tools/respec/respec-w3c"`);
  assert.ok(app !== -1 && respec !== -1 && app < respec, "app.js sets respecConfig, so it must run first");
  assert.match(index.slice(respec - 200, respec + 200), /\bdefer\b/);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(index)?.[1];
  assert.ok(csp);
  const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
  assert.equal(scriptSrc, "script-src 'self' https://www.w3.org");
  // Examples are rendered into the "Examples" section, so they nest under it.
  assert.match(index, /<section id="examples">\s*<h2>Examples<\/h2>[\s\S]*<div id="examples-end" hidden><\/div>\s*<\/section>/);
  assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline scripts");
});
