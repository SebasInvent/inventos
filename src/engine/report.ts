// InventOS — motor de deploy · report.ts (reporte final).
//
// Cierra el flujo (docs/ARCHITECTURE.md §4 y §5): imprime las URLs públicas y
// las credenciales UNA sola vez, escribe un archivo de recuperación local
// `.inventos/<project>/credentials.txt` (chmod 600, dir 700) y lista los
// próximos pasos de endurecimiento (fail2ban, SSH solo-llave, backups).
//
// Regla de oro: los secretos viven en la máquina del operador, nunca en el repo
// ni en el server más de lo necesario. En dry-run (`plan`) NO hay valores reales
// todavía: se muestran las URLs y se avisa que los secretos se generan en
// `--apply`; no se escribe nada a disco. Node 24 borra los tipos por
// type-stripping nativo (sin build).

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeployMode, DeployTarget, PlanResult, PlannedRoute } from './types.ts';

// ---------------------------------------------------------------------------
// Entrada / salida
// ---------------------------------------------------------------------------

/** Una credencial resuelta a mostrar una vez (valor SENSIBLE en `apply`). */
export interface ReportCredential {
  /** Nombre de la credencial (p. ej. `STUDIO_PASS`). */
  key: string;
  /** Valor concreto (generado en deploy). Vacío en dry-run. */
  value: string;
}

/** Bloque de reporte por app: sus URLs y sus credenciales de salida. */
export interface ReportApp {
  /** Id de la app. */
  id: string;
  /** Nombre legible. */
  name: string;
  /** Rutas públicas (URLs finales). */
  routes: PlannedRoute[];
  /** Credenciales `credentialsOut` ya resueltas (vacías en dry-run). */
  credentials: ReportCredential[];
}

/**
 * Todo lo necesario para el reporte final. Lo arma el flujo de deploy tras
 * render (que genera los valores de secretos). En dry-run se puede derivar del
 * plan con `reportFromPlan` (credenciales vacías).
 */
export interface DeployReport {
  /** Modo con el que se corrió. `apply` = deploy real (escribe el archivo). */
  mode: DeployMode;
  /** Nombre del proyecto (namespace local). */
  project: string;
  /** Dominio base. */
  domain: string;
  /** Carpeta local de salida (`.inventos/<project>/`), chmod 700. */
  outDir: string;
  /** Bloques por app. */
  apps: ReportApp[];
  /** Destino de deploy (o `null` en dry-run puro). */
  target?: DeployTarget | null;
  /** Avisos heredados del plan (DNS, etc.). */
  warnings?: string[];
}

