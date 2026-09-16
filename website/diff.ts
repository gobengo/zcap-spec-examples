/**
 * Compares the examples of two versions of a spec, and renders the comparison
 * as HTML.
 *
 * Used by `website/diff-app.ts`, the `/diff/` page. Like `describe.ts` it must
 * stay pure: no `node:*`, no DOM, no `process`. Its input is two arbitrary
 * documents fetched from user-supplied URLs, so everything rendered is escaped
 * and every link goes through {@link safeHref}.
 *
 * Examples have no identity across versions: ReSpec numbers them by position,
 * so inserting one example renumbers every example after it. So examples are
 * paired by *content*, not by name:
 *
 * 1. Each pair (before, after) gets a similarity in [0, 1] from the words the
 *    two share (see {@link exampleSimilarity}). Words, not lines, so that
 *    reflowing JSON does not make an example look new. Two JSON examples with
 *    the same `id` score at least 0.5, since an example that grew a lot (the
 *    zcap-spec's delegation examples tripled in size from v0.3.0 to v0.4.0)
 *    still usually keeps its `id`. Similarity is always computed on the source,
 *    whatever the {@link DiffView}, so both views pair examples the same way.
 * 2. An order-preserving alignment picks the pairs that maximize total
 *    similarity, ignoring pairs below a threshold. Unpaired examples are
 *    added or removed.
 * 3. Leftover added/removed examples that are still similar enough are paired
 *    too, and marked as moved.
 */
import { parseExampleContent, type ZcapSpecExample } from "../examples.ts";
import { describeExample, escapeHtml, safeHref } from "./describe.ts";

// ---------------------------------------------------------------------------
// Pairing examples
// ---------------------------------------------------------------------------

/**
 * What is compared. `source` is each example's text as written in the spec;
 * `parsed` is JSON examples with comments removed and formatting normalized,
 * so only changes to the data itself show up.
 */
export type DiffView = "source" | "parsed";

export type ExampleChangeStatus = "unchanged" | "changed" | "added" | "removed";

/** How one example differs between the two versions. */
export interface ExampleChange {
  status: ExampleChangeStatus;
  /** The example in the older version; absent when added. */
  before?: ZcapSpecExample;
  /** The example in the newer version; absent when removed. */
  after?: ZcapSpecExample;
  /** The compared text of `before`, per the {@link DiffView}. */
  beforeText?: string;
  /** The compared text of `after`, per the {@link DiffView}. */
  afterText?: string;
  /** Paired out of document order: the example moved relative to others. */
  moved: boolean;
  /** Similarity of the pair, in [0, 1]; 0 when added or removed. */
  similarity: number;
}

export interface CompareExamplesOptions {
  view?: DiffView;
  /** Minimum similarity for pairing examples in document order. */
  threshold?: number;
  /** Minimum similarity for pairing leftovers out of order (as moved). */
  movedThreshold?: number;
  /** Examples differing only in whitespace (including line breaks) are unchanged. See {@link DiffLinesOptions}. */
  ignoreWhitespace?: boolean;
}

export const DEFAULT_PAIRING_THRESHOLD = 0.5;
export const DEFAULT_MOVED_THRESHOLD = 0.6;

/**
 * Above this many (before × after) pairs, similarity is not computed and only
 * identical examples are paired. Real specs have tens of examples; this only
 * bounds the work a hostile document can cause.
 */
export const MAX_PAIRWISE_COMPARISONS = 250_000;

/** The text of `example` that is compared, for a {@link DiffView}. */
export function exampleText(example: ZcapSpecExample, view: DiffView = "source"): string {
  if (view !== "parsed") return example.content;
  const mediaType = (example.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "message/http") return example.content;
  try {
    return JSON.stringify(parseExampleContent(example), null, 2);
  } catch {
    return example.content;
  }
}

// Linear, no backtracking: one character class, repeated.
const WORD = /[\p{L}\p{N}]+/gu;

function wordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [word] of text.matchAll(WORD)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let sizeA = 0;
  let sizeB = 0;
  let shared = 0;
  for (const count of a.values()) sizeA += count;
  for (const [word, count] of b) {
    sizeB += count;
    const other = a.get(word);
    if (other) shared += Math.min(count, other);
  }
  return sizeA + sizeB === 0 ? 1 : (2 * shared) / (sizeA + sizeB);
}

