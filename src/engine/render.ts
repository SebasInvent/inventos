// InventOS — motor de deploy · render.ts (renderizador de plantillas).
//
// Convierte una plantilla endurecida (`templates/<id>/stack.yml.tmpl`) en un
// `docker stack` concreto listo para desplegar. Ref: docs/ARCHITECTURE.md §2.2 y §5.
//
// Responsabilidad (§5): leer el manifest, juntar params (defaults + overrides),
// GENERAR los secretos (vía `secrets.ts`), resolver lo que la app CONSUME de un
// global o de otro stack, componer los dominios `sub.${DOMAIN}`, interpolar cada
// token `${VAR}` de la plantilla e INYECTAR el middleware basicauth de Traefik
// para cada panel `adminAuth` que la plantilla no traiga ya cableado.
//
// Regla de oro (seguro de fábrica): ningún secreto vive en el repo — el motor los
// genera aquí, en memoria, y solo se persisten en la máquina del operador (§4).
// El orden topológico de deploy lo resuelve `resolveOrder` (reexportado de plan.ts,
// fuente única). El modo por defecto del sistema es plan/dry-run; `render` NO toca
// infra: solo produce texto. Node 24 borra los tipos por type-stripping (sin build).
//
// Escapado docker-compose: el YAML que produce `render` se despliega con
// `docker stack deploy`, que vuelve a interpolar `${...}`/`$...`. Por eso todo `$`
// literal dentro de un VALOR interpolado (en la práctica, solo los hashes bcrypt)
// se emite escapado como `$$` — así sobrevive intacto a esa segunda pasada.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { genAll, bcryptHash } from './secrets.ts';
import { resolveOrder } from './plan.ts';
import type { Consume, Manifest, PlannedRoute, Secret } from './types.ts';

// El orden topológico de deploy es responsabilidad de una única fuente (plan.ts).
export { resolveOrder };

// ---------------------------------------------------------------------------
// Entrada / salida
// ---------------------------------------------------------------------------

/**
 * Opciones para renderizar. Trae los globals del deploy (dominio, red, email de
 * ACME), la carpeta de plantillas y los `overrides` de params por app. Los
 * valores sensibles (overrides que sean credenciales del operador, p. ej.
 * SMTP_PASS) viven en runtime del operador, nunca en el repo (§4).
 */
export interface RenderOptions {
  /** Carpeta raíz de plantillas (`templates/`). */
  templatesDir: string;
  /** Nombre del proyecto (namespace local del operador). */
  project?: string;
  /** Dominio base (apex) con el que se componen los subdominios. */
  domain: string;
  /** Red overlay compartida. Default `inventnet`. */
  network?: string;
  /** Email para los avisos de Let's Encrypt (token `${ACME_EMAIL}`). */
  acmeEmail?: string;
  /** Usuario por defecto del basicauth de Traefik cuando el manifest no lo fija. */
  adminUser?: string;
  /** Overrides de params por app: `overrides[appId][PARAM_KEY] = valor`. */
  overrides?: Record<string, Record<string, string>>;
  /**
   * Secretos YA generados en un apply anterior, por app: `existingSecrets[appId][KEY]`.
   * Si un secreto ya existe acá, se REUSA en vez de generar uno nuevo — así `apply`
   * es idempotente y no rota claves en cada corrida (romper servicios en vivo).
   */
  existingSecrets?: Record<string, Record<string, string>>;
  /** Registro compartido entre apps para resolver `consumes` (lo crea `renderAll`). */
  store?: SharedStore;
  /**
   * Si `true` (default), `render` lanza cuando queda algún token `${VAR}` sin
   * resolver — nunca emite un stack a medio interpolar. `renderAll` lo pone en
   * `false` para poder juntar TODOS los faltantes en un solo informe.
   */
  strict?: boolean;
}

/** Resultado de renderizar una app. Interlaza con plan.ts/report.ts/deploy.ts. */
export interface RenderResult {
  /** Id de la app. */
  id: string;
  /** `docker stack` concreto (compose 3.8) listo para `docker stack deploy`. */
  yaml: string;
  /** Params resueltos (no sensibles). */
  params: Record<string, string>;
  /** Secretos que ESTA app genera (SENSIBLES; nunca al repo). */
  secrets: Record<string, string>;
  /** Mapa completo de interpolación `${VAR}` (globals + params + consumes + secretos). */
  env: Record<string, string>;
  /** Rutas públicas finales (`https://<sub>.<domain>`), forma `PlannedRoute`. */
  urls: PlannedRoute[];
  /** `credentialsOut` ya resueltos (para el reporte; forma `ReportCredential`). */
  credentials: Array<{ key: string; value: string }>;
  /** Routers que quedaron protegidos con basicauth de Traefik. */
  adminAuthRouters: string[];
  /** Avisos accionables (subdominio vacío, consume sin origen, etc.). */
  warnings: string[];
  /** Tokens `${VAR}` que quedaron sin resolver (debe ir vacío). */
  unresolved: string[];
}

