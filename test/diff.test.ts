import { test } from "node:test";
import assert from "node:assert/strict";
import { extractExamplesFromHtml, type ZcapSpecExample } from "../examples.ts";
import {
  compareExamples,
  diffLines,
  diffWords,
  exampleSimilarity,
  exampleText,
  MAX_LINE_DIFF_CELLS,
  renderDiff,
  renderDiffTable,
} from "../website/diff.ts";
import { diffOptionsFromSearch, diffQuery, versionLabel } from "../website/diff-app.ts";
import { specUrlFromSearch } from "../website/spec-url.ts";

function example(name: string, content: string, mediaType = "application/jsonc"): ZcapSpecExample {
  return { name, content, mediaType, url: `https://spec.example/#${name}` };
}

const car = `{
  "id": "https://whatacar.example/a-fancy-car/proc/7a397d7b",
  // the first delegated capability
  "parentCapability": "https://whatacar.example/a-fancy-car",
  "controller": "https://social.example/alyssa#key-for-car",
  "proof": { "type": "Ed25519Signature2018", "proofPurpose": "capabilityDelegation" }
}`;
const carV2 = car
  .replace('"https://whatacar.example/a-fancy-car"', '"urn:zcap:root:https%3A%2F%2Fwhatacar.example%2Fa-fancy-car"')
  .replace("Ed25519Signature2018", "DataIntegrityProof");
const root = `{ "id": "urn:zcap:root:https%3A%2F%2Fexample.com%2Ffoo", "controller": "did:key:example", "invocationTarget": "https://example.com/foo" }`;
const http = "POST /api/v1/example HTTP/1.1\nHost: example.com\nCapability-Invocation: zcap capability=abc";
const cid = `{ "@context": ["https://www.w3.org/ns/cid/v1"], "id": "https://whatacar.example/a-fancy-car", "capabilityDelegation": ["#key"] }`;

test("exampleSimilarity ignores formatting and is 0 for nothing in common", () => {
  assert.equal(exampleSimilarity('{"a": ["x", "y"]}', '{\n  "a": [\n    "x",\n    "y"\n  ]\n}'), 1);
  assert.equal(exampleSimilarity("alpha beta", "gamma delta"), 0);
  assert.ok(exampleSimilarity(car, carV2) > 0.7);
});

test("compareExamples pairs by content when an inserted example renumbers the rest", () => {
  const before = [example("example-1", car), example("example-2", root)];
  const after = [example("example-1", cid), example("example-2", carV2), example("example-3", root), example("example-4", http, "message/http")];
  const changes = compareExamples(before, after);
  assert.deepEqual(
    changes.map((c) => [c.status, c.before?.name, c.after?.name]),
    [
      ["added", undefined, "example-1"],
      ["changed", "example-1", "example-2"],
      ["unchanged", "example-2", "example-3"],
      ["added", undefined, "example-4"],
    ],
  );
});

test("compareExamples reports removed examples where they used to be", () => {
  const changes = compareExamples([example("example-1", root), example("example-2", http), example("example-3", car)], [example("example-1", root), example("example-2", car)]);
  assert.deepEqual(changes.map((c) => c.status), ["unchanged", "removed", "unchanged"]);
  assert.equal(changes[1]!.before!.name, "example-2");
});

test("compareExamples pairs examples that share an id even after growing a lot", () => {
  const grown = car.replace("{", `{\n${Array.from({ length: 40 }, (_, i) => `  // new commentary line ${i} about delegation chains\n  "extra${i}": "value${i}",`).join("\n")}`);
  assert.ok(exampleSimilarity(car, grown) < 0.5, "precondition: words alone would not pair these");
  const changes = compareExamples([example("example-1", car)], [example("example-1", grown)]);
  assert.deepEqual(changes.map((c) => c.status), ["changed"]);
});

test("compareExamples marks examples that moved out of order", () => {
  const changes = compareExamples([example("example-1", car), example("example-2", http, "message/http")], [example("example-1", http, "message/http"), example("example-2", car)]);
  const moved = changes.filter((c) => c.moved);
  assert.equal(moved.length, 1);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((c) => c.status === "unchanged"));
});

