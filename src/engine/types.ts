// InventOS — motor de deploy · tipos compartidos.
//
// Base de tipos para el resto del motor (target, preflight, secrets, render,
// deploy, report, plan). Ref: docs/ARCHITECTURE.md §2.1 (esquema del manifest)
// y §5 (módulos del motor).
//
// Regla de oro: seguro de fábrica. Aquí SOLO viven formas de datos; los valores
// de secretos nunca se declaran literalmente en plantillas ni en el repo — el
// motor los genera en deploy (§4). Este archivo es type-only: Node 24 lo borra
// por type-stripping nativo (sin build).

// ---------------------------------------------------------------------------
// Utilidad: unión abierta. Da autocompletado con valores conocidos sin cerrar
// el conjunto (nuevas apps pueden traer categorías nuevas). Evita `any`.
// ---------------------------------------------------------------------------
type Open<T extends string> = T | (string & {});

/** Categoría funcional de una app en el catálogo. Unión abierta. */
export type Category = Open<
  | 'base'
  | 'database'
  | 'cache'
  | 'backend'
  | 'automation'
  | 'messaging'
  | 'storage'
  | 'admin'
  | 'chatbot'
>;

// ===========================================================================
// Manifest y sus partes (docs/ARCHITECTURE.md §2.1)
// ===========================================================================

/**
 * Tipo de secreto que el motor sabe generar (secrets.ts, §4).
 * - `hex` / `base64url`: llaves aleatorias fuertes (≥256-bit según `bytes`).
 * - `bcrypt`: hash para basicauth de Traefik.
 * - `supabase-jwt`: JWT HS256 (anon/service_role) derivado de otro secreto.
 */
export type SecretType = 'hex' | 'base64url' | 'bcrypt' | 'supabase-jwt';

/**
 * Un secreto que el motor GENERA en el momento del deploy. Jamás lleva un
 * valor literal: `key` es el nombre del token `${key}` en la plantilla.
 */
export interface Secret {
  /** Nombre del token `${key}` a interpolar en `stack.yml.tmpl`. */
  key: string;
  /** Algoritmo de generación. */
  type: SecretType;
  /** Tamaño en bytes de la entropía (hex/base64url/bcrypt). ≥32 = 256-bit. */
  bytes?: number;
  /** Rol del JWT de Supabase (p. ej. `anon`, `service_role`). */
  role?: string;
  /** Secreto base del que se deriva (p. ej. `JWT_SECRET` para un JWT). */
  from?: string;
  /** Este secreto también debe provisionarse en el stack indicado (id). */
  provisionIn?: string;
  /** Este secreto se comparte con otro stack (mismo valor en ambos, id). */
  sharedWith?: string;
}

/**
 * Un parámetro configurable por receta/usuario. A diferencia de un `Secret`,
 * puede llevar un `default` visible; nunca es sensible.
 */
export interface Param {
  /** Nombre del token `${key}` a interpolar. */
  key: string;
  /** Texto que se muestra al pedir el valor. */
  prompt: string;
  /** Valor por defecto propuesto (cadena vacía = requiere entrada). */
  default: string;
}

/**
 * Valor que una app CONSUME de un global o de otro stack (no lo genera).
 * P. ej. Evolution consume `POSTGRES_PASSWORD` del stack `postgres`.
 */
export interface Consume {
  /** Nombre del token `${key}` a interpolar. */
  key: string;
  /** Origen: `global` (DOMAIN/NETWORK…) o el id de otro stack. */
  from: Open<'global'>;
  /** Valor por defecto si el origen no lo provee. */
  default?: string;
  /** Nota explicativa para el operador. */
  note?: string;
}

/**
 * Ruta pública (router de Traefik + TLS por `letsencryptresolver`). El
 * subdominio sale de un `Param`; la URL final es `https://<sub>.<domain>`.
 */
export interface ExposeRoute {
  /** Nombre lógico del router (p. ej. `studio`, `console`, `editor`). */
  name: string;
  /** `key` del `Param` que aporta el subdominio. */
  subdomainParam: string;
  /** Puerto interno del servicio al que enruta Traefik. */
  servicePort: number;
}

