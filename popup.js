/* Commute Check — Popup Script */

const DEFAULT_SETTINGS = {
  enabled: false,
  luasLines: true, luasStops: true,
  dartLines: true, dartStations: true,
  irishRailLines: true, irishRailStations: true,
  opacity: 75,
  walkRadius5: true, walkRadius10: true, walkRadius20: false
};

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get('daftTransitSettings', r => {
    const settings = { ...DEFAULT_SETTINGS, ...(r.daftTransitSettings || {}) };
    syncUI(settings);
    wireControls(settings);
    updateDisabledState(settings);
    checkActiveTab();
  });
});

function syncUI(settings) {
  const el = id => document.getElementById(id);
  el('dt-enabled').checked = settings.enabled;
  el('dt-luas-lines').checked = settings.luasLines;
  el('dt-luas-stops').checked = settings.luasStops;
  el('dt-dart-lines').checked = settings.dartLines;
  el('dt-dart-stations').checked = settings.dartStations;
  el('dt-rail-lines').checked = settings.irishRailLines;
  el('dt-rail-stations').checked = settings.irishRailStations;
  el('dt-walk-5').checked = settings.walkRadius5;
  el('dt-walk-10').checked = settings.walkRadius10;
  el('dt-walk-20').checked = settings.walkRadius20;
  el('dt-opacity').value = settings.opacity;
  el('dt-opacity-val').textContent = settings.opacity + '%';
}

function wireControls(settings) {
  // Master toggle
  document.getElementById('dt-enabled').addEventListener('change', e => {
    settings.enabled = e.target.checked;
    save(settings);
    updateDisabledState(settings);
  });

  // Layer toggles
  const bind = (id, key) => {
    document.getElementById(id).addEventListener('change', e => {
      settings[key] = e.target.checked;
      save(settings);
    });
  };
  bind('dt-luas-lines', 'luasLines');
  bind('dt-luas-stops', 'luasStops');
  bind('dt-dart-lines', 'dartLines');
  bind('dt-dart-stations', 'dartStations');
  bind('dt-rail-lines', 'irishRailLines');
  bind('dt-rail-stations', 'irishRailStations');
  bind('dt-walk-5', 'walkRadius5');
  bind('dt-walk-10', 'walkRadius10');
  bind('dt-walk-20', 'walkRadius20');

  // Opacity
  document.getElementById('dt-opacity').addEventListener('input', e => {
    settings.opacity = +e.target.value;
    document.getElementById('dt-opacity-val').textContent = settings.opacity + '%';
    save(settings);
  });
}

function save(settings) {
  chrome.storage.local.set({ daftTransitSettings: settings });
}

function updateDisabledState(settings) {
  document.body.classList.toggle('disabled', !settings.enabled);
  const label = document.getElementById('dt-status-label');
  if (label) label.textContent = settings.enabled ? 'On' : 'Off';
}

function checkActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (!tabs[0]) return;
    const url = tabs[0].url || '';
    const status = document.getElementById('popup-status');
    if (!url.includes('daft.ie')) {
      status.textContent = 'Navigate to daft.ie to use this extension.';
      status.classList.add('visible');
    }
  });
}
