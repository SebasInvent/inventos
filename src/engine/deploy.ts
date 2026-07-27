// InventOS — motor de deploy · módulo `deploy`.
//
// Responsabilidad (docs/ARCHITECTURE.md §5, fila `deploy.ts`):
//   Desplegar los stacks renderizados en ORDEN TOPOLÓGICO (el que resolvió
//   render/plan por dependencias). Por cada app:
//     1. subir el YAML renderizado al destino (scp)
//     2. `docker stack deploy -c <archivo> <name>`
//     3. esperar CONVERGENCIA (`docker service ls/ps` → réplicas 1/1)
//     4. ROLLBACK (`docker stack rm`) en caso de fallo.
//
// Seguridad de operación (§5): el modo por defecto es dry-run/plan y NO toca
// infra. El deploy real exige `--apply` + un target explícito con host y user.
// Este módulo respeta esa regla: sin `apply`, arma el resumen de lo que HARÍA
// sin abrir una sola conexión SSH.
//
// Autocontenido a propósito: el acceso remoto se expresa con la interfaz
// `RemoteExecutor` y su implementación por defecto (`createSshExecutor`) usa el
// cliente `ssh`/`scp` del sistema vía `node:child_process` (única dependencia
// externa aceptada en Fase 1, §5). Un ejecutor alterno puede inyectarse por
// `options.executor` (tests, swarm local, o el futuro `target.ts`).
//
// Node 24 corre este .ts por type-stripping nativo (sin build). Los imports de
// tipos van con `import type`; los locales llevan extensión `.ts` explícita.

import { execFile, type ExecFileException } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { basename } from 'node:path';

import type {
  DeployMode,
  DeployTarget,
  PlannedApp,
  PlanResult,
} from './types.ts';

// ===========================================================================
// Tipos públicos del módulo
// ===========================================================================

/** Resultado crudo de un proceso local (ssh/scp/etc.). Nunca lanza por exit≠0. */
export interface CommandResult {
  /** Código de salida del proceso (0 = ok). */
  code: number;
  /** Salida estándar (utf8). */
  stdout: string;
  /** Salida de error (utf8). */
  stderr: string;
}

/**
 * Capacidad de ejecutar comandos y subir archivos al destino. La abstracción
 * desacopla `deploy` del transporte concreto (ssh/scp por defecto) y permite
 * inyectar un doble en tests. Ninguno de sus métodos filtra secretos a logs.
 */
export interface RemoteExecutor {
  /** Corre `command` en el host remoto y devuelve su resultado (no lanza por exit≠0). */
  run(command: string): Promise<CommandResult>;
  /** Sube `localPath` al `remotePath` del destino (lanza si el scp falla). */
  upload(localPath: string, remotePath: string): Promise<void>;
}

/** Estado de convergencia de un servicio del stack (`docker service ls`). */
export interface ServiceStatus {
  /** Nombre completo del servicio Swarm (`<stack>_<service>`). */
  service: string;
  /** Réplicas corriendo. */
  running: number;
  /** Réplicas deseadas. */
  desired: number;
  /** `true` cuando `running == desired` y `desired > 0`. */
  converged: boolean;
}

/** Estado terminal de una app dentro del deploy. */
export type AppDeployStatus = 'converged' | 'failed' | 'skipped';

/** Resultado del deploy de una app concreta. */
export interface AppDeployResult {
  /** Id de la app. */
  id: string;
  /** Nombre legible. */
  name: string;
  /** Nombre del stack Swarm con el que se desplegó (`docker stack deploy … <stack>`). */
  stack: string;
  /** Ruta LOCAL del YAML renderizado que se subió. */
  renderedStackPath: string;
  /** Ruta REMOTA a la que se subió (o a la que se subiría en dry-run). */
  remoteStackPath: string;
  /** Estado terminal. */
  status: AppDeployStatus;
  /** Estado de convergencia por servicio (vacío en dry-run/skipped). */
  services: ServiceStatus[];
  /** Nº de sondeos de convergencia realizados. */
  attempts: number;
  /** Duración del paso en ms. */
  durationMs: number;
  /** Mensaje de error si `status === 'failed'`. */
  error?: string;
}