/** Resultado de imprimir el reporte. */
export interface ReportResult {
  /** Ruta del archivo de recuperación escrito, o `null` si no se escribió. */
  credentialsPath: string | null;
  /** URLs públicas listadas. */
  urls: string[];
  /** Cantidad de credenciales mostradas. */
  credentialCount: number;
  /** Resumen legible de una línea. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Próximos pasos de endurecimiento (§ auditoría del server real)
// ---------------------------------------------------------------------------

/** Checklist de endurecimiento post-deploy que el operador debe aplicar. */
export function nextHardeningSteps(target: DeployTarget | null): string[] {
  const host = target ? `${target.user}@${target.host}` : 'el VPS';
  return [
    `SSH solo-llave: desactivá el login por password en ${host} ` +
      '(PasswordAuthentication no, PermitRootLogin prohibit-password) y recargá sshd.',
    'fail2ban: instalalo y activá el jail de sshd para frenar fuerza bruta.',
    'Firewall: dejá abiertos solo 22 (SSH), 80 y 443; todo lo demás cerrado.',
    'Backups diarios: programá dumps de Postgres y de los volúmenes con retención y prueba de restore.',
    'Guardá este archivo fuera del server (gestor de contraseñas). Nunca lo subas a git.',
  ];
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Deriva un `DeployReport` desde un `PlanResult` (dry-run): copia URLs y modo,
 * con credenciales vacías (los valores se generan recién en `--apply`).
 */
export function reportFromPlan(plan: PlanResult, outDir?: string): DeployReport {
  return {
    mode: plan.mode,
    project: plan.project,
    domain: plan.domain,
    outDir: outDir ?? join('.inventos', plan.project),
    target: plan.target,
    warnings: plan.warnings,
    apps: plan.apps.map((a) => ({
      id: a.id,
      name: a.name,
      routes: a.routes,
      credentials: [],
    })),
  };
}

/**
 * Imprime el reporte final UNA vez (URLs + credenciales + próximos pasos) y, si
 * el modo es `apply` y hay credenciales, escribe el archivo de recuperación
 * local `credentials.txt` (chmod 600, dir 700). Devuelve el resumen.
 */
export function printReport(report: DeployReport): ReportResult {
  const urls = report.apps.flatMap((a) => a.routes.map((r) => r.url));
  const credentialCount = report.apps.reduce((n, a) => n + a.credentials.length, 0);
  const steps = nextHardeningSteps(report.target ?? null);

  const shouldWrite = report.mode === 'apply' && credentialCount > 0;
  let credentialsPath: string | null = null;
  if (shouldWrite) {
    credentialsPath = writeRecoveryFile(report, steps);
  }

  process.stdout.write(renderConsole(report, steps, credentialsPath) + '\n');

  const savedNote = credentialsPath
    ? `, guardadas en ${credentialsPath}`
    : report.mode === 'apply'
      ? ''
      : ' (dry-run: nada escrito a disco)';
  const summary = `Reporte impreso: ${urls.length} URL(s), ${credentialCount} credencial(es)${savedNote}.`;

  return { credentialsPath, urls, credentialCount, summary };
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/** Escribe el archivo de recuperación con permisos 600 (dir 700). */
function writeRecoveryFile(report: DeployReport, steps: string[]): string {
  mkdirSync(report.outDir, { recursive: true, mode: 0o700 });
  const path = join(report.outDir, 'credentials.txt');
  writeFileSync(path, renderFile(report, steps), { mode: 0o600 });
  // Forzar 600 pese al umask del sistema (writeFileSync lo aplica al crear).
  chmodSync(path, 0o600);
  return path;
}

/** Cuerpo en texto plano del archivo de recuperación. */
function renderFile(report: DeployReport, steps: string[]): string {
  const lines: string[] = [];
  lines.push('InventOS · Invent Agency · credenciales de recuperacion');
  lines.push(`Proyecto: ${report.project}   Dominio: ${report.domain}`);
  lines.push(`Generado: ${new Date().toISOString()}`);
  if (report.target) lines.push(`Target: ${report.target.user}@${report.target.host}`);
  lines.push('');
  lines.push('ADVERTENCIA: este archivo contiene secretos. Permisos 600. No lo subas a git.');
  lines.push('');

  lines.push('== URLs ==');
  for (const app of report.apps) {
    for (const route of app.routes) lines.push(`${app.name} / ${route.name}: ${route.url}`);
  }
  lines.push('');

  lines.push('== Credenciales ==');
  for (const app of report.apps) {
    if (app.credentials.length === 0) continue;
    lines.push(`[${app.name}]`);
    for (const c of app.credentials) lines.push(`  ${c.key} = ${c.value}`);
  }
  lines.push('');

  lines.push('== Proximos pasos de endurecimiento ==');
  for (const s of steps) lines.push(`- ${s}`);

  return lines.join('\n') + '\n';
}

/** Versión para la terminal (con color si es TTY). */
function renderConsole(
  report: DeployReport,
  steps: string[],
  credentialsPath: string | null,
): string {
  const s = styler();
  const lines: string[] = [];

  lines.push('');
  lines.push(s.bold(`✔ InventOS — ${report.project} listo [${report.mode}]`));
  lines.push(s.dim(`  Dominio ${report.domain}`));
  lines.push('');

  lines.push(s.bold('URLs:'));
  for (const app of report.apps) {
    for (const route of app.routes) {
      lines.push(`  ${s.cyan(route.url)}  ${s.dim(`(${app.name} · ${route.name})`)}`);
    }
  }

  const hasCreds = report.apps.some((a) => a.credentials.length > 0);
  lines.push('');
  lines.push(s.bold('Credenciales (se muestran una sola vez):'));
  if (hasCreds) {
    for (const app of report.apps) {
      if (app.credentials.length === 0) continue;
      lines.push(`  ${s.bold(app.name)}`);
      for (const c of app.credentials) {
        lines.push(`    ${c.key} = ${s.green(c.value)}`);
      }
    }
    if (credentialsPath) {
      lines.push('');
      lines.push(s.dim(`  Copia de recuperación (chmod 600): ${credentialsPath}`));
    }
  } else {
    lines.push(s.dim('  (dry-run: los secretos se generan con --execute; nada se escribió a disco)'));
  }

  if (report.warnings && report.warnings.length > 0) {
    lines.push('');
    lines.push(s.bold('Avisos:'));
    for (const w of report.warnings) lines.push(`  ${s.yellow('!')} ${w}`);
  }

  lines.push('');
  lines.push(s.bold('Próximos pasos de endurecimiento:'));
  for (const step of steps) lines.push(`  ${s.yellow('→')} ${step}`);

  return lines.join('\n');
}

/** Colores ANSI mínimos, solo si stdout es un TTY. */
function styler(): {
  bold: (t: string) => string;
  dim: (t: string) => string;
  green: (t: string) => string;
  yellow: (t: string) => string;
  cyan: (t: string) => string;
} {
  const tty = process.stdout.isTTY === true;
  const wrap = (code: string) => (t: string) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}