test("the parsed view ignores comments and formatting", () => {
  const reflowed = example("example-1", '{\n  // a comment\n  "a": ["x",\n        "y"]\n}');
  const plain = example("example-1", '{\n  "a": [\n    "x",\n    "y"\n  ]\n}');
  assert.equal(compareExamples([reflowed], [plain], { view: "source" })[0]!.status, "changed");
  assert.equal(compareExamples([reflowed], [plain], { view: "parsed" })[0]!.status, "unchanged");
  assert.equal(exampleText(example("h", http, "message/http"), "parsed"), http);
});

test("diffLines numbers lines and lists removals before additions", () => {
  const ops = diffLines("a\nb\nc\nd", "a\nB\nC\nd\ne");
  assert.deepEqual(
    ops.map((o) => [o.type, o.text, o.beforeLine, o.afterLine]),
    [
      ["equal", "a", 1, 1],
      ["remove", "b", 2, undefined],
      ["remove", "c", 3, undefined],
      ["add", "B", undefined, 2],
      ["add", "C", undefined, 3],
      ["equal", "d", 4, 4],
      ["add", "e", undefined, 5],
    ],
  );
  assert.deepEqual(diffLines("", "x").map((o) => o.type), ["add"]);
  assert.deepEqual(diffLines("x  ", "x").map((o) => o.type), ["equal"]);
});

test("diffLines stays bounded on huge inputs", () => {
  const size = Math.ceil(Math.sqrt(MAX_LINE_DIFF_CELLS)) + 10;
  const a = Array.from({ length: size }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: size }, (_, i) => `b${i}`).join("\n");
  const started = performance.now();
  const ops = diffLines(`same\n${a}\nsame`, `same\n${b}\nsame`);
  assert.ok(performance.now() - started < 2000);
  assert.equal(ops.length, 2 * size + 2);
  assert.equal(ops[0]!.type, "equal");
  assert.equal(ops.at(-1)!.type, "equal");
});

test("diffWords highlights the changed word within a line", () => {
  const words = diffWords('"type": "Ed25519Signature2018",', '"type": "DataIntegrityProof",');
  assert.ok(words);
  assert.deepEqual(words[0].filter((s) => s.changed).map((s) => s.text), ["Ed25519Signature2018"]);
  assert.deepEqual(words[1].filter((s) => s.changed).map((s) => s.text), ["DataIntegrityProof"]);
  assert.equal(diffWords("completely different", "nothing shared here"), undefined);
});

test("renderDiffTable collapses unchanged lines far from a change", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const changed = [...lines];
  changed[10] = "changed";
  const table = renderDiffTable(diffLines(lines.join("\n"), changed.join("\n")), 2);
  assert.match(table, /⋯ 8 unchanged lines/);
  assert.match(table, /⋯ 7 unchanged lines/);
  assert.doesNotMatch(renderDiffTable(diffLines(lines.join("\n"), changed.join("\n")), Infinity), /unchanged line/);
});

test("renderDiff hides unchanged examples unless asked, and summarizes counts", () => {
  const changes = compareExamples([example("example-1", root), example("example-2", car)], [example("example-1", root), example("example-2", carV2)]);
  const hidden = renderDiff(changes, { beforeLabel: "v1", afterLabel: "v2" });
  assert.doesNotMatch(hidden.sections, /id="to-example-1"/);
  assert.match(hidden.sections, /id="to-example-2"/);
  assert.match(hidden.summary, /1 changed/);
  assert.match(hidden.summary, /1 unchanged/);
  assert.match(renderDiff(changes, { beforeLabel: "v1", afterLabel: "v2", showUnchanged: true }).sections, /id="to-example-1"/);
});