/** The top-level string `id` of a JSON example, if it has one. */
function jsonId(example: ZcapSpecExample): string | undefined {
  if (!example.content.trimStart().startsWith("{")) return undefined;
  try {
    const value = parseExampleContent(example);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const id = (value as { id?: unknown }).id;
      return typeof id === "string" && id !== "" ? id : undefined;
    }
  } catch {
    // Not JSON: no id.
  }
  return undefined;
}

/**
 * How alike two texts are, from 0 (no words in common) to 1 (the same words,
 * the same number of times): the Sørensen–Dice coefficient over their words.
 * Punctuation and whitespace are ignored, so reformatting changes nothing.
 *
 * @example
 * exampleSimilarity('{"a": ["x", "y"]}', '{\n  "a": [\n    "x",\n    "y"\n  ]\n}'); // 1
 */
export function exampleSimilarity(a: string, b: string): number {
  return dice(wordCounts(a), wordCounts(b));
}

/**
 * Pairs the examples of two versions of a spec and classifies each one as
 * unchanged, changed, added, or removed. The result is in document order: the
 * newer version's order, with removed examples where they used to be.
 *
 * @example
 * const changes = compareExamples(extractExamplesFromHtml(oldHtml), extractExamplesFromHtml(newHtml));
 * changes.filter((c) => c.status === "added").map((c) => c.after!.name);
 */
