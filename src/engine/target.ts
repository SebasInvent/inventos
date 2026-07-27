// InventOS — motor de deploy · módulo `target`.
//
// Conexión al VPS DESTINO vía el cliente `ssh`/`scp` del sistema (node:child_process):
//   - `exec(target, cmd)`   : corre un comando en el server remoto.
//   - `upload(t, l, r)`     : sube un archivo local (scp) al server remoto.
//   - `uploadContent(t,...)`: escribe contenido en el server sin tocar disco local
//                             (pipe por stdin → `cat > file`), útil para YAML con
//                             secretos interpolados (evita dejar copias sueltas).
//
// Doctrina de seguridad (docs/ARCHITECTURE.md §5):
//   - El modo POR DEFECTO es `plan` (dry-run): NO muta el server. Solo con
//     `mode: 'apply'` se ejecuta el deploy real. Los comandos solo-lectura
//     (`readOnly: true`) sí corren en `plan` para poder sondear el destino.
//   - Target explícito SIEMPRE: sin host/user no se hace nada. Nunca toca la
//     infra propia del operador de forma implícita.
//   - Auth por llave (`identityFile`) o por contraseña (`password` → `sshpass -e`,
//     inyectada por env `SSHPASS`, jamás por argv: no aparece en `ps` ni en logs).
//
// Única dependencia externa aceptada en Fase 1: los binarios `ssh`/`scp` (y
// `sshpass` si se usa contraseña). El resto es stdlib de Node. Node 24 borra los
// tipos por type-stripping nativo (sin build).

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

import type { DeployMode, DeployTarget } from './types.ts';

/** Timeout por defecto de un proceso ssh/scp (ms). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Timeout de establecimiento de conexión SSH por defecto (segundos). */
const DEFAULT_CONNECT_TIMEOUT_S = 10;

// ===========================================================================
// Tipos públicos
// ===========================================================================

/** Opciones de una operación remota (exec/upload). */
export interface RemoteOptions {
  /**
   * Modo de operación. `plan` (default) = dry-run, no muta el server.
   * `apply` = ejecuta de verdad. El deploy real exige `apply`.
   */
  mode?: DeployMode;
  /**
   * Marca el comando como solo-lectura (sonda). Un `readOnly` se ejecuta incluso
   * en `plan` porque no cambia el estado del server (p. ej. `docker info`,
   * `docker service ls`). Ignorado por `upload`/`uploadContent` (siempre mutan).
   */
  readOnly?: boolean;
  /** Timeout del proceso en ms (default 120000). 0 = sin timeout. */
  timeoutMs?: number;
  /** Timeout de conexión SSH en segundos (`-o ConnectTimeout`, default 10). */
  connectTimeoutSeconds?: number;
  /** Datos para el stdin del comando remoto (p. ej. YAML a `docker stack deploy -c -`). */
  input?: string;
}

/** Resultado (o resumen dry-run) de una operación remota. */
export interface RemoteResult {
  /** Modo con el que se corrió. */
  mode: DeployMode;
  /** Ejecutable invocado: `ssh`, `scp` o `sshpass`. */
  file: string;
  /** Argumentos del ejecutable. SIN secretos: la contraseña viaja por env. */
  argv: string[];
  /** Comando legible para logs/plan (sin secretos). */
  printable: string;
  /** `true` si de verdad se ejecutó; `false` en dry-run/plan. */
  executed: boolean;
  /** Código de salida del proceso (`null` si no se ejecutó o murió por señal). */
  exitCode: number | null;
  /**
   * `true` si la operación no falló. Cuando se ejecutó: código 0. Cuando se
   * omitió por dry-run: `true` (planificar no es un fallo).
   */
  ok: boolean;
  /** stdout capturado (vacío si no se ejecutó). */
  stdout: string;
  /** stderr capturado (vacío si no se ejecutó). */
  stderr: string;
  /** `true` si se abortó por timeout. */
  timedOut: boolean;
}

/**
 * Target ya "atado": expone `exec`/`upload`/`uploadContent` sin repetir el
 * `DeployTarget` en cada llamada. Los defaults (p. ej. `mode`) se fusionan con
 * las opciones puntuales de cada operación.
 */
