/**
 * contentScript.js — Commute Check v2.0
 *
 * Architecture:
 *   TransitDataProvider  — loads + caches bundled GeoJSON
 *   MapAdapter           — detects map, provides viewport / projection
 *   OverlayRenderer      — draws SVG over the map container
 *   Popup (popup.js)      — toggle, layer toggles, opacity (via chrome.storage)
 *
 * Data model (canonical GeoJSON):
 *   Stops:  FeatureCollection<Point>      { id, name, mode, line }
 *   Lines:  FeatureCollection<LineString>  { id, name, mode, line }
 *   mode ∈ { "luas", "rail" }
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════
  //  TRANSIT DATA PROVIDER
  // ═══════════════════════════════════════════════════════════════════

  const TransitDataProvider = {
    _cache: null,

    /** @returns {Promise<{luasLines, luasStops, railLines, railStations}>} */
    async getAll() {
      if (this._cache) return this._cache;
      try {
        const files = {
          luasLines:    'data/luas_lines.json',
          luasStops:    'data/luas_stops.json',
          railLines:    'data/rail_lines.json',
          railStations: 'data/dart_stations.json'
        };
        const entries = Object.entries(files);
        const results = await Promise.all(
          entries.map(([, path]) =>
            fetch(chrome.runtime.getURL(path)).then(r => r.json())
          )
        );
        this._cache = {};
        entries.forEach(([key], i) => { this._cache[key] = results[i]; });
        return this._cache;
      } catch (e) {
        console.error('[Transit Overlay] data load failed:', e);
        return null;
      }
    },

    getMeta() {
      return {
        version: '2.0.0',
        sources: [
          { name: 'Luas GTFS', publisher: 'NTA / TFI', licence: 'CC BY 4.0' },
          { name: 'Irish Rail GTFS', publisher: 'NTA / TFI', licence: 'CC BY 4.0' }
        ]
      };
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  MAP ADAPTER  (MapLibre GL via page-script + URL-param fallback)
  // ═══════════════════════════════════════════════════════════════════

  const MapAdapter = {
    container: null,
    found: false,
    instanceAvailable: false,
    viewport: null,
    _pendingProjections: {},
    _projIdCounter: 0,

    inject() {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('pageScript.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    },

    detect() {
      this.container =
        document.querySelector('.maplibregl-map') ||
        document.querySelector('.mapboxgl-map');
      if (this.container) { this.found = true; }
      return this.found;
    },

    getViewport() {
      if (this.viewport) return this.viewport;
      return this._viewportFromURL();
    },

    requestViewport() {
      window.postMessage({ type: 'DAFT_TRANSIT_GET_VIEWPORT' }, '*');
    },

    project(points) {
      return new Promise(resolve => {
        const id = ++this._projIdCounter;
        this._pendingProjections[id] = resolve;
        window.postMessage({
          type: 'DAFT_TRANSIT_PROJECT_REQUEST',
          payload: { id, points }
        }, '*');
        setTimeout(() => {
          if (this._pendingProjections[id]) {
            delete this._pendingProjections[id];
            resolve(null);
          }
        }, 1000);
      });
    },

    handleMessage(data) {
      switch (data.type) {
        case 'DAFT_TRANSIT_MAP_FOUND':
          this.instanceAvailable = true;
          this.found = true;
          this.detect();
          break;
        case 'DAFT_TRANSIT_MAP_NOT_FOUND':
          this.instanceAvailable = false;
          this.detect();
          break;
        case 'DAFT_TRANSIT_MAP_VIEWPORT':
          this.viewport = data.payload;
          break;
        case 'DAFT_TRANSIT_PROJECT_RESPONSE': {
          const { id, points } = data.payload;
          const cb = this._pendingProjections[id];
          if (cb) { cb(points); delete this._pendingProjections[id]; }
          break;
        }
      }
    },

    _viewportFromURL() {
      const u = new URL(window.location.href);
      const n = parseFloat(u.searchParams.get('top'));
      const s = parseFloat(u.searchParams.get('bottom'));
      const w = parseFloat(u.searchParams.get('left'));
      const e = parseFloat(u.searchParams.get('right'));
      if ([n,s,w,e].some(Number.isNaN)) return null;
      const r = this.container ? this.container.getBoundingClientRect() : null;
      if (!r || r.width === 0) return null;
      return {
        bounds: { north: n, south: s, east: e, west: w },
        containerRect: { top: r.top, left: r.left, width: r.width, height: r.height }
      };
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  OVERLAY RENDERER
  // ═══════════════════════════════════════════════════════════════════

  const COLORS = {
    luasRed:   '#E2383F',
    luasGreen: '#00B259',
    luasBoth:  '#9B59B6',
    rail:      '#6366F1',
    dart:      '#0b5e22' // dark green for DART lines and stations
  };

  function colorForLuasLine(lineVal) {
    const l = (lineVal || '').toLowerCase();
    if (l === 'green')                return COLORS.luasGreen;
    if (l === 'both' || l === 'cross') return COLORS.luasBoth;
    return COLORS.luasRed;
  }

  function colorForRailLine(lineVal) {
    const l = (lineVal || '').toLowerCase();
    if (l === 'dart') return COLORS.dart;
    return COLORS.rail;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const WALK_RADII = [
    { key: 'walkRadius5',  meters: 360,  label: '5 min',  color: '#22c55e' },  // Green
    { key: 'walkRadius10', meters: 720,  label: '10 min', color: '#eab308' },  // Yellow
    { key: 'walkRadius20', meters: 1440, label: '20 min', color: '#ef4444' }   // Red
  ];

  let svgOverlay  = null;
  let tooltip     = null;
  let _pxPerMeter = 0;

  function ensureOverlay() {
    const mc = MapAdapter.container;
    if (!mc) return;
    if (svgOverlay && svgOverlay.parentElement) return;
    svgOverlay = document.createElementNS(SVG_NS, 'svg');
    svgOverlay.id = 'daft-transit-svg-overlay';
    // Insert after the canvas container but before native MapLibre overlays
    // so Daft's markers/controls remain on top
    const cc = mc.querySelector('.maplibregl-canvas-container,.mapboxgl-canvas-container');
    if (cc) cc.insertAdjacentElement('afterend', svgOverlay);
    else mc.insertBefore(svgOverlay, mc.firstChild);
  }

  // Web Mercator
  function projectAll(points, vp) {
    const { bounds: b, containerRect: r } = vp;
    const W = r.width, H = r.height;
    const mercY = lat => Math.log(Math.tan(Math.PI/4 + (lat*Math.PI/180)/2));
    const yN = mercY(b.north), yS = mercY(b.south);
    return points.map(p => ({
      x: ((p.lng - b.west) / (b.east - b.west)) * W,
      y: ((yN - mercY(p.lat)) / (yN - yS)) * H
    }));
  }

  async function render(settings) {
    if (!svgOverlay) { ensureOverlay(); if (!svgOverlay) return; }
    const data = await TransitDataProvider.getAll();
    if (!data) { svgOverlay.innerHTML = ''; return; }

    // Gather points
    const pts = [];
    const idx = { luasLines:[], luasStops:[], railLines:[], railStations:[] };

    const addLineFeatures = (fc, key) => {
      for (const f of fc.features) {
        const coords = f.geometry.type === 'MultiLineString'
          ? f.geometry.coordinates.flat() : f.geometry.coordinates;
        const start = pts.length;
        for (const c of coords) pts.push({ lat: c[1], lng: c[0] });
        idx[key].push({ start, count: coords.length, props: f.properties });
      }
    };
    const addPointFeatures = (fc, key) => {
      for (const f of fc.features) {
        const c = f.geometry.coordinates;
        idx[key].push({ i: pts.length, props: f.properties });
        pts.push({ lat: c[1], lng: c[0] });
      }
    };

    if (settings.luasLines)    addLineFeatures(data.luasLines,    'luasLines');
    if (settings.luasStops)    addPointFeatures(data.luasStops,   'luasStops');

    // Rail lines — filter DART vs Irish Rail independently
    if (settings.dartLines || settings.irishRailLines) {
      const filtered = { features: data.railLines.features.filter(f => {
        const isDart = (f.properties.line || '').toLowerCase() === 'dart';
        return isDart ? settings.dartLines : settings.irishRailLines;
      })};
      addLineFeatures(filtered, 'railLines');
    }

    // Rail stations — filter DART vs Irish Rail independently
    if (settings.dartStations || settings.irishRailStations) {
      const filtered = { features: data.railStations.features.filter(f => {
        const isDart = (f.properties.line || '').toLowerCase() === 'dart';
        return isDart ? settings.dartStations : settings.irishRailStations;
      })};
      addPointFeatures(filtered, 'railStations');
    }

    if (pts.length === 0) { svgOverlay.innerHTML = ''; return; }

    // Project
    let projected = null;
    if (MapAdapter.instanceAvailable) {
      projected = await MapAdapter.project(pts);
      if (projected && !projected.some(p => p !== null)) projected = null;
    }
    if (!projected) {
      const vp = MapAdapter.getViewport();
      if (!vp) return;
      projected = projectAll(pts, vp);
    }

    // Compute px-per-meter for walk radius (using viewport or projected points)
    const vp2 = MapAdapter.getViewport();
    if (vp2) {
      const degLngSpan = vp2.bounds.east - vp2.bounds.west;
      const midLat = (vp2.bounds.north + vp2.bounds.south) / 2;
      const metersPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
      _pxPerMeter = vp2.containerRect.width / (degLngSpan * metersPerDegLng);
    } else if (projected.length >= 2 && pts.length >= 2) {
      // Fallback: measure from two projected points
      const dLng = Math.abs(pts[1].lng - pts[0].lng);
      const dPx  = Math.abs(projected[1].x - projected[0].x);
      if (dLng > 0 && dPx > 0) {
        const midLat = (pts[0].lat + pts[1].lat) / 2;
        const metersPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
        _pxPerMeter = dPx / (dLng * metersPerDegLng);
      }
    }

    // Build SVG
    const op = settings.opacity / 100;
    const svg = [];

    // Defs for drop shadow on stops
    svg.push(`<defs><filter id="dt-shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.25"/></filter></defs>`);

    // Lines
    const drawLine = (seg, color, width) => {
      const ps = [];
      for (let j = seg.start; j < seg.start + seg.count; j++)
        if (projected[j]) ps.push(`${projected[j].x.toFixed(1)},${projected[j].y.toFixed(1)}`);
      if (ps.length > 1)
        svg.push(`<polyline points="${ps.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="${op}" stroke-linecap="round" stroke-linejoin="round"/>`);
    };

    // Rail lines first (behind Luas)
    for (const s of idx.railLines) drawLine(s, colorForRailLine(s.props.line), 2.5);
    // Luas on top
    for (const s of idx.luasLines) drawLine(s, colorForLuasLine(s.props.line), 3);

    // Stops / stations
    const dot = (p, fill, name, mode, line, r) => {
      if (!p) return;
      svg.push(`<g class="transit-stop" data-name="${esc(name)}" data-mode="${mode}" data-line="${esc(line)}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="#fff" stroke-width="1.5" opacity="${op}" filter="url(#dt-shadow)"/></g>`);
    };
    for (const s of idx.railStations) dot(projected[s.i], colorForRailLine(s.props.line), s.props.name || 'Station', 'rail', s.props.line || 'rail', 3.5);
    for (const s of idx.luasStops)    dot(projected[s.i], colorForLuasLine(s.props.line), s.props.name || 'Luas Stop', 'luas', s.props.line || 'luas', 4);

    svgOverlay.innerHTML = svg.join('');
    wireTooltips();
  }

  function wireTooltips() {
    if (!svgOverlay) return;
    svgOverlay.querySelectorAll('.transit-stop').forEach(g => {
      g.addEventListener('mouseenter', e => showTip(e, g));
      g.addEventListener('mouseleave', hideTip);
      g.addEventListener('click', e => { e.stopPropagation(); showTip(e, g); });
    });
  }
  function showTip(e, g) {
    hideTip();
    const mode = g.dataset.mode === 'luas' ? 'Luas' : (g.dataset.line || '').toLowerCase() === 'dart' ? 'DART' : 'Rail';
    tooltip = document.createElement('div');
    tooltip.className = 'daft-transit-tooltip';
    tooltip.textContent = `${mode}: ${g.dataset.name}`;
    const c = g.querySelector('circle');
    const cr = MapAdapter.container.getBoundingClientRect();
    tooltip.style.left = (cr.left + +c.getAttribute('cx')) + 'px';
    tooltip.style.top  = (cr.top  + +c.getAttribute('cy') - 8) + 'px';
    document.body.appendChild(tooltip);
    showWalkRadius(g);
  }
  function hideTip() {
    hideWalkRadius();
    if (tooltip) { tooltip.remove(); tooltip = null; }
  }

  // ── Walking radius circles ──
  function showWalkRadius(g) {
    hideWalkRadius();
    if (!svgOverlay || _pxPerMeter <= 0) return;
    const anyOn = WALK_RADII.some(r => settings[r.key]);
    if (!anyOn) return;

    const c  = g.querySelector('circle');
    const cx = +c.getAttribute('cx');
    const cy = +c.getAttribute('cy');

    const group = document.createElementNS(SVG_NS, 'g');
    group.id = 'dt-walk-radii';

    for (const r of WALK_RADII) {
      if (!settings[r.key]) continue;
      const px = r.meters * _pxPerMeter;

      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', px);
      circle.setAttribute('fill', r.color);
      circle.setAttribute('fill-opacity', '0.10');
      circle.setAttribute('stroke', r.color);
      circle.setAttribute('stroke-opacity', '0.45');
      circle.setAttribute('stroke-width', '1.5');
      circle.setAttribute('stroke-dasharray', '6 4');
      group.appendChild(circle);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', cx);
      text.setAttribute('y', cy - px - 5);
      text.textContent = r.label;
      group.appendChild(text);
    }

    svgOverlay.insertBefore(group, svgOverlay.firstChild);
  }

  function hideWalkRadius() {
    if (!svgOverlay) return;
    const existing = svgOverlay.getElementById('dt-walk-radii');
    if (existing) existing.remove();
  }

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ═══════════════════════════════════════════════════════════════════
  //  SETTINGS & STATE
  // ═══════════════════════════════════════════════════════════════════

  let overlayVisible = false;
  let renderTimer    = null;
  let lastRender     = 0;
  let settings = {
    enabled: false,
    luasLines: true, luasStops: true,
    dartLines: true, dartStations: true,
    irishRailLines: true, irishRailStations: true,
    opacity: 75,
    walkRadius5: true, walkRadius10: true, walkRadius20: false
  };

  function loadSettings() {
    chrome.storage?.local?.get('daftTransitSettings', r => {
      if (r?.daftTransitSettings) {
        Object.assign(settings, r.daftTransitSettings);
      }
      if (settings.enabled) {
        overlayVisible = true;
        scheduleRender();
      }
    });
  }

  function scheduleRender() {
    if (renderTimer) return;
    const wait = Math.max(0, 50 - (Date.now() - lastRender));
    renderTimer = setTimeout(() => {
      renderTimer = null;
      lastRender = Date.now();
      if (overlayVisible && MapAdapter.found) render(settings);
    }, wait);
  }

  // Listen for settings changes from the popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.daftTransitSettings) return;
    const newSettings = changes.daftTransitSettings.newValue;
    if (!newSettings) return;

    const wasEnabled = settings.enabled;
    Object.assign(settings, newSettings);

    if (settings.enabled && !wasEnabled) {
      overlayVisible = true;
      if (MapAdapter.found) {
        ensureOverlay();
        if (MapAdapter.instanceAvailable) MapAdapter.requestViewport();
        else scheduleRender();
      }
    } else if (!settings.enabled && wasEnabled) {
      overlayVisible = false;
      if (svgOverlay) svgOverlay.innerHTML = '';
      hideTip();
    } else if (settings.enabled) {
      scheduleRender();
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  //  MAP OBSERVATION
  // ═══════════════════════════════════════════════════════════════════

  function observeMap() {
    const tryRender = () => {
      if (overlayVisible) {
        MapAdapter.instanceAvailable ? MapAdapter.requestViewport() : scheduleRender();
      }
    };

    if (MapAdapter.container) {
      new ResizeObserver(tryRender).observe(MapAdapter.container);
      MapAdapter.container.addEventListener('wheel',   () => setTimeout(tryRender, 120), { passive: true });
      MapAdapter.container.addEventListener('mouseup',  () => setTimeout(tryRender, 200));
      MapAdapter.container.addEventListener('touchend', () => setTimeout(tryRender, 200), { passive: true });
    }

    // URL polling (Daft updates bounds in URL on search pages)
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        // SPA navigation: re-detect map container and overlay if needed
        MapAdapter.container = null;
        MapAdapter.found = false;
        if (MapAdapter.detect()) {
          ensureOverlay();
          observeMap();
        }
        tryRender();
      }
    }, 300);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ═══════════════════════════════════════════════════════════════════

  function init() {
    loadSettings();
    MapAdapter.inject();

    window.addEventListener('message', e => {
      if (e.data?.type?.startsWith('DAFT_TRANSIT_')) {
        MapAdapter.handleMessage(e.data);
        if (e.data.type === 'DAFT_TRANSIT_MAP_FOUND') {
          ensureOverlay();
          observeMap();
          if (overlayVisible) MapAdapter.requestViewport();
        }
        if (e.data.type === 'DAFT_TRANSIT_MAP_NOT_FOUND') {
          if (MapAdapter.found && overlayVisible) scheduleRender();
        }
        if (e.data.type === 'DAFT_TRANSIT_MAP_VIEWPORT' && overlayVisible) scheduleRender();
      }
    });

    // DOM watcher for map container
    const check = () => {
      if (!MapAdapter.container && MapAdapter.detect()) {
        ensureOverlay();
        observeMap();
        if (overlayVisible) scheduleRender();
      }
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    const poll = setInterval(() => { check(); if (MapAdapter.container) clearInterval(poll); }, 500);
    check();
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
