(() => {
  // This file is also served by the browser version. Only NW.js exposes both globals, so the web
  // application remains a normal browser page with no desktop-specific filesystem access.
  if (typeof nw === 'undefined' || typeof require !== 'function') return;

  const fs = require('fs');
  const path = require('path');
  const appWindow = nw.Window.get();
  const windowStatePath = path.join(nw.App.dataPath, 'window-state.json');

  let state = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight,
    maximized: false,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    if (['x', 'y', 'width', 'height'].every((key) => Number.isFinite(saved[key]))) {
      state = { ...state, ...saved, maximized: Boolean(saved.maximized) };
    }
  } catch { /* First launch or unreadable state: begin with the current NW.js bounds. */ }

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.writeFileSync(windowStatePath, JSON.stringify(state));
    } catch { /* Window persistence must never prevent Workbench from running or closing. */ }
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 250);
  };

  appWindow.on('move', (x, y) => {
    if (state.maximized) return;
    state.x = x;
    state.y = y;
    scheduleSave();
  });
  appWindow.on('resize', (width, height) => {
    if (state.maximized) return;
    state.width = width;
    state.height = height;
    scheduleSave();
  });
  appWindow.on('maximize', () => {
    state.maximized = true;
    scheduleSave();
  });
  appWindow.on('unmaximize', () => {
    state.maximized = false;
    scheduleSave();
  });
  appWindow.on('restore', () => {
    state.maximized = false;
    scheduleSave();
  });
  appWindow.on('close', function closeWorkbench() {
    save();
    this.close(true);
  });
})();

