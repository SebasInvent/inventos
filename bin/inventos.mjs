#!/usr/bin/env node
// InventOS — instalador de terminal para stacks open-source.
// Fase 1: la CLI maneja el MOTOR real (dry-run por defecto).
//   inventos                 → interactivo (elegís receta, dominio)
//   inventos plan --recipe agencia --domain cliente.com
//   inventos --demo          → dry-run de ejemplo (receta agencia)
// El deploy real (apply, con target SSH) llega en la Fase 1.5.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { planRecipe } from '../src/engine/index.ts';
import { applyRecipe } from '../src/engine/apply.ts';
import { printReport } from '../src/engine/report.ts';
import { createLiveView } from '../src/live.mjs';
import { startGuiServer } from '../src/gui-server.mjs';
import { RECIPES, recipeById } from '../src/recipes.mjs';
import { select, ask } from '../src/menu.mjs';
import {
  banner, box, ok, warnGuard, aria, cyan, green, amber, gray, dim, bold, white,
} from '../src/ui.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
const flags = parseFlags(argv);
const isDemo = argv.includes('--demo');

const COMMANDS = ['plan', 'apply', 'gui'];
// Flags que el CLI entiende. Cualquier otra `--x` es un error (antes se ignoraba
// en silencio y el usuario recibía un plan de demo en vez de lo que pidió).
const KNOWN_FLAGS = new Set([
  'recipe', 'domain', 'project', 'email', 'target', 'identity', 'network',
  'execute', 'converge-timeout', 'gui', 'port', 'open', 'demo', 'help', 'version', 'yes',
]);

async function main() {
  process.stdout.write(banner());

  if (flags.help === true || argv.includes('-h') || cmd === 'help') return printHelp();
  if (flags.version === true || argv.includes('-v') || cmd === 'version') return printVersion();

  if (cmd && !COMMANDS.includes(cmd)) {
    return fail(`Comando desconocido: "${cmd}". Comandos: ${COMMANDS.join(', ')}.  Ayuda: ${cyan('inventos --help')}`);
  }
  const unknown = Object.keys(flags).filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length) {
    return fail(`Opción desconocida: ${unknown.map((f) => `--${f}`).join(', ')}.  Ayuda: ${cyan('inventos --help')}`);
  }

  if (cmd === 'gui' || flags.gui === true) {
    const port = flags.port ? Number(flags.port) : 4747;
    const { uri } = await startGuiServer({ port, open: flags.open !== false });
    process.stdout.write(`  ${green('●')} GUI de InventOS corriendo en ${cyan(uri)}\n`);
    process.stdout.write(`  ${gray('Se abrió en tu navegador. Toda la lógica corre local — nada sale de este equipo.')}\n`);
    process.stdout.write(`  ${gray('Ctrl+C para salir.')}\n\n`);
    return; // el server queda escuchando: mantiene el proceso vivo
  }

  if (isDemo) {
    return runPlan(recipeById('agencia'), { project: 'demo-cliente', domain: 'cliente.com', email: 'admin@cliente.com' });
  }

  if (cmd === 'plan') {
    const recipe = resolveRecipe(flags.recipe ?? 'agencia');
    if (!recipe) return;
    const domain = flags.domain ?? 'midominio.com';
    return runPlan(recipe, { project: flags.project ?? recipe.id, domain, email: flags.email ?? `admin@${domain}` });
  }

  if (cmd === 'apply') {
    const recipe = resolveRecipe(flags.recipe ?? 'agencia');
    if (!recipe) return;
    const domain = flags.domain ?? 'midominio.com';
    const execute = flags.execute === true;
    if (execute && !flags.target) return fail('El deploy real (--execute) exige un --target explícito (ej: --target root@1.2.3.4).');
    const target = parseTarget(flags.target, flags.identity);
    return runApply(recipe, {
      project: flags.project ?? recipe.id,
      domain,
      email: flags.email ?? `admin@${domain}`,
      network: flags.network,
      target,
      execute,
      convergeSeconds: flags['converge-timeout'],
    });
  }

  // Interactivo (requiere TTY)
  if (!process.stdin.isTTY) {
    process.stdout.write(`  ${gray('Modo no interactivo. Usá')} ${cyan('inventos plan --recipe <receta> --domain <dominio>')}${gray('. Ejemplo (agencia):')}\n\n`);
    return runPlan(recipeById('agencia'), { project: 'agencia', domain: 'midominio.com', email: 'admin@midominio.com' });
  }
  const choices = RECIPES.filter((r) => r.apps.length > 0);
  const idx = await select('¿Qué querés desplegar?', choices.map((r) => ({ label: r.name, hint: r.tagline })));
  const recipe = choices[idx];
  process.stdout.write('\n');
  const domain = await ask('Dominio (ej: cliente.com)', 'midominio.com');
  const email = await ask('Email para el certificado SSL', `admin@${domain}`);
  process.stdout.write('\n');
  await runPlan(recipe, { project: recipe.id, domain, email }, { closing: false });

  // El plan ya se vio; ahora se puede INSTALAR de verdad sin aprender otro comando.
  // (Antes el modo interactivo terminaba en el dry-run y no había forma de seguir.)
  const dest = await select('¿Instalamos ahora?', [
    { label: 'Solo ver el plan', hint: 'no instala nada — salir acá' },
    { label: 'Instalar en este equipo', hint: 'Docker local · ideal para probar' },
    { label: 'Instalar en un VPS por SSH', hint: 'tu servidor real, con HTTPS' },
  ]);
  process.stdout.write('\n');

  if (dest === 0) {
    process.stdout.write(`  ${bold(cyan('▐'))} ${bold('Dry-run.')} ${gray('Nada se desplegó. Cuando quieras instalar:')}\n`);
    process.stdout.write(`     ${cyan(`inventos apply --recipe ${recipe.id} --domain ${domain} --target root@IP --execute`)}\n\n`);
    return;
  }

  let target;
  if (dest === 1) {
    target = { user: 'local', host: 'local' };
  } else {
    const spec = await ask('Servidor (usuario@ip)', 'root@1.2.3.4');
    const identity = await ask('Llave SSH (dejá vacío para la default)', '');
    target = parseTarget(spec, identity || undefined);
    process.stdout.write('\n');
  }

  const confirm = await select(`Se va a INSTALAR ${recipe.name} en ${dest === 1 ? 'este equipo' : `${target.user}@${target.host}`}. ¿Confirmás?`, [
    { label: 'No, cancelar', hint: 'no se toca nada' },
    { label: 'Sí, instalar ahora', hint: 'ejecuta el deploy real' },
  ]);
  process.stdout.write('\n');
  if (confirm !== 1) {
    process.stdout.write(`  ${gray('Cancelado. No se desplegó nada.')}\n\n`);
    return;
  }

  return runApply(recipe, { project: recipe.id, domain, email, target, execute: true });
}