export interface BoundTarget {
  /** El destino subyacente. */
  readonly target: DeployTarget;
  exec(command: string, options?: RemoteOptions): Promise<RemoteResult>;
  upload(localPath: string, remotePath: string, options?: RemoteOptions): Promise<RemoteResult>;
  uploadContent(content: string, remotePath: string, options?: RemoteOptions): Promise<RemoteResult>;
  /** Descripción legible del destino (sin filtrar la contraseña). */
  describe(): string;
}

// ===========================================================================
// API pública
// ===========================================================================

/**
 * Valida que el destino sea explícito y utilizable. Lanza si falta host o user.
 * Enforcement de la regla "nunca la infra propia del operador de forma implícita".
 */
export function assertTarget(target: DeployTarget): void {
  if (typeof target !== 'object' || target === null) {
    throw new Error('Target de deploy inválido: se esperaba un objeto DeployTarget.');
  }
  if (target.host.trim() === '') {
    throw new Error(
      'Target de deploy sin host: define el VPS destino de forma explícita (nunca la infra propia del operador).',
    );
  }
  if (isLocal(target)) return; // El target `local` corre en la máquina actual: no necesita user SSH.
  if (target.user.trim() === '') {
    throw new Error('Target de deploy sin user: define el usuario SSH del VPS destino.');
  }
}

/**
 * `true` si el target es LOCAL: los comandos corren en esta máquina vía shell
 * (child_process), no por SSH. Útil para emular/probar contra un Docker Swarm
 * local antes de desplegar a un VPS. Se activa con host `local`.
 */
export function isLocal(target: DeployTarget): boolean {
  return target.host === 'local';
}

/** Descripción legible del destino, indicando el método de auth (sin valores sensibles). */
export function describeTarget(target: DeployTarget): string {
  if (isLocal(target)) return 'local (Docker en esta máquina, sin SSH)';
  const port = target.port ?? 22;
  const auth = usesPassword(target) ? 'password' : target.identityFile ? 'key' : 'agent/default';
  return `${target.user}@${target.host}:${port} (${auth})`;
}

/**
 * Corre un comando en el server remoto vía `ssh`. En `plan` (default) solo
 * ejecuta si `readOnly` es `true`; si no, devuelve el resumen de lo que HARÍA.
 */
export async function exec(
  target: DeployTarget,
  command: string,
  options: RemoteOptions = {},
): Promise<RemoteResult> {
  assertTarget(target);
  const mode = options.mode ?? 'plan';

  // Target LOCAL: corre el comando en esta máquina vía `sh -c` (sin SSH).
  if (isLocal(target)) {
    const printable = `local $ ${command}`;
    const shouldRunLocal = mode === 'apply' || options.readOnly === true;
    if (!shouldRunLocal) return planned(mode, 'sh', ['-c', command], printable);
    const runLocal = await safeSpawn(
      'sh', ['-c', command],
      { input: options.input, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: process.env },
      false,
    );
    return executed(mode, 'sh', ['-c', command], printable, runLocal);
  }

  const withPass = usesPassword(target);
  const connectTimeout = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_S;

  const sshArgs = [...sshOptions(target, withPass, connectTimeout), destination(target), command];
  const { file, argv } = wrapAuth('ssh', sshArgs, withPass);
  const printable = printableCommand(file, argv);

  const shouldRun = mode === 'apply' || options.readOnly === true;
  if (!shouldRun) return planned(mode, file, argv, printable);

  const run = await safeSpawn(
    file,
    argv,
    { input: options.input, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: envFor(target, withPass) },
    withPass,
  );
  return executed(mode, file, argv, printable, run);
}

/**
 * Sube un archivo local al server remoto vía `scp`. Siempre muta el destino, así
 * que solo corre en `mode: 'apply'`; en `plan` devuelve el resumen.
 */
