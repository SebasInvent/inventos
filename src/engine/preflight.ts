// InventOS — motor de deploy · preflight.
//
// Verifica (y, con --apply, remedia) que un target esté listo para desplegar
// stacks de Swarm. Ref: docs/ARCHITECTURE.md §5. Chequeos sobre el target:
//   1. Docker instalado y con daemon operativo (instala/arranca si falta).
//   2. Docker Swarm activo (init si no).
//   3. Red overlay `${NETWORK}` existe (crea attachable + cifrada si no).
//   4. DNS: cada subdominio tiene A-record → IP del target (dns.resolve4; solo
//      avisa, nunca remedia — el registro DNS vive fuera del server).
//   5. Puertos 80/443 libres para el ingress de Traefik.
//
// Doctrina de operación (§5): el modo por defecto es `plan` (dry-run). En `plan`
// solo se corren sondas de LECTURA (docker --version/info, ss, network inspect):
// nunca se toca la infra. Las remediaciones (instalar, swarm init, crear red,
// arrancar daemon) SOLO se ejecutan con `mode: 'apply'`. Node 24 borra los tipos
// por type-stripping nativo (sin build).

import { isIP } from 'node:net';
import { promises as dnsPromises } from 'node:dns';

import type { DeployMode, DeployTarget } from './types.ts';

// ===========================================================================
// Ejecución remota (contrato que target.ts implementará vía ssh/child_process)
// ===========================================================================

/** Resultado de correr un comando en el target. */
export interface ExecResult {
  /** Código de salida del comando (0 = éxito). */
  code: number;
  /** Salida estándar capturada. */
  stdout: string;
  /** Salida de error capturada. */
  stderr: string;
}

/**
 * Ejecutor de comandos en el target. `preflight` solo necesita esta capacidad;
 * `target.ts` la implementa envolviendo el cliente `ssh` del sistema. Inyectarlo
 * mantiene a `preflight` desacoplado y testeable (se puede pasar un doble).
 */
export interface RemoteExec {
  /** Corre `command` en el target y resuelve con su resultado. */
  run(command: string): Promise<ExecResult>;
}

// ===========================================================================
// Checklist
// ===========================================================================

/**
 * Estado de un chequeo:
 * - `pass`      ya estaba bien.
 * - `fail`      bloqueante: no está bien y no se pudo (o no se debe) remediar.
 * - `warn`      no bloqueante: aviso para el operador (p. ej. DNS pendiente).
 * - `fixed`     estaba mal y se remedió en este `apply`.
 * - `would-fix` (solo en `plan`) se remediaría con `--apply`.
 * - `skipped`   no se pudo evaluar (dependía de un paso previo que falta).
 */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'fixed' | 'would-fix' | 'skipped';

/** Un ítem del checklist de preflight. */
export interface PreflightCheck {
  /** Identificador estable (p. ej. `docker`, `swarm`, `port:80`, `dns:db.x.co`). */
  id: string;
  /** Título legible. */
  title: string;
  /** Estado resultante. */
  status: CheckStatus;
  /** Mensaje para el operador. */
  detail: string;
  /** Comando/acción que lo arreglaría (se muestra en el plan). */
  remediation?: string;
}

/** Contexto de un preflight sobre un target concreto. */
export interface PreflightContext {
  /** `plan` (default, solo lectura) o `apply` (remedia). */
  mode: DeployMode;
  /** Nombre de la red overlay compartida (`${NETWORK}`, p. ej. `inventnet`). */
  network: string;
  /** Dominio base (apex) con el que se construyen los subdominios. */
  domain: string;
  /** Subdominios a verificar por DNS (labels, `@`/apex, o FQDN ya completo). */
  subdomains: string[];
  /** Ejecutor de comandos en el target. */
  exec: RemoteExec;
  /** Resolver A-records; inyectable para tests (default: node:dns.resolve4). */
  resolve4?: (hostname: string) => Promise<string[]>;
}

