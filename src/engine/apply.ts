// InventOS — motor de deploy · apply.ts (orquestador del deploy real).
//
// Encadena el deploy sobre UN solo camino SSH (target.ts): preflight (red overlay),
// y por cada app en orden topológico → subir el YAML renderizado (por stdin, sin
// copia local con secretos) → aprovisionar rol/base si hace falta → docker stack
// deploy → esperar convergencia. Al final, reporte con credenciales.
//
// DOS MODOS (docs/ARCHITECTURE.md §5):
//   - dry-apply (default): NO toca el server. Arma e imprime la secuencia EXACTA
//     de comandos remotos (sin secretos). Verificable sin VPS.
//   - apply real (`execute: true` + target): ejecuta de verdad.
//
// Node 24 borra los tipos por type-stripping nativo (sin build).

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPlan } from './plan.ts';
import type { Recipe } from './plan.ts';
import { renderAll } from './render.ts';
import { createTarget, isLocal } from './target.ts';
import type { BoundTarget, RemoteResult } from './target.ts';
import { planProvisioning } from './provision.ts';
import type { DeployReport, ReportCredential } from './report.ts';
import { loadManifests, TEMPLATES_DIR } from './index.ts';
import type { DeployMode, DeployTarget } from './types.ts';

/** Opciones del apply. */
export interface ApplyOptions {
  project: string;
  domain: string;
  target: DeployTarget;
  network?: string;
  acmeEmail?: string;
  adminUser?: string;
  templatesDir?: string;
  /** `true` = deploy real. `false`/ausente = dry-apply (imprime, no ejecuta). */
  execute?: boolean;
  /** Carpeta remota base para los YAML. Default `/opt/inventos/<project>`. */
  remoteBase?: string;
  /** Timeout de convergencia por stack (ms). Default 120000. */
  convergeTimeoutMs?: number;
  /**
   * Callback de progreso EN VIVO. El motor lo llama al empezar/terminar cada paso
   * y en cada lectura de convergencia, para que un frontend (terminal, GUI) pinte
   * el avance en tiempo real. Sin él, el motor corre igual (solo devuelve al final).
   */
  onEvent?: (event: ApplyEvent) => void;
}

/** Un paso del plan de apply (para imprimir o auditar). */
export interface ApplyStep {
  kind: 'preflight' | 'upload' | 'provision' | 'deploy' | 'converge' | 'warn';
  app?: string;
  description: string;
  /** Comando remoto imprimible (SIN secretos). Vacío para `warn`. */
  printable: string;
  executed: boolean;
  ok: boolean;
}

/** Evento de progreso emitido durante el apply (para UIs en vivo). */
export interface ApplyEvent {
  /** `start` (empezó), `done`/`fail`/`warn` (terminó), `converge` (lectura de réplicas). */
  type: 'start' | 'done' | 'fail' | 'warn' | 'converge';
  /** Tipo de paso (preflight/upload/deploy/…). */
  stepKind: ApplyStep['kind'];
  /** App asociada (si aplica). */
  app?: string;
  /** Texto legible del paso. */
  label: string;
  /** Réplicas corriendo / deseadas (solo en `converge`). */
  running?: number;
  desired?: number;
}

/** Resultado del apply. */
export interface ApplyResult {
  mode: DeployMode;
  project: string;
  order: string[];
  steps: ApplyStep[];
  ok: boolean;
  /** Reporte final (URLs + credenciales). Lo imprime el llamador tras los pasos. */
  report: DeployReport;
}

/**
 * Ejecuta (o planifica) el deploy de una receta. En dry-apply arma la secuencia
 * de comandos remotos sin tocar el server; en apply real los ejecuta en orden y
 * corta ante el primer fallo remoto.
 */
