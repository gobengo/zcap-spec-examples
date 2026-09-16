import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, findLatestVersionUrl, parseVersionSegment } from "../website/latest-version.ts";

const index = "https://w3c-ccg.github.io/zcap-spec/";

/** The shape of the zcap-spec's version index, as of v0.4.0-rc.3. */
const zcapSpecIndex = `<!DOCTYPE html>
<html><head><title>Authorization Capabilities (ZCAP) — published versions</title>
<script>location.replace("v0.4.0-rc.3/")</script></head>
<body><h1>Authorization Capabilities (ZCAP)</h1>
<ul>
  <li><a href="v0.3.0/">v0.3.0</a></li>
  <li><a href="https://w3c-ccg.github.io/zcap-spec/v0.4.0-draft/">v0.4.0-draft</a></li>
  <li><a href="./v0.4.0-rc/">v0.4.0-rc</a></li>
  <li><a href="v0.4.0-rc.3/">v0.4.0-rc.3</a></li>
  <li><a href="v0.4.0-rc.1/index.html">v0.4.0-rc.1</a></li>
  <li><a href="v0.4.0-rc.2/">v0.4.0-rc.2</a></li>
</ul>
<p><a href="https://github.com/w3c-ccg/zcap-spec">Repository</a> · <a href="?all">all</a></p>
</body></html>`;

test("findLatestVersionUrl picks the highest version linked from the zcap-spec index", () => {
  assert.equal(findLatestVersionUrl(zcapSpecIndex, index), "https://w3c-ccg.github.io/zcap-spec/v0.4.0-rc.3/");
  assert.equal(
    findLatestVersionUrl(zcapSpecIndex, "https://w3c-ccg.github.io/zcap-spec/index.html?all"),
    "https://w3c-ccg.github.io/zcap-spec/v0.4.0-rc.3/",
  );
});

test("findLatestVersionUrl: a release outranks its prereleases", () => {
  const html = zcapSpecIndex.replace("</ul>", `<li><a href="v0.4.0/">v0.4.0</a></li></ul>`);
  assert.equal(findLatestVersionUrl(html, index), "https://w3c-ccg.github.io/zcap-spec/v0.4.0/");
});

test("findLatestVersionUrl prefers a meta refresh", () => {
  const html = `<meta http-equiv="Refresh" content="0; url=v0.3.0/">${zcapSpecIndex}`;
  assert.equal(findLatestVersionUrl(html, index), "https://w3c-ccg.github.io/zcap-spec/v0.3.0/");
});

test("findLatestVersionUrl ignores other sites, deeper paths, and non-versions", () => {
  const html = `
    <a href="https://evil.example/zcap-spec/v9.9.9/">x</a>
    <a href="/other/v9.9.9/">x</a>
    <a href="v9.9.9/extra/">x</a>
    <a href="javascript:alert(1)//v9.9.9/">x</a>
    <a href="latest/">x</a>`;
  assert.equal(findLatestVersionUrl(html, index), undefined);
  assert.equal(findLatestVersionUrl("<p>no links</p>", index), undefined);
});

test("compareVersions follows semver precedence", () => {
  const order = ["v0.3.0", "v0.4.0-draft", "v0.4.0-rc", "v0.4.0-rc.1", "v0.4.0-rc.2", "v0.4.0-rc.10", "v0.4.0", "v1.0.0"];
  const parsed = order.map((s) => parseVersionSegment(s)!);
  for (let i = 1; i < parsed.length; i++) {
    assert.ok(compareVersions(parsed[i - 1]!, parsed[i]!) < 0, `${order[i - 1]} < ${order[i]}`);
    assert.ok(compareVersions(parsed[i]!, parsed[i - 1]!) > 0, `${order[i]} > ${order[i - 1]}`);
  }
  assert.equal(parseVersionSegment("latest"), undefined);
});
