// InventOS — app de escritorio (Electron) para macOS.
//
// Es la MISMA experiencia de la GUI web (capa C) dentro de una ventana nativa:
// arranca el `gui-server` local (motor headless) y carga el wizard de React. Toda
// la lógica corre en el equipo del usuario; las credenciales SSH nunca salen de acá.
//
// Importa el `gui-server` YA BUNDLEADO (`dist/gui-server.mjs`, esbuild) para no
// depender del type-stripping de TypeScript del Node interno de Electron.

import { app, BrowserWindow, shell } from 'electron';
import { startGuiServer } from '../dist/gui-server.mjs';

app.setName('InventOS');

// Las apps GUI de macOS lanzadas desde Finder NO heredan el PATH del shell del
// usuario: sin esto, el modo "Este equipo" no encontraría `docker` (Homebrew) ni
// `ssh` extra. Se agregan las rutas estándar de binarios de Mac.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];
process.env.PATH = [...EXTRA_PATH, process.env.PATH ?? ''].join(':');

/** Puerto propio de la app de escritorio (distinto del `inventos --gui` = 4747). */
const PORT = 4757;
let httpServer = null;

async function createWindow() {
  const { uri, server } = await startGuiServer({ port: PORT, open: false });
  httpServer = server;

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#0A0A0A', // fondo Invent mientras carga (sin flash blanco)
    title: 'InventOS',
    titleBarStyle: 'hiddenInset', // barra integrada, look nativo de macOS
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(uri);

  // Links externos (docs, URLs desplegadas) → navegador del sistema, no en la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

const closeServer = () => { try { httpServer?.close(); } catch { /* no-op */ } };
app.on('before-quit', closeServer);
app.on('window-all-closed', () => {
  closeServer();
  if (process.platform !== 'darwin') app.quit();
});
