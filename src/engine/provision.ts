// InventOS — motor de deploy · provision.ts (aprovisionamiento de dependencias).
//
// Algunas apps (n8n, evolution) piden en su manifest un secreto con
// `provisionIn: "postgres"`: no comparten el superusuario, sino que necesitan un
// ROL + BASE de datos DEDICADOS creados en el Postgres del stack indicado, con la
// contraseña que el motor generó para esa app. Este módulo arma esos pasos.
//
// SEGURIDAD: el SQL (que incluye la contraseña nueva) y la contraseña del
// superusuario viajan por STDIN a `docker exec -i ... sh`, nunca por argv. Así el
// comando "imprimible" del dry-apply queda SIN secretos (igual criterio que
// target.uploadContent). Node 24 borra los tipos por type-stripping (sin build).

import type { Manifest } from './types.ts';

/** Un paso de aprovisionamiento (crear rol + base para una app). */
export interface ProvisionStep {
  /** App que necesita el rol/base (p. ej. `n8n`). */
  app: string;
  /** Stack de Postgres destino (p. ej. `postgres`). */
  onStack: string;
  /** Nombre del rol/usuario a crear. */
  role: string;
  /** Nombre de la base a crear. */
  database: string;
  /** Descripción legible para el plan. */
  description: string;
  /** Comando remoto SIN secretos (los secretos van por `input`/stdin). */
  remoteCommand: string;
  /** Script sh (con secretos) que se alimenta por stdin al comando remoto. */
  input: string;
}

/**
 * Recorre las apps en orden y arma un `ProvisionStep` por cada secreto con
 * `provisionIn`. Deriva el usuario y la base del prefijo del secreto
 * (`*_PASSWORD` → `*_USER`, `*_DATABASE`) leyendo el env ya renderizado de la app;
 * toma las credenciales del superusuario del env del stack Postgres destino.
 */
export function planProvisioning(
  order: string[],
  manifests: Record<string, Manifest>,
  renderEnv: Record<string, Record<string, string>>,
): ProvisionStep[] {
  const steps: ProvisionStep[] = [];

  for (const id of order) {
    const manifest = manifests[id];
    if (manifest?.secrets === undefined) continue;

    for (const secret of manifest.secrets) {
      const target = secret.provisionIn;
      if (target === undefined || target === '') continue;

      const env = renderEnv[id] ?? {};
      const pwKey = secret.key; // p. ej. DB_POSTGRESDB_PASSWORD
      const userKey = pwKey.replace(/PASSWORD$/, 'USER');
      const dbKey = pwKey.replace(/PASSWORD$/, 'DATABASE');

      const role = env[userKey] ?? id;
      const database = env[dbKey] ?? id;
      const password = env[pwKey] ?? '';

      const supEnv = renderEnv[target] ?? {};
      const supUser = supEnv.POSTGRES_USER ?? 'postgres';
      const supPassword = supEnv.POSTGRES_PASSWORD ?? '';
      const service = `${target}_${target}`; // stack `postgres` → servicio `postgres_postgres`

      steps.push({
        app: id,
        onStack: target,
        role,
        database,
        description: `Aprovisionar rol "${role}" + base "${database}" en Postgres (${target}) para ${id}`,
        // El id del contenedor se resuelve en el server; secretos por stdin.
        remoteCommand: `docker exec -i "$(docker ps -qf name=${service} | head -n1)" sh`,
        input: provisionScript(supUser, supPassword, provisionSql(role, database, password)),
      });
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Internos
// ---------------------------------------------------------------------------

/** SQL idempotente: crea/actualiza el rol y crea la base si no existe. */
function provisionSql(role: string, database: string, password: string): string {
  const r = sqlIdent(role);
  const d = sqlIdent(database);
  const p = sqlLiteral(password);
  return [
    `DO $ib$`,
    `BEGIN`,
    `  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN`,
    `    CREATE ROLE ${r} WITH LOGIN PASSWORD ${p};`,
    `  ELSE`,
    `    ALTER ROLE ${r} WITH LOGIN PASSWORD ${p};`,
    `  END IF;`,
    `END`,
    `$ib$;`,
    // CREATE DATABASE no corre dentro de un bloque/transacción: guardia con \\gexec.
    `SELECT 'CREATE DATABASE ${d} OWNER ${r}'`,
    `  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${sqlLiteral(database)})\\gexec`,
    `GRANT ALL PRIVILEGES ON DATABASE ${d} TO ${r};`,
  ].join('\n');
}

/**
 * Script sh que se pipea a `docker exec -i <c> sh`. La contraseña del superusuario
 * va por env dentro del contenedor (no por argv del host); el SQL por heredoc
 * `'EOSQL'` (comillado → sin expansión de shell, preserva el `$ib$` del bloque).
 */
function provisionScript(supUser: string, supPassword: string, sql: string): string {
  return [
    `set -e`,
    `export PGPASSWORD=${shQuote(supPassword)}`,
    `psql -v ON_ERROR_STOP=1 -U ${shQuote(supUser)} -h 127.0.0.1 -d postgres <<'EOSQL'`,
    sql,
    `EOSQL`,
    '',
  ].join('\n');
}

/** Identificador SQL entre comillas dobles (escapa comillas dobles). */
function sqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Literal SQL entre comillas simples (escapa comillas simples). */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Comillas simples para sh (uso dentro del script). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