/** Resultado global del deploy. Es el RESUMEN que el módulo devuelve. */
export interface DeployResult {
  /** Modo con el que se corrió. */
  mode: DeployMode;
  /** `true` solo si se ejecutó un deploy real (apply); `false` en dry-run. */
  applied: boolean;
  /** `true` si todo convergió (o, en dry-run, si el plan es ejecutable). */
  ok: boolean;
  /** Proyecto (namespace local del operador). */
  project: string;
  /** Destino usado, o `null` en dry-run puro. */
  target: DeployTarget | null;
  /** Orden topológico de deploy (ids). */
  order: string[];
  /** Detalle por app, en orden de deploy. */
  apps: AppDeployResult[];
  /** Stacks que se removieron por rollback (`docker stack rm`). */
  rolledBack: string[];
  /** Avisos/recomendaciones para el operador. */
  warnings: string[];
  /** Resumen legible para imprimir en terminal. */
  summary: string;
}

/** Opciones de `deploy`. Todas tienen defaults seguros. */
export interface DeployOptions {
  /**
   * Forzar deploy real. Por defecto se deriva de `plan.mode === 'apply'`.
   * Sin esto (y sin `plan.mode === 'apply'`) el módulo hace dry-run: no toca infra.
   */
  apply?: boolean;
  /** Ejecutor remoto a usar. Por defecto se construye uno ssh/scp desde `target`. */
  executor?: RemoteExecutor;
  /** Directorio remoto donde subir los YAML. Default `.inventos/<project>` (relativo al home). */
  remoteDir?: string;
  /** Timeout total de convergencia por app, en ms. Default 180000 (3 min). */
  convergenceTimeoutMs?: number;
  /** Intervalo entre sondeos de convergencia, en ms. Default 4000. */
  pollIntervalMs?: number;
  /** Timeout por comando ssh/scp individual, en ms. Default 60000. */
  commandTimeoutMs?: number;
  /** En fallo, además de remover el stack fallido, tirar abajo TODO lo desplegado en esta corrida (orden inverso). Default false. */
  rollbackAll?: boolean;
  /** No borrar del destino los YAML subidos tras el deploy. Default false (se borran: contienen secretos). */
  keepRemoteFiles?: boolean;
  /** Deriva el nombre del stack Swarm de una app. Default: el id de la app. */
  stackName?: (app: PlannedApp, plan: PlanResult) => string;
}

// ===========================================================================
// Utilidades internas
// ===========================================================================

const DEFAULT_CONVERGENCE_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Escapa un valor para incrustarlo seguro en un comando de shell remoto. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Corre un proceso local. Resuelve SIEMPRE con {code,stdout,stderr}: un exit≠0
 * NO lanza (es información, p. ej. `docker stack deploy` fallido). Solo rechaza
 * ante fallo de spawn (binario ausente) o timeout (proceso colgado).
 */
function runProcess(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args as string[],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        // Exit code numérico → salida no-cero normal, no es una excepción.
        if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        // ENOENT (binario ausente), timeout (killed) u otro fallo de spawn.
        reject(error);
      },
    );
  });
}

/**
 * Ejecutor remoto por defecto: cliente `ssh`/`scp` del sistema. Fuerza
 * `BatchMode=yes` (falla rápido en vez de colgarse pidiendo password) y un
 * `ConnectTimeout` corto; ambos pueden sobreescribirse vía `target.sshOptions`.
 */
