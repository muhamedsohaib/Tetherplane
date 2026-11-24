import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { SemanticSnapshotEngine, StaleReferenceError } from "../../browser/bridge/src/semantic.ts";

class FakeElement {
  constructor(tag, text = "", attributes = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.ownText = text;
    this.attributes = attributes;
    this.children = children;
    this.id = attributes.id || "";
    this.parentElement = null;
    for (const child of children) child.parentElement = this;
  }
  get textContent() { return this.ownText + this.children.map(x => x.textContent).join(" "); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  closest() {
    for (let x = this; x; x = x.parentElement) {
      if (x.hasAttribute("hidden") || x.getAttribute("aria-hidden") === "true") return x;
    }
    return null;
  }
  getClientRects() { return this.closest() ? [] : [{}]; }
}
class FakeButton extends FakeElement {
  constructor(text) { super("button", text); this.disabled = false; }
}
class FakeInput extends FakeElement {}
class FakeTextarea extends FakeElement {}
class FakeSelect extends FakeElement {}
class FakeOption extends FakeElement {}
function flatten(node) { return [node, ...node.children.flatMap(flatten)]; }
function card(label, secondHeading = false) {
  return new FakeElement("div", "", {}, [
    new FakeElement("h2", label),
    new FakeElement("h3", "Hidden heading", {hidden: ""}),
    ...(secondHeading ? [new FakeElement("h3", "Other heading")] : []),
    new FakeElement("div", "", {}, [new FakeButton("Create campaign")]),
  ]);
}
function fixture(labels, secondHeading = false) {
  const body = new FakeElement("body", "", {}, [
    new FakeElement("main", "", {}, labels.map(label => card(label, secondHeading))),
  ]);
  const root = new FakeElement("html", "", {}, [body]);
  const all = flatten(root);
  const heading = x => /^H[1-6]$/.test(x.tagName) || x.getAttribute("role") === "heading";
  const document = {
    body, documentElement: root,
    querySelectorAll(selector) {
      if (selector === "h1,h2,h3,h4,h5,h6,[role='heading']") return all.filter(heading);
      if (selector.includes("button") && selector.includes("h1")) {
        return all.filter(x => x instanceof FakeButton || heading(x));
      }
      return [];
    },
    querySelector() { return null; },
    getElementById(id) { return all.find(x => x.id === id) || null; },
  };
  return {
    document, location: { href: "https://fixture.example/campaigns", origin: "https://fixture.example" },
    Element: FakeElement, HTMLElement: FakeElement,
    HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextarea,
    HTMLSelectElement: FakeSelect, HTMLButtonElement: FakeButton, HTMLOptionElement: FakeOption,
    CSS: { escape: x => x },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  };
}
const observers = [
  ["owner extension", "extension/browser/src/page-agent.ts", "collectDocumentSemanticState", "performDocumentAction"],
  ["managed CDP", "browser/bridge/src/cdp-control.ts", "collectCdpFrameObservation", "performCdpFrameAction"],
];
function observe(spec, labels, secondHeading = false) {
  const [, path, name, next] = spec;
  const source = fs.readFileSync(new URL("../../" + path, import.meta.url), "utf8");
  const start = source.indexOf("function " + name + "(");
  const end = source.indexOf("function " + next + "(", start);
  assert.ok(start >= 0 && end > start, "observer boundary must exist");
  const js = stripTypeScriptTypes(source.slice(start, end), { mode: "strip" });
  const observed = vm.runInNewContext(js + "\n" + name + '("https://fixture.example")', fixture(labels, secondHeading));
  return JSON.parse(JSON.stringify(observed.nodes)).map(node => ({
    ...node, document_id: "document-1", frame_id: "frame:0",
  }));
}
for (const spec of observers) {
  test(spec[0] + ": contextual duplicate buttons resolve correctly after card reorder", () => {
    const engine = new SemanticSnapshotEngine();
    const first = observe(spec, ["Sponsored Products", "Sponsored Brands", "Display"]);
    const before = engine.snapshot(first, { revision: 1 });
    const buttons = before.nodes.filter(n => n.role === "button");
    assert.equal(buttons.length, 3);
    const ref = buttons.find(n => n.ancestry.some(a => a.accessible_name === "Sponsored Products")).ref;
    const after = observe(spec, ["Display", "Sponsored Brands", "Sponsored Products"]);
    const resolved = engine.reacquire(ref, after);
    assert.ok(resolved.ancestry.some(a => a.accessible_name === "Sponsored Products"));
    assert.notEqual(resolved.backend_id, first.find(n => n.role === "button" && n.ancestry.some(a => a.accessible_name === "Sponsored Products")).backend_id);
    assert.ok(!JSON.stringify(before).includes("Hidden heading"));
  });
  test(spec[0] + ": identical headings do not justify arbitrary action", () => {
    const engine = new SemanticSnapshotEngine();
    const before = engine.snapshot(observe(spec, ["Same", "Same"]), { revision: 1 });
    const ref = before.nodes.filter(n => n.role === "button")[0].ref;
    assert.throws(() => engine.reacquire(ref, observe(spec, ["Same", "Same"])), StaleReferenceError);
    assert.throws(() => engine.reacquire(ref, observe(spec, ["Same"])), StaleReferenceError);
  });
  test(spec[0] + ": multi-heading containers are not labelled from an arbitrary heading", () => {
    const before = new SemanticSnapshotEngine().snapshot(observe(spec, ["First", "Second"], true), { revision: 1 });
    const buttons = before.nodes.filter(n => n.role === "button");
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every(n => !n.ancestry.some(a => ["First", "Second", "Other heading"].includes(a.accessible_name))));
  });
}
test("truncation cannot turn an ambiguous reference into a unique reference", () => {
  const engine = new SemanticSnapshotEngine();
  const a = { backend_id: "css:#a", role: "button", accessible_name: "Add", document_id: "doc", frame_id: "frame:0", ancestry: [] };
  const b = { ...a, backend_id: "css:#b" };
  const first = engine.snapshot([a, b], { revision: 7, max_nodes: 1 });
  assert.equal(first.truncated, true);
  assert.throws(() => engine.reacquire(first.nodes[0].ref, [b]), StaleReferenceError);
});
test("unique references retain stable IDs and safely reacquire after rerender", () => {
  const engine = new SemanticSnapshotEngine();
  const old = {backend_id: "css:#old", role: "button", accessible_name: "Save", document_id: "doc", frame_id: "frame:0", ancestry: []};
  const next = {...old, backend_id: "css:#next"};
  const first = engine.snapshot([old], {revision: 1}).nodes[0].ref;
  assert.equal(first.ref_id, engine.snapshot([next], {revision: 2}).nodes[0].ref.ref_id);
  assert.equal(engine.reacquire(first, [next]).backend_id, next.backend_id);
});
