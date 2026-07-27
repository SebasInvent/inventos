/**
 * InventOS — motor de deploy · módulo `secrets`
 * ------------------------------------------------------------------
 * Generadores criptográficos "seguros de fábrica" para el deploy.
 *
 * Regla de oro (ver docs/ARCHITECTURE.md §3 y §4): ningún secreto real
 * vive en el repo ni en las plantillas. El motor GENERA cada secreto en
 * el momento del deploy con crypto seguro (`node:crypto`), lo inyecta por
 * env-interpolation al renderizar el stack y lo guarda solo en la máquina
 * del operador (`.inventos/<project>/secrets.env`, chmod 600).
 *
 * Tipos de secreto soportados (esquema en §2.1):
 *   - hex           : N bytes aleatorios en hexadecimal (llaves, passwords).
 *   - base64url     : N bytes aleatorios en base64url sin padding.
 *   - bcrypt        : hash bcrypt del texto plano indicado en `from`
 *                     (para el middleware basicauth de Traefik).
 *   - supabase-jwt  : JWT HS256 (rol anon/service_role) firmado con el
 *                     secreto indicado en `from` (típicamente JWT_SECRET).
 *
 * Nota de dependencia: `bcryptHash` usa `bcryptjs` (bcrypt en JavaScript
 * puro, SIN build nativo — compatible con "Node 24 sin build"). Es la
 * única dependencia npm del módulo; se carga de forma perezosa y solo se
 * necesita cuando un manifest declara un secreto `type: "bcrypt"`. El
 * resto es stdlib de Node (`node:crypto`).
 *
 * Nota de escapado: `bcryptHash` devuelve el hash CRUDO con `$` simples.
 * El escapado a `$$` para la interpolación de docker-compose es
 * responsabilidad del renderizador (`render.ts`), no de este módulo.
 */

import { randomBytes, createHmac } from 'node:crypto';

// ----------------------------------------------------------------------------
// Tipos
// ----------------------------------------------------------------------------

/** Tipos de secreto que el motor sabe generar. */
export type SecretType = 'hex' | 'base64url' | 'bcrypt' | 'supabase-jwt';

/** Roles válidos para un JWT de Supabase. */
export type SupabaseRole = 'anon' | 'service_role';

/**
 * Especificación de un secreto tal como aparece en `manifest.secrets`.
 * Campos como `desc`, `provisionIn` o `sharedWith` son metadatos opcionales
 * que este módulo ignora sin problema.
 */
export interface SecretSpec {
  /** Nombre de la variable (ej. `POSTGRES_PASSWORD`). */
  key: string;
  /** Estrategia de generación. */
  type: SecretType;
  /** Nº de bytes de entropía (obligatorio en `hex` y `base64url`). */
  bytes?: number;
  /** Clave de otro secreto del que este deriva (`bcrypt`, `supabase-jwt`). */
  from?: string;
  /** Rol del JWT (obligatorio en `supabase-jwt`). */
  role?: string;
  /** Descripción legible (informativa). */
  desc?: string;
}

/** Subconjunto del manifest que este módulo necesita. */
export interface ManifestSecrets {
  secrets?: SecretSpec[];
}

/** Mapa `key -> valor generado`. */
export type SecretMap = Record<string, string>;

/** Metadato de un secreto para el modo plan/dry-run (nunca lleva el valor). */
export interface SecretPlanEntry {
  key: string;
  type: SecretType;
  /** Detalle legible en español, sin exponer ningún valor. */
  detail: string;
}

// ----------------------------------------------------------------------------
// Constantes de endurecimiento
// ----------------------------------------------------------------------------

/** Coste bcrypt por defecto (fuerte, aún rápido para basicauth). */
const BCRYPT_ROUNDS = 12;
/** Emisor de los JWT de Supabase (convención del self-hosting oficial). */
const SUPABASE_ISS = 'supabase';
/** Vida por defecto de los JWT: 10 años (llaves de servicio de larga duración). */
const JWT_TTL_SECONDS = 60 * 60 * 24 * 365 * 10;

