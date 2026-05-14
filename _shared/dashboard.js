/**
 * dashboard.js — hypothesis prototype analytics dashboard (v2)
 *
 * Improvements over v1:
 *  - Human-readable action labels derived from element text / aria-label
 *  - Track IDs shown in muted text below the label (not as the primary cell)
 *  - Event types show colored dot + human label + raw type key + full tooltip
 *  - "Clear data" fully resets the in-memory buffer via BroadcastChannel
 *    (works across tabs AND within the same tab)
 *  - Recent event log: human labels, color-coded type badges, no heartbeat noise
 *  - Glossary section: event type definitions + track-ID naming conventions
 */
(function () {
  'use strict';

  var params      = new URLSearchParams(location.search);
  var prototypeId = params.get('id');

  if (!prototypeId) { document.body.innerHTML = renderPicker(); return; }

  var STORAGE_KEY = 'HT_EVENTS_' + prototypeId;
  var currentMode = 'stats'; // 'stats' | 'heatmap'

  /* ── Event type definitions ──────────────────────────────────────────── */
  var EVENT_DEFS = {
    pageview:      { label: 'Page View',     color: '#6aa6ff', desc: 'Page or screen was loaded. Fires on the initial page load and on every hash change inside a single-page prototype.' },
    click:         { label: 'Click',         color: '#3ddc97', desc: 'User clicked a button, link, or interactive element. Elements tagged with data-track show the track ID and human label.' },
    scroll_depth:  { label: 'Scroll Depth',  color: '#ffb454', desc: 'Scroll milestone reached: 25%, 50%, 75%, or 100% of the page height. Each milestone fires at most once per page load.' },
    form_focus:    { label: 'Field Focus',   color: '#c792ea', desc: 'User clicked into an input, textarea, or select field.' },
    form_change:   { label: 'Field Change',  color: '#c792ea', desc: 'User changed the value of a form field (fires on blur / change event).' },
    form_submit:   { label: 'Form Submit',   color: '#c792ea', desc: 'User submitted a form.' },
    heartbeat:     { label: 'Heartbeat',     color: '#37474f', desc: 'Sent every 15 seconds while the tab is visible. Used to measure active engagement time. Hidden from the event log to reduce noise.' },
    page_exit:     { label: 'Page Exit',     color: '#ff6b6b', desc: 'User closed the tab or navigated to a different origin. Carries activeMs / totalMs for time-on-page measurement.' },
    screen_change: { label: 'Screen Change', color: '#89ddff', desc: 'Hash-based navigation to a new screen inside a single-page prototype (e.g. #orders → #order/123).' },
  };

  /* ── Track ID prefix conventions ────────────────────────────────────── */
  var TRACK_PREFIXES = [
    { prefix: 'cta-',     desc: 'Call-to-action button — primary or secondary user task (e.g. cta-mark-read, cta-apply-filter).' },
    { prefix: 'nav-',     desc: 'Navigation element — topbar logo, menu link, or icon button (e.g. nav-bell-icon, nav-logo).' },
    { prefix: 'tab-',     desc: 'Tab switch within a page section (e.g. tab-unread, tab-orders).' },
    { prefix: 'filter-',  desc: 'Filter control or filter-apply action (e.g. filter-open-status, filter-apply).' },
    { prefix: 'topbar-',  desc: 'Element inside the BEES top navigation bar (e.g. topbar-search, topbar-cart).' },
    { prefix: 'row-',     desc: 'Inline action button inside a data row (e.g. row-view-summary, row-reprocess).' },
  ];

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function loadEvents() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch (_) { return []; }
  }

  function fmtSec(ms) {
    var s = Math.round((ms || 0) / 1000);
    if (s < 60)   return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function getEventDef(type) {
    return EVENT_DEFS[type] || { label: type, color: '#8b97ad', desc: 'Custom event emitted by the prototype via HT.track().' };
  }

  /* ── Summarize ───────────────────────────────────────────────────────── */
  function summarize(events) {
    var counts = {}, byTrack = {}, byTrackLabel = {}, byPath = {}, byField = {};
    var scroll = { 25: 0, 50: 0, 75: 0, 100: 0 };
    var participants = new Set(), sessions = new Set();
    var totalActiveMs = 0, totalMs = 0, lastTs = 0, firstTs = Infinity;

    events.forEach(function (e) {
      counts[e.type] = (counts[e.type] || 0) + 1;

      if (e.track) {
        byTrack[e.track] = (byTrack[e.track] || 0) + 1;
        // Capture the most recently seen human label for this track ID.
        // The tracker stores the element's visible text / aria-label in e.text.
        if (e.text && e.text.trim()) byTrackLabel[e.track] = e.text.trim();
      }

      if (e.path)  byPath[e.path]   = (byPath[e.path]   || 0) + 1;
      if (e.field) byField[e.field] = (byField[e.field] || 0) + 1;

      if (e.type === 'scroll_depth' && scroll[e.depth] != null) scroll[e.depth]++;
      if (e.participantId) participants.add(e.participantId);
      if (e.sessionId)     sessions.add(e.sessionId);

      if (e.type === 'page_exit' || e.type === 'screen_change') {
        totalActiveMs += e.activeMs || 0;
        totalMs       += e.totalMs  || 0;
      }
      if (e.ts) {
        lastTs  = Math.max(lastTs, e.ts);
        firstTs = Math.min(firstTs, e.ts);
      }
    });

    return {
      counts, byTrack, byTrackLabel, byPath, byField, scroll,
      participants: participants.size,
      sessions:     sessions.size,
      totalActiveMs, totalMs,
      firstTs: isFinite(firstTs) ? firstTs : null,
      lastTs:  lastTs || null,
      total:   events.length,
    };
  }

  /* ── Table renderers ─────────────────────────────────────────────────── */

  /* Generic key → count table */
  function topRows(obj, max) {
    max = max || 10;
    var entries = Object.entries(obj).sort(function (a, b) { return b[1] - a[1]; }).slice(0, max);
    var peak = (entries[0] && entries[0][1]) || 1;
    if (!entries.length) return '<tr><td colspan="2" class="no-data">no data yet</td></tr>';
    return entries.map(function (item) {
      var k = item[0], v = item[1];
      return '<tr><td>' + escHtml(k) + '</td><td class="num">' + v +
        '<div class="bar"><span style="width:' + Math.round((v / peak) * 100) + '%"></span></div></td></tr>';
    }).join('');
  }

  /* CTA clicks: shows human label in bold, track ID below in muted text */
  function trackRows(byTrack, byTrackLabel, max) {
    max = max || 15;
    var entries = Object.entries(byTrack).sort(function (a, b) { return b[1] - a[1]; }).slice(0, max);
    var peak = (entries[0] && entries[0][1]) || 1;
    if (!entries.length) return '<tr><td colspan="2" class="no-data">no data yet — click around in the prototype first</td></tr>';

    return entries.map(function (item) {
      var trackId = item[0], count = item[1];
      var label   = byTrackLabel[trackId];

      // Derive tooltip from prefix conventions
      var prefixMatch = TRACK_PREFIXES.find(function (p) { return trackId.startsWith(p.prefix); });
      var tooltip = prefixMatch ? prefixMatch.desc : 'Custom interaction ID.';

      var cell = label
        ? escHtml(label) + '<br><small class="track-id">' + escHtml(trackId) + '</small>'
        : '<span class="track-id-only">' + escHtml(trackId) + '</span>';

      return '<tr title="' + escHtml(tooltip) + '"><td>' + cell + '</td>' +
        '<td class="num">' + count +
        '<div class="bar"><span style="width:' + Math.round((count / peak) * 100) + '%"></span></div>' +
        '</td></tr>';
    }).join('');
  }

  /* Event types: colored dot + human label + raw key in muted + tooltip desc */
  function eventTypeRows(counts) {
    var entries = Object.entries(counts).sort(function (a, b) { return b[1] - a[1]; });
    var peak = (entries[0] && entries[0][1]) || 1;
    if (!entries.length) return '<tr><td colspan="2" class="no-data">no data yet</td></tr>';

    return entries.map(function (item) {
      var type = item[0], count = item[1];
      var def  = getEventDef(type);
      return '<tr title="' + escHtml(def.desc) + '">' +
        '<td>' +
          '<span class="evt-dot" style="background:' + def.color + '"></span>' +
          escHtml(def.label) +
          '<small class="type-raw">' + escHtml(type) + '</small>' +
        '</td>' +
        '<td class="num">' + count +
          '<div class="bar"><span style="width:' + Math.round((count / peak) * 100) + '%"></span></div>' +
        '</td></tr>';
    }).join('');
  }

  /* ── Event log ───────────────────────────────────────────────────────── */
  function recentEventsHtml(events) {
    // Exclude heartbeats (noise), show newest first, cap at 150
    var shown = events
      .filter(function (e) { return e.type !== 'heartbeat'; })
      .slice(-150)
      .reverse();

    if (!shown.length) {
      return '<p class="no-data" style="padding:8px">No events yet — open the prototype and interact with it.</p>';
    }

    return shown.map(function (e) {
      var def  = getEventDef(e.type);
      var time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      var detail = '';

      if (e.type === 'click') {
        // Show human label first; fall back to track ID; then selector
        var human = (e.text && e.text.trim()) ? e.text.trim() : (e.track || e.selector || '');
        detail = escHtml(human);
        if (e.track) detail += '  <span class="track-id">' + escHtml(e.track) + '</span>';

      } else if (e.type === 'pageview' || e.type === 'screen_change') {
        detail = escHtml(e.path || e.url || '');

      } else if (e.type === 'scroll_depth') {
        detail = 'Reached <b>' + escHtml(String(e.depth)) + '%</b> of page';

      } else if (e.type === 'page_exit') {
        detail = 'Active ' + fmtSec(e.activeMs) + ' · elapsed ' + fmtSec(e.totalMs);

      } else if (e.type === 'form_focus' || e.type === 'form_change') {
        detail = escHtml(e.field || '');

      } else if (e.props && typeof e.props === 'object') {
        // Custom HT.track() call — show its props as compact JSON
        detail = escHtml(JSON.stringify(e.props));
      }

      return '<div class="row">' +
        '<span class="t">' + escHtml(time) + '</span>' +
        '<span class="evt-badge" style="background:' + def.color + '22;color:' + def.color + '">' +
          escHtml(def.label) +
        '</span>' +
        '<span class="evt-detail">' + detail + '</span>' +
        '</div>';
    }).join('');
  }

  /* ── Glossary ────────────────────────────────────────────────────────── */
  function glossaryHtml() {
    var evtRows = Object.entries(EVENT_DEFS).map(function (item) {
      var type = item[0], def = item[1];
      return '<tr>' +
        '<td>' +
          '<span class="evt-dot" style="background:' + def.color + '"></span>' +
          '<b>' + escHtml(def.label) + '</b>' +
          '<br><small class="track-id">' + escHtml(type) + '</small>' +
        '</td>' +
        '<td>' + escHtml(def.desc) + '</td>' +
        '</tr>';
    }).join('');

    var pfxRows = TRACK_PREFIXES.map(function (p) {
      return '<tr>' +
        '<td><code>' + escHtml(p.prefix) + '…</code></td>' +
        '<td>' + escHtml(p.desc) + '</td>' +
        '</tr>';
    }).join('');

    return '<div class="card glossary" id="glossary">' +
      '<h3 class="glossary-toggle" onclick="document.getElementById(\'glossary\').classList.toggle(\'open\')">' +
        'Glossary &amp; definitions ' +
        '<span class="caret">▸</span>' +
      '</h3>' +
      '<div class="glossary-body">' +
        '<div class="gloss-grid">' +
          '<div>' +
            '<h4>Event types</h4>' +
            '<p class="gloss-hint">Every row in the "Event types" table shows a full description when you hover it.</p>' +
            '<table><thead><tr><th>Type</th><th>Description</th></tr></thead>' +
            '<tbody>' + evtRows + '</tbody></table>' +
          '</div>' +
          '<div>' +
            '<h4>Track ID naming conventions</h4>' +
            '<p class="gloss-hint">IDs follow a prefix pattern so you can infer the interaction category at a glance.</p>' +
            '<table><thead><tr><th>Prefix</th><th>Meaning</th></tr></thead>' +
            '<tbody>' + pfxRows + '</tbody></table>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ── Picker (no prototype selected yet) ─────────────────────────────── */
  function renderPicker() {
    var ids = Object.keys(localStorage)
      .filter(function (k) { return k.startsWith('HT_EVENTS_'); })
      .map(function (k) { return k.replace('HT_EVENTS_', ''); });
    var list = ids.length
      ? ids.map(function (id) {
          return '<li><a href="?id=' + encodeURIComponent(id) + '">' + escHtml(id) + '</a></li>';
        }).join('')
      : '<li class="no-data">No tracked prototypes found in this browser yet. Open a prototype, interact with it, then come back.</li>';
    return '<div class="dash"><h1>Hypothesis Dashboard</h1><p class="sub">Pick a prototype to inspect:</p><ul>' + list + '</ul></div>';
  }

  /* ── Heatmap ─────────────────────────────────────────────────────────── */

  /* Convert normalised intensity 0-1 → [R, G, B] using blue→cyan→green→yellow→red */
  function heatColor(t) {
    var stops = [
      [0,   0,   200],
      [0,   200, 255],
      [0,   210, 80],
      [255, 220, 0],
      [255, 0,   0],
    ];
    var idx = t * (stops.length - 1);
    var lo  = Math.floor(idx);
    var hi  = Math.min(lo + 1, stops.length - 1);
    var f   = idx - lo;
    return stops[lo].map(function (c, i) { return Math.round(c + (stops[hi][i] - c) * f); });
  }

  /* Draw a Gaussian-blob heatmap onto a canvas element.
     points: [{x, y}] already in canvas pixel coordinates */
  function drawHeatmap(canvas, points) {
    var W   = canvas.width;
    var H   = canvas.height;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!points.length) return;

    var radius = Math.max(50, Math.min(W, H) * 0.07);

    /* Step 1 – draw intensity blobs on an offscreen canvas */
    var off = document.createElement('canvas');
    off.width  = W;
    off.height = H;
    var oc = off.getContext('2d');

    points.forEach(function (p) {
      var g = oc.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      g.addColorStop(0,    'rgba(0,0,0,0.40)');
      g.addColorStop(0.35, 'rgba(0,0,0,0.18)');
      g.addColorStop(1,    'rgba(0,0,0,0)');
      oc.fillStyle = g;
      oc.beginPath();
      oc.arc(p.x, p.y, radius, 0, Math.PI * 2);
      oc.fill();
    });

    /* Step 2 – read pixel data, find peak intensity, colorise */
    var src     = oc.getImageData(0, 0, W, H).data;
    var maxA    = 0;
    for (var k = 3; k < src.length; k += 4) { if (src[k] > maxA) maxA = src[k]; }
    if (maxA === 0) return;

    var out = ctx.createImageData(W, H);
    var dst = out.data;
    for (var j = 0; j < src.length; j += 4) {
      var t = src[j + 3] / maxA;
      if (t < 0.02) continue;
      var rgb    = heatColor(t);
      dst[j]     = rgb[0];
      dst[j + 1] = rgb[1];
      dst[j + 2] = rgb[2];
      dst[j + 3] = Math.round(t * 230);
    }
    ctx.putImageData(out, 0, 0);
  }

  function renderHeatmap() {
    currentMode = 'heatmap';
    var events = loadEvents();

    /* All paths that had at least one event */
    var pathsSeen = [], pathSet = {};
    events.forEach(function (e) {
      if (e.path && !pathSet[e.path]) { pathSet[e.path] = true; pathsSeen.push(e.path); }
    });

    /* Click events that carry page coordinates */
    var allClicks = events.filter(function (e) {
      return e.type === 'click' && e.position &&
        (e.position.px != null || e.position.x != null);
    });

    document.body.innerHTML =
      '<div class="dash hm-dash">' +
        '<div class="toolbar">' +
          '<button id="hm-back">← Back to stats</button>' +
          '<label class="hm-path-label">Screen</label>' +
          '<select id="hm-path">' +
            pathsSeen.map(function (p) {
              return '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>';
            }).join('') +
          '</select>' +
          '<button id="hm-reload">↺ Reload</button>' +
          '<span id="hm-count" class="hm-count"></span>' +
        '</div>' +

        '<div class="hm-viewport" id="hm-viewport">' +
          '<div class="hm-container" id="hm-container">' +
            '<iframe id="hm-iframe" src="about:blank" scrolling="yes" title="Prototype preview"></iframe>' +
            '<canvas id="hm-canvas"></canvas>' +
          '</div>' +
        '</div>' +

        '<div class="hm-legend">' +
          '<span class="hm-legend-label">Low</span>' +
          '<div class="hm-legend-bar"></div>' +
          '<span class="hm-legend-label">High</span>' +
          '<span class="hm-legend-note">· each blob radius ≈ 7% of smaller page dimension</span>' +
        '</div>' +
      '</div>';

    /* ── Wire up controls ── */
    document.getElementById('hm-back').onclick = function () {
      currentMode = 'stats';
      render();
    };

    function loadPath(path) {
      var countEl    = document.getElementById('hm-count');
      var iframe     = document.getElementById('hm-iframe');
      var canvas     = document.getElementById('hm-canvas');
      var container  = document.getElementById('hm-container');

      var clicks = allClicks.filter(function (e) { return e.path === path; });
      countEl.textContent = clicks.length + ' click' + (clicks.length === 1 ? '' : 's') + ' on this screen';

      /* Build iframe URL: use stored href, inject ht_preview=1, restore hash */
      var srcEvent = events.find(function (e) { return e.path === path && e.url; });
      var rawUrl   = (srcEvent && srcEvent.url) || (location.origin + path);
      var hashIdx  = rawUrl.indexOf('#');
      var iframeUrl = hashIdx >= 0
        ? rawUrl.slice(0, hashIdx) + '?ht_preview=1' + rawUrl.slice(hashIdx)
        : rawUrl + '?ht_preview=1';

      /* ── Determine the viewport width testers actually used ──────────────
         Render the iframe at that exact width so the layout is identical to
         what testers saw. Then place dots at raw pageX/pageY — no coordinate
         normalisation needed because both spaces are now the same.
         Use the MODE of stored vw values (most common tester viewport width).
         Fall back to sw (scrollWidth) then 1280 for events recorded before
         the vw field was added. ────────────────────────────────────────── */
      var vwValues = clicks.map(function (e) {
        return (e.position && (e.position.vw || e.position.sw)) || 1280;
      }).filter(function (v) { return v > 0; });

      var testerWidth = 1280;
      if (vwValues.length) {
        var freq = {};
        vwValues.forEach(function (v) { freq[v] = (freq[v] || 0) + 1; });
        testerWidth = parseInt(
          Object.entries(freq).sort(function (a, b) { return b[1] - a[1]; })[0][0], 10
        );
      }

      var viewportEl = document.getElementById('hm-viewport');
      var available  = viewportEl.clientWidth - 2;

      /* Set iframe width to TESTER width before loading so layout matches */
      iframe.style.width  = testerWidth + 'px';
      iframe.style.height = '900px'; /* temporary — corrected after load */

      iframe.onload = function () {
        /* Measure true page height now that the prototype rendered at tester width */
        var IH = 900;
        try {
          var doc = iframe.contentDocument || iframe.contentWindow.document;
          IH = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 400);
        } catch (_) { /* cross-origin fallback */ }

        var IW = testerWidth;
        container.style.width  = IW + 'px';
        container.style.height = IH + 'px';
        iframe.style.height    = IH + 'px';
        canvas.width           = IW;
        canvas.height          = IH;
        canvas.style.width     = IW + 'px';
        canvas.style.height    = IH + 'px';

        /* Scale the whole container (iframe + canvas) to fit dashboard width.
           Because layout matches tester viewport, dots need NO normalisation —
           raw pageX/pageY land on the exact element the tester clicked. */
        var scale = Math.min(1, available / IW);
        container.style.transform       = 'scale(' + scale + ')';
        container.style.transformOrigin = 'top left';
        container.style.marginBottom    = '-' + Math.floor(IH * (1 - scale)) + 'px';
        viewportEl.style.height         = Math.ceil(IH * scale) + 'px';

        /* Raw coordinates — no normalisation required */
        var scaled = clicks.map(function (e) {
          var pos  = e.position;
          var rawX = (pos.px != null) ? pos.px : pos.x;
          var rawY = (pos.py != null) ? pos.py : pos.y;
          return { x: rawX, y: rawY };
        });

        drawHeatmap(canvas, scaled);
      };

      iframe.src = iframeUrl;
    }

    document.getElementById('hm-path').onchange = function () { loadPath(this.value); };
    document.getElementById('hm-reload').onclick  = function () {
      loadPath(document.getElementById('hm-path').value);
    };

    /* Auto-load first path */
    if (pathsSeen.length) loadPath(pathsSeen[0]);
  }

  /* ── Main render ─────────────────────────────────────────────────────── */
  function render() {
    var events = loadEvents();
    var s      = summarize(events);
    var meta   = events[events.length - 1] || {};

    document.body.innerHTML =
      '<div class="dash">' +

      /* Header */
      '<h1>' + escHtml(prototypeId) +
        '<span class="pill">variant ' + escHtml(meta.variant || 'A') + '</span>' +
      '</h1>' +
      '<p class="sub">' + (s.firstTs
        ? new Date(s.firstTs).toLocaleString() + ' → ' + new Date(s.lastTs).toLocaleString()
        : 'No events yet — open the prototype and start interacting.') +
      '</p>' +

      /* Toolbar */
      '<div class="toolbar">' +
        '<button id="btn-refresh">↺ Refresh</button>' +
        '<button id="btn-heatmap">🗺 Heatmap</button>' +
        '<button id="btn-json">↓ JSON</button>' +
        '<button id="btn-csv">↓ CSV</button>' +
        '<button id="btn-copy">⧉ Copy summary</button>' +
        '<button id="btn-clear" class="danger">✕ Clear data</button>' +
        '<a href="dashboard.html" class="back-link">← all prototypes</a>' +
      '</div>' +

      /* KPI cards */
      '<div class="grid">' +
        '<div class="card"><h3>Total events</h3><div class="kpi">' + s.total +
          '<small>' + Object.keys(s.counts).length + ' event types</small></div></div>' +
        '<div class="card"><h3>Participants</h3><div class="kpi">' + s.participants +
          '<small>' + s.sessions + ' sessions</small></div></div>' +
        '<div class="card"><h3>Active time</h3><div class="kpi">' + fmtSec(s.totalActiveMs) +
          '<small>of ' + fmtSec(s.totalMs) + ' elapsed</small></div></div>' +
        '<div class="card"><h3>Avg per session</h3><div class="kpi">' +
          (s.sessions ? fmtSec(s.totalActiveMs / s.sessions) : '—') +
          '<small>active time</small></div></div>' +
      '</div>' +

      /* CTA clicks + event types + paths */
      '<div class="grid">' +
        '<div class="card">' +
          '<h3>Top CTA clicks <span class="hint-icon" title="Sorted by click count. Button label shown bold; track ID below in muted text. Hover a row for the track-ID category.">?</span></h3>' +
          '<p class="col-hint">Human label derived from button text or aria-label · track ID in muted text</p>' +
          '<table><thead><tr><th>Action</th><th class="num">Clicks</th></tr></thead>' +
          '<tbody>' + trackRows(s.byTrack, s.byTrackLabel) + '</tbody></table>' +
        '</div>' +
        '<div class="card">' +
          '<h3>Event types <span class="hint-icon" title="Hover any row for a full description of what that event type means.">?</span></h3>' +
          '<table><thead><tr><th>Type</th><th class="num">Count</th></tr></thead>' +
          '<tbody>' + eventTypeRows(s.counts) + '</tbody></table>' +
        '</div>' +
        '<div class="card">' +
          '<h3>Pages / paths viewed</h3>' +
          '<table><thead><tr><th>Path</th><th class="num">Views</th></tr></thead>' +
          '<tbody>' + topRows(s.byPath) + '</tbody></table>' +
        '</div>' +
      '</div>' +

      /* Scroll + forms + hypothesis */
      '<div class="grid">' +
        '<div class="card">' +
          '<h3>Scroll depth funnel</h3>' +
          '<table><tbody>' +
          [25, 50, 75, 100].map(function (d) {
            var w = s.scroll[25] ? Math.round((s.scroll[d] / s.scroll[25]) * 100) : 0;
            return '<tr><td>' + d + '%</td><td class="num">' + s.scroll[d] +
              '<div class="bar"><span style="width:' + w + '%"></span></div></td></tr>';
          }).join('') +
          '</tbody></table>' +
        '</div>' +
        '<div class="card">' +
          '<h3>Form field engagement</h3>' +
          '<table><thead><tr><th>Field</th><th class="num">Interactions</th></tr></thead>' +
          '<tbody>' + topRows(s.byField) + '</tbody></table>' +
        '</div>' +
        '<div class="card">' +
          '<h3>Hypothesis</h3>' +
          '<p class="hypothesis-text">' +
            escHtml(meta.hypothesis || 'No hypothesis recorded. Set data-hypothesis on the tracker script tag.') +
          '</p>' +
        '</div>' +
      '</div>' +

      /* Event log */
      '<div class="card">' +
        '<h3>Event log ' +
          '<small class="log-meta">last 150 interactions · heartbeats hidden · newest first</small>' +
        '</h3>' +
        '<div class="events">' + recentEventsHtml(events) + '</div>' +
      '</div>' +

      /* Glossary */
      glossaryHtml() +

      '</div>';

    /* Wire buttons */
    document.getElementById('btn-refresh').onclick = render;
    document.getElementById('btn-heatmap').onclick  = renderHeatmap;

    document.getElementById('btn-clear').onclick = function () {
      if (confirm(
        'Delete all tracked events for "' + prototypeId + '"?\n\n' +
        'This also clears the in-memory buffer in any open prototype tabs so new ' +
        'events start from zero immediately.'
      )) {
        localStorage.removeItem(STORAGE_KEY);
        // Cross-tab: the 'storage' event in the prototype tab handles clearing.
        // Same-tab: BroadcastChannel fills the gap (storage events don't fire
        // in the tab that made the change).
        try { new BroadcastChannel('HT_CLEAR_' + prototypeId).postMessage('clear'); } catch (_) {}
        render();
      }
    };

    document.getElementById('btn-json').onclick = function () {
      var blob = new Blob(
        [JSON.stringify({ prototypeId: prototypeId, exportedAt: new Date().toISOString(), events: events }, null, 2)],
        { type: 'application/json' }
      );
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = prototypeId + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      a.click();
    };

    document.getElementById('btn-csv').onclick = function () { downloadCsv(events); };

    document.getElementById('btn-copy').onclick = function () {
      navigator.clipboard.writeText(JSON.stringify({ prototypeId: prototypeId, summary: s }, null, 2))
        .then(function () {
          var btn = document.getElementById('btn-copy');
          btn.textContent = '✓ Copied!';
          setTimeout(function () { btn.textContent = '⧉ Copy summary'; }, 1800);
        });
    };
  }

  function downloadCsv(events) {
    var cols = ['ts','iso','type','variant','participantId','sessionId','path','track','text','selector','depth','field','formId','activeMs','totalMs','href'];
    var rows = [cols.join(',')];
    events.forEach(function (e) {
      rows.push(cols.map(function (c) {
        var v = e[c];
        if (v == null) return '';
        if (typeof v === 'object') v = JSON.stringify(v);
        v = String(v).replace(/"/g, '""');
        return /[",\n]/.test(v) ? '"' + v + '"' : v;
      }).join(','));
    });
    var blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    var a    = document.createElement('a');
    a.href   = URL.createObjectURL(blob);
    a.download = prototypeId + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
    a.click();
  }

  render();
  setInterval(function () { if (!document.hidden && currentMode === 'stats') render(); }, 5000);
})();