/** Resultado de renderizar una receta completa en orden de deploy. */
export interface RenderAllResult {
  /** Orden topológico de deploy (ids), deps antes que dependientes. */
  order: string[];
  /** Resultado por app, en orden de deploy. */
  results: RenderResult[];
  /** Registro compartido con los valores provistos por cada app. */
  store: SharedStore;
  /** Union de tokens sin resolver de todas las apps (debe ir vacío). */
  unresolved: string[];
  /** Avisos de todas las apps, prefijados con `[id]`. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Registro compartido entre apps (para resolver `consumes` y secretos `sharedWith`)
// ---------------------------------------------------------------------------

/**
 * Memoria compartida de un plan: cada app, al renderizarse, "provee" sus valores
 * (params + secretos + consumes) para que las apps siguientes (que dependen de
 * ella) los CONSUMAN. P. ej. `postgres` provee `POSTGRES_PASSWORD` y `typebot`
 * lo consume. Vive solo en memoria durante el render; nunca se persiste.
 */
export class SharedStore {
  readonly #values = new Map<string, Map<string, string>>();
  readonly #secretKeys = new Map<string, Set<string>>();

  /** Registra un valor `key` provisto por la app `app`. */
  provide(app: string, key: string, value: string): void {
    let m = this.#values.get(app);
    if (m === undefined) {
      m = new Map<string, string>();
      this.#values.set(app, m);
    }
    m.set(key, value);
  }

  /** Marca `key` como SECRETO de la app `app` (para resolver `sharedWith`). */
  markSecret(app: string, key: string): void {
    let s = this.#secretKeys.get(app);
    if (s === undefined) {
      s = new Set<string>();
      this.#secretKeys.set(app, s);
    }
    s.add(key);
  }

  /** Devuelve el valor `key` provisto por `app`, o `undefined`. */
  get(app: string, key: string): string | undefined {
    return this.#values.get(app)?.get(key);
  }

