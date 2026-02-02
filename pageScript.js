/**
 * pageScript.js — injected into the page context so we can access MapLibre GL internals.
 * Communicates with the content script via window.postMessage.
 *
 * Detection strategies (in order):
 *   1. Monkey-patch maplibregl.Map constructor (catches new maps)
 *   2. React fiber traversal (finds existing map via React internals)
 *   3. Canvas internal lookup (finds map via canvas __bindbindings)
 *   4. Polling with multiple heuristics
 */
(function () {
  'use strict';

  let mapInstance = null;
  let pollAttempts = 0;
  const MAX_POLL = 80;

  // ─── Strategy 1: React fiber traversal ───
  function findMapViaFiber() {
    const container = document.querySelector('.maplibregl-map, .mapboxgl-map');
    if (!container) return null;

    const fiberKey = Object.keys(container).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return null;

    let fiber = container[fiberKey];
    let depth = 0;
    while (fiber && depth < 100) {
      if (fiber.stateNode && fiber.stateNode.getCenter && typeof fiber.stateNode.getCenter === 'function') {
        return fiber.stateNode;
      }
      if (fiber.memoizedState) {
        let state = fiber.memoizedState;
        let sd = 0;
        while (state && sd < 20) {
          const ms = state.memoizedState;
          if (ms && ms.getCenter && typeof ms.getCenter === 'function') return ms;
          if (ms && ms.current && ms.current.getCenter && typeof ms.current.getCenter === 'function') return ms.current;
          state = state.next;
          sd++;
        }
      }
      if (fiber.memoizedProps) {
        const p = fiber.memoizedProps;
        if (p.map && p.map.getCenter) return p.map;
        if (p.mapRef && p.mapRef.current && p.mapRef.current.getCenter) return p.mapRef.current;
      }
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  // ─── Strategy 2: Canvas internal lookup ───
  function findMapViaCanvas() {
    const canvases = document.querySelectorAll('.maplibregl-canvas, .mapboxgl-canvas');
    for (const canvas of canvases) {
      // MapLibre stores a reference on the canvas or its parent
      const keys = Object.keys(canvas);
      for (const k of keys) {
        const v = canvas[k];
        if (v && typeof v === 'object' && v.getCenter && v.getBounds) return v;
      }
      // Check parent container
      const mapEl = canvas.closest('.maplibregl-map, .mapboxgl-map');
      if (mapEl) {
        const mKeys = Object.keys(mapEl);
        for (const k of mKeys) {
          const v = mapEl[k];
          if (v && typeof v === 'object' && v.getCenter && v.getBounds) return v;
        }
      }
    }
    return null;
  }

  // ─── Strategy 3: Global/known patterns ───
  function findMapViaGlobals() {
    if (window.maplibregl && window.maplibregl._maps && window.maplibregl._maps.length) {
      return window.maplibregl._maps[0];
    }
    // Some apps store the map on window
    for (const k of ['map', '_map', '__map', 'mapInstance']) {
      const v = window[k];
      if (v && typeof v === 'object' && v.getCenter && v.getBounds) return v;
    }
    return null;
  }

  function findMapInstance() {
    return findMapViaFiber() || findMapViaCanvas() || findMapViaGlobals();
  }

  // ─── Viewport / Projection ───
  function sendViewport() {
    if (!mapInstance) return;
    try {
      const bounds = mapInstance.getBounds();
      const center = mapInstance.getCenter();
      const zoom = mapInstance.getZoom();
      const container = mapInstance.getContainer();
      const rect = container.getBoundingClientRect();

      window.postMessage({
        type: 'DAFT_TRANSIT_MAP_VIEWPORT',
        payload: {
          bounds: {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
          },
          center: { lat: center.lat, lng: center.lng },
          zoom,
          containerRect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          }
        }
      }, '*');
    } catch (e) {
      // Map might have been destroyed
    }
  }

  function projectPoint(lat, lng) {
    if (!mapInstance) return null;
    try {
      const px = mapInstance.project([lng, lat]);
      return { x: px.x, y: px.y };
    } catch (e) {
      return null;
    }
  }

  // ─── Message handling ───
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'DAFT_TRANSIT_PROJECT_REQUEST') {
      const points = e.data.payload.points;
      const results = points.map(p => projectPoint(p.lat, p.lng));
      window.postMessage({
        type: 'DAFT_TRANSIT_PROJECT_RESPONSE',
        payload: { id: e.data.payload.id, points: results }
      }, '*');
    }
    if (e.data && e.data.type === 'DAFT_TRANSIT_GET_VIEWPORT') {
      sendViewport();
    }
  });

  function onMapFound(map) {
    mapInstance = map;
    window.postMessage({ type: 'DAFT_TRANSIT_MAP_FOUND' }, '*');
    sendViewport();

    // Listen for map move/zoom
    map.on('move', sendViewport);
    map.on('zoom', sendViewport);
    map.on('resize', sendViewport);
    map.on('moveend', sendViewport);
  }

  // ─── Polling ───
  function poll() {
    if (mapInstance) return;
    const map = findMapInstance();
    if (map) {
      onMapFound(map);
      return;
    }
    pollAttempts++;
    if (pollAttempts < MAX_POLL) {
      setTimeout(poll, 500);
    } else {
      window.postMessage({ type: 'DAFT_TRANSIT_MAP_NOT_FOUND' }, '*');
    }
  }

  // ─── Constructor monkey-patch ───
  function tryPatchConstructor() {
    const lib = window.maplibregl || window.mapboxgl;
    if (!lib || !lib.Map) return false;

    const OrigMap = lib.Map;
    lib.Map = function (...args) {
      const instance = new OrigMap(...args);
      instance.on('load', () => {
        if (!mapInstance) onMapFound(instance);
      });
      setTimeout(() => {
        if (!mapInstance && instance.loaded && instance.loaded()) {
          onMapFound(instance);
        }
      }, 100);
      return instance;
    };
    lib.Map.prototype = OrigMap.prototype;
    Object.setPrototypeOf(lib.Map, OrigMap);
    return true;
  }

  // ─── DOM observer for late-appearing maps ───
  function observeForMaps() {
    const observer = new MutationObserver(() => {
      if (mapInstance) { observer.disconnect(); return; }
      const canvas = document.querySelector('.maplibregl-canvas, .mapboxgl-canvas');
      if (canvas) {
        // Canvas appeared — try finding the map instance after a short delay
        setTimeout(() => {
          if (!mapInstance) {
            const map = findMapInstance();
            if (map) { observer.disconnect(); onMapFound(map); }
          }
        }, 500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Auto-disconnect after 60s
    setTimeout(() => observer.disconnect(), 60000);
  }

  // ─── Start ───
  tryPatchConstructor();
  poll();
  observeForMaps();
})();