export function compareExamples(
  before: readonly ZcapSpecExample[],
  after: readonly ZcapSpecExample[],
  options: CompareExamplesOptions = {},
): ExampleChange[] {
  const view = options.view ?? "source";
  const threshold = options.threshold ?? DEFAULT_PAIRING_THRESHOLD;
  const movedThreshold = options.movedThreshold ?? DEFAULT_MOVED_THRESHOLD;
  const ignoreWhitespace = options.ignoreWhitespace ?? false;
  const beforeTexts = before.map((e) => exampleText(e, view));
  const afterTexts = after.map((e) => exampleText(e, view));
  const n = before.length;
  const m = after.length;

  // similarity[i * m + j] for before[i], after[j].
  const similarity = new Float64Array(n * m);
  if (n * m <= MAX_PAIRWISE_COMPARISONS) {
    const beforeWords = before.map((e) => wordCounts(e.content));
    const afterWords = after.map((e) => wordCounts(e.content));
    const beforeIds = before.map(jsonId);
    const afterIds = after.map(jsonId);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const s = dice(beforeWords[i]!, afterWords[j]!);
        const sameId = beforeIds[i] !== undefined && beforeIds[i] === afterIds[j];
        similarity[i * m + j] = sameId ? (1 + s) / 2 : s;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) similarity[i * m + j] = beforeTexts[i] === afterTexts[j] ? 1 : 0;
    }
  }

  // best[i * w + j]: the most total similarity achievable pairing before[i..]
  // with after[j..] in order. Filled from the end so the walk below goes forward.
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = similarity[i * m + j]!;
      const skip = Math.max(best[(i + 1) * w + j]!, best[i * w + j + 1]!);
      best[i * w + j] = s >= threshold ? Math.max(skip, s + best[(i + 1) * w + j + 1]!) : skip;
    }
  }

  type Op = { i?: number; j?: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = similarity[i * m + j]!;
    // Same arithmetic as the fill above, so exact equality is reliable.
    if (s >= threshold && best[i * w + j] === s + best[(i + 1) * w + j + 1]!) {
      ops.push({ i: i++, j: j++ });
    } else if (best[(i + 1) * w + j]! >= best[i * w + j + 1]!) {
      ops.push({ i: i++ });
    } else {
      ops.push({ j: j++ });
    }
  }
  while (i < n) ops.push({ i: i++ });
  while (j < m) ops.push({ j: j++ });

  // Pair leftovers that moved, most similar first.
  const removed = ops.flatMap((op) => (op.j === undefined ? [op.i!] : []));
  const added = ops.flatMap((op) => (op.i === undefined ? [op.j!] : []));
  const candidates: Array<[s: number, i: number, j: number]> = [];
  for (const ri of removed) {
    for (const aj of added) {
      const s = similarity[ri * m + aj]!;
      if (s >= movedThreshold) candidates.push([s, ri, aj]);
    }
  }
  candidates.sort((x, y) => y[0] - x[0] || x[2] - y[2]);
  const movedFrom = new Map<number, number>(); // after index -> before index
  const movedBefore = new Set<number>();
  for (const [, ri, aj] of candidates) {
    if (movedBefore.has(ri) || movedFrom.has(aj)) continue;
    movedFrom.set(aj, ri);
    movedBefore.add(ri);
  }

  const changes: ExampleChange[] = [];
  for (const op of ops) {
    if (op.j === undefined) {
      if (movedBefore.has(op.i!)) continue;
      changes.push({ status: "removed", before: before[op.i!], beforeText: beforeTexts[op.i!], moved: false, similarity: 0 });
      continue;
    }
    const bi = op.i ?? movedFrom.get(op.j);
    if (bi === undefined) {
      changes.push({ status: "added", after: after[op.j], afterText: afterTexts[op.j], moved: false, similarity: 0 });
      continue;
    }
    changes.push({
      status: sameText(beforeTexts[bi]!, afterTexts[op.j]!, ignoreWhitespace) ? "unchanged" : "changed",
      before: before[bi],
      after: after[op.j],
      beforeText: beforeTexts[bi],
      afterText: afterTexts[op.j],
      moved: op.i === undefined,
      similarity: similarity[bi * m + op.j]!,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Diffing text
// ---------------------------------------------------------------------------

/** One line of a line diff. Line numbers are 1-based. */
export interface LineOp {
  type: "equal" | "remove" | "add";
  text: string;
  beforeLine?: number;
  afterLine?: number;
}

/**
 * Above this many cells in the LCS table, the differing middle of two texts is
 * shown as removed-then-added instead of being diffed. Bounds hostile input.
 */
export const MAX_LINE_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

/** `text` with every whitespace character removed, as `git diff -w` compares lines. */
function withoutWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

function sameText(a: string, b: string, ignoreWhitespace: boolean): boolean {
  return ignoreWhitespace ? withoutWhitespace(a) === withoutWhitespace(b) : a === b;
}

/** Lines equal apart from trailing whitespace. */
function sameLine(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

/** Lines equal apart from any whitespace at all. */
function sameLineIgnoringWhitespace(a: string, b: string): boolean {
  return withoutWhitespace(a) === withoutWhitespace(b);
}

export interface DiffLinesOptions {
  /**
   * Ignore whitespace entirely, like `git diff -w`, and also line breaks: a run
   * of changed lines whose text is the same once whitespace is removed (JSON
   * reflowed across lines, added blank lines, re-indentation) is shown as
   * unchanged, in its newer form. The caveat is also git's: a change inside a
   * string that only adds or removes a space is ignored too.
   */
  ignoreWhitespace?: boolean;
}

/**
 * Longest-common-subsequence edit script from `a` to `b`, in order, with each
 * run of changes listed as all removals then all additions (as `diff -u` does).
 */
function editScript<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean, maxCells: number): Array<LineOp["type"]> | undefined {
  let start = 0;
  while (start < a.length && start < b.length && same(a[start]!, b[start]!)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1]!, b[endB - 1]!)) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const kinds: Array<LineOp["type"]> = new Array<LineOp["type"]>(start).fill("equal");

  if ((n + 1) * (m + 1) <= maxCells) {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = same(a[start + i]!, b[start + j]!)
          ? lcs[(i + 1) * w + j + 1]! + 1
          : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (same(a[start + i]!, b[start + j]!)) {
        kinds.push("equal");
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        kinds.push("remove");
        i++;
      } else {
        kinds.push("add");
        j++;
      }
    }
    for (; i < n; i++) kinds.push("remove");
    for (; j < m; j++) kinds.push("add");
  } else if (maxCells === 0) {
    return undefined;
  } else {
    for (let i = 0; i < n; i++) kinds.push("remove");
    for (let j = 0; j < m; j++) kinds.push("add");
  }
  for (let k = endA; k < a.length; k++) kinds.push("equal");

  // Within each run of changes, removals first.
  for (let k = 0; k < kinds.length; ) {
    if (kinds[k] === "equal") {
      k++;
      continue;
    }
    let end = k;
    let removes = 0;
    while (end < kinds.length && kinds[end] !== "equal") {
      if (kinds[end] === "remove") removes++;
      end++;
    }
    for (let x = k; x < end; x++) kinds[x] = x - k < removes ? "remove" : "add";
    k = end;
  }
  return kinds;
}