async function runPlan(recipe, cfg, o = {}) {
  const closing = o.closing !== false;
  const outcome = await planRecipe(recipe, {
    project: cfg.project, domain: cfg.domain, acmeEmail: cfg.email, adminUser: 'admin',
  });
  const p = outcome.plan;

  // 1) Plan — qué se despliega y dónde
  const rows = [];
  for (const app of p.apps) {
    const img = app.image ? dim(`  ${app.image}`) : '';
    if (app.routes.length === 0) {
      rows.push(`${white(app.name.padEnd(15))} ${gray('interno · sin ruta pública')}${img}`);
    } else {
      app.routes.forEach((r, i) => {
        const name = i === 0 ? white(app.name.padEnd(15)) : ' '.repeat(15);
        const guard = app.adminAuth.length && r.name === 'studio' ? amber('  [basicauth]') : '';
        rows.push(`${name} ${cyan(r.url)}${guard}`);
      });
    }
  }
  process.stdout.write(box(`Plan: ${recipe.name}  ·  ${p.apps.length} stacks  ·  ${cfg.domain}`, rows) + '\n\n');

  // 2) Seguro de fábrica (derivado del plan real)
  const totalSecrets = p.apps.reduce((n, a) => n + a.secrets.length, 0);
  const authRouters = p.apps.flatMap((a) => a.adminAuth);
  const internalCount = p.apps.reduce((n, a) => n + a.internalOnly.length, 0);
  const authLine = authRouters.length
    ? `Paneles sensibles tras basicauth de Traefik (${authRouters.join(', ')}) · lección de la auditoría`
    : 'Todo panel admin tras su login propio obligatorio — ninguno queda abierto';
  const sec = [
    ok('TLS automático (Let\'s Encrypt) en todas las URLs públicas'),
    ok(`${totalSecrets} secretos fuertes generados en el deploy — cero en las plantillas`),
    ok(authLine),
    ok(`${internalCount} servicios internos sin puerto al host (bases de datos, cache)`),
    ok('Imágenes con tag fijo — nunca :latest'),
    warnGuard('Post-deploy: fail2ban + SSH solo-llave + backups diarios'),
  ];
  process.stdout.write(box('Seguro de fábrica', sec, green) + '\n\n');

  // 3) ARIA
  if (recipe.aria && recipe.aria.length) {
    process.stdout.write(box('ARIA · asistente de configuración', recipe.aria.map((t) => aria(t)), (s) => s) + '\n\n');
  }

  // 4) Validación de render + cierre honesto
  const mark = outcome.ok ? green('✔') : amber('!');
  process.stdout.write(`  ${mark} Render validado: ${bold(String(outcome.rendered))} stacks, ${bold(String(outcome.unresolved.length))} tokens sin resolver.\n`);
  if (outcome.unresolved.length) {
    process.stdout.write(`  ${amber('sin resolver:')} ${outcome.unresolved.join(', ')}\n`);
  }
  if (closing) {
    process.stdout.write(`  ${bold(cyan('▐'))} ${bold('Dry-run.')} ${gray('Nada se desplegó. Deploy real:')} ${cyan(`inventos apply --domain ${cfg.domain} --target root@IP --execute`)}\n\n`);
  } else {
    process.stdout.write('\n');
  }
}

