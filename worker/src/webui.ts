/**
 * webui.ts — B4: the quilt's browser surface (the UX 25% + the video demo).
 *
 * A single, dependency-free HTML+JS page served straight from the Worker:
 * no build step, no framework, no CDN. It is **self-contained by design** (no
 * imports) so it can be imported and smoke-tested under plain node
 * (`node --experimental-strip-types test/b4-web-smoke.mjs`) without a bundle.
 *
 * The page renders, from a LIVE Artifacts quilt repo, the three surfaces the
 * flow-state vision (docs/QUILT-AS-GIT.md) and the B4 spec call for:
 *
 *   1. Routing view — the quilt's cells + edges (the tensor).
 *   2. Timeline / rewind — the commit list; view any commit's state.
 *   3. Doubt-query — ask the receipt/doubt ledger for a cell or the whole
 *      quilt; the chain answers "proven" or names where it breaks.
 *
 * Data flows over one read-only endpoint the router adds alongside this page:
 *   GET /quilt/<repo>[?ref=<sha|branch>][?limit=N][?tail=N]   → quilt state JSON
 *
 * Everything is client-side `fetch` + vanilla DOM. If the data endpoint is
 * absent (404/500) or the repo is empty, the page still renders and says so —
 * the HTML is a static string; it never depends on live Artifacts to load.
 *
 * Deliberately NOT here: auth, write/push, diff/merge controls. Those are the
 * existing POST /diff and POST /merge (B3.6) — the UI only views and asks.
 */