export async function upload(
  target: DeployTarget,
  localPath: string,
  remotePath: string,
  options: RemoteOptions = {},
): Promise<RemoteResult> {
  assertTarget(target);
  const mode = options.mode ?? 'plan';

  // Target LOCAL: copia el archivo en esta máquina (mkdir -p + cp), sin scp.
  if (isLocal(target)) {
    const cmd = `mkdir -p "$(dirname ${posixQuote(remotePath)})" && cp ${posixQuote(localPath)} ${posixQuote(remotePath)}`;
    const printable = `local $ cp ${localPath} ${remotePath}`;
    if (mode !== 'apply') return planned(mode, 'sh', ['-c', cmd], printable);
    await ensureLocalFile(localPath);
    const runLocal = await safeSpawn('sh', ['-c', cmd], { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: process.env }, false);
    return executed(mode, 'sh', ['-c', cmd], printable, runLocal);
  }

  const withPass = usesPassword(target);
  const connectTimeout = options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_S;

  const scpArgs = [...scpOptions(target, withPass, connectTimeout), localPath, `${destination(target)}:${remotePath}`];
  const { file, argv } = wrapAuth('scp', scpArgs, withPass);
  const printable = printableCommand(file, argv);

  if (mode !== 'apply') return planned(mode, file, argv, printable);

  await ensureLocalFile(localPath);
  const run = await safeSpawn(
    file,
    argv,
    { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, env: envFor(target, withPass) },
    withPass,
  );
  return executed(mode, file, argv, printable, run);
}

/**
 * Escribe `content` en `remotePath` del server SIN pasar por un archivo local:
 * abre `ssh` y hace `cat > <remotePath>` alimentando el stdin. Ideal para el YAML
 * renderizado (que puede llevar secretos interpolados) sin dejar copias locales.
 * Siempre muta: solo corre en `apply`.
 */
export async function uploadContent(
  target: DeployTarget,
  content: string,
  remotePath: string,
  options: RemoteOptions = {},
): Promise<RemoteResult> {
  const command = `cat > ${posixQuote(remotePath)}`;
  return exec(target, command, { ...options, input: content, readOnly: false });
}

/**
 * "Ata" un `DeployTarget` a un conjunto de defaults y devuelve helpers que ya no
 * requieren repetir el target. Útil para `deploy.ts`/`preflight.ts`.
 */
export function createTarget(target: DeployTarget, defaults: RemoteOptions = {}): BoundTarget {
  assertTarget(target);
  const merge = (options?: RemoteOptions): RemoteOptions => ({ ...defaults, ...options });
  return {
    target,
    exec: (command, options) => exec(target, command, merge(options)),
    upload: (localPath, remotePath, options) => upload(target, localPath, remotePath, merge(options)),
    uploadContent: (content, remotePath, options) => uploadContent(target, content, remotePath, merge(options)),
    describe: () => describeTarget(target),
  };
}

/**
 * Lanza si el resultado se ejecutó y falló. No hace nada en dry-run (nada corrió).
 * Azúcar para que `deploy.ts` corte el pipeline ante un error remoto.
 */
export function assertOk(result: RemoteResult, context?: string): void {
  if (!result.executed || result.ok) return;
  const where = context ? `${context}: ` : '';
  const reason = result.timedOut
    ? `timeout tras esperar la respuesta del server`
    : `código de salida ${result.exitCode ?? 'desconocido'}`;
  const detail = result.stderr.trim() !== '' ? `\n${result.stderr.trim()}` : '';
  throw new Error(`${where}comando remoto falló (${reason}): ${result.printable}${detail}`);
}

// ===========================================================================
// Internos
// ===========================================================================

/** `true` si el target usa auth por contraseña (no vacía). */
function usesPassword(target: DeployTarget): boolean {
  return typeof target.password === 'string' && target.password.length > 0;
}

/** `user@host` del destino. */
function destination(target: DeployTarget): string {
  return `${target.user}@${target.host}`;
}

/** Entorno para el proceso hijo: inyecta `SSHPASS` solo si se usa contraseña. */
function envFor(target: DeployTarget, withPass: boolean): Record<string, string | undefined> {
  if (!withPass) return process.env;
  return { ...process.env, SSHPASS: target.password };
}

/**
 * Opciones `-o`/`-i` comunes a ssh y scp. El puerto se añade aparte porque el
 * flag difiere (`ssh -p` vs `scp -P`).
 */
function commonOptions(target: DeployTarget, withPass: boolean, connectTimeout: number): string[] {
  const opts: string[] = ['-o', `ConnectTimeout=${connectTimeout}`];
  // Sin contraseña: fallar rápido en vez de colgarse en un prompt interactivo.
  if (!withPass) opts.push('-o', 'BatchMode=yes');
  if (typeof target.identityFile === 'string' && target.identityFile !== '') {
    opts.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes');
  }
  for (const opt of target.sshOptions ?? []) opts.push('-o', opt);
  return opts;
}