test("renderDiff escapes hostile documents and does not link javascript: URLs", () => {
  const hostile = (id: string) => `<html><head><script>var respecConfig = { edDraftURI: "javascript:alert(1)//" };</script></head><body>
    <pre class="example">{"id": "&lt;img src=x onerror=alert(2)&gt;", "v": "${id}"}</pre></body></html>`;
  const [before] = extractExamplesFromHtml(hostile("1"));
  const [after] = extractExamplesFromHtml(hostile("2"));
  assert.ok(before && after);
  const { summary, toc, sections } = renderDiff(compareExamples([before], [after]), {
    beforeLabel: "<b>old</b>",
    afterLabel: "<script>new</script>",
  });
  const html = summary + toc + sections;
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("diffQuery round-trips through the page's query parsing", () => {
  const from = "https://w3c-ccg.github.io/zcap-spec/v0.3.0/";
  const to = "https://a.example/spec/?x=1&y=2";
  const query = diffQuery(from, to, { view: "parsed", showUnchanged: true });
  assert.equal(query.startsWith("?from=https://w3c-ccg.github.io/zcap-spec/v0.3.0/&to="), true);
  const page = "https://gobengo.github.io/zcap-spec-examples/diff/";
  assert.equal(specUrlFromSearch(query, page, "from"), from);
  assert.equal(specUrlFromSearch(query, page, "to"), to);
  assert.deepEqual(diffOptionsFromSearch(query), { view: "parsed", showUnchanged: true, fullContext: false, ignoreWhitespace: false });
  assert.deepEqual(diffOptionsFromSearch(diffQuery(from, to)), { view: "source", showUnchanged: false, fullContext: false, ignoreWhitespace: false });
  assert.throws(() => specUrlFromSearch("?to=javascript:alert(1)", page, "to"), /\?to= must be an http\(s\) URL/);
});

test("versionLabel names a spec version by its last path segment", () => {
  assert.equal(versionLabel("https://w3c-ccg.github.io/zcap-spec/v0.4.0-rc.5/"), "v0.4.0-rc.5");
  assert.equal(versionLabel("https://w3c-ccg.github.io/zcap-spec/v0.3.0/index.html"), "v0.3.0");
  assert.equal(versionLabel("https://spec.example/"), "spec.example");
});

test("diffLines ignoreWhitespace treats reflowed lines, indentation, and blank lines as unchanged", () => {
  const before = '{\n  "@context": ["https://w3id.org/zcap/v1",\n               "https://autopower.example/"],\n  "id": "x"\n}';
  const after = '{\n    "@context": [\n    "https://w3id.org/zcap/v1",\n    "https://autopower.example/"\n  ],\n\n  "id": "x"\n}';
  assert.ok(diffLines(before, after).some((o) => o.type !== "equal"), "precondition: differs by default");
  const ops = diffLines(before, after, { ignoreWhitespace: true });
  assert.ok(ops.every((o) => o.type === "equal"));
  assert.deepEqual(ops.map((o) => o.text), after.split("\n"));
  assert.deepEqual(ops.map((o) => o.afterLine), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("diffLines ignoreWhitespace still shows real changes, whole runs at a time", () => {
  const ops = diffLines('a\n"type": "Old",\n\nz', 'a\n  "type":"New",\nz', { ignoreWhitespace: true });
  assert.deepEqual(
    ops.map((o) => [o.type, o.text]),
    [
      ["equal", "a"],
      ["remove", '"type": "Old",'],
      ["remove", ""],
      ["add", '  "type":"New",'],
      ["equal", "z"],
    ],
  );
});

test("compareExamples ignoreWhitespace reports whitespace-only changes as unchanged", () => {
  const before = example("example-1", '{"a": ["x", "y"]} // same');
  const after = example("example-1", '{\n  "a": [\n    "x",\n    "y"\n  ]\n}  //  same');
  assert.equal(compareExamples([before], [after])[0]!.status, "changed");
  assert.equal(compareExamples([before], [after], { ignoreWhitespace: true })[0]!.status, "unchanged");
  const changes = compareExamples([before], [example("example-1", '{"a": ["x", "z"]} // same')], { ignoreWhitespace: true });
  assert.equal(changes[0]!.status, "changed");
  assert.equal(diffOptionsFromSearch(diffQuery("https://a.example/", "https://b.example/", { ignoreWhitespace: true })).ignoreWhitespace, true);
});
