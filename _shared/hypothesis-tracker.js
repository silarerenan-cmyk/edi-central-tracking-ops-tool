/**
 * hypothesis-tracker.js
 *
 * Zero-dependency usage tracker for low-code hypothesis prototypes.
 *
 * Captures:
 *   - pageviews / screen views (incl. hash-based SPAs)
 *   - clicks (with selector, text, position, modifier keys)
 *   - scroll depth (25 / 50 / 75 / 100%)
 *   - form interactions (focus, change, submit, abandonment)
 *   - time on page / per screen
 *   - custom events via window.HT.track('event_name', {...})
 *
 * Storage:
 *   - localStorage (key: HT_EVENTS_<prototypeId>) — survives reloads
 *   - in-memory ring buffer (last 5000 events) for the dashboard
 *
 * Exporters:
 *   - JSON download
 *   - CSV download
 *   - Optional remote sink (POST to endpoint) — opt-in via config.endpoint
 *   - Optional PostHog adapter — opt-in via config.posthog = { apiKey, host }
 *
 * Identity:
 *   - Anonymous participantId (UUIDv4) stored in localStorage, persists across sessions
 *   - sessionId rotates after 30 min of inactivity
 *   - No PII collected unless an input element has data-track-value="true"
 *
 * Usage (drop into any HTML page):
 *   <script src="../_shared/hypothesis-tracker.js"
 *           data-prototype-id="pricing-test-v1"
 *           data-hypothesis="Showing price upfront increases CTA click rate"></script>
 *
 * Then mark elements you want to track explicitly with:
 *   <button data-track="cta-primary">Buy now</button>
 *   <a data-track="nav-pricing" href="#pricing">Pricing</a>
 *
 * (Untagged clicks are still captured, but tagged ones are easier to analyse.)
 */
