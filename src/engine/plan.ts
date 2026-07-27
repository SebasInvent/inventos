// InventOS — motor de deploy · plan.ts (dry-run).
//
// El modo POR DEFECTO del motor es plan/dry-run (docs/ARCHITECTURE.md §5): arma
// el `PlanResult` — todo lo que se HARÍA — SIN ejecutar nada ni tocar infra.
// Alimenta la UX del v0 y el reporte final. El deploy real exige `--apply` +
// target explícito.
//
// `buildPlan` es PURA: no lee disco ni red. Recibe los manifests ya cargados en
// `ctx.manifests` (los carga el llamador / render.ts). Resuelve orden topológico
// por deps, calcula URLs finales, lista las KEYS de secretos a generar (jamás
// valores) y junta avisos (DNS, endurecimiento). Node 24 borra los tipos por
// type-stripping nativo (sin build).

import { join } from 'node:path';
import type {
  DeployMode,
  DeployTarget,
  ExposeRoute,
  Manifest,
  PlanResult,
  PlannedApp,
  PlannedRoute,
} from './types.ts';

// ---------------------------------------------------------------------------
// Entrada de buildPlan
// ---------------------------------------------------------------------------

/**
 * Una receta = lista ordenada de ids de apps (src/recipes.mjs). El motor expande
 * las deps declaradas en cada manifest y despliega en orden topológico.
 */
export interface Recipe {
  /** Id de la receta (p. ej. `agencia`). */
  id: string;
  /** Nombre legible. */
  name: string;
  /** Ids de apps elegidas (las deps se expanden solas). */
  apps: string[];
  /** Gancho comercial (opcional, para la UX). */
  tagline?: string;
  /** Notas de Aria para la UX (opcional). */
  aria?: string[];
}

/**
 * Contexto de un plan. Trae los manifests YA cargados (`buildPlan` no toca
 * disco) más los globals y los valores de params resueltos. `target` es `null`
 * en dry-run puro; en `apply` es obligatorio (se valida como aviso).
 */