  /** Claves de secreto provistas por `app`. */
  secretKeysOf(app: string): string[] {
    return [...(this.#secretKeys.get(app) ?? [])];
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Renderiza UNA app a YAML concreto. `app` puede ser el id (se carga el manifest)
 * o un `Manifest` ya cargado. Genera secretos, resuelve consumes, compone URLs e
 * inyecta basicauth donde haga falta. Por defecto (`strict`) lanza si queda algún
 * `${VAR}` sin resolver.
 */
export async function render(
  app: string | Manifest,
  opts: RenderOptions,
): Promise<RenderResult> {
  const manifest =
    typeof app === 'string' ? await loadManifest(opts.templatesDir, app) : app;

  const { params, secrets, env, warnings } = await buildEnv(manifest, opts);

  const tmplPath = join(opts.templatesDir, manifest.id, 'stack.yml.tmpl');
  const template = await readTemplate(tmplPath, manifest.id);

  const interpolated = interpolateStack(template, env);
  const yaml = await ensureBasicAuth(interpolated.yaml, manifest, env, warnings);

  const urls = buildUrls(manifest, env, opts.domain, warnings);
  const credentials = manifest.credentialsOut.map((key) => {
    if (!(key in env)) {
      warnings.push(`credentialsOut "${key}" no se pudo resolver (no está en el env).`);
    }
    return { key, value: env[key] ?? '' };
  });

  if (opts.store !== undefined) {
    recordInStore(opts.store, manifest, env, secrets);
  }

  const result: RenderResult = {
    id: manifest.id,
    yaml,
    params,
    secrets,
    env,
    urls,
    credentials,
    adminAuthRouters: manifest.adminAuth.map((a) => a.router),
    warnings,
    unresolved: interpolated.unresolved,
  };

  const strict = opts.strict ?? true;
  if (strict && interpolated.unresolved.length > 0) {
    throw new Error(
      `render(${manifest.id}): tokens sin resolver: ${interpolated.unresolved.join(', ')}. ` +
        'Declaralos en el manifest (params/secrets/consumes) o revisá la plantilla.',
    );
  }
  return result;
}

/**
 * Renderiza una lista de apps (una receta) en ORDEN de deploy: resuelve el orden
 * topológico por deps, encadena un `SharedStore` para que cada app consuma lo que
 * proveen sus dependencias, y junta faltantes/avisos. No lanza por tokens sin
 * resolver: los reúne en `unresolved` para un único informe (útil en dry-run).
 */
export async function renderAll(
  ids: string[],
  opts: RenderOptions,
): Promise<RenderAllResult> {
  const manifests = await loadManifestClosure(ids, opts.templatesDir);
  const order = resolveOrder(ids, manifests);

  const store = opts.store ?? new SharedStore();
  const results: RenderResult[] = [];
  for (const id of order) {
    const manifest = manifests[id]!;
    results.push(await render(manifest, { ...opts, store, strict: false }));
  }

  const unresolved = [...new Set(results.flatMap((r) => r.unresolved))];
  const warnings = results.flatMap((r) => r.warnings.map((w) => `[${r.id}] ${w}`));
  return { order, results, store, unresolved, warnings };
}

/**
 * Arma el mapa de interpolación `${VAR}` de una app: params (defaults + overrides),
 * globals (DOMAIN/NETWORK/ACME_EMAIL y alias de dominio), lo que consume de otros
 * stacks, los usuarios de basicauth y los secretos GENERADOS. Precedencia (de
 * menor a mayor): params → globals → consumes → usuarios admin → secretos.
 */
export async function buildEnv(
  manifest: Manifest,
  opts: RenderOptions,
): Promise<{
  params: Record<string, string>;
  secrets: Record<string, string>;
  env: Record<string, string>;
  warnings: string[];
}> {
  if (!opts.domain) {
    throw new Error('buildEnv: falta el dominio base (opts.domain) para componer subdominios.');
  }
  const warnings: string[] = [];
  const network = opts.network ?? 'inventnet';
  const overrides = opts.overrides?.[manifest.id] ?? {};

  // 1) Params: override del operador → default del manifest.
  const params: Record<string, string> = {};
  for (const p of manifest.params) {
    params[p.key] = overrides[p.key] ?? p.default;
  }

  // 2) Globals. DOMAIN/ROOT_DOMAIN/BASE_DOMAIN son alias del mismo apex; NETWORK
  //    y ACME_EMAIL son invariantes del deploy (ganan sobre cualquier default de
  //    param para no divergir de la red/cuenta ACME reales).
  const globals: Record<string, string> = {
    DOMAIN: opts.domain,
    ROOT_DOMAIN: opts.domain,
    BASE_DOMAIN: opts.domain,
    NETWORK: network,
  };
  if (opts.acmeEmail !== undefined) globals.ACME_EMAIL = opts.acmeEmail;

  // 3) Secretos GENERADOS por el motor (respeta `from` para derivados: JWT→anon,
  //    STUDIO_PASS→bcrypt, etc.). Los `sharedWith` reusan el valor del stack fuente.
  const secrets = await genAll(manifest);
  // 3b) Idempotencia: reusar los secretos ya persistidos de un apply anterior (así
  //     re-aplicar NO rota claves y no rompe servicios en vivo). Los derivados
  //     (ANON_KEY, *_BCRYPT) también se reusan porque se persiste el mapa completo.
  const persisted = opts.existingSecrets?.[manifest.id];
  if (persisted !== undefined) {
    for (const key of Object.keys(secrets)) {
      if (persisted[key] !== undefined) secrets[key] = persisted[key]!;
    }
  }
  applySharedSecrets(manifest.secrets, opts.store, secrets, warnings);

  // 4) Consumes: valores que la app toma de un global o de otro stack ya rendido.
  const consumes: Record<string, string> = {};
  for (const c of manifest.consumes ?? []) {
    const value = resolveConsume(c, globals, opts.store);
    if (value !== undefined) {
      consumes[c.key] = value;
    } else {
      warnings.push(
        `consume "${c.key}" desde "${c.from}" sin resolver (¿la dependencia se rindió antes?).`,
      );
    }
  }

  // 5) Usuarios del basicauth de Traefik (el password es un secreto aparte).
  const adminUsers: Record<string, string> = {};
  for (const a of manifest.adminAuth) {
    adminUsers[a.user] = overrides[a.user] ?? opts.adminUser ?? 'admin';
  }

  const env: Record<string, string> = {
    ...params,
    ...globals,
    ...consumes,
    ...adminUsers,
    ...secrets,
  };
  return { params, secrets, env, warnings };
}

/**
 * Interpola los tokens `${VAR}` de una plantilla con `env` (función PURA). Escapa
 * `$` → `$$` en cada valor para que sobreviva a la segunda interpolación de
 * `docker stack deploy`. Reporta los tokens que quedaron sin resolver, ignorando
 * los que aparecen solo en líneas de comentario (documentación como `${VAR}`).
 */
export function interpolateStack(
  template: string,
  env: Record<string, string>,
): { yaml: string; unresolved: string[] } {
  const yaml = template.replace(TOKEN_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(env, name) ? escapeDollars(env[name]!) : match,
  );

  const unresolved = new Set<string>();
  for (const line of yaml.split('\n')) {
    if (line.trimStart().startsWith('#')) continue; // comentario: ignorar
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(line)) !== null) unresolved.add(m[1]!);
  }
  return { yaml, unresolved: [...unresolved] };
}

/** Carga y normaliza `templates/<id>/manifest.json`. */
export async function loadManifest(templatesDir: string, id: string): Promise<Manifest> {
  const path = join(templatesDir, id, 'manifest.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No pude leer el manifest de "${id}" en ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest.json de "${id}" no es JSON válido: ${(err as Error).message}`);
  }
  return normalizeManifest(parsed as Partial<Manifest>, id);
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/** Regex de un token `${NOMBRE}` (nombre estilo identificador). */
const TOKEN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Duplica cada `$` → `$$` (escapado de docker-compose para valores literales). */
function escapeDollars(value: string): string {
  return value.split('$').join('$$');
}

/** Lee la plantilla `stack.yml.tmpl`, con error claro si falta. */
async function readTemplate(path: string, id: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(`No pude leer la plantilla de "${id}" en ${path}.`);
  }
}

/**
 * Reusa el valor de un secreto compartido (`sharedWith`) desde el stack fuente ya
 * rendido, de modo que ambos lados usen EXACTAMENTE la misma clave (p. ej. n8n y
 * su cola Redis). Si no lo encuentra, deja el valor recién generado y avisa.
 */
function applySharedSecrets(
  specs: Secret[],
  store: SharedStore | undefined,
  secrets: Record<string, string>,
  warnings: string[],
): void {
  if (store === undefined) return;
  for (const spec of specs) {
    if (spec.sharedWith === undefined) continue;
    const src = spec.sharedWith;
    let value = store.get(src, spec.key); // mismo nombre en ambos lados
    if (value === undefined) {
      const keys = store.secretKeysOf(src);
      const pick =
        keys.length === 1 ? keys[0] : keys.find((k) => /PASS|PASSWORD|KEY|TOKEN/.test(k));
      if (pick !== undefined) value = store.get(src, pick);
    }
    if (value !== undefined) {
      secrets[spec.key] = value;
    } else {
      warnings.push(
        `secreto "${spec.key}" sharedWith="${src}": no hallé el valor compartido; se usará uno nuevo.`,
      );
    }
  }
}

/** Resuelve un `consume`: desde globals (`from:global`) o desde otro stack. */
function resolveConsume(
  c: Consume,
  globals: Record<string, string>,
  store: SharedStore | undefined,
): string | undefined {
  if (c.from === 'global') {
    return globals[c.key] ?? c.default;
  }
  return store?.get(c.from, c.key) ?? c.default;
}

/**
 * Garantiza el middleware basicauth de Traefik para cada `adminAuth`. Si la
 * plantilla YA lo trae cableado (caso Supabase Studio), solo lo satisface la
 * interpolación de `${STUDIO_USER}`/`${STUDIO_PASS_BCRYPT}`. Si no lo trae, INYECTA
 * las labels (usuario + hash bcrypt) sobre el router indicado.
 */
async function ensureBasicAuth(
  yaml: string,
  manifest: Manifest,
  env: Record<string, string>,
  warnings: string[],
): Promise<string> {
  let out = yaml;
  for (const a of manifest.adminAuth) {
    if (isBasicAuthWired(out, a.router)) continue;

    const user = env[a.user];
    if (!user) {
      warnings.push(`basicauth "${a.router}": falta el usuario (${a.user}); no lo inyecté.`);
      continue;
    }
    // Preferir un hash bcrypt ya declarado (`<PASS>_BCRYPT`); si no, hashear el
    // texto plano indicado por `pass`.
    let hash = env[`${a.pass}_BCRYPT`];
    if (hash === undefined) {
      const plain = env[a.pass];
      if (!plain) {
        warnings.push(`basicauth "${a.router}": falta el password (${a.pass}); no lo inyecté.`);
        continue;
      }
      hash = await bcryptHash(plain);
    }
    out = injectBasicAuthLabels(out, a.router, user, hash, warnings);
  }
  return out;
}

/** `true` si el YAML ya tiene un basicauth atado al router indicado. */
function isBasicAuthWired(yaml: string, router: string): boolean {
  const hasMiddlewareRef = new RegExp(`routers\\.${escapeRegExp(router)}\\.middlewares`).test(yaml);
  return hasMiddlewareRef && /\.basicauth\.users\s*=/.test(yaml);
}

/**
 * Inyecta las labels de basicauth después del anchor del router (su línea de
 * `tls.certresolver` o, en su defecto, `entrypoints`), replicando indentación y
 * comillas de esa línea. El hash se emite con `$` escapado como `$$`.
 */
function injectBasicAuthLabels(
  yaml: string,
  router: string,
  user: string,
  hash: string,
  warnings: string[],
): string {
  const lines = yaml.split('\n');
  const anchorIdx = findRouterAnchor(lines, router);
  if (anchorIdx === -1) {
    warnings.push(`basicauth "${router}": no encontré el router en el YAML; no lo inyecté.`);
    return yaml;
  }
  const anchor = lines[anchorIdx]!;
  const prefix = anchor.slice(0, anchor.indexOf('traefik'));
  const quote = anchor.trimEnd().endsWith('"') ? '"' : '';
  const middleware = `${router}_auth`;
  const escapedHash = escapeDollars(hash);

  const usersLabel = `${prefix}${quote}traefik.http.middlewares.${middleware}.basicauth.users=${user}:${escapedHash}${quote}`;
  const routerLabel = `${prefix}${quote}traefik.http.routers.${router}.middlewares=${middleware}${quote}`;
  lines.splice(anchorIdx + 1, 0, usersLabel, routerLabel);

  warnings.push(`basicauth inyectado en el router "${router}" (la plantilla no lo traía).`);
  return lines.join('\n');
}

/** Índice de la línea-anchor de un router (certresolver, si no entrypoints). */
function findRouterAnchor(lines: string[], router: string): number {
  const cert = lines.findIndex((l) => l.includes(`routers.${router}.tls.certresolver`));
  if (cert !== -1) return cert;
  return lines.findIndex((l) => l.includes(`routers.${router}.entrypoints`));
}

/** URLs finales de las rutas públicas, forma `PlannedRoute`. */
function buildUrls(
  manifest: Manifest,
  env: Record<string, string>,
  domain: string,
  warnings: string[],
): PlannedRoute[] {
  return manifest.exposes.map((e) => {
    const sub = env[e.subdomainParam] ?? '';
    if (sub === '') {
      warnings.push(`ruta "${e.name}": subdominio (${e.subdomainParam}) vacío; usa el apex ${domain}.`);
    }
    const host = sub === '' ? domain : `${sub}.${domain}`;
    return { name: e.name, url: `https://${host}`, servicePort: e.servicePort };
  });
}

/** Publica en el store todo lo que la app resolvió, marcando sus secretos. */
function recordInStore(
  store: SharedStore,
  manifest: Manifest,
  env: Record<string, string>,
  secrets: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(env)) {
    store.provide(manifest.id, key, value);
  }
  for (const key of Object.keys(secrets)) {
    store.markSecret(manifest.id, key);
  }
}

/** Carga los manifests de `ids` y de todas sus deps transitivas. */
async function loadManifestClosure(
  ids: string[],
  templatesDir: string,
): Promise<Record<string, Manifest>> {
  const out: Record<string, Manifest> = {};
  const pending = [...ids];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (out[id] !== undefined) continue;
    const manifest = await loadManifest(templatesDir, id);
    out[id] = manifest;
    for (const dep of manifest.requires) {
      if (out[dep] === undefined) pending.push(dep);
    }
  }
  return out;
}

/** Rellena arrays opcionales del manifest para un consumo robusto aguas abajo. */
function normalizeManifest(raw: Partial<Manifest>, id: string): Manifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`manifest.json de "${id}" no es un objeto.`);
  }
  const manifest = raw as Manifest;
  manifest.id = manifest.id ?? id;
  manifest.requires = manifest.requires ?? [];
  manifest.params = manifest.params ?? [];
  manifest.secrets = manifest.secrets ?? [];
  manifest.adminAuth = manifest.adminAuth ?? [];
  manifest.exposes = manifest.exposes ?? [];
  manifest.internalOnly = manifest.internalOnly ?? [];
  manifest.credentialsOut = manifest.credentialsOut ?? [];
  return manifest;
}

/** Escapa una cadena para uso literal dentro de un `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
