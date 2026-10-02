/**
 * b4-web-smoke.mjs — B4 offline smoke check for the web surface.
 *
 * Proves the artifact the keeper would ship, WITHOUT Cloudflare, without a
 * bundle and without any live Artifacts repo:
 *
 *   1. `src/webui.ts` imports cleanly under node type-stripping (it has ZERO
 *      runtime imports by design — that is the property under test).
 *   2. GET /ui  → 200, `content-type: text/html; charset=utf-8`, and a real
 *      HTML document string (has <!doctype html>, the three surfaces, and the
 *      client-side `fetch('/quilt/…')` wiring).
 *   3. GET /ui/ → 200 (same page).
 *   4. GET /nope → 404 JSON (the handler does not widen the surface).
 *   5. The page renders WITHOUT live data: it starts with a fetch to the data
 *      endpoint and has a graceful error branch — asserted textually, since
 *      the browser half is vanilla JS the page carries inline.
 *
 * Usage: node --experimental-strip-types test/b4-web-smoke.mjs
 */

import { UI_HTML, makeWebUi } from "../src/webui.ts";

const failures = [];
function check(cond, label) {
  if (!cond) failures.push(label);
}

const ui = makeWebUi();

// ── 1. the HTML string itself ──────────────────────────────────────────────
check(typeof UI_HTML === "string", "UI_HTML is a string");
check(UI_HTML.length > 2000, `UI_HTML is non-trivial (got ${UI_HTML.length} bytes)`);
check(/^<!doctype html>/i.test(UI_HTML), "UI_HTML starts with <!doctype html>");
check(UI_HTML.includes("Routing view"), "page has the routing view");
check(UI_HTML.includes("Timeline"), "page has the timeline/rewind control");
check(UI_HTML.includes("Doubt-query"), "page has the doubt-query box");
check(UI_HTML.includes("/quilt/"), "page fetches the /quilt/<repo> data endpoint");
check(UI_HTML.includes("no live Artifacts required"), "page degrades gracefully without live data");
check(!/https?:\/\/[^"']*\.(js|css)/.test(UI_HTML), "no external JS/CSS assets (dependency-free)");

// ── 2. GET /ui → 200 HTML ──────────────────────────────────────────────────
{
  const res = await ui.fetch(new Request("https://x/ui"));
  check(res.status === 200, `GET /ui status 200 (got ${res.status})`);
  const ct = res.headers.get("content-type") ?? "";
  check(ct.startsWith("text/html"), `GET /ui content-type text/html (got "${ct}")`);
  const body = await res.text();
  check(body === UI_HTML, "GET /ui body is exactly UI_HTML");
  check(body.length > 2000, "GET /ui body is a real document");
}

// ── 3. GET /ui/ → 200 (trailing slash) ─────────────────────────────────────
{
  const res = await ui.fetch(new Request("https://x/ui/"));
  const body = await res.text();
  check(res.status === 200 && body === UI_HTML, "GET /ui/ serves the same page");
}

// ── 4. other paths → 404 JSON ──────────────────────────────────────────────
{
  const res = await ui.fetch(new Request("https://x/nope"));
  const j = await res.json();
  check(res.status === 404, `GET /nope status 404 (got ${res.status})`);
  check(j.error === "not_found", "GET /nope returns not_found");
}
{
  const res = await ui.fetch(new Request("https://x/ui", { method: "POST" }));
  check(res.status === 404, `POST /ui is not served (got ${res.status})`);
}

// ── report ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error("B4 WEB SMOKE: FAIL");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("B4 WEB SMOKE: PASS");
console.log(`  UI_HTML ${UI_HTML.length} bytes · GET /ui 200 · GET /ui/ 200 · 404s held`);
