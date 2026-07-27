// InventOS — servidor local de la GUI (`inventos --gui`).
//
// Puente DELGADO entre el motor headless y el wizard web: NO tiene lógica de deploy,
// solo expone `planRecipe`/`applyRecipe` por HTTP y hace streaming de los `ApplyEvent`
// al navegador (NDJSON). Toda la lógica sigue en `src/engine/`.
//
// Seguridad: escucha SOLO en 127.0.0.1 (nunca expuesto a la red). Las credenciales
// SSH viven en la máquina del usuario, como en el CLI. Cero dependencias: solo el
// `http`/`fs` de Node.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { planRecipe } from './engine/index.ts';
import { applyRecipe } from './engine/apply.ts';
import { RECIPES, recipeById } from './recipes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Ubica `dist-gui/` (build del wizard) subiendo desde el módulo — dev y bundle. */
function findGuiDir(start) {
  // App empaquetada (Electron): dist-gui va a `app.asar.unpacked/` (asarUnpack).
  const res = process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked', 'dist-gui') : undefined;
  if (res !== undefined && existsSync(join(res, 'index.html'))) return res;

  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'dist-gui');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, '..', 'dist-gui');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.png': 'image/png', '.map': 'application/json',
};

/** Construye un DeployTarget desde el modo elegido en la GUI. */
function targetFromMode(mode, host, identityFile) {
  if (mode === 'local') return { user: 'local', host: 'local' };
  if (mode === 'ssh' && host) {
    const at = host.indexOf('@');
    const user = at >= 0 ? host.slice(0, at) : 'root';
    const rest = at >= 0 ? host.slice(at + 1) : host;
    const t = { user, host: rest };
    if (identityFile) t.identityFile = identityFile;
    return t;
  }
  return { user: 'root', host: 'VPS-IP' }; // placeholder para dry-run
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve({}); }
    });
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

async function serveStatic(res, guiDir, urlPath) {
  const clean = normalize(urlPath.split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(guiDir, clean === '/' ? 'index.html' : clean);
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
    const buf = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    // SPA fallback: cualquier ruta desconocida → index.html
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(join(guiDir, 'index.html')));
    } catch {
      res.writeHead(404); res.end('not found');
    }
  }
}

/** Arranca el servidor de la GUI y (opcional) abre el navegador. */
export async function startGuiServer({ port = 4747, open = true } = {}) {
  const guiDir = findGuiDir(HERE);
  const built = existsSync(join(guiDir, 'index.html'));

  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/api/recipes') {
      return json(res, 200, {
        recipes: RECIPES.filter((r) => r.apps.length > 0)
          .map((r) => ({ id: r.id, name: r.name, tagline: r.tagline, apps: r.apps, aria: r.aria ?? [] })),
      });
    }

    if (url === '/api/plan' && req.method === 'POST') {
      const body = await readBody(req);
      const recipe = recipeById(body.recipe);
      if (!recipe) return json(res, 400, { error: `Receta desconocida: ${body.recipe}` });
      try {
        const outcome = await planRecipe(recipe, {
          project: recipe.id, domain: body.domain || 'midominio.com', acmeEmail: `admin@${body.domain || 'midominio.com'}`,
        });
        const p = outcome.plan;
        return json(res, 200, {
          ok: outcome.ok, rendered: outcome.rendered, unresolved: outcome.unresolved,
          order: p.order, warnings: p.warnings,
          apps: p.apps.map((a) => ({
            id: a.id, name: a.name, image: a.image ?? null, routes: a.routes,
            secrets: a.secrets, adminAuth: a.adminAuth, internalOnly: a.internalOnly.length,
          })),
        });
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err) });
      }
    }

    if (url === '/api/apply' && req.method === 'POST') {
      const body = await readBody(req);
      const recipe = recipeById(body.recipe);
      if (!recipe) return json(res, 400, { error: `Receta desconocida: ${body.recipe}` });
      const execute = body.mode === 'local' || body.mode === 'ssh';
      const target = targetFromMode(body.mode, body.host, body.identityFile);

      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache', 'x-accel-buffering': 'no',
      });
      const send = (obj) => res.write(JSON.stringify(obj) + '\n');
      try {
        const result = await applyRecipe(recipe, {
          project: recipe.id, domain: body.domain || 'midominio.com',
          acmeEmail: `admin@${body.domain || 'midominio.com'}`, adminUser: 'admin',
          target, execute,
          convergeTimeoutMs: target.host === 'local' ? 900_000 : 180_000,
          onEvent: (e) => send({ t: 'event', ...e }),
        });
        send({
          t: 'done', ok: result.ok, mode: result.mode,
          report: {
            apps: result.report.apps.map((a) => ({ id: a.id, name: a.name, routes: a.routes,
              credentials: a.credentials })),
            warnings: result.report.warnings ?? [],
          },
        });
      } catch (err) {
        send({ t: 'error', error: String(err?.message ?? err) });
      }
      return res.end();
    }

    if (url.startsWith('/api/')) return json(res, 404, { error: 'ruta no encontrada' });

    if (!built) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<h1>InventOS GUI</h1><p>El frontend no está compilado. Corré <code>npm run build:gui</code>.</p>');
    }
    return serveStatic(res, guiDir, url);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const uri = `http://127.0.0.1:${port}`;
  if (open) openBrowser(uri);
  return { uri, server };
}

function openBrowser(uri) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, [uri], { stdio: 'ignore', detached: true }).unref(); } catch { /* no-op */ }
}