export function createSshExecutor(
  target: DeployTarget,
  commandTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): RemoteExecutor {
  const userHost = `${target.user}@${target.host}`;
  const port = target.port ?? 22;
  const identityArgs = target.identityFile ? ['-i', target.identityFile] : [];
  const optionArgs: string[] = [];
  for (const opt of ['BatchMode=yes', 'ConnectTimeout=10', ...(target.sshOptions ?? [])]) {
    optionArgs.push('-o', opt);
  }

  return {
    async run(command: string): Promise<CommandResult> {
      // ssh usa `-p` para el puerto.
      const args = [...identityArgs, ...optionArgs, '-p', String(port), userHost, command];
      return runProcess('ssh', args, commandTimeoutMs);
    },
    async upload(localPath: string, remotePath: string): Promise<void> {
      // scp usa `-P` (mayúscula) para el puerto.
      const args = [
        ...identityArgs,
        ...optionArgs,
        '-P',
        String(port),
        localPath,
        `${userHost}:${remotePath}`,
      ];
      const result = await runProcess('scp', args, commandTimeoutMs);
      if (result.code !== 0) {
        throw new Error(
          `scp falló (code ${result.code}) subiendo ${localPath}: ${firstLine(result.stderr) || firstLine(result.stdout)}`,
        );
      }
    },
  };
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

/** Deriva el nombre del stack Swarm de una app (id por defecto). */
function stackNameFor(app: PlannedApp, plan: PlanResult, options: DeployOptions): string {
  return options.stackName ? options.stackName(app, plan) : app.id;
}

// --- Operaciones Docker sobre el destino -----------------------------------

/** `docker stack deploy` idempotente (con prune y auth de registry para tags privados). */
async function dockerStackDeploy(
  executor: RemoteExecutor,
  stack: string,
  remoteStackPath: string,
): Promise<CommandResult> {
  const command =
    `docker stack deploy --with-registry-auth --prune ` +
    `-c ${shellQuote(remoteStackPath)} ${shellQuote(stack)}`;
  return executor.run(command);
}

/** Lee el estado de réplicas de los servicios del stack vía `docker service ls`. */
async function serviceStatuses(
  executor: RemoteExecutor,
  stack: string,
): Promise<ServiceStatus[]> {
  const command =
    `docker service ls ` +
    `--filter label=com.docker.stack.namespace=${shellQuote(stack)} ` +
    `--format '{{.Name}} {{.Replicas}}'`;
  const result = await executor.run(command);
  if (result.code !== 0) return []; // el stack quizá aún no existe → no convergido
  return result.stdout
    .split('\n')
    .map((line) => parseServiceLine(line))
    .filter((s): s is ServiceStatus => s !== null);
}

/** Parsea una línea `<name> <running>/<desired>` de `docker service ls`. */
function parseServiceLine(line: string): ServiceStatus | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(/\s+/);
  const service = parts[0];
  const replicas = parts[1] ?? '';
  const match = /^(\d+)\/(\d+)/.exec(replicas);
  if (service === undefined || match === null) return null;
  const running = Number(match[1]);
  const desired = Number(match[2]);
  return { service, running, desired, converged: desired > 0 && running >= desired };
}

/** Recolecta detalle de tareas en error vía `docker stack ps` (para enriquecer el fallo). */
async function inspectFailures(executor: RemoteExecutor, stack: string): Promise<string> {
  const command =
    `docker stack ps ${shellQuote(stack)} --no-trunc ` +
    `--format '{{.Name}}\t{{.CurrentState}}\t{{.Error}}'`;
  const result = await executor.run(command);
  if (result.code !== 0) return '';
  const problems: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const [name, state = '', error = ''] = line.split('\t');
    if (name === undefined || name.trim() === '') continue;
    if (error.trim().length > 0 || /rejected|failed/i.test(state)) {
      problems.push(`${name.trim()} [${state.trim()}] ${error.trim()}`.trim());
    }
  }
  return problems.slice(0, 5).join(' ; ');
}

interface ConvergenceOutcome {
  converged: boolean;
  statuses: ServiceStatus[];
  attempts: number;
  detail?: string;
}

/** Sondea hasta que todos los servicios del stack alcancen réplicas 1/1 o venza el timeout. */
async function waitForConvergence(
  executor: RemoteExecutor,
  stack: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<ConvergenceOutcome> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let statuses: ServiceStatus[] = [];
  while (Date.now() < deadline) {
    attempts += 1;
    statuses = await serviceStatuses(executor, stack);
    if (statuses.length > 0 && statuses.every((s) => s.converged)) {
      return { converged: true, statuses, attempts };
    }
    await sleep(pollIntervalMs);
  }
  const detail = await inspectFailures(executor, stack);
  return { converged: false, statuses, attempts, detail };
}

/** `docker stack rm` best-effort (rollback). No lanza: registra en `warnings` el llamador. */
async function safeStackRm(executor: RemoteExecutor, stack: string): Promise<string | null> {
  try {
    const result = await executor.run(`docker stack rm ${shellQuote(stack)}`);
    if (result.code !== 0) {
      return `rollback de '${stack}' devolvió code ${result.code}: ${firstLine(result.stderr)}`;
    }
    return null;
  } catch (err) {
    return `rollback de '${stack}' falló: ${errorMessage(err)}`;
  }
}