export interface PlanContext {
  /** Nombre del proyecto (namespace local del operador). */
  project: string;
  /** Dominio base (apex) para construir subdominios. */
  domain: string;
  /** Nombre de la red overlay compartida. */
  network: string;
  /** Manifests cargados, indexados por id (`templates/<id>/manifest.json`). */
  manifests: Record<string, Manifest>;
  /** Modo de operación. Default `plan` (dry-run). */
  mode?: DeployMode;
  /** Destino de deploy. `null`/ausente en dry-run puro. */
  target?: DeployTarget | null;
  /** Valores resueltos de params (subdominios, etc.). No sensibles. */
  params?: Record<string, string>;
  /** Carpeta local de salida. Default `.inventos/<project>/`. */
  outDir?: string;
  /**
   * Resultado de preflight de DNS: hostname → `true` si su A-record ya apunta a
   * la IP del VPS. Ausente = no se verificó todavía (se emite aviso genérico).
   */
  dns?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Construye el plan (dry-run) de una receta. No ejecuta nada: solo describe lo
 * que se HARÍA. Lanza si falta un manifest o si hay un ciclo de dependencias
 * (validación en el borde del sistema; sin plan no hay UX confiable).
 */
export function buildPlan(recipe: Recipe, ctx: PlanContext): PlanResult {
  const mode: DeployMode = ctx.mode ?? 'plan';
  const target: DeployTarget | null = ctx.target ?? null;
  const params: Record<string, string> = ctx.params ?? {};
  const outDir = ctx.outDir ?? join('.inventos', ctx.project);

  const order = resolveOrder(recipe.apps, ctx.manifests);

  const apps: PlannedApp[] = order.map((id) => {
    const manifest = ctx.manifests[id]!; // resolveOrder ya validó existencia
    const routes = planRoutes(manifest, ctx.domain, params);
    return {
      id: manifest.id,
      name: manifest.name,
      requires: manifest.requires,
      image: manifest.image,
      routes,
      secrets: manifest.secrets.map((s) => s.key),
      adminAuth: manifest.adminAuth.map((a) => a.router),
      internalOnly: manifest.internalOnly,
      renderedStackPath: join(outDir, `${manifest.id}.stack.yml`),
    };
  });

  const createsNetwork = order.some((id) => {
    const m = ctx.manifests[id]!;
    return m.base === true || m.createsNetwork !== undefined;
  });

  const warnings = collectWarnings({ mode, target, apps, dns: ctx.dns });
  const summary = renderSummary({
    project: ctx.project,
    domain: ctx.domain,
    network: ctx.network,
    mode,
    target,
    createsNetwork,
    order,
    apps,
    manifests: ctx.manifests,
    params,
    warnings,
  });

  return {
    mode,
    project: ctx.project,
    domain: ctx.domain,
    network: ctx.network,
    createsNetwork,
    target,
    order,
    apps,
    warnings,
    summary,
  };
}

/**
 * Expande las deps declaradas por cada manifest y devuelve el orden topológico
 * de deploy (deps antes que dependientes). El orden de la receta desempata.
 * Lanza si falta un manifest o si detecta un ciclo.
 */
export function resolveOrder(
  ids: string[],
  manifests: Record<string, Manifest>,
): string[] {
  const visited = new Set<string>();
  const order: string[] = [];

  const visit = (id: string, trail: string[]): void => {
    if (visited.has(id)) return;
    const manifest = manifests[id];
    if (manifest === undefined) {
      const chain = trail.length > 0 ? ` (requerido por ${trail.join(' -> ')})` : '';
      throw new Error(`Falta el manifest de la app "${id}"${chain}.`);
    }
    for (const dep of manifest.requires) {
      if (trail.includes(dep) || dep === id) {
        throw new Error(`Ciclo de dependencias: ${[...trail, id, dep].join(' -> ')}.`);
      }
      visit(dep, [...trail, id]);
    }
    visited.add(id);
    order.push(id);
  };

  for (const id of ids) visit(id, []);
  return order;
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/** Resuelve las rutas públicas (URLs finales `https://<sub>.<domain>`). */
function planRoutes(
  manifest: Manifest,
  domain: string,
  params: Record<string, string>,
): PlannedRoute[] {
  return manifest.exposes.map((expose) => {
    const sub = resolveSubdomain(manifest, expose.subdomainParam, params);
    const host = sub === '' ? domain : `${sub}.${domain}`;
    return {
      name: expose.name,
      url: `https://${host}`,
      servicePort: expose.servicePort,
    };
  });
}

/** Subdominio efectivo: valor de param → default del manifest → vacío (apex). */
function resolveSubdomain(
  manifest: Manifest,
  key: string,
  params: Record<string, string>,
): string {
  const explicit = params[key];
  if (explicit !== undefined && explicit !== '') return explicit;
  const param = manifest.params.find((p) => p.key === key);
  return param?.default ?? '';
}

/** `protectedBy` es un campo opcional de algunos exposes (p. ej. basicauth). */
function protectedBy(expose: ExposeRoute): string | undefined {
  return (expose as ExposeRoute & { protectedBy?: string }).protectedBy;
}

/** Junta avisos accionables para la UX (DNS, target, endurecimiento). */
function collectWarnings(input: {
  mode: DeployMode;
  target: DeployTarget | null;
  apps: PlannedApp[];
  dns?: Record<string, boolean>;
}): string[] {
  const warnings: string[] = [];

  if (input.mode === 'apply' && input.target === null) {
    warnings.push(
      'Modo apply sin target: el deploy real exige --apply + un target SSH explícito (host/usuario).',
    );
  }

  // Colisiones de hostname: dos routers no pueden reclamar el mismo host.
  const claimants = new Map<string, string[]>();
  for (const app of input.apps) {
    for (const route of app.routes) {
      const host = hostOf(route.url);
      const list = claimants.get(host) ?? [];
      list.push(`${app.id}/${route.name}`);
      claimants.set(host, list);
    }
  }
  for (const [host, owners] of claimants) {
    if (owners.length > 1) {
      warnings.push(
        `Colisión de hostname: "${host}" lo reclaman ${owners.join(', ')}. Asigná subdominios distintos.`,
      );
    }
  }

  const hosts = [...claimants.keys()];
  if (hosts.length > 0) {
    if (input.dns === undefined) {
      warnings.push(
        'DNS: verificá que los A-records de los subdominios apunten a la IP del VPS antes de --execute ' +
          '(el challenge HTTP-01 de Let\'s Encrypt lo exige).',
      );
    } else {
      for (const host of hosts) {
        if (input.dns[host] !== true) {
          warnings.push(`DNS: "${host}" no resuelve todavía a la IP del VPS (A-record faltante).`);
        }
      }
    }
  }

  warnings.push(
    'Endurecimiento post-deploy: activá fail2ban, SSH solo-llave y backups diarios (ver reporte final).',
  );

  return warnings;
}

/** Extrae el hostname de una URL `https://host`. */
function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Arma el resumen legible del plan para imprimir en terminal. */
function renderSummary(input: {
  project: string;
  domain: string;
  network: string;
  mode: DeployMode;
  target: DeployTarget | null;
  createsNetwork: boolean;
  order: string[];
  apps: PlannedApp[];
  manifests: Record<string, Manifest>;
  params: Record<string, string>;
  warnings: string[];
}): string {
  const lines: string[] = [];
  const targetStr = input.target
    ? `${input.target.user}@${input.target.host}`
    : 'ninguno (dry-run puro)';

  lines.push(`Plan de InventOS — proyecto "${input.project}" [modo: ${input.mode}]`);
  lines.push(`  Dominio: ${input.domain}   Red overlay: ${input.network}   Target: ${targetStr}`);
  lines.push(`  Orden de deploy: ${input.order.join(' -> ')}`);
  lines.push('');
  lines.push('Apps:');

  for (const app of input.apps) {
    const manifest = input.manifests[app.id]!;
    const img = app.image ? `  img ${app.image}` : '';
    lines.push(`  - ${app.id} (${app.name})${img}`);

    if (input.createsNetwork && (manifest.base || manifest.createsNetwork)) {
      const ports = manifest.publishesPorts?.join('/') ?? '';
      lines.push(
        `      crea la red overlay "${input.network}"${ports ? ` · publica ${ports} al host` : ''}`,
      );
    }

    for (const expose of manifest.exposes) {
      const route = app.routes.find((r) => r.name === expose.name);
      if (!route) continue;
      const guard = protectedBy(expose) === 'basicauth' ? '  [basicauth]' : '';
      lines.push(`      URL ${route.name}: ${route.url}${guard}`);
    }

    if (app.adminAuth.length > 0) {
      lines.push(`      basicauth de Traefik en: ${app.adminAuth.join(', ')}`);
    }
    if (app.secrets.length > 0) {
      lines.push(`      secretos a generar (${app.secrets.length}): ${app.secrets.join(', ')}`);
    }
    if (app.internalOnly.length > 0) {
      lines.push(`      internos (sin puerto al host): ${app.internalOnly.length} servicio(s)`);
    }
  }

  if (input.warnings.length > 0) {
    lines.push('');
    lines.push('Avisos:');
    for (const w of input.warnings) lines.push(`  ! ${w}`);
  }

  return lines.join('\n');
}