export async function applyRecipe(recipe: Recipe, opts: ApplyOptions): Promise<ApplyResult> {
  const mode: DeployMode = opts.execute === true ? 'apply' : 'plan';
  const network = opts.network ?? 'inventnet';
  const templatesDir = opts.templatesDir ?? TEMPLATES_DIR;
  // En local los comandos corren como el usuario actual (no root): base escribible
  // en el home. En un VPS (SSH como root) se usa /opt/inventos.
  const remoteBase = opts.remoteBase
    ?? (isLocal(opts.target) ? join(homedir(), '.inventos', opts.project) : `/opt/inventos/${opts.project}`);

  const manifests = await loadManifests(recipe.apps, templatesDir);
  const plan = buildPlan(recipe, {
    project: opts.project, domain: opts.domain, network, manifests, mode, target: opts.target,
  });

  // Idempotencia: cargar los secretos ya generados en un apply anterior para
  // REUSARLOS (no rotar claves y romper servicios). Se guardan en apply real.
  // Estado SIEMPRE en ~/.inventos/<proyecto>: consistente entre CLI, GUI y app de
  // escritorio (una app lanzada desde Finder tiene cwd=/, no escribible).
  const stateDir = join(homedir(), '.inventos', opts.project);
  const secretsPath = join(stateDir, 'secrets.json');
  const existingSecrets = await loadSecrets(secretsPath);

  // La carpeta de assets de cada app cuelga de `remoteBase` (que en local es el
  // home y en VPS /opt/inventos). El default del manifest apunta a /opt, que en
  // un target local no es escribible — y además el YAML monta ESA ruta, así que
  // el override tiene que entrar en el render, no solo en la subida.
  const assetOverrides: Record<string, Record<string, string>> = {};
  for (const [id, m] of Object.entries(manifests)) {
    const dirKey = (m as Manifest & { assets?: AssetSpec }).assets?.dir;
    if (dirKey !== undefined) assetOverrides[id] = { [dirKey]: `${remoteBase}/${id}` };
  }

  const render = await renderAll(plan.order, {
    templatesDir, project: opts.project, domain: opts.domain, network,
    acmeEmail: opts.acmeEmail, adminUser: opts.adminUser, strict: false,
    existingSecrets, overrides: assetOverrides,
  });
  if (render.unresolved.length > 0) {
    throw new Error(`No se despliega: tokens sin resolver → ${render.unresolved.join(', ')}.`);
  }

  // Persistir los secretos (merge con los previos) SOLO en apply real, con 0600.
  if (mode === 'apply') {
    const merged: Record<string, Record<string, string>> = { ...existingSecrets };
    for (const r of render.results) merged[r.id] = r.secrets;
    await saveSecrets(secretsPath, merged);
  }

  const envById: Record<string, Record<string, string>> = {};
  const yamlById: Record<string, string> = {};
  const credsById: Record<string, ReportCredential[]> = {};
  for (const r of render.results) {
    envById[r.id] = r.env;
    yamlById[r.id] = r.yaml;
    credsById[r.id] = r.credentials;
  }

  const emit = (event: ApplyEvent): void => opts.onEvent?.(event);
  const bound = createTarget(opts.target, { mode });
  const steps: ApplyStep[] = [];
  // Ejecuta un paso: emite `start` → corre (con guard) → registra → emite `done`/`fail`.
  const track = async (
    kind: ApplyStep['kind'], description: string, app: string | undefined,
    op: () => Promise<RemoteResult>,
  ): Promise<RemoteResult> => {
    emit({ type: 'start', stepKind: kind, app, label: description });
    try {
      const res = await guard(op());
      steps.push({ kind, app, description, printable: res.printable, executed: res.executed, ok: res.ok });
      emit({ type: res.ok ? 'done' : 'fail', stepKind: kind, app, label: description });
      return res;
    } catch (err) {
      emit({ type: 'fail', stepKind: kind, app, label: description });
      throw err;
    }
  };

  // 1) Preflight: Docker vivo y Swarm activo ANTES de tocar nada. Sin esto el
  // primer comando fallaba con el error crudo del daemon ("Cannot connect to the
  // Docker daemon…"), que no le dice al usuario qué hacer.
  if (mode === 'apply') await assertDockerReady(bound, opts.target);

  // Los stacks se llaman como la app (`n8n`, `supabase`), NO como el proyecto, así
  // que dos proyectos en el mismo host comparten volúmenes pero tienen secretos
  // distintos → n8n arranca con otra encryption key y entra en crash loop. Se
  // detecta ANTES de desplegar en vez de dejar que falle de forma confusa.
  if (mode === 'apply') await assertStackOwnership(plan.order, opts.project, opts.target);

  // Carpeta remota + red overlay compartida.
  await track('preflight', `Crear carpeta remota ${remoteBase}`, undefined,
    () => bound.exec(`mkdir -p ${remoteBase} && chmod 700 ${remoteBase}`, { mode }));
  await track('preflight', `Asegurar red overlay "${network}"`, undefined,
    () => bound.exec(
      `docker network inspect ${network} >/dev/null 2>&1 || docker network create --driver overlay --attachable --opt encrypted ${network}`,
      { mode }));

  const provSteps = planProvisioning(plan.order, manifests, envById);

  // 2) Por cada app en orden topológico.
  for (const id of plan.order) {
    const remotePath = `${remoteBase}/${id}.stack.yml`;

    // 2a) Subir el YAML (por stdin: sin copia local con secretos; printable sin secretos).
    await track('upload', `Subir stack de ${id}`, id,
      () => bound.uploadContent(yamlById[id]!, remotePath, { mode }));

    // 2b) Subir los assets estáticos del stack (p. ej. Supabase: kong.yml, SQL init…).
    await uploadAssets(bound, manifests[id]!, envById[id] ?? {}, templatesDir, remoteBase, mode, steps, emit);

    // 2c) Aprovisionar rol/base dedicados (n8n/evolution) ANTES de su deploy.
    for (const p of provSteps.filter((s) => s.app === id)) {
      await track('provision', p.description, id, () => bound.exec(p.remoteCommand, { mode, input: p.input }));
    }

    // 2d) Deploy del stack.
    await track('deploy', `docker stack deploy ${id}`, id,
      () => bound.exec(`docker stack deploy --with-registry-auth --prune -c ${remotePath} ${id}`, { mode }));

    // 2e) Convergencia (1/1). En apply real hace poll y emite progreso; en dry solo registra.
    await converge(bound, id, mode, steps, opts.convergeTimeoutMs ?? 120_000, emit);
  }

  // 3) Reporte: URLs + credenciales (lo imprime el llamador, tras los pasos).
  const report: DeployReport = {
    mode,
    project: opts.project,
    domain: opts.domain,
    outDir: stateDir, // ~/.inventos/<proyecto> — credenciales junto a secrets.json
    target: opts.target,
    warnings: plan.warnings,
    // En dry-apply NO se muestran valores de secretos (aunque render los generó en
    // memoria): solo en apply real se imprimen una vez y se escriben a chmod 600.
    apps: plan.apps.map((a) => ({
      id: a.id, name: a.name, routes: a.routes,
      credentials: mode === 'apply' ? (credsById[a.id] ?? []) : [],
    })),
  };

  const ok = steps.every((s) => s.ok);
  return { mode, project: opts.project, order: plan.order, steps, ok, report };
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/** Declaración de assets estáticos de un manifest (subida verbatim, sin secretos). */
interface AssetSpec {
  /** Key del param que tiene la ruta base remota (p. ej. `SUPABASE_ASSETS_DIR`). */
  dir?: string;
  /** Rutas relativas de los archivos a subir (bajo `templates/<id>/assets/`). */
  files: string[];
  note?: string;
}

/**
 * Sube los assets ESTÁTICOS de una app (si su manifest los declara) antes de su
 * deploy. Se leen del repo (`templates/<id>/assets/`) y se suben por stdin. No
 * llevan secretos ni tokens de InventOS. Si falta un archivo en el repo, se anota
 * como aviso en vez de abortar (útil para ver el plan en dry-apply).
 */
async function uploadAssets(
  bound: BoundTarget,
  manifest: Manifest,
  env: Record<string, string>,
  templatesDir: string,
  remoteBase: string,
  mode: DeployMode,
  steps: ApplyStep[],
  emit: (event: ApplyEvent) => void,
): Promise<void> {
  const assets = (manifest as Manifest & { assets?: AssetSpec }).assets;
  if (assets === undefined || !Array.isArray(assets.files) || assets.files.length === 0) return;

  emit({ type: 'start', stepKind: 'upload', app: manifest.id, label: `Subir ${assets.files.length} assets de ${manifest.id}` });
  const dirKey = assets.dir;
  const remoteRoot = dirKey !== undefined && env[dirKey] !== undefined && env[dirKey] !== ''
    ? env[dirKey]!
    : `${remoteBase}/${manifest.id}`;
  const localRoot = join(templatesDir, manifest.id, 'assets');

  const dirs = new Set<string>();
  for (const rel of assets.files) dirs.add(posixDirname(`${remoteRoot}/${rel}`));
  const mk = await guard(bound.exec(`mkdir -p ${[...dirs].map(shArg).join(' ')}`, { mode }));
  steps.push({ kind: 'upload', app: manifest.id, description: `Crear carpetas de assets de ${manifest.id}`, printable: mk.printable, executed: mk.executed, ok: mk.ok });

  for (const rel of assets.files) {
    const localPath = join(localRoot, rel);
    let content: string;
    try {
      content = await readFile(localPath, 'utf8');
    } catch {
      steps.push({ kind: 'warn', app: manifest.id, description: `Asset faltante en el repo: ${manifest.id}/assets/${rel} (no se sube)`, printable: '', executed: false, ok: true });
      continue;
    }
    const res = await guard(bound.uploadContent(content, `${remoteRoot}/${rel}`, { mode }));
    steps.push({ kind: 'upload', app: manifest.id, description: `Asset ${manifest.id}: ${rel}`, printable: res.printable, executed: res.executed, ok: res.ok });
  }
  emit({ type: 'done', stepKind: 'upload', app: manifest.id, label: `Assets de ${manifest.id} subidos` });
}

/** Carga los secretos persistidos de un apply anterior. `{}` si no existen o son inválidos. */
async function loadSecrets(path: string): Promise<Record<string, Record<string, string>>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, Record<string, string>>)
      : {};
  } catch {
    return {};
  }
}