/** Borra best-effort un archivo remoto (los YAML contienen secretos). */
async function safeRemoteRemove(executor: RemoteExecutor, remotePath: string): Promise<void> {
  try {
    await executor.run(`rm -f ${shellQuote(remotePath)}`);
  } catch {
    // best-effort: no bloquea el resultado del deploy.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// API pública: deploy(target, plan, options?)
// ===========================================================================

/**
 * Despliega el plan en el destino, en orden topológico, con convergencia y
 * rollback en fallo. Devuelve el resumen (`DeployResult`).
 *
 * Seguridad: por defecto es dry-run (no toca infra). El deploy real requiere
 * `plan.mode === 'apply'` (u `options.apply === true`) MÁS un `target` explícito
 * con host y user. `target` puede ser `null` para un dry-run puro sin destino.
 *
 * Nota de firma: la arquitectura es Swarm de un nodo (§1), así que el destino es
 * uno solo (`target`, singular).
 */
export async function deploy(
  target: DeployTarget | null,
  plan: PlanResult,
  options: DeployOptions = {},
): Promise<DeployResult> {
  const apply = options.apply ?? plan.mode === 'apply';
  const remoteDir = options.remoteDir ?? `.inventos/${plan.project}`;
  const appsById = new Map<string, PlannedApp>(plan.apps.map((a) => [a.id, a]));
  const warnings: string[] = [];

  // --- DRY-RUN: no se abre ninguna conexión. Se describe lo que se HARÍA. ---
  if (!apply) {
    const apps: AppDeployResult[] = plan.order.map((id) => {
      const app = appsById.get(id);
      const remoteStackPath = app ? `${remoteDir}/${basename(app.renderedStackPath)}` : '';
      return {
        id,
        name: app?.name ?? id,
        stack: app ? stackNameFor(app, plan, options) : id,
        renderedStackPath: app?.renderedStackPath ?? '',
        remoteStackPath,
        status: 'skipped',
        services: [],
        attempts: 0,
        durationMs: 0,
      };
    });
    warnings.push('Modo dry-run: no se ejecutó ningún cambio. Usá --apply + target para desplegar de verdad.');
    const result: DeployResult = {
      mode: plan.mode,
      applied: false,
      ok: true,
      project: plan.project,
      target: target ?? plan.target,
      order: plan.order,
      apps,
      rolledBack: [],
      warnings,
      summary: '',
    };
    result.summary = buildSummary(result);
    return result;
  }

  // --- APPLY: exige target explícito (§5, seguridad de operación). ---
  if (target === null || !target.host || !target.user) {
    throw new Error('deploy --apply requiere un target explícito con host y user.');
  }

  const executor = options.executor ?? createSshExecutor(target, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const convergenceTimeoutMs = options.convergenceTimeoutMs ?? DEFAULT_CONVERGENCE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Directorio remoto para los YAML (relativo al home del usuario SSH).
  await executor.run(`mkdir -p ${shellQuote(remoteDir)}`);

  const apps: AppDeployResult[] = [];
  const rolledBack: string[] = [];
  const deployedStacks: string[] = []; // convergidos en esta corrida (para rollbackAll)
  let aborted = false;

  for (const id of plan.order) {
    const app = appsById.get(id);
    if (app === undefined) {
      warnings.push(`El orden del plan incluye '${id}' pero no hay una app para ese id; se omite.`);
      continue;
    }
    const stack = stackNameFor(app, plan, options);
    const remoteStackPath = `${remoteDir}/${basename(app.renderedStackPath)}`;

    // Si una app previa falló, el resto se omite (deploy topológico abortado).
    if (aborted) {
      apps.push({
        id, name: app.name, stack,
        renderedStackPath: app.renderedStackPath, remoteStackPath,
        status: 'skipped', services: [], attempts: 0, durationMs: 0,
        error: 'Omitido: el deploy se abortó por un fallo anterior.',
      });
      continue;
    }

    const started = Date.now();
    let uploaded = false;
    try {
      await executor.upload(app.renderedStackPath, remoteStackPath);
      uploaded = true;

      const deployed = await dockerStackDeploy(executor, stack, remoteStackPath);
      if (deployed.code !== 0) {
        throw new Error(
          `docker stack deploy devolvió code ${deployed.code}: ${firstLine(deployed.stderr) || firstLine(deployed.stdout)}`,
        );
      }

      const outcome = await waitForConvergence(executor, stack, convergenceTimeoutMs, pollIntervalMs);
      if (!outcome.converged) {
        const detail = outcome.detail && outcome.detail.length > 0 ? ` Detalle: ${outcome.detail}` : '';
        throw new Error(
          `'${stack}' no convergió en ${convergenceTimeoutMs} ms (réplicas incompletas).${detail}`,
        );
      }

      deployedStacks.push(stack);
      apps.push({
        id, name: app.name, stack,
        renderedStackPath: app.renderedStackPath, remoteStackPath,
        status: 'converged', services: outcome.statuses, attempts: outcome.attempts,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      aborted = true;
      const message = errorMessage(err);

      // Rollback del stack fallido.
      const rmWarn = await safeStackRm(executor, stack);
      if (rmWarn) warnings.push(rmWarn);
      else rolledBack.push(stack);

      // Rollback total opcional: tirar abajo lo ya desplegado, en orden inverso.
      if (options.rollbackAll) {
        for (const prior of [...deployedStacks].reverse()) {
          const w = await safeStackRm(executor, prior);
          if (w) warnings.push(w);
          else rolledBack.push(prior);
        }
        deployedStacks.length = 0;
      }

      apps.push({
        id, name: app.name, stack,
        renderedStackPath: app.renderedStackPath, remoteStackPath,
        status: 'failed', services: [], attempts: 0,
        durationMs: Date.now() - started, error: message,
      });
    } finally {
      // Los YAML renderizados contienen secretos: se borran del destino salvo opt-out.
      if (uploaded && !options.keepRemoteFiles) {
        await safeRemoteRemove(executor, remoteStackPath);
      }
    }
  }

  const ok = !aborted && apps.length > 0 && apps.every((a) => a.status === 'converged');
  const result: DeployResult = {
    mode: 'apply',
    applied: true,
    ok,
    project: plan.project,
    target,
    order: plan.order,
    apps,
    rolledBack,
    warnings,
    summary: '',
  };
  result.summary = buildSummary(result);
  return result;
}

// ===========================================================================
// Resumen legible (español, sin emojis)
// ===========================================================================

function buildSummary(result: DeployResult): string {
  const lines: string[] = [];
  const modeLabel = result.applied ? 'apply' : 'dry-run';
  lines.push(`InventOS deploy — proyecto '${result.project}' (${modeLabel})`);

  if (result.target) {
    const port = result.target.port ?? 22;
    lines.push(`Destino: ${result.target.user}@${result.target.host}:${port}`);
  } else {
    lines.push('Destino: (sin target — dry-run puro)');
  }

  lines.push(`Orden: ${result.order.length > 0 ? result.order.join(' -> ') : '(vacío)'}`);

  for (const app of result.apps) {
    lines.push(formatAppLine(app));
  }

  if (result.rolledBack.length > 0) {
    lines.push(`Rollback aplicado a: ${result.rolledBack.join(', ')}`);
  }
  for (const warning of result.warnings) {
    lines.push(`Aviso: ${warning}`);
  }

  if (result.applied) {
    lines.push(result.ok ? 'Resultado: OK — todos los stacks convergieron.' : 'Resultado: FALLO — el deploy se abortó (ver arriba).');
  } else {
    lines.push('Resultado: plan listo — nada se ejecutó. Revisá y corré con --apply.');
  }

  return lines.join('\n');
}

function formatAppLine(app: AppDeployResult): string {
  const marker = app.status === 'converged' ? '[OK]   ' : app.status === 'failed' ? '[FALLO]' : '[--]   ';
  if (app.status === 'converged') {
    const svc = app.services.map((s) => `${s.service} ${s.running}/${s.desired}`).join(', ');
    const secs = (app.durationMs / 1000).toFixed(1);
    return `${marker} ${app.id} (${svc || 'sin servicios reportados'}) ${secs}s`;
  }
  if (app.status === 'failed') {
    return `${marker} ${app.id} — ${app.error ?? 'fallo desconocido'}`;
  }
  return `${marker} ${app.id} — ${app.error ?? 'no ejecutado'}`;
}