/**
 * A line diff of two texts. Lines that differ only in trailing whitespace are
 * always treated as equal; with `ignoreWhitespace`, all whitespace is ignored.
 *
 * With `ignoreWhitespace`, an `equal` op may be missing `beforeLine`: a
 * reflowed run is shown as its newer lines, which need not line up one-to-one
 * with the older ones.
 *
 * @example
 * diffLines("a\nb", "a\nc").map((op) => op.type); // ["equal", "remove", "add"]
 * diffLines('["a",\n "b"]', '[\n  "a",\n  "b"\n]', { ignoreWhitespace: true }).map((op) => op.type);
 * // ["equal", "equal", "equal", "equal"]
 */
export function diffLines(beforeText: string, afterText: string, options: DiffLinesOptions = {}): LineOp[] {
  const a = splitLines(beforeText);
  const b = splitLines(afterText);
  const ignoreWhitespace = options.ignoreWhitespace ?? false;
  const kinds = editScript(a, b, ignoreWhitespace ? sameLineIgnoringWhitespace : sameLine, MAX_LINE_DIFF_CELLS)!;
  const ops: LineOp[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  for (let k = 0; k < kinds.length; ) {
    const type = kinds[k]!;
    if (ignoreWhitespace && type !== "equal") {
      // A run of changes: removals, then additions (editScript groups them).
      let removes = 0;
      let adds = 0;
      while (k + removes < kinds.length && kinds[k + removes] === "remove") removes++;
      while (k + removes + adds < kinds.length && kinds[k + removes + adds] === "add") adds++;
      const removed = a.slice(beforeLine, beforeLine + removes).join("");
      const added = b.slice(afterLine, afterLine + adds).join("");
      if (withoutWhitespace(removed) === withoutWhitespace(added)) {
        for (let x = 0; x < adds; x++) {
          ops.push({ type: "equal", text: b[afterLine]!, beforeLine: x < removes ? beforeLine + x + 1 : undefined, afterLine: ++afterLine });
        }
        beforeLine += removes;
      } else {
        for (let x = 0; x < removes; x++) ops.push({ type: "remove", text: a[beforeLine]!, beforeLine: ++beforeLine });
        for (let x = 0; x < adds; x++) ops.push({ type: "add", text: b[afterLine]!, afterLine: ++afterLine });
      }
      k += removes + adds;
      continue;
    }
    k++;
    if (type === "equal") {
      ops.push({ type, text: b[afterLine]!, beforeLine: ++beforeLine, afterLine: ++afterLine });
    } else if (type === "remove") {
      ops.push({ type, text: a[beforeLine]!, beforeLine: ++beforeLine });
    } else {
      ops.push({ type, text: b[afterLine]!, afterLine: ++afterLine });
    }
  }
  return ops;
}

/** A piece of a line, and whether it is part of the change. */
export interface Segment {
  text: string;
  changed: boolean;
}

const WORD_OR_OTHER = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_WORD_DIFF_CELLS = 250_000;

/**
 * Which parts of a changed line changed, for highlighting within it. Returns
 * `undefined` when the lines have too little in common for that to help.
 *
 * @example
 * diffWords('"type": "Ed25519Signature2018"', '"type": "DataIntegrityProof"');
 */
export function diffWords(before: string, after: string): [before: Segment[], after: Segment[]] | undefined {
  const a = before.match(WORD_OR_OTHER) ?? [];
  const b = after.match(WORD_OR_OTHER) ?? [];
  const kinds = editScript(a, b, (x, y) => x === y, MAX_WORD_DIFF_CELLS);
  if (!kinds) return undefined;
  let common = 0;
  const beforeSegments: Segment[] = [];
  const afterSegments: Segment[] = [];
  const append = (segments: Segment[], text: string, changed: boolean) => {
    const last = segments.at(-1);
    if (last && last.changed === changed) last.text += text;
    else segments.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  for (const type of kinds) {
    if (type === "equal") {
      const token = a[i++]!;
      j++;
      if (token.trim()) common += token.length;
      append(beforeSegments, token, false);
      append(afterSegments, token, false);
    } else if (type === "remove") {
      append(beforeSegments, a[i++]!, true);
    } else {
      append(afterSegments, b[j++]!, true);
    }
  }
  const longest = Math.max(before.trim().length, after.trim().length);
  return longest > 0 && common / longest >= 0.25 ? [beforeSegments, afterSegments] : undefined;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderDiffOptions {
  /** Short name of the older version, e.g. "v0.3.0". */
  beforeLabel: string;
  /** Short name of the newer version, e.g. "v0.4.0-rc.5". */
  afterLabel: string;
  /** Unchanged lines shown around each change; `Infinity` shows every line. */
  context?: number;
  /** Include unchanged examples in the table of contents and sections. */
  showUnchanged?: boolean;
  /** Diff lines ignoring whitespace; pass the same value given to {@link compareExamples}. */
  ignoreWhitespace?: boolean;
}

/** The rendered comparison: a one-paragraph summary, `<li>` items, and `<section>`s. */
export interface RenderedDiff {
  summary: string;
  toc: string;
  sections: string;
}

/** The element id of a change's section. */
export function changeAnchor(change: ExampleChange): string {
  return change.after ? `to-${change.after.name}` : `from-${change.before!.name}`;
}

function changeTitle(change: ExampleChange): string {
  const { before, after } = change;
  if (before && after && before.name !== after.name) return `${before.name} → ${after.name}`;
  return (after ?? before)!.name;
}

function kindOf(change: ExampleChange): string {
  const beforeKind = change.before && describeExample(change.before).kind;
  const afterKind = change.after && describeExample(change.after).kind;
  return beforeKind && afterKind && beforeKind !== afterKind ? `${beforeKind} → ${afterKind}` : (afterKind ?? beforeKind)!;
}

function badges(change: ExampleChange, options: RenderDiffOptions): string {
  const text: Record<ExampleChangeStatus, string> = {
    unchanged: "unchanged",
    changed: "changed",
    added: `added in ${options.afterLabel}`,
    removed: `removed in ${options.afterLabel}`,
  };
  const status = `<span class="badge ${change.status}">${escapeHtml(text[change.status])}</span>`;
  return change.moved ? `${status} <span class="badge moved">moved</span>` : status;
}

function lineStats(ops: readonly LineOp[]): string {
  let adds = 0;
  let removes = 0;
  for (const op of ops) {
    if (op.type === "add") adds++;
    else if (op.type === "remove") removes++;
  }
  return adds || removes ? `<span class="stat-add">+${adds}</span> <span class="stat-remove">−${removes}</span>` : "";
}

function linkToExample(label: string, example: ZcapSpecExample): string {
  const href = safeHref(example.url);
  const text = `${label} #${example.name}`;
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` : `<code>${escapeHtml(text)}</code>`;
}

function renderSegments(segments: readonly Segment[]): string {
  // Changed whitespace alone (re-indentation) is not worth a highlight.
  return segments.map((s) => (s.changed && s.text.trim() ? `<mark>${escapeHtml(s.text)}</mark>` : escapeHtml(s.text))).join("");
}

/** A line diff as a `<table>`, collapsing unchanged lines more than `context` away from a change. */
export function renderDiffTable(ops: readonly LineOp[], context = 3): string {
  const visible = new Uint8Array(ops.length);
  let last = -Infinity;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type !== "equal") last = k;
    if (k - last <= context) visible[k] = 1;
  }
  let next = Infinity;
  for (let k = ops.length - 1; k >= 0; k--) {
    if (ops[k]!.type !== "equal") next = k;
    if (next - k <= context) visible[k] = 1;
  }

  // Highlight within lines: pair the n-th removal of a run with its n-th addition.
  const highlighted = new Map<number, Segment[]>();
  for (let k = 0; k < ops.length; ) {
    if (ops[k]!.type !== "remove") {
      k++;
      continue;
    }
    const removeStart = k;
    while (k < ops.length && ops[k]!.type === "remove") k++;
    const addStart = k;
    while (k < ops.length && ops[k]!.type === "add") k++;
    const pairs = Math.min(addStart - removeStart, k - addStart);
    for (let p = 0; p < pairs; p++) {
      const words = diffWords(ops[removeStart + p]!.text, ops[addStart + p]!.text);
      if (!words) continue;
      highlighted.set(removeStart + p, words[0]);
      highlighted.set(addStart + p, words[1]);
    }
  }

  const rows: string[] = [];
  const sign = { equal: " ", remove: "−", add: "+" };
  const rowClass = { equal: "ctx", remove: "del", add: "ins" };
  for (let k = 0; k < ops.length; ) {
    if (!visible[k]) {
      let end = k;
      while (end < ops.length && !visible[end]) end++;
      const count = end - k;
      rows.push(`<tr class="gap"><td colspan="4">⋯ ${count} unchanged line${count === 1 ? "" : "s"}</td></tr>`);
      k = end;
      continue;
    }
    const op = ops[k]!;
    const segments = highlighted.get(k);
    const code = segments ? renderSegments(segments) : escapeHtml(op.text);
    rows.push(
      `<tr class="${rowClass[op.type]}"><td class="ln">${op.beforeLine ?? ""}</td><td class="ln">${op.afterLine ?? ""}</td>` +
        `<td class="sign" aria-hidden="true">${sign[op.type]}</td><td class="code">${code}</td></tr>`,
    );
    k++;
  }
  return `<div class="diff-scroll"><table class="diff"><tbody>${rows.join("")}</tbody></table></div>`;
}

/** Counts of each status, plus how many paired examples moved. */
export function summarizeChanges(changes: readonly ExampleChange[]): Record<ExampleChangeStatus | "moved", number> {
  const counts = { unchanged: 0, changed: 0, added: 0, removed: 0, moved: 0 };
  for (const change of changes) {
    counts[change.status]++;
    if (change.moved) counts.moved++;
  }
  return counts;
}

/**
 * Renders a comparison from {@link compareExamples}.
 *
 * @example
 * const { summary, toc, sections } = renderDiff(changes, { beforeLabel: "v0.3.0", afterLabel: "v0.4.0-rc.5" });
 */
export function renderDiff(changes: readonly ExampleChange[], options: RenderDiffOptions): RenderedDiff {
  const context = options.context ?? 3;
  const counts = summarizeChanges(changes);
  const plural = (n: number, word: string) => `${n} ${word}`;
  const summary =
    `<p class="diff-summary">From <strong>${escapeHtml(options.beforeLabel)}</strong> to <strong>${escapeHtml(options.afterLabel)}</strong>: ` +
    [
      `<span class="badge changed">${plural(counts.changed, "changed")}</span>`,
      `<span class="badge added">${plural(counts.added, "added")}</span>`,
      `<span class="badge removed">${plural(counts.removed, "removed")}</span>`,
      `<span class="badge unchanged">${plural(counts.unchanged, "unchanged")}</span>`,
    ].join(" ") +
    (counts.moved ? ` <span class="badge moved">${plural(counts.moved, "moved")}</span>` : "") +
    `</p>`;

  const toc: string[] = [];
  const sections: string[] = [];
  for (const change of changes) {
    if (change.status === "unchanged" && !options.showUnchanged) continue;
    const id = escapeHtml(changeAnchor(change));
    const title = escapeHtml(changeTitle(change));
    const kind = escapeHtml(kindOf(change));
    const ops =
      change.status === "unchanged" ? [] : diffLines(change.beforeText ?? "", change.afterText ?? "", { ignoreWhitespace: options.ignoreWhitespace });
    const stats = lineStats(ops);

    toc.push(
      `<li><a href="#${id}">${title}</a> ${badges(change, options)} <span class="muted">${kind}</span>${stats ? ` ${stats}` : ""}</li>`,
    );

    const links = [
      change.before && linkToExample(options.beforeLabel, change.before),
      change.after && linkToExample(options.afterLabel, change.after),
    ]
      .filter(Boolean)
      .join(" → ");
    const mediaType =
      change.before && change.after && change.before.mediaType !== change.after.mediaType
        ? `<code>${escapeHtml(change.before.mediaType)}</code> → <code>${escapeHtml(change.after.mediaType)}</code>`
        : `<code>${escapeHtml((change.after ?? change.before)!.mediaType)}</code>`;
    const body =
      change.status === "unchanged"
        ? `<details><summary>Show example</summary><pre><code>${escapeHtml(change.afterText ?? "")}</code></pre></details>`
        : renderDiffTable(ops, context);
    sections.push(`
    <section id="${id}" class="example change ${change.status}">
      <h2><a href="#${id}">${title}</a>: ${kind}</h2>
      <p class="meta">${badges(change, options)}${stats ? ` ${stats}` : ""} · ${mediaType} · ${links}</p>
      ${body}
    </section>`);
  }
  if (!sections.length) {
    sections.push(`<p class="muted">No examples changed.</p>`);
  }
  return { summary, toc: toc.join(""), sections: sections.join("\n") };
}
