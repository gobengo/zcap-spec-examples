import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExamplesFromHtml } from "../examples.ts";
import { renderExampleSection, safeHref } from "../website/describe.ts";
import { specUrlFromSearch, specUrlQuery } from "../website/app.ts";

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