/** Resultado completo de un preflight. */
export interface PreflightResult {
  /** Target evaluado. */
  target: DeployTarget;
  /** Modo con el que se corrió. */
  mode: DeployMode;
  /** `true` si ningún chequeo quedó en `fail`. */
  ok: boolean;
  /** `true` si se pudo ejecutar comandos en el target. */
  reachable: boolean;
  /** Todos los chequeos, en orden. */
  checks: PreflightCheck[];
  /** Detalles de los chequeos en `warn` (aviso al operador). */
  warnings: string[];
  /** Resumen legible para imprimir en terminal. */
  summary: string;
}

// ===========================================================================
// API principal
// ===========================================================================

/**
 * Corre el preflight sobre `target`. En `plan` solo lee estado y reporta qué se
 * haría; en `apply` remedia lo remediable (Docker, Swarm, red overlay). El DNS
 * y los puertos ocupados nunca se remedian (dependen de infra externa/host).
 */
export async function preflight(
  target: DeployTarget,
  ctx: PreflightContext,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];

  // 1. Docker (incluye conectividad al target y estado del daemon).
  const docker = await ensureDocker(target, ctx);
  checks.push(...docker.checks);

  // 2. Swarm, red overlay y puertos — requieren un Docker operativo.
  if (docker.dockerUsable) {
    checks.push(await ensureSwarm(target, ctx));
    checks.push(await ensureNetwork(ctx));
    checks.push(...(await checkPorts(ctx)));
  } else {
    const reason = docker.reachable
      ? 'Requiere un Docker operativo (se resolvería primero).'
      : 'Target inaccesible (no se pudo ejecutar comandos).';
    checks.push(skipped('swarm', 'Docker Swarm', reason));
    checks.push(skipped('network', `Red overlay ${ctx.network}`, reason));
    checks.push(skipped('port:80', 'Puerto 80', reason));
    checks.push(skipped('port:443', 'Puerto 443', reason));
  }

  // 3. DNS — chequeo LOCAL (no depende de que el target sea accesible).
  checks.push(...(await checkDns(target, ctx)));

  const warnings = checks
    .filter((c) => c.status === 'warn')
    .map((c) => `${c.title}: ${c.detail}`);
  const ok = checks.every((c) => c.status !== 'fail');
  const summary = renderSummary(target, ctx, checks, ok);

  return { target, mode: ctx.mode, ok, reachable: docker.reachable, checks, warnings, summary };
}

// ===========================================================================
// Chequeos individuales
// ===========================================================================

interface DockerState {
  checks: PreflightCheck[];
  /** `true` si se pudo ejecutar algo en el target. */
  reachable: boolean;
  /** `true` si Docker está instalado y el daemon responde. */
  dockerUsable: boolean;
}

