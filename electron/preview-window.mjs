import { BrowserWindow, ipcMain, screen } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const finite = value => typeof value === 'number' && Number.isFinite(value);
// The shape the follower window accepts; anything else is dropped.
export function cleanState(value) {
  if (!value || typeof value !== 'object' || !finite(value.position) || value.position < 0 || value.position > 864000) return null;
  const rate = finite(value.rate) && value.rate >= 0.25 && value.rate <= 4 ? value.rate : 1;
  return { position: value.position, playing: value.playing === true, rate };
}
// Where the preview goes: a display other than the one the main window is on, or null when there is only one.
export function otherDisplay(displays, current) { return displays.find(display => display.id !== current.id) || null; }
// A second window that only shows the video. The main window stays the transport: it sends position, play state and rate, and
// this window follows with a muted copy, so audio always comes from the stems in the main window.
export class PreviewWindow {
  constructor(getMain, onClosed) { this.getMain = getMain; this.onClosed = onClosed; this.window = null; this.pending = null; this.state = null; }
  get open() { return !!this.window && !this.window.isDestroyed(); }
  register() {
    ipcMain.on('preview:ready', event => { if (!this.open || event.sender !== this.window.webContents) return; this.window.webContents.send('preview:init', { url: this.pending, state: this.state }); });
    ipcMain.on('preview:escape', event => { if (this.open && event.sender === this.window.webContents) this.close(); });
  }
  show(url, state) {
    this.state = cleanState(state); this.pending = url;
    if (this.open) { this.window.webContents.send('preview:init', { url, state: this.state }); return { external: this.external }; }
    const main = this.getMain(), displays = screen.getAllDisplays(), target = otherDisplay(displays, screen.getDisplayMatching(main.getBounds()));
    this.external = !!target;
    const base = { backgroundColor: '#000000', title: 'Stem Studio preview', autoHideMenuBar: true, webPreferences: { preload: join(here, 'preview-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } };
    this.window = new BrowserWindow(target ? { ...base, x: target.bounds.x, y: target.bounds.y, width: target.bounds.width, height: target.bounds.height, fullscreen: true, frame: false } : { ...base, width: 960, height: 540, minWidth: 320, minHeight: 180 });
    this.window.setMenuBarVisibility(false);
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.once('closed', () => { this.window = null; this.onClosed?.(); });
    void this.window.loadFile(join(here, 'preview.html'));
    return { external: this.external };
  }
  sync(value) { const state = cleanState(value); if (!state) return; this.state = state; if (this.open) this.window.webContents.send('preview:state', state); }
  close() { if (this.open) this.window.close(); }
}