async function runApply(recipe, cfg) {
  const dry = !cfg.execute;
  // Convergencia: local tira de imágenes en el primer deploy (lento) → timeout mayor.
  const isLocalTarget = cfg.target.host === 'local';
  const convergeTimeoutMs = cfg.convergeSeconds
    ? Number(cfg.convergeSeconds) * 1000
    : (isLocalTarget ? 900_000 : 180_000);
  // Header primero — después arranca el stream en vivo (apply real) o el plan (dry).
  const head = dry ? amber('DRY-APPLY (no toca el server)') : green('APPLY REAL');
  const tgt = cfg.target.host === 'local' ? 'local (esta máquina)' : `${cfg.target.user}@${cfg.target.host}`;
  process.stdout.write(`  ${bold('Plan de ejecución')}  ·  ${head}  ·  ${cyan(tgt)}\n\n`);

  // En apply real, la vista EN VIVO pinta cada paso con spinner + convergencia en tiempo real.
  const view = dry ? null : createLiveView();
  const result = await applyRecipe(recipe, {
    project: cfg.project, domain: cfg.domain, acmeEmail: cfg.email, adminUser: 'admin',
    network: cfg.network, target: cfg.target, execute: cfg.execute, convergeTimeoutMs,
    onEvent: view ? (e) => view.on(e) : undefined,
  });
  if (view) view.end();

  // En dry-apply imprimo el plan de comandos exacto (útil para inspección). En apply
  // real ya se vio en vivo, así que no lo repito.
  if (dry) {
    const tag = {
      preflight: gray('preflight'), upload: cyan('upload  '), provision: cyan('provision'),
      deploy: green('deploy  '), converge: gray('converge'), warn: amber('aviso   '),
    };
    for (const s of result.steps) {
      const label = tag[s.kind] ?? s.kind;
      process.stdout.write(`  ${label}  ${s.description}\n`);
      if (s.printable) process.stdout.write(`            ${dim(s.printable)}\n`);
      else if (s.kind === 'warn') process.stdout.write(`            ${amber('⚠ pendiente de assets')}\n`);
    }
  }
  process.stdout.write('\n');

  // Reporte final (URLs + credenciales; el archivo .txt solo se escribe en apply real)
  printReport(result.report);

  process.stdout.write('\n');
  if (dry) {
    process.stdout.write(`  ${bold(cyan('▐'))} ${bold('Dry-apply.')} ${gray('Nada se ejecutó. Para desplegar de verdad:')}\n`);
    process.stdout.write(`     ${cyan(`inventos apply --recipe ${recipe.id} --domain ${cfg.domain} --target root@IP --execute`)}\n\n`);
  } else {
    const okmark = result.ok ? green('✔ deploy OK') : amber('! deploy con fallos');
    process.stdout.write(`  ${bold(okmark)} — ${result.steps.filter((s) => s.executed).length} comandos ejecutados.\n\n`);
  }
}

// Parsea "user@host" o "user@host:port". "local" = correr en esta máquina (sin SSH).
// Placeholder para dry-apply sin target.
function parseTarget(spec, identity) {
  if (spec === 'local') return { user: 'local', host: 'local' };
  if (!spec || spec === true) return { user: 'root', host: 'VPS-IP', identityFile: identity === true ? undefined : identity };
  const at = spec.indexOf('@');
  const user = at >= 0 ? spec.slice(0, at) : 'root';
  const rest = at >= 0 ? spec.slice(at + 1) : spec;
  const colon = rest.indexOf(':');
  const host = colon >= 0 ? rest.slice(0, colon) : rest;
  const port = colon >= 0 ? Number(rest.slice(colon + 1)) : undefined;
  const t = { user, host };
  if (port) t.port = port;
  if (identity && identity !== true) t.identityFile = identity;
  return t;
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

/**
 * Resuelve una receta por id y avisa si no sirve. `custom` existe en el catálogo
 * como marcador de "elegir a mano" pero no trae apps: sin este chequeo, pedirla
 * desplegaba 0 stacks en silencio y parecía que el instalador no hacía nada.
 * Devuelve null (con el mensaje ya impreso) cuando no se puede continuar.
 */
function resolveRecipe(id) {
  const usable = RECIPES.filter((r) => r.apps.length > 0);
  const list = usable.map((r) => r.id).join(', ');
  const recipe = recipeById(id);
  if (!recipe) { fail(`Receta desconocida: "${id}". Opciones: ${list}`); return null; }
  if (recipe.apps.length === 0) {
    fail(`La receta "${recipe.id}" (${recipe.name}) todavía no está disponible: no trae apps.\n    Usá una de estas: ${cyan(list)}`);
    return null;
  }
  return recipe;
}

function pkg() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../package.json'), join(here, 'package.json')]) {
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { /* siguiente */ }
  }
  return { version: '0.0.0' };
}