/** Docker instalado + daemon operativo; instala/arranca en `apply` si falta. */
async function ensureDocker(target: DeployTarget, ctx: PreflightContext): Promise<DockerState> {
  const { exec, mode } = ctx;

  const version = await safeRun(exec, 'docker --version');
  if (version.errored) {
    return {
      reachable: false,
      dockerUsable: false,
      checks: [{
        id: 'connectivity',
        title: 'Conexión al target',
        status: 'fail',
        detail: `No se pudo ejecutar comandos en ${target.user}@${target.host}: ${version.stderr}`,
      }],
    };
  }

  // Docker no instalado.
  if (version.code !== 0) {
    const remediation = 'curl -fsSL https://get.docker.com | sh';
    if (mode !== 'apply') {
      return {
        reachable: true,
        dockerUsable: false,
        checks: [{
          id: 'docker',
          title: 'Docker',
          status: 'would-fix',
          detail: 'Docker no está instalado; se instalaría con el script oficial get.docker.com.',
          remediation,
        }],
      };
    }
    await safeRun(exec, remediation);
    const recheck = await daemonVersion(exec);
    if (recheck !== null) {
      return {
        reachable: true,
        dockerUsable: true,
        checks: [{
          id: 'docker',
          title: 'Docker',
          status: 'fixed',
          detail: `Docker instalado y operativo (v${recheck}).`,
          remediation,
        }],
      };
    }
    return {
      reachable: true,
      dockerUsable: false,
      checks: [{
        id: 'docker',
        title: 'Docker',
        status: 'fail',
        detail: 'Se ejecutó la instalación de Docker pero el daemon no quedó operativo.',
      }],
    };
  }

  // Docker instalado: ¿daemon operativo?
  const serverVersion = await daemonVersion(exec);
  if (serverVersion !== null) {
    return {
      reachable: true,
      dockerUsable: true,
      checks: [{ id: 'docker', title: 'Docker', status: 'pass', detail: `Docker operativo (v${serverVersion}).` }],
    };
  }

  // Instalado pero el daemon no responde.
  const remediation = 'systemctl enable --now docker';
  if (mode !== 'apply') {
    return {
      reachable: true,
      dockerUsable: false,
      checks: [{
        id: 'docker',
        title: 'Docker',
        status: 'would-fix',
        detail: 'Docker instalado pero el daemon no responde; se arrancaría el servicio.',
        remediation,
      }],
    };
  }
  await safeRun(exec, remediation);
  const afterStart = await daemonVersion(exec);
  if (afterStart !== null) {
    return {
      reachable: true,
      dockerUsable: true,
      checks: [{ id: 'docker', title: 'Docker', status: 'fixed', detail: `Daemon de Docker arrancado (v${afterStart}).`, remediation }],
    };
  }
  return {
    reachable: true,
    dockerUsable: false,
    checks: [{ id: 'docker', title: 'Docker', status: 'fail', detail: 'El daemon de Docker no respondió tras intentar arrancarlo.' }],
  };
}

/** Swarm activo; `docker swarm init` en `apply` si no. */
async function ensureSwarm(target: DeployTarget, ctx: PreflightContext): Promise<PreflightCheck> {
  const { exec, mode } = ctx;
  const state = await safeRun(exec, 'docker info --format "{{.Swarm.LocalNodeState}}"');
  const value = state.stdout.trim();
  if (state.code === 0 && value === 'active') {
    return { id: 'swarm', title: 'Docker Swarm', status: 'pass', detail: 'Swarm activo (nodo manager).' };
  }

  // Anuncia la IP del target cuando `host` es una IPv4 (evita ambigüedad multi-IP).
  const advertise = isIP(target.host) === 4 ? ` --advertise-addr ${target.host}` : '';
  const remediation = `docker swarm init${advertise}`;
  if (mode !== 'apply') {
    return {
      id: 'swarm',
      title: 'Docker Swarm',
      status: 'would-fix',
      detail: `Swarm inactivo (estado: ${value || 'desconocido'}); se inicializaría.`,
      remediation,
    };
  }
  const init = await safeRun(exec, remediation);
  if (init.code === 0) {
    return { id: 'swarm', title: 'Docker Swarm', status: 'fixed', detail: 'Swarm inicializado (nodo manager).', remediation };
  }
  return { id: 'swarm', title: 'Docker Swarm', status: 'fail', detail: `No se pudo inicializar Swarm: ${init.stderr.trim()}` };
}