/** The whole page: inline CSS + inline vanilla JS. No external fetches. */
export const UI_HTML: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QUILT — the connection is the unit</title>
<style>
  :root {
    --bg: #0b0e13; --panel: #121722; --line: #232b3a; --ink: #dbe4f0;
    --dim: #8394ab; --acc: #7dd3fc; --ok: #4ade80; --bad: #f87171;
    --warn: #fbbf24; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 18px 22px; border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg,#0f1420,#0b0e13); }
  h1 { margin: 0; font-size: 17px; letter-spacing: .14em; text-transform: uppercase; }
  h1 span { color: var(--acc); }
  .tag { color: var(--dim); font-size: 12px; margin-top: 5px; font-family: var(--mono); }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
  input, button { font: inherit; font-size: 13px; border-radius: 7px;
    border: 1px solid var(--line); background: #0e1320; color: var(--ink); padding: 7px 10px; }
  input { font-family: var(--mono); }
  input:focus { outline: 1px solid var(--acc); }
  button { cursor: pointer; }
  button:hover { border-color: var(--acc); color: var(--acc); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 16px 22px; }
  @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-width: 0; }
  .card.full { grid-column: 1 / -1; }
  .card h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: .16em; color: var(--dim);
    text-transform: uppercase; font-weight: 600; }
  .stat { display: flex; gap: 18px; flex-wrap: wrap; font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .stat b { color: var(--ink); font-weight: 600; }
  .cell { border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; margin-bottom: 8px; }
  .cell .nm { font-family: var(--mono); font-size: 13px; color: var(--acc); }
  .cell .meta { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 4px; word-break: break-all; }
  .edge { font-family: var(--mono); font-size: 12px; padding: 4px 0; border-bottom: 1px dashed var(--line); word-break: break-all; }
  .edge:last-child { border-bottom: 0; }
  .op { color: var(--warn); }
  .pill { display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--line); margin-left: 6px; font-family: var(--mono); }
  .pill.ok { color: var(--ok); border-color: #1d4d34; }
  .pill.bad { color: var(--bad); border-color: #5a2630; }
  .commit { display: flex; gap: 10px; align-items: baseline; padding: 6px 8px; border-radius: 6px;
    cursor: pointer; font-family: var(--mono); font-size: 12px; }
  .commit:hover { background: #0e1320; }
  .commit.cur { background: #10202b; outline: 1px solid var(--acc); }
  .commit .sha { color: var(--acc); }
  .commit .msg { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit .when { color: var(--dim); margin-left: auto; white-space: nowrap; }
  .ledger { font-family: var(--mono); font-size: 12px; max-height: 240px; overflow: auto; }
  .ledger div { padding: 3px 0; word-break: break-all; }
  .verdict { font-family: var(--mono); font-size: 12px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); margin-top: 8px; }
  .verdict.proven { color: var(--ok); border-color: #1d4d34; background: #0e1a14; }
  .verdict.doubt { color: var(--warn); border-color: #4d3f1d; background: #1a160e; }
  .muted { color: var(--dim); font-size: 12px; font-family: var(--mono); }
  #err { display: none; margin: 12px 22px 0; padding: 10px 12px; border-radius: 8px;
    border: 1px solid #5a2630; background: #1b0f13; color: var(--bad); font-family: var(--mono); font-size: 12px; }
  footer { padding: 14px 22px 26px; color: var(--dim); font-family: var(--mono); font-size: 11px; }
  a { color: var(--acc); }
</style>
</head>
<body>
<header>
  <h1>QUILT <span>//</span> the connection is the unit</h1>
  <div class="tag">a repository is a live body &middot; a merge is a routing decision &middot; wake = verify the chain</div>
  <div class="bar">
    <input id="repo" value="quilt-demo" size="18" aria-label="quilt repo" />
    <button id="load">wake / refresh</button>
    <button id="head">rewind to HEAD</button>
    <span id="where" class="muted"></span>
  </div>
</header>
<div id="err"></div>

<div class="grid">
  <div class="card">
    <h2>Routing view — cells</h2>
    <div id="stats" class="stat"></div>
    <div id="cells" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <h2>Edges — the tensor</h2>
    <div id="edges"></div>
  </div>

  <div class="card">
    <h2>Timeline — rewind</h2>
    <div id="log"></div>
  </div>

  <div class="card">
    <h2>Doubt-query — what trust lets through</h2>
    <input id="q" placeholder="cell address, opcode, tip, or edge…" style="width:100%" />
    <div id="dq" class="ledger" style="margin-top:8px"></div>
  </div>

  <div class="card full">
    <h2>Receipt ledger — routing memory</h2>
    <div id="ledger" class="ledger"></div>
  </div>
</div>

<footer>
  read-only surface &middot; data: GET /quilt/&lt;repo&gt; &middot; writes: POST /diff, POST /merge (B3.6)
  &middot; <span id="build">b4-web</span>
</footer>

<script>
'use strict';
var state = { repo: 'quilt-demo', ref: null, data: null, commits: [] };
var $ = function (id) { return document.getElementById(id); };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function short(h) { return h ? String(h).slice(0, 10) : ''; }
function when(unix) {
  if (!unix) return '';
  try { return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 16); }
  catch (e) { return ''; }
}
function showErr(msg) {
  var e = $('err'); e.textContent = msg; e.style.display = 'block';
}
function clearErr() { $('err').style.display = 'none'; }

function load(ref) {
  var repo = $('repo').value.trim() || 'quilt-demo';
  state.repo = repo;
  var url = '/quilt/' + encodeURIComponent(repo) + (ref ? '?ref=' + encodeURIComponent(ref) : '');
  $('where').textContent = 'waking ' + repo + (ref ? ' @ ' + short(ref) : '') + ' …';
  fetch(url, { headers: { accept: 'application/json' } })
    .then(function (r) { return r.text().then(function (t) { return { r: r, t: t }; }); })
    .then(function (x) {
      var j = null;
      try { j = JSON.parse(x.t); } catch (e) {}
      if (!x.r.ok || !j || j.ok !== true) {
        var d = (j && (j.detail || j.error)) || ('HTTP ' + x.r.status);
        showErr('data endpoint: ' + d + ' — the page still renders; no live Artifacts required.');
        state.data = null;
        render();
        return;
      }
      clearErr();
      state.data = j;
      state.ref = j.ref || null;
      state.commits = j.log || [];
      render();
    })
    .catch(function (e) {
      showErr('fetch failed: ' + e + ' — served HTML is static; data layer is down.');
      state.data = null; render();
    });
}

function render() {
  var d = state.data;
  $('where').textContent = d ? ('viewing ' + state.repo + ' @ ' + short(d.ref)) : (state.repo + ' — no data');
  var cells = (d && d.cells) || [];
  var edges = (d && d.edges && d.edges.declared) || [];
  var q = d && d.quilt || null;

  $('stats').innerHTML = d
    ? '<span>cells <b>' + cells.length + '</b></span>' +
      '<span>edges <b>' + edges.length + '</b></span>' +
      '<span>commits <b>' + ((d.log || []).length) + '</b></span>' +
      '<span>quilt <b>' + (q && q.ok ? 'ok' : 'doubt') + '</b></span>'
    : '<span class="muted">no data — hit “wake / refresh”</span>';

  // cells
  var ch = '';
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    var badge = c.ok ? '<span class="pill ok">ok</span>' : '<span class="pill bad">doubt</span>';
    var chain = c.chainOk ? '' : '<span class="pill bad">chain break @' + c.firstBreakAt + '</span>';
    ch += '<div class="cell"><div class="nm">' + esc(c.address) + badge + chain + '</div>' +
      '<div class="meta">tip ' + esc(short(c.tip)) + ' &middot; count ' + esc(c.count) +
      ' &middot; ops ' + esc((c.opcodes || []).join(',')) + '</div></div>';
  }
  $('cells').innerHTML = ch || '<div class="muted">no cells</div>';

  // edges
  var eh = '';
  for (var k = 0; k < edges.length; k++) {
    var parts = String(edges[k]).split(' ');
    eh += '<div class="edge">' + esc(parts[1] || '') + ' <span class="op">' + esc(parts[2] || '') +
      '</span> ' + esc(parts[3] || '') + '</div>';
  }
  $('edges').innerHTML = eh || '<div class="muted">no edges</div>';

  // timeline
  var lh = '';
  var logs = (d && d.log) || [];
  for (var m = 0; m < logs.length; m++) {
    var cm = logs[m];
    var cur = d && state.ref && cm.hash === d.ref ? ' cur' : '';
    lh += '<div class="commit' + cur + '" data-sha="' + esc(cm.hash) + '">' +
      '<span class="sha">' + esc(short(cm.hash)) + '</span>' +
      '<span class="msg">' + esc(cm.message || '(no message)') + '</span>' +
      '<span class="when">' + esc(when(cm.committedAt || cm.authoredAt)) + '</span></div>';
  }
  $('log').innerHTML = lh || '<div class="muted">no commits visible</div>';
  var nodes = $('log').querySelectorAll('.commit');
  for (var n = 0; n < nodes.length; n++) {
    nodes[n].onclick = function () { load(this.getAttribute('data-sha')); };
  }

  // routing ledger
  var r = (d && d.routing) || null;
  var out = '';
  if (r) {
    out += '<div class="muted">' + r.positions + ' ops &middot; tip ' + esc(short(r.tip)) +
      (r.tipMatch === false ? ' (tip MISMATCH)' : '') + '</div>';
    var tl = r.tail || [];
    for (var t = 0; t < tl.length; t++) {
      out += '<div><span class="sha">' + esc(short(tl[t].receipt)) + '</span> ' + esc(tl[t].op) + '</div>';
    }
    if (r.merges) out += '<div class="muted">' + r.merges + ' MERGE op(s) — “a merge is a routing decision”</div>';
    if (r.unknown && r.unknown.length) out += '<div class="muted">' + r.unknown.length + ' unrecognized op(s)</div>';
  }
  $('ledger').innerHTML = out || '<div class="muted">no routing ledger</div>';

  doubt();
}

// Doubt-query: search the receipt/doubt ledger and report what the chain PROVES.
function doubt() {
  var q = ($('q').value || '').trim().toLowerCase();
  var d = state.data;
  var box = $('dq');
  if (!d) { box.innerHTML = '<div class="muted">no data to query</div>'; return; }
  var hits = [];
  var cells = d.cells || [];
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    var hay = (c.address + ' ' + c.type + ' ' + (c.opcodes || []).join(' ') + ' ' + c.tip).toLowerCase();
    var tail = c.tail || [];
    var ops = [];
    for (var j = 0; j < tail.length; j++) ops.push(tail[j].op);
    if (q === '' || hay.indexOf(q) >= 0 || ops.join(' ').toLowerCase().indexOf(q) >= 0) {
      hits.push({
        src: 'cell ' + c.address, ok: !!c.ok && c.chainOk,
        detail: 'tip ' + short(c.tip) + ' &middot; ' + (c.count) + ' ops &middot; ' +
          (c.ok ? 'chain verified' : 'CHAIN DOUBT @' + c.firstBreakAt)
      });
    }
  }
  var r = d.routing;
  if (r) {
    var rlines = [];
    var tl = r.tail || [];
    for (var t = 0; t < tl.length; t++) rlines.push(tl[t].op);
    if (q === '' || ('routing ledger ' + rlines.join(' ')).toLowerCase().indexOf(q) >= 0) {
      hits.push({
        src: 'routing ledger', ok: !!r.ok,
        detail: r.positions + ' ops &middot; tip ' + short(r.tip) +
          (r.tipMatch === false ? ' &middot; TIP MISMATCH' : ' &middot; chain verified')
      });
    }
  }
  var problems = (d.quilt && d.quilt.problems) || [];
  var h = '';
  if (q === '') {
    h += '<div class="verdict ' + (d.quilt && d.quilt.ok ? 'proven' : 'doubt') + '">' +
      'whole quilt: ' + (d.quilt && d.quilt.ok ? 'PROVEN — every cell + routing chain walks to its tip'
        : 'DOUBT — ' + problems.length + ' problem(s)') + '</div>';
  }
  for (var z = 0; z < hits.length; z++) {
    h += '<div style="margin-top:6px">' +
      '<span class="pill ' + (hits[z].ok ? 'ok' : 'bad') + '">' + (hits[z].ok ? 'proven' : 'doubt') + '</span> ' +
      esc(hits[z].src) + '<div class="muted">' + hits[z].detail + '</div></div>';
  }
  if (q !== '' && hits.length === 0) {
    h += '<div class="verdict doubt">no ledger entry matches “' + esc(q) +
      '” — nothing the chain can vouch for. (absence is not proof; it is doubt.)</div>';
  }
  if (problems.length) {
    h += '<div class="muted" style="margin-top:6px">' +
      problems.map(esc).join('<br>') + '</div>';
  }
  box.innerHTML = h;
}

$('load').onclick = function () { load(null); };
$('head').onclick = function () { load(null); };
$('q').oninput = doubt;
$('repo').onkeydown = function (e) { if (e.key === 'Enter') load(null); };

// auto-wake from ?repo= if present, else the default repo
try {
  var p = new URLSearchParams(location.search);
  if (p.get('repo')) { $('repo').value = p.get('repo'); }
} catch (e) {}
load(null);
</script>
</body>
</html>`;

/** Build the B4 web-ui handler. `fetch` serves the page at GET /ui (and /ui/). */
export function makeWebUi(): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        (url.pathname === "/ui" || url.pathname === "/ui/")
      ) {
        return new Response(UI_HTML, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      return Response.json(
        { error: "not_found", hint: "GET /ui" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    },
  };
}

export default makeWebUi();