/** Opciones para `ssh` (puerto con `-p`). */
function sshOptions(target: DeployTarget, withPass: boolean, connectTimeout: number): string[] {
  const opts = commonOptions(target, withPass, connectTimeout);
  if (typeof target.port === 'number' && target.port !== 22) opts.push('-p', String(target.port));
  return opts;
}

/** Opciones para `scp` (puerto con `-P` mayúscula). */
function scpOptions(target: DeployTarget, withPass: boolean, connectTimeout: number): string[] {
  const opts = commonOptions(target, withPass, connectTimeout);
  if (typeof target.port === 'number' && target.port !== 22) opts.push('-P', String(target.port));
  return opts;
}

/**
 * Envuelve el binario base (`ssh`/`scp`) con `sshpass -e` cuando hay contraseña.
 * `-e` hace que sshpass lea la contraseña de la env `SSHPASS` (nunca de argv).
 */
function wrapAuth(base: 'ssh' | 'scp', baseArgs: string[], withPass: boolean): { file: string; argv: string[] } {
  if (!withPass) return { file: base, argv: baseArgs };
  return { file: 'sshpass', argv: ['-e', base, ...baseArgs] };
}

/** Resultado crudo del proceso hijo. */
interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Opciones internas del spawn. */
interface SpawnOptions {
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

/**
 * `spawn` sin shell (argv array → cero inyección de shell local). Captura
 * stdout/stderr, respeta timeout y alimenta stdin opcional.
 */
function spawnCapture(file: string, argv: string[], options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

    child.on('error', (error: Error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code: number | null) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    });

    if (options.input !== undefined) child.stdin?.write(options.input);
    child.stdin?.end();
  });
}

/** `spawnCapture` con mensajes claros cuando falta el binario (`ssh`/`scp`/`sshpass`). */
async function safeSpawn(
  file: string,
  argv: string[],
  options: SpawnOptions,
  withPass: boolean,
): Promise<SpawnResult> {
  try {
    return await spawnCapture(file, argv, options);
  } catch (error) {
    if (hasErrnoCode(error) && error.code === 'ENOENT') {
      if (withPass) {
        throw new Error(
          "No se encontró 'sshpass' (requerido para auth por contraseña). Instálalo (brew install hudochenkov/sshpass/sshpass · apt install sshpass) o usa una llave SSH (identityFile).",
        );
      }
      throw new Error(`No se encontró el cliente '${file}' del sistema. Instala OpenSSH (ssh/scp).`);
    }
    throw error;
  }
}

/** Construye el `RemoteResult` de una operación omitida (dry-run/plan). */
function planned(mode: DeployMode, file: string, argv: string[], printable: string): RemoteResult {
  return { mode, file, argv, printable, executed: false, exitCode: null, ok: true, stdout: '', stderr: '', timedOut: false };
}

/** Construye el `RemoteResult` de una operación ejecutada. */
function executed(
  mode: DeployMode,
  file: string,
  argv: string[],
  printable: string,
  run: SpawnResult,
): RemoteResult {
  return {
    mode,
    file,
    argv,
    printable,
    executed: true,
    exitCode: run.code,
    ok: run.code === 0,
    stdout: run.stdout,
    stderr: run.stderr,
    timedOut: run.timedOut,
  };
}

/** Lanza si el archivo local a subir no existe/legible. */
async function ensureLocalFile(localPath: string): Promise<void> {
  try {
    await access(localPath);
  } catch {
    throw new Error(`No se puede subir '${localPath}': el archivo local no existe o no es accesible.`);
  }
}

/** Cita para POSIX shell (uso remoto, p. ej. `cat > <path>`). */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Comando legible para logs/plan (cita solo lo que tenga caracteres especiales). */
function printableCommand(file: string, argv: string[]): string {
  return [file, ...argv].map(quoteForDisplay).join(' ');
}

/** Cita para MOSTRAR (no para ejecutar). */
function quoteForDisplay(arg: string): string {
  return /[\s"'$`\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

/** Type guard: error con `.code` string (p. ej. `ENOENT`), sin usar `any`. */
function hasErrnoCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}