function printVersion() {
  process.stdout.write(`  ${bold(cyan('InventOS'))} ${white('v' + pkg().version)}  ${gray('· por Invent Agency')}\n\n`);
}

function printHelp() {
  const L = (a, b) => `${cyan(a.padEnd(38))} ${gray(b)}`;
  process.stdout.write([
    `  ${bold('Uso')}   ${cyan('inventos')} ${gray('[comando] [opciones]')}`,
    '',
    `  ${bold('Sin argumentos')} — modo guiado: elegís receta y dominio, y podés instalar ahí mismo.`,
    '',
    `  ${bold('Comandos')}`,
    '    ' + L('plan', 'muestra qué se desplegaría (no toca nada)'),
    '    ' + L('apply', 'despliega de verdad (exige --target y --execute)'),
    '    ' + L('gui', 'abre el wizard web local en el navegador'),
    '',
    `  ${bold('Opciones')}`,
    '    ' + L('--recipe <id>', `receta: ${RECIPES.filter((r) => r.apps.length).map((r) => r.id).join(', ')}`),
    '    ' + L('--domain <dominio>', 'dominio base (ej: cliente.com)'),
    '    ' + L('--email <email>', 'email del certificado SSL'),
    '    ' + L('--target <user@ip | local>', '"local" = Docker de este equipo'),
    '    ' + L('--execute', 'ejecuta el deploy real (sin esto, simula)'),
    '    ' + L('--identity <ruta>', 'llave SSH privada'),
    '    ' + L('--project <nombre>', 'nombre del proyecto (default: la receta)'),
    '    ' + L('--port <n>', 'puerto de la GUI (default 4747)'),
    '    ' + L('--demo', 'plan de ejemplo'),
    '    ' + L('-h, --help / -v, --version', 'esta ayuda / la versión'),
    '',
    `  ${bold('Ejemplos')}`,
    `    ${cyan('inventos')}                                             ${gray('guiado, de cero a instalado')}`,
    `    ${cyan('inventos plan --recipe agencia --domain cliente.com')}  ${gray('ver el plan')}`,
    `    ${cyan('inventos apply --recipe minimo --target local --execute')}  ${gray('instalar acá')}`,
    `    ${cyan('inventos apply --recipe agencia --domain cliente.com \\')}`,
    `      ${cyan('--target root@1.2.3.4 --execute')}                    ${gray('instalar en tu VPS')}`,
    '',
    `  ${gray('Requisitos del destino: Docker con Swarm activo.')} ${gray('Docs:')} ${cyan('https://os.inventagency.co')}`,
    '',
  ].join('\n'));
}

function fail(msg) {
  process.stdout.write(`\n  ${amber('✗')} ${msg}\n\n`);
  process.exitCode = 1;
}

/**
 * Pie de diagnóstico para fallos inesperados. Sin esto un reporte de usuario es
 * "no me funcionó" sin contexto; con esto llega con versión, sistema y Docker.
 */
function crashFooter() {
  let docker = 'no detectado';
  try {
    docker = execSync('docker version --format "{{.Server.Version}}"', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'no responde';
  } catch { /* queda "no detectado" */ }
  const bugs = pkg().bugs?.url;
  return [
    '',
    `  ${gray('InventOS')} ${white('v' + pkg().version)} ${gray('·')} ${gray(`${process.platform} ${process.arch}`)} ${gray('·')} ${gray(`Node ${process.versions.node}`)} ${gray('·')} ${gray(`Docker ${docker}`)}`,
    bugs ? `  ${gray('Esto es un fallo nuestro, no tuyo. Contanos qué pasó y lo arreglamos:')}\n  ${cyan(bugs)}` : '',
    '',
  ].filter(Boolean).join('\n');
}

main().catch((err) => {
  // Errores esperados (Docker apagado, Swarm sin activar…) se muestran limpios:
  // son instrucciones para el usuario, no un crash que deba reportar.
  if (err?.expected) {
    const [head, ...rest] = String(err.message).split('\n');
    process.stdout.write(`\n  ${amber('✗')} ${bold(head)}\n${rest.join('\n')}\n\n`);
    process.exit(1);
  }
  console.error('\n' + amber('InventOS se detuvo:'), err?.stack || err?.message || err);
  process.stderr.write(crashFooter());
  process.exit(1);
});