/**
 * Panel admin que el motor protege con middleware `basicauth` de Traefik
 * (cuando la app no trae login propio; lección: Supabase Studio, §3.2).
 */
export interface AdminAuth {
  /** Router de Traefik al que se le adjunta el basicauth. */
  router: string;
  /** `key` del secreto/param con el usuario del basicauth. */
  user: string;
  /** `key` del secreto (bcrypt) con la contraseña del basicauth. */
  pass: string;
}

/** Healthcheck declarado por el manifest para esperar convergencia. */
export interface HealthCheck {
  /** Servicio del stack a chequear. */
  service: string;
  /** Comando que devuelve 0 cuando el servicio está sano. */
  cmd: string;
}

/** Definición de la red overlay que crea la app base (Traefik). */
export interface CreatesNetwork {
  /** `key` del `Param` con el nombre de la red. */
  nameParam: string;
  /** Driver de red (siempre `overlay` en Swarm). */
  driver: Open<'overlay'>;
  /** La red admite contenedores no-Swarm. */
  attachable: boolean;
  /** Tráfico de la red cifrado. */
  encrypted: boolean;
}

/**
 * Manifest de una app (`templates/<id>/manifest.json`). Metadatos que el motor
 * consume para resolver deps, pedir params, generar secretos y renderizar.
 */
export interface Manifest {
  /** Identificador único (nombre de la carpeta en `templates/`). */
  id: string;
  /** Nombre legible. */
  name: string;
  /** Rol/descripción corta. */
  role: string;
  /** Categoría funcional. */
  category: Category;
  /** Ids de otros stacks que deben existir antes (deps). */
  requires: string[];
  /** Parámetros configurables. */
  params: Param[];
  /** Secretos que el motor genera en deploy. */
  secrets: Secret[];
  /** Paneles admin a proteger con basicauth de Traefik. */
  adminAuth: AdminAuth[];
  /** Rutas públicas (Traefik + TLS). */
  exposes: ExposeRoute[];
  /** Servicios sin ruta pública (solo red overlay). */
  internalOnly: string[];
  /** Healthcheck para esperar convergencia. */
  healthcheck?: HealthCheck;
  /** Credenciales que se muestran una sola vez al final (keys). */
  credentialsOut: string[];

  // --- Campos opcionales según el rol de la app ---
  /** `true` si es la app base del ingress (Traefik). */
  base?: boolean;
  /** Imagen con tag FIJO (nunca `:latest`, §3.6). */
  image?: string;
  /** Puertos publicados al host (solo la app base los tiene). */
  publishesPorts?: number[];
  /** La app base crea la red overlay compartida. */
  createsNetwork?: CreatesNetwork;
  /** Volúmenes nombrados que declara. */
  volumes?: string[];
  /** Estado del dashboard admin (p. ej. `disabled` en Traefik). */
  dashboard?: Open<'disabled'>;
  /** Cert resolver de Traefik a usar. */
  certResolver?: string;
  /** Valores que la app consume de globals u otros stacks. */
  consumes?: Consume[];
  /** Nota sobre cómo queda protegido el panel admin. */
  adminNote?: string;
  /** Lista de medidas de endurecimiento aplicadas (para el README/plan). */
  hardening?: string[];
}

// ===========================================================================
// Contexto de render (render.ts, §5)
// ===========================================================================

/**
 * Todo lo necesario para renderizar una plantilla concreta a YAML: manifest,
 * rutas locales y el mapa de interpolación (`env`) con params + secretos +
 * globals. Los valores de `secrets`/`env` son sensibles: nunca se persisten en
 * el repo (§4); viven en la máquina del operador (`.inventos/<project>/`).
 */