(function () {
  'use strict';

  // Skip tracking when the page is loaded inside the heatmap preview iframe
  if (location.search.indexOf('ht_preview=1') !== -1) return;

  // ---------- config ----------
  const script = document.currentScript || (function () {
    const ss = document.getElementsByTagName('script');
    return ss[ss.length - 1];
  })();
  const cfg = {
    prototypeId: script?.dataset?.prototypeId || 'unnamed',
    hypothesis: script?.dataset?.hypothesis || '',
    variant: script?.dataset?.variant || 'A',
    endpoint: script?.dataset?.endpoint || null,
    debug: script?.dataset?.debug === 'true',
    sessionTimeoutMs: 30 * 60 * 1000,
    maxBuffer: 5000,
  };

  const STORAGE_KEY = 'HT_EVENTS_' + cfg.prototypeId;
  const PARTICIPANT_KEY = 'HT_PARTICIPANT_ID';
  const SESSION_KEY = 'HT_SESSION_' + cfg.prototypeId;

  // ---------- identity ----------
  function uuid() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getParticipantId() {
    let id = localStorage.getItem(PARTICIPANT_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(PARTICIPANT_KEY, id);
    }
    return id;
  }

  function getSessionId() {
    const now = Date.now();
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (now - s.last < cfg.sessionTimeoutMs) {
          s.last = now;
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
          return s.id;
        }
      }
    } catch (_) {}
    const fresh = { id: uuid(), start: now, last: now };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
    return fresh.id;
  }

  // ---------- selector helper ----------
  function buildSelector(el) {
    if (!el || el === document) return 'document';
    if (el === document.body) return 'body';
    if (el.dataset?.track) return `[data-track="${el.dataset.track}"]`;
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.classList?.length) {
        part += '.' + Array.from(node.classList).slice(0, 2).join('.');
      }
      const parent = node.parentNode;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      if (node.id) break;
      node = node.parentNode;
    }
    return parts.join(' > ');
  }

  function visibleText(el) {
    // aria-label is checked last so visible text always wins; it fills the gap
    // for icon-only buttons that have no rendered text (e.g. row action buttons).
    const t = (
      el?.innerText ||
      el?.value ||
      el?.alt ||
      el?.ariaLabel ||
      el?.getAttribute?.('aria-label') ||
      ''
    ).trim();
    return t.length > 80 ? t.slice(0, 77) + '…' : t;
  }

  // ---------- buffer + persist ----------
  let buffer = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) buffer = JSON.parse(raw);
  } catch (_) {}

  function persist() {
    if (buffer.length > cfg.maxBuffer) buffer = buffer.slice(-cfg.maxBuffer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
    } catch (_) {
      // quota exceeded — drop oldest 1000 and retry once
      buffer = buffer.slice(-Math.max(100, cfg.maxBuffer - 1000));
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer)); } catch (__) {}
    }
  }

  function emit(type, payload) {
    const ev = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      type,
      prototypeId: cfg.prototypeId,
      variant: cfg.variant,
      participantId: getParticipantId(),
      sessionId: getSessionId(),
      url: location.href,
      path: location.pathname + location.hash,
      ...payload,
    };
    buffer.push(ev);
    persist();
    if (cfg.debug) console.log('[HT]', type, ev);
    if (cfg.endpoint) {
      try {
        const blob = new Blob([JSON.stringify(ev)], { type: 'application/json' });
        navigator.sendBeacon?.(cfg.endpoint, blob);
      } catch (_) {}
    }
    if (window.posthog?.capture) {
      window.posthog.capture(type, ev);
    }
    window.dispatchEvent(new CustomEvent('ht:event', { detail: ev }));
  }

  // ---------- collectors ----------
  // 1. pageview / screen view
  function trackPageview() {
    emit('pageview', {
      title: document.title,
      referrer: document.referrer,
      viewport: { w: innerWidth, h: innerHeight },
    });
  }

  // 2. clicks (capture phase so we get everything before stopPropagation)
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target.closest('a, button, [data-track], [role="button"], input[type="submit"], input[type="button"]') || e.target;
      const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      emit('click', {
        track: target?.dataset?.track || null,
        selector: buildSelector(target),
        tag: target?.tagName?.toLowerCase() || null,
        text: visibleText(target),
        href: target?.href || null,
      position: {
        x: e.clientX, y: e.clientY,                                            // viewport-relative (legacy)
        px: Math.round(e.pageX), py: Math.round(e.pageY),                      // document-relative (heatmap)
        vw: window.innerWidth,                                                  // actual viewport width at click time
        vh: window.innerHeight,                                                 // actual viewport height at click time
        sw: document.documentElement.scrollWidth,                               // page width at click time
        sh: document.documentElement.scrollHeight,                              // page height at click time
      },
        elementBox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        modifier: { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey },
      });
    },
    true
  );

  // 3. scroll depth — emit milestones once per page load
  const scrollMarks = new Set();
  function checkScroll() {
    const h = document.documentElement;
    const scrollable = (h.scrollHeight - innerHeight) || 1;
    const pct = Math.min(100, Math.round(((h.scrollTop || document.body.scrollTop) / scrollable) * 100));
    [25, 50, 75, 100].forEach((m) => {
      if (pct >= m && !scrollMarks.has(m)) {
        scrollMarks.add(m);
        emit('scroll_depth', { depth: m });
      }
    });
  }
  let scrollTimer;
  addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(checkScroll, 150);
  }, { passive: true });

  // 4. forms: focus / change / submit / abandonment
  document.addEventListener('focusin', (e) => {
    if (!e.target.matches('input, textarea, select')) return;
    emit('form_focus', {
      field: e.target.name || e.target.id || buildSelector(e.target),
      type: e.target.type || e.target.tagName.toLowerCase(),
    });
  });
  document.addEventListener('change', (e) => {
    if (!e.target.matches('input, textarea, select')) return;
    const el = e.target;
    const includeValue = el.dataset?.trackValue === 'true';
    emit('form_change', {
      field: el.name || el.id || buildSelector(el),
      type: el.type || el.tagName.toLowerCase(),
      hasValue: !!(el.value && String(el.value).length),
      value: includeValue ? el.value : undefined,
    });
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    const fields = Array.from(form.elements || []).filter((el) => el.name).map((el) => ({
      name: el.name,
      type: el.type,
      filled: !!(el.value && String(el.value).length),
    }));
    emit('form_submit', {
      formId: form.id || form.name || buildSelector(form),
      fields,
    });
  }, true);

  // 5. time on page (heartbeat every 15s while visible, plus final on unload)
  let pageStart = Date.now();
  let totalActiveMs = 0;
  let lastActive = Date.now();
  let visible = !document.hidden;
  function tickActive() {
    if (visible) totalActiveMs += Date.now() - lastActive;
    lastActive = Date.now();
  }
  document.addEventListener('visibilitychange', () => {
    tickActive();
    visible = !document.hidden;
    lastActive = Date.now();
  });
  setInterval(() => {
    tickActive();
    emit('heartbeat', { activeMs: totalActiveMs, totalMs: Date.now() - pageStart });
  }, 15000);
  addEventListener('beforeunload', () => {
    tickActive();
    emit('page_exit', { activeMs: totalActiveMs, totalMs: Date.now() - pageStart });
  });

  // 6. SPA hash navigation
  addEventListener('hashchange', () => {
    tickActive();
    emit('screen_change', { from: '', to: location.hash, activeMs: totalActiveMs });
    pageStart = Date.now();
    totalActiveMs = 0;
    lastActive = Date.now();
    scrollMarks.clear();
    trackPageview();
  });

  // ---------- public API ----------
  const HT = {
    config: cfg,
    track(name, props = {}) { emit(name, { custom: true, props }); },
    getEvents() { return buffer.slice(); },
    clear() { buffer = []; localStorage.removeItem(STORAGE_KEY); },
    download(format = 'json') {
      const filename = `${cfg.prototypeId}_${cfg.variant}_${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
      let blob;
      if (format === 'csv') {
        const cols = ['ts', 'iso', 'type', 'prototypeId', 'variant', 'participantId', 'sessionId', 'path', 'track', 'selector', 'text', 'depth', 'field', 'formId', 'activeMs', 'totalMs', 'href'];
        const rows = [cols.join(',')];
        buffer.forEach((e) => {
          rows.push(cols.map((c) => {
            let v = e[c];
            if (v == null) return '';
            if (typeof v === 'object') v = JSON.stringify(v);
            v = String(v).replace(/"/g, '""');
            return /[",\n]/.test(v) ? `"${v}"` : v;
          }).join(','));
        });
        blob = new Blob([rows.join('\n')], { type: 'text/csv' });
      } else {
        blob = new Blob([JSON.stringify({ prototype: cfg, exportedAt: new Date().toISOString(), events: buffer }, null, 2)], { type: 'application/json' });
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    summary() {
      const counts = {};
      const byTrack = {};
      const byPath = {};
      const participants = new Set();
      const sessions = new Set();
      let totalActive = 0;
      buffer.forEach((e) => {
        counts[e.type] = (counts[e.type] || 0) + 1;
        if (e.track) byTrack[e.track] = (byTrack[e.track] || 0) + 1;
        if (e.path) byPath[e.path] = (byPath[e.path] || 0) + 1;
        if (e.participantId) participants.add(e.participantId);
        if (e.sessionId) sessions.add(e.sessionId);
        if (e.type === 'page_exit' || e.type === 'screen_change') totalActive += e.activeMs || 0;
      });
      return {
        prototypeId: cfg.prototypeId,
        hypothesis: cfg.hypothesis,
        variant: cfg.variant,
        totalEvents: buffer.length,
        participants: participants.size,
        sessions: sessions.size,
        totalActiveSec: Math.round(totalActive / 1000),
        countsByType: counts,
        clicksByTrackId: byTrack,
        viewsByPath: byPath,
      };
    },
  };
  window.HT = HT;

  // Sync: clear the in-memory buffer when another tab (e.g. the dashboard)
  // deletes the localStorage key. The 'storage' event fires on cross-tab writes.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue === null) {
      buffer = [];
      if (cfg.debug) console.log('[HT] buffer cleared via storage event');
    }
  });

  // Sync: same-tab clear via BroadcastChannel (localStorage 'storage' events
  // do NOT fire in the tab that made the change — BroadcastChannel fills that gap).
  try {
    const _bc = new BroadcastChannel('HT_CLEAR_' + cfg.prototypeId);
    _bc.onmessage = (e) => {
      if (e.data === 'clear') {
        buffer = [];
        if (cfg.debug) console.log('[HT] buffer cleared via BroadcastChannel');
      }
    };
  } catch (_) {}

  // ---------- bootstrap ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trackPageview);
  } else {
    trackPageview();
  }
})();