/** Guarda los secretos por app con permisos 0600 (dir 0700). Nunca al repo/git. */
async function saveSecrets(
  path: string,
  secrets: Record<string, Record<string, string>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

/** dirname POSIX simple (para mkdir -p remoto). */
function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** Comillas simples para un argumento de shell remoto. */
function shArg(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** En apply real, lanza si el comando remoto falló. En dry no hay nada que verificar. */
async function guard(promise: Promise<RemoteResult>): Promise<RemoteResult> {
  const res = await promise;
  if (res.executed && !res.ok) {
    const detail = res.stderr.trim() !== '' ? `\n${res.stderr.trim()}` : '';
    throw new Error(`Comando remoto falló: ${res.printable}${detail}`);
  }
  return res;
}

/** Espera 1/1 réplicas del stack (apply real) o registra el comando (dry). Emite progreso. */
async function converge(
  bound: BoundTarget,
  stack: string,
  mode: DeployMode,
  steps: ApplyStep[],
  timeoutMs: number,
  emit: (event: ApplyEvent) => void,
): Promise<void> {
  const cmd = `docker stack services --format '{{.Name}} {{.Replicas}}' ${stack}`;

  if (mode !== 'apply') {
    const res = await bound.exec(cmd, { mode }); // planned (no ejecuta), captura printable
    steps.push({ kind: 'converge', app: stack, description: `Esperar convergencia de ${stack} (réplicas 1/1)`, printable: res.printable, executed: false, ok: true });
    emit({ type: 'done', stepKind: 'converge', app: stack, label: `Convergencia de ${stack}` });
    return;
  }

  emit({ type: 'start', stepKind: 'converge', app: stack, label: `Esperando convergencia de ${stack}` });
  // La espera es por PROGRESO, no por reloj: un stack grande (Supabase = 13
  // servicios) puede tardar mucho más que cualquier tope fijo solo bajando
  // imágenes, y abortarlo ahí es un falso fallo. Se corta cuando deja de avanzar
  // durante `stallMs`, o al llegar al techo absoluto.
  const stallMs = Math.max(timeoutMs, 300_000);
  const hardDeadline = Date.now() + Math.max(timeoutMs * 4, 3_600_000);
  let last = '';
  let bestRunning = -1;
  let lastProgressAt = Date.now();

  while (Date.now() < hardDeadline) {
    const res = await bound.exec(cmd, { mode: 'apply', readOnly: true });
    last = res.stdout.trim();
    const { running, desired } = replicaCounts(last);
    emit({ type: 'converge', stepKind: 'converge', app: stack, label: `Convergiendo ${stack}`, running, desired });
    if (desired > 0 && running === desired) {
      steps.push({ kind: 'converge', app: stack, description: `Convergió ${stack} (${running}/${desired})`, printable: res.printable, executed: true, ok: true });
      emit({ type: 'done', stepKind: 'converge', app: stack, label: `Convergió ${stack}`, running, desired });
      return;
    }
    if (running > bestRunning) { bestRunning = running; lastProgressAt = Date.now(); }
    if (Date.now() - lastProgressAt > stallMs) break;
    await sleep(3000);
  }

  const mins = Math.round(stallMs / 60_000);
  steps.push({ kind: 'converge', app: stack, description: `Timeout esperando convergencia de ${stack}: ${last}`, printable: cmd, executed: true, ok: false });
  emit({ type: 'fail', stepKind: 'converge', app: stack, label: `Timeout en ${stack}` });
  const e = new Error(
    `El stack "${stack}" no terminó de levantar.\n` +
    `  Estuvo ${mins} min sin avanzar. Última lectura:\n` +
    last.split('\n').map((l) => `    ${l}`).join('\n') +
    `\n  Revisá por qué no arranca:  docker service ps ${stack}_<servicio> --no-trunc`);
  (e as Error & { expected?: boolean }).expected = true;
  throw e;
}

/** Suma réplicas corriendo/deseadas a través de las líneas "servicio r/d". */
function replicaCounts(output: string): { running: number; desired: number } {
  let running = 0;
  let desired = 0;
  for (const line of output.split('\n')) {
    const m = /(\d+)\/(\d+)\s*$/.exec(line.trim());
    if (m !== null) {
      running += Number(m[1]);
      desired += Number(m[2]);
    }
  }
  return { running, desired };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Ruta del registro de propiedad de stacks para UN destino SSH.
 *
 * Los nombres de stack sólo colisionan dentro del mismo Docker Swarm. Un registro global hacía que
 * desplegar `n8n` en el VPS B chocara con el `n8n` del VPS A, aunque fueran discos y enjambres
 * distintos. La identidad incluye usuario, host y puerto; omite la credencial porque rotar una
 * llave no convierte el servidor en otro. El hash evita usar datos de red como nombres de carpeta.
 */
export function stackOwnershipRegistryPath(
  target: DeployTarget,
  inventosHome = join(homedir(), '.inventos'),
): string {
  const identity = `${target.user}@${target.host.toLowerCase()}:${target.port ?? 22}`;
  const targetHash = createHash('sha256').update(identity).digest('hex');
  return join(inventosHome, 'targets', targetHash, 'stacks.json');
}

/** Registra qué proyecto es dueño de cada stack y falla si otro intenta pisarlo EN ESE destino. */
async function assertStackOwnership(
  stacks: string[],
  project: string,
  target: DeployTarget,
): Promise<void> {
  const registryPath = stackOwnershipRegistryPath(target);
  let owners: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(registryPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) owners = parsed as Record<string, string>;
  } catch { /* primera vez: registro vacío */ }

  const clash = stacks.filter((s) => owners[s] !== undefined && owners[s] !== project);
  if (clash.length > 0) {
    const detail = clash.map((s) => `    ${s}  →  ya es del proyecto "${owners[s]}"`).join('\n');
    const e = new Error(
      `Estos stacks ya los desplegó otro proyecto en este destino:\n${detail}\n` +
      `  Los stacks se llaman como la app, así que comparten volúmenes: reusarlos con los\n` +
      `  secretos de "${project}" rompería los servicios (p. ej. n8n: "mismatching encryption keys").\n` +
      `  Opciones:  volvé a usar --project ${owners[clash[0]!]}   |   borrá el stack viejo:  docker stack rm ${clash.join(' ')}`);
    (e as Error & { expected?: boolean }).expected = true;
    throw e;
  }

  for (const s of stacks) owners[s] = project;
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(owners, null, 2), { mode: 0o600 });
}

/**
 * Verifica que el destino tenga Docker corriendo y Swarm activo, y falla con
 * instrucciones concretas si no. Distingue local de VPS porque la solución es
 * distinta en cada caso.
 */
async function assertDockerReady(bound: BoundTarget, target: DeployTarget): Promise<void> {
  const local = target.host === 'local';
  const where = local ? 'este equipo' : `${target.user}@${target.host}`;
  const hint = (body: string): never => {
    const e = new Error(`InventOS no puede desplegar en ${where}.\n${body}`);
    // Marca de "error esperado y accionable": el CLI lo imprime limpio, sin stack.
    (e as Error & { expected?: boolean }).expected = true;
    throw e;
  };

  const probe = await bound.exec("docker info --format '{{.Swarm.LocalNodeState}}'", { mode: 'apply' });
  if (!probe.ok) {
    const err = `${probe.stdout}\n${(probe as { stderr?: string }).stderr ?? ''}`.toLowerCase();
    if (err.includes('not found') || err.includes('command not found')) {
      return hint(local
        ? '  Docker no está instalado. En Mac: instalá Docker Desktop (https://docker.com/products/docker-desktop)\n  o por terminal:  brew install --cask docker'
        : '  Docker no está instalado en el servidor. Instalalo con:  curl -fsSL https://get.docker.com | sh');
    }
    return hint(local
      ? '  Docker está instalado pero el motor no responde — casi siempre es que Docker Desktop está cerrado.\n  Abrilo (o corré:  open -a Docker), esperá a que el ícono deje de animarse y volvé a intentar.'
      : '  El motor de Docker no responde en el servidor. Verificá:  systemctl status docker');
  }

  const state = probe.stdout.trim().replace(/'/g, '');
  if (state !== 'active') {
    return hint(`  Docker funciona, pero Docker Swarm no está activado (estado: ${state || 'inactive'}).\n  InventOS despliega con Swarm. Activalo con:  docker swarm init`);
  }
}
