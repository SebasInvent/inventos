// InventOS — motor de deploy · index.ts (orquestador).
//
// Encadena el flujo del motor en una sola API de alto nivel: cargar manifests →
// construir el plan (dry-run) → renderizar (validar que TODO resuelve, 0 tokens
// sueltos). Es la capa de pegado que la CLI (bin/inventos.mjs) consume.
//
// El modo por defecto es plan/dry-run: no toca disco de salida ni infra. El
// deploy real (apply) vive en deploy.ts y exige target + --apply (Fase 1.5).
//
// Node 24 borra los tipos por type-stripping nativo (sin build).

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from './plan.ts';
import type { Recipe } from './plan.ts';
import { renderAll } from './render.ts';
import type { RenderAllResult } from './render.ts';
import type { DeployMode, DeployTarget, Manifest, PlanResult } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Ubica la carpeta `templates/` subiendo desde el módulo actual. Funciona tanto en
 * DEV (`src/engine/` → sube 2) como en el bundle publicado (`dist/` → sube 1) o
 * instalado en `node_modules`. Evita rutas fijas frágiles según el layout.
 */
function findTemplatesDir(start: string): string {
  // App de escritorio empaquetada (Electron): los templates van a
  // `app.asar.unpacked/` (asarUnpack); el walk desde dentro del asar no cruza solo.
  const res = process.env.INVENTOS_TEMPLATES_DIR
    ?? (process.resourcesPath ? join(process.resourcesPath, 'app.asar.unpacked', 'templates') : undefined);
  if (res !== undefined && existsSync(join(res, 'traefik', 'manifest.json'))) return res;

  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'templates');
    if (existsSync(join(candidate, 'traefik', 'manifest.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, '..', '..', 'templates'); // fallback (layout dev)
}

/** Carpeta de plantillas del paquete (`InventOS/templates`). */
export const TEMPLATES_DIR = findTemplatesDir(HERE);

/** Lee y parsea `templates/<id>/manifest.json`. */
export async function loadManifest(
  id: string,
  templatesDir: string = TEMPLATES_DIR,
): Promise<Manifest> {
  const raw = await readFile(join(templatesDir, id, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

/**
 * Carga los manifests de una lista de apps MÁS todas sus deps transitivas
 * (`requires`). `buildPlan` exige el set completo o `resolveOrder` lanza.
 */
export async function loadManifests(
  ids: string[],
  templatesDir: string = TEMPLATES_DIR,
): Promise<Record<string, Manifest>> {
  const out: Record<string, Manifest> = {};
  const visit = async (id: string): Promise<void> => {
    if (out[id] !== undefined) return;
    const manifest = await loadManifest(id, templatesDir);
    out[id] = manifest;
    for (const dep of manifest.requires ?? []) await visit(dep);
  };
  for (const id of ids) await visit(id);
  return out;
}

/** Opciones del orquestador. */
export interface OrchestrateOptions {
  /** Namespace local del operador. */
  project: string;
  /** Dominio apex para componer subdominios. */
  domain: string;
  /** Red overlay compartida (default `inventnet`). */
  network?: string;
  /** Email para el certificado ACME/Let's Encrypt. */
  acmeEmail?: string;
  /** Usuario del basicauth admin (default `admin`). */
  adminUser?: string;
  /** Overrides de params por app: `overrides[appId][PARAM] = valor`. */
  overrides?: Record<string, Record<string, string>>;
  /** Carpeta de plantillas (default la del paquete). */
  templatesDir?: string;
  /** Modo (default `plan`). */
  mode?: DeployMode;
  /** Target de deploy (null en dry-run puro). */
  target?: DeployTarget | null;
}

/** Resultado del dry-run: el plan + la validación de render. */
export interface PlanOutcome {
  plan: PlanResult;
  render: RenderAllResult;
  /** Cantidad de stacks renderizados. */
  rendered: number;
  /** Tokens `${VAR}` que quedaron sin resolver (debe ser 0). */
  unresolved: string[];
  /** true si todo resolvió y no hay colisiones bloqueantes. */
  ok: boolean;
}

/**
 * Dry-run end-to-end de una receta: carga manifests (+deps), arma el plan y
 * RENDERIZA todos los stacks para probar que cada `${VAR}` resuelve. No escribe
 * salida ni despliega nada. Es la prueba real de que la receta es desplegable.
 */
export async function planRecipe(
  recipe: Recipe,
  opts: OrchestrateOptions,
): Promise<PlanOutcome> {
  const templatesDir = opts.templatesDir ?? TEMPLATES_DIR;
  const network = opts.network ?? 'inventnet';

  const manifests = await loadManifests(recipe.apps, templatesDir);

  const plan = buildPlan(recipe, {
    project: opts.project,
    domain: opts.domain,
    network,
    manifests,
    mode: opts.mode ?? 'plan',
    target: opts.target ?? null,
  });

  // Render real (en memoria): valida que todo interpola. strict:false para juntar
  // TODOS los tokens sueltos en un solo informe en vez de lanzar en el primero.
  const render = await renderAll(plan.order, {
    templatesDir,
    project: opts.project,
    domain: opts.domain,
    network,
    acmeEmail: opts.acmeEmail,
    adminUser: opts.adminUser,
    overrides: opts.overrides,
    strict: false,
  });

  const unresolved = render.unresolved ?? [];
  const blockingWarnings = plan.warnings.filter((w) => w.startsWith('Colisión'));

  return {
    plan,
    render,
    rendered: render.results.length,
    unresolved,
    ok: unresolved.length === 0 && blockingWarnings.length === 0,
  };
}