// ----------------------------------------------------------------------------
// Generadores primitivos
// ----------------------------------------------------------------------------

/** `bytes` de entropía criptográfica en hexadecimal. */
export function hex(bytes: number): string {
  assertBytes(bytes, 'hex');
  return randomBytes(bytes).toString('hex');
}

/** `bytes` de entropía criptográfica en base64url (sin padding). */
export function base64url(bytes: number): string {
  assertBytes(bytes, 'base64url');
  return randomBytes(bytes).toString('base64url');
}

/**
 * JWT HS256 de Supabase para el rol indicado, firmado con `jwtSecret`.
 * Estructura: `base64url(header).base64url(payload).base64url(HMAC-SHA256)`.
 */
export function supabaseJwt(
  role: string,
  jwtSecret: string,
  ttlSeconds: number = JWT_TTL_SECONDS,
): string {
  if (!role) {
    throw new Error('supabaseJwt: falta el rol (ej. anon | service_role).');
  }
  if (!jwtSecret) {
    throw new Error('supabaseJwt: falta el secreto de firma (JWT_SECRET).');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { role, iss: SUPABASE_ISS, iat: now, exp: now + ttlSeconds };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = createHmac('sha256', jwtSecret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Hash bcrypt del texto plano (para el middleware basicauth de Traefik).
 * Devuelve el hash CRUDO (`$2a$...` / `$2b$...`); el renderizador es quien
 * escapa `$` → `$$` si el destino lo requiere.
 */
export async function bcryptHash(
  password: string,
  rounds: number = BCRYPT_ROUNDS,
): Promise<string> {
  if (!password) {
    throw new Error('bcryptHash: la contraseña a hashear no puede estar vacía.');
  }
  const lib = await loadBcrypt();
  return lib.hashSync(password, lib.genSaltSync(rounds));
}

// ----------------------------------------------------------------------------
// API de alto nivel
// ----------------------------------------------------------------------------

/**
 * Genera el valor de un único secreto según su `spec`.
 * Para tipos derivados (`bcrypt`, `supabase-jwt`) resuelve `from` desde
 * `resolved` (mapa de secretos ya generados).
 */
export async function genSecret(
  spec: SecretSpec,
  resolved: SecretMap = {},
): Promise<string> {
  switch (spec.type) {
    case 'hex':
      return hex(requireBytes(spec));
    case 'base64url':
      return base64url(requireBytes(spec));
    case 'supabase-jwt': {
      if (!spec.role) {
        throw new Error(`genSecret(${spec.key}): 'supabase-jwt' requiere 'role'.`);
      }
      return supabaseJwt(spec.role, requireFrom(spec, resolved));
    }
    case 'bcrypt':
      return bcryptHash(requireFrom(spec, resolved));
    default: {
      const bad = spec as SecretSpec;
      throw new Error(
        `genSecret(${bad.key}): tipo de secreto no soportado: ${String(bad.type)}`,
      );
    }
  }
}

/**
 * Genera TODOS los secretos de un manifest respetando las dependencias
 * (`from`). Primero los secretos base (sin `from`) y luego los derivados,
 * por rondas hasta el punto fijo. Detecta claves duplicadas y dependencias
 * faltantes o circulares.
 */
export async function genAll(manifest: ManifestSecrets): Promise<SecretMap> {
  const specs = manifest.secrets ?? [];
  const resolved: SecretMap = {};

  const seen = new Set<string>();
  for (const spec of specs) {
    if (!spec.key) {
      throw new Error('genAll: hay un secreto sin "key" en el manifest.');
    }
    if (seen.has(spec.key)) {
      throw new Error(`genAll: clave de secreto duplicada: ${spec.key}`);
    }
    seen.add(spec.key);
  }

  // 1) Secretos base (sin dependencias): orden irrelevante.
  for (const spec of specs.filter((s) => s.from === undefined)) {
    resolved[spec.key] = await genSecret(spec, resolved);
  }

  // 2) Secretos derivados: resolver por rondas hasta punto fijo.
  let pending = specs.filter((s) => s.from !== undefined);
  while (pending.length > 0) {
    const ready = pending.filter((s) => resolved[s.from as string] !== undefined);
    if (ready.length === 0) {
      const missing = pending.map((s) => `${s.key}←${String(s.from)}`).join(', ');
      throw new Error(
        `genAll: dependencias de secretos irresolubles (faltantes o circulares): ${missing}`,
      );
    }
    for (const spec of ready) {
      resolved[spec.key] = await genSecret(spec, resolved);
    }
    const done = new Set(ready.map((s) => s.key));
    pending = pending.filter((s) => !done.has(s.key));
  }

  return resolved;
}

/**
 * Describe los secretos que se generarían, SIN generarlos ni exponer
 * valores. Alimenta la UX del modo plan/dry-run (el modo por defecto).
 */
export function planSecrets(manifest: ManifestSecrets): SecretPlanEntry[] {
  return (manifest.secrets ?? []).map((spec) => ({
    key: spec.key,
    type: spec.type,
    detail: describeSecret(spec),
  }));
}

/** Texto legible en español para un secreto (sin exponer su valor). */
export function describeSecret(spec: SecretSpec): string {
  switch (spec.type) {
    case 'hex':
      return `${spec.bytes ?? '?'} bytes aleatorios en hex (${bitsOf(spec.bytes)})`;
    case 'base64url':
      return `${spec.bytes ?? '?'} bytes aleatorios en base64url (${bitsOf(spec.bytes)})`;
    case 'supabase-jwt':
      return `JWT HS256 rol '${spec.role ?? '?'}' firmado con ${spec.from ?? '?'}`;
    case 'bcrypt':
      return `hash bcrypt (coste ${BCRYPT_ROUNDS}) de ${spec.from ?? '?'}`;
    default:
      return 'secreto';
  }
}

// ----------------------------------------------------------------------------
// Helpers internos
// ----------------------------------------------------------------------------

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function assertBytes(bytes: number, who: string): void {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new Error(`${who}: 'bytes' debe ser un entero positivo (recibido: ${String(bytes)}).`);
  }
}

function requireBytes(spec: SecretSpec): number {
  if (spec.bytes === undefined) {
    throw new Error(`genSecret(${spec.key}): el tipo '${spec.type}' requiere 'bytes'.`);
  }
  return spec.bytes;
}

function requireFrom(spec: SecretSpec, resolved: SecretMap): string {
  if (!spec.from) {
    throw new Error(`genSecret(${spec.key}): el tipo '${spec.type}' requiere 'from'.`);
  }
  const value = resolved[spec.from];
  if (value === undefined) {
    throw new Error(
      `genSecret(${spec.key}): no se pudo resolver 'from' = '${spec.from}' (¿aún no generado?).`,
    );
  }
  return value;
}

function bitsOf(bytes: number | undefined): string {
  return bytes === undefined ? '?-bit' : `${bytes * 8}-bit`;
}

// ----------------------------------------------------------------------------
// Carga perezosa de bcryptjs (única dependencia npm; bcrypt en JS puro)
// ----------------------------------------------------------------------------

interface BcryptLib {
  hashSync(data: string, salt: string | number): string;
  genSaltSync(rounds?: number): string;
}

async function loadBcrypt(): Promise<BcryptLib> {
  try {
    const mod = (await import('bcryptjs')) as unknown as
      { default?: BcryptLib } & Partial<BcryptLib>;
    const lib = (mod.default ?? (mod as BcryptLib));
    if (typeof lib.hashSync !== 'function' || typeof lib.genSaltSync !== 'function') {
      throw new Error('API de bcryptjs inesperada.');
    }
    return lib;
  } catch (err) {
    throw new Error(
      "bcryptHash requiere la dependencia 'bcryptjs' (bcrypt en JS puro, sin build nativo). " +
        'Instálala con:  npm i bcryptjs  — es la única dependencia npm del módulo de secretos. ' +
        `Causa: ${(err as Error).message}`,
    );
  }
}