export interface RenderContext {
  /** Manifest de la app que se renderiza. */
  manifest: Manifest;
  /** Nombre del proyecto (namespace local del operador). */
  project: string;
  /** Dominio base (apex) para construir subdominios. */
  domain: string;
  /** Nombre de la red overlay compartida. */
  network: string;
  /** Carpeta de la plantilla (`templates/<id>/`). */
  templateDir: string;
  /** Carpeta local de salida (`.inventos/<project>/`), chmod 600. */
  outDir: string;
  /** Valores resueltos de los params (no sensibles). */
  params: Record<string, string>;
  /** Valores generados de los secretos (SENSIBLES, nunca al repo). */
  secrets: Record<string, string>;
  /** Mapa completo de interpolación `${VAR}`: globals + params + secretos. */
  env: Record<string, string>;
}

// ===========================================================================
// Destino de deploy (target.ts, §5)
// ===========================================================================

/**
 * Servidor destino al que el motor sube los stacks renderizados vía `ssh`/`scp`
 * del sistema. Nunca apunta a la infra del operador salvo que se indique con
 * `--apply` + target explícito (§5, seguridad de operación).
 */
export interface DeployTarget {
  /** IP o hostname del VPS destino. */
  host: string;
  /** Usuario SSH (p. ej. `root` o un usuario con acceso a Docker). */
  user: string;
  /** Puerto SSH (default 22). */
  port?: number;
  /** Ruta a la llave privada SSH (`ssh -i`). Método de auth recomendado. */
  identityFile?: string;
  /**
   * Contraseña SSH (alternativa a `identityFile`). El motor la inyecta vía
   * `sshpass -e` por variable de entorno `SSHPASS`, nunca por argv/línea de
   * comandos (no aparece en `ps` ni en logs). Valor en runtime del operador;
   * jamás se persiste en el repo (§4).
   */
  password?: string;
  /** Opciones extra para `ssh`/`scp` (p. ej. StrictHostKeyChecking). */
  sshOptions?: string[];
}

// ===========================================================================
// Plan / dry-run (plan.ts, §5) — el modo POR DEFECTO del motor
// ===========================================================================

/**
 * Modo de operación. `plan` = dry-run (default, no toca infra). `apply` =
 * deploy real; exige `--apply` + target explícito.
 */
export type DeployMode = 'plan' | 'apply';

/** Ruta pública ya resuelta en el plan (URL final). */
export interface PlannedRoute {
  /** Nombre lógico del router. */
  name: string;
  /** URL final `https://<sub>.<domain>`. */
  url: string;
  /** Puerto interno del servicio. */
  servicePort: number;
}

/** Resumen por app de lo que el motor HARÍA. */
export interface PlannedApp {
  /** Id de la app. */
  id: string;
  /** Nombre legible. */
  name: string;
  /** Deps declaradas. */
  requires: string[];
  /** Imagen con tag fijo que se desplegaría. */
  image?: string;
  /** Rutas públicas que quedarían activas. */
  routes: PlannedRoute[];
  /** KEYS de secretos a generar (NUNCA valores). */
  secrets: string[];
  /** Routers que quedarían protegidos con basicauth. */
  adminAuth: string[];
  /** Servicios que quedarían solo en red interna. */
  internalOnly: string[];
  /** Ruta local donde se escribiría el YAML renderizado. */
  renderedStackPath: string;
}

/**
 * Resultado de un plan/dry-run: todo lo que se HARÍA, sin ejecutar nada. Es el
 * resumen que devuelve el motor y que alimenta la UX del v0.
 */
export interface PlanResult {
  /** Modo con el que se corrió (`plan` por defecto). */
  mode: DeployMode;
  /** Proyecto (namespace local). */
  project: string;
  /** Dominio base. */
  domain: string;
  /** Red overlay compartida. */
  network: string;
  /** `true` si el plan implica crear la red overlay (app base presente). */
  createsNetwork: boolean;
  /** Destino de deploy, o `null` en dry-run puro (sin target). */
  target: DeployTarget | null;
  /** Orden topológico de deploy (ids), resuelto por deps. */
  order: string[];
  /** Detalle por app en orden de deploy. */
  apps: PlannedApp[];
  /** Avisos/recomendaciones (p. ej. DNS faltante, fail2ban sugerido). */
  warnings: string[];
  /** Resumen legible para imprimir en terminal. */
  summary: string;
}