/** Red overlay `${NETWORK}` existe y es overlay; la crea en `apply` si no. */
async function ensureNetwork(ctx: PreflightContext): Promise<PreflightCheck> {
  const { exec, mode, network } = ctx;
  const title = `Red overlay ${network}`;
  const quoted = shQuote(network);
  const inspect = await safeRun(exec, `docker network inspect ${quoted} --format "{{.Driver}}"`);
  if (inspect.code === 0) {
    const driver = inspect.stdout.trim();
    if (driver === 'overlay') {
      return { id: 'network', title, status: 'pass', detail: `Existe y es overlay.` };
    }
    return {
      id: 'network',
      title,
      status: 'fail',
      detail: `La red ${network} existe pero su driver es "${driver}", no overlay; renómbrala o recréala.`,
    };
  }

  const remediation = `docker network create --driver overlay --attachable --opt encrypted ${quoted}`;
  if (mode !== 'apply') {
    return {
      id: 'network',
      title,
      status: 'would-fix',
      detail: `La red overlay ${network} no existe; se crearía (attachable, cifrada).`,
      remediation,
    };
  }
  const create = await safeRun(exec, remediation);
  if (create.code === 0) {
    return { id: 'network', title, status: 'fixed', detail: `Red overlay ${network} creada (attachable, cifrada).`, remediation };
  }
  return { id: 'network', title, status: 'fail', detail: `No se pudo crear la red ${network}: ${create.stderr.trim()}` };
}

/** Puertos 80 y 443 libres para el ingress de Traefik (no remediable). */
async function checkPorts(ctx: PreflightContext): Promise<PreflightCheck[]> {
  const { exec } = ctx;
  // Un solo listado de puertos publicados por contenedores, para clasificar la ocupación.
  const published = await safeRun(exec, "docker ps --format '{{.Ports}}'");
  const publishedText = published.code === 0 ? published.stdout : '';
  const checks: PreflightCheck[] = [];
  for (const port of [80, 443] as const) {
    checks.push(await checkPort(exec, port, publishedText));
  }
  return checks;
}

async function checkPort(exec: RemoteExec, port: number, publishedText: string): Promise<PreflightCheck> {
  const id = `port:${port}`;
  const title = `Puerto ${port}`;
  const listen = await safeRun(exec, `ss -H -ltn "sport = :${port}"`);
  if (listen.code !== 0) {
    return {
      id,
      title,
      status: 'warn',
      detail: `No se pudo verificar el puerto ${port} (¿'ss' disponible en el target?).`,
    };
  }
  if (listen.stdout.trim() === '') {
    return { id, title, status: 'pass', detail: `Puerto ${port} libre.` };
  }
  // Ocupado: ¿lo publica un contenedor (posible Traefik nuestro) o un proceso del host?
  const byContainer = new RegExp(`:${port}->`).test(publishedText);
  if (byContainer) {
    return {
      id,
      title,
      status: 'warn',
      detail: `Puerto ${port} ya publicado por un contenedor (posible Traefik existente); reconciliar antes del deploy.`,
    };
  }
  return {
    id,
    title,
    status: 'fail',
    detail: `Puerto ${port} ocupado por un proceso del host; libéralo para el ingress de Traefik.`,
  };
}

/** DNS: cada subdominio (A-record) debe apuntar a la IP del target. Solo avisa. */
async function checkDns(target: DeployTarget, ctx: PreflightContext): Promise<PreflightCheck[]> {
  const resolve4 = ctx.resolve4 ?? ((hostname: string) => dnsPromises.resolve4(hostname));
  const hostnames = buildHostnames(ctx.subdomains, ctx.domain);
  if (hostnames.length === 0) return [];
  const expected = await expectedTargetIps(target, resolve4);
  const checks: PreflightCheck[] = [];
  for (const host of hostnames) {
    checks.push(await checkOneDns(host, expected, resolve4));
  }
  return checks;
}

async function checkOneDns(
  host: string,
  expected: string[],
  resolve4: (hostname: string) => Promise<string[]>,
): Promise<PreflightCheck> {
  const id = `dns:${host}`;
  const title = `DNS ${host}`;
  const targetHint = expected[0] ?? 'la IP del target';

  let records: string[];
  try {
    records = await resolve4(host);
  } catch (err) {
    const code = errCode(err);
    return {
      id,
      title,
      status: 'warn',
      detail: `Sin registro A para ${host}${code ? ` (${code})` : ''}; crea el A-record → ${targetHint} antes de emitir TLS.`,
    };
  }

  if (records.length === 0) {
    return { id, title, status: 'warn', detail: `Sin registro A para ${host}; crea el A-record → ${targetHint}.` };
  }
  if (expected.length === 0) {
    return {
      id,
      title,
      status: 'warn',
      detail: `No se pudo determinar la IP del target para comparar; ${host} → ${records.join(', ')}.`,
    };
  }
  if (records.some((r) => expected.includes(r))) {
    return { id, title, status: 'pass', detail: `${host} → ${records.join(', ')} (apunta al target).` };
  }
  return {
    id,
    title,
    status: 'warn',
    detail: `${host} → ${records.join(', ')} no coincide con el target (${expected.join(', ')}); el TLS HTTP-01 fallará hasta corregir el A-record.`,
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Construye los FQDN a verificar a partir de subdominios y dominio base.
 * Acepta labels (`db`), apex (`@`) y FQDN ya completos (`db.dominio.co`). Dedup.
 */
export function buildHostnames(subdomains: string[], domain: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subdomains) {
    const label = raw.trim();
    if (label === '') continue;
    let host: string;
    if (label === '@' || label === domain) {
      host = domain;
    } else if (label.endsWith(`.${domain}`)) {
      host = label;
    } else {
      host = `${label}.${domain}`;
    }
    if (!seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

/** IPs esperadas del target: la propia si `host` es IPv4, o sus A-records. */
async function expectedTargetIps(
  target: DeployTarget,
  resolve4: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  if (isIP(target.host) === 4) return [target.host];
  try {
    return await resolve4(target.host);
  } catch {
    return [];
  }
}

/** Versión del daemon (`docker info`) o `null` si no responde. */
async function daemonVersion(exec: RemoteExec): Promise<string | null> {
  const info = await safeRun(exec, 'docker info --format "{{.ServerVersion}}"');
  const value = info.stdout.trim();
  return info.code === 0 && value !== '' ? value : null;
}

/** Corre un comando capturando errores de transporte (ssh caído, etc.). */
async function safeRun(exec: RemoteExec, command: string): Promise<ExecResult & { errored: boolean }> {
  try {
    const result = await exec.run(command);
    return { ...result, errored: false };
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err), errored: true };
  }
}

/** Chequeo omitido por falta de un prerrequisito. */
function skipped(id: string, title: string, detail: string): PreflightCheck {
  return { id, title, status: 'skipped', detail };
}

/** Cita un valor para uso seguro en shell POSIX (comillas simples). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Código de error (`ENOTFOUND`, `ENODATA`…) de un error de node:dns, si lo hay. */
function errCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const { code } = err as { code: unknown };
    return typeof code === 'string' ? code : '';
  }
  return '';
}

/** Resumen legible del checklist para imprimir en terminal (sin emojis). */
function renderSummary(
  target: DeployTarget,
  ctx: PreflightContext,
  checks: PreflightCheck[],
  ok: boolean,
): string {
  const marker: Record<CheckStatus, string> = {
    pass: '[ok]  ',
    fail: '[x]   ',
    warn: '[!]   ',
    fixed: '[fix] ',
    'would-fix': '[plan]',
    skipped: '[--]  ',
  };
  const lines: string[] = [];
  lines.push(`Preflight · ${target.user}@${target.host} · modo ${ctx.mode}`);
  lines.push('-'.repeat(60));
  for (const c of checks) {
    lines.push(`${marker[c.status]} ${c.title} — ${c.detail}`);
    if (c.remediation && ctx.mode !== 'apply' && c.status === 'would-fix') {
      lines.push(`         acción: ${c.remediation}`);
    }
  }
  lines.push('-'.repeat(60));
  if (ok) {
    lines.push(
      ctx.mode === 'apply'
        ? 'Preflight OK: el target está listo para el deploy.'
        : 'Preflight OK (plan): con --apply se remediaría lo pendiente y quedaría listo.',
    );
  } else {
    lines.push('Preflight con bloqueos: resuelve los [x] antes de continuar.');
  }
  return lines.join('\n');
}
