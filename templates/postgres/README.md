# PostgreSQL — plantilla endurecida (InventOS)

**PostgreSQL 16 standalone.** Base de datos para las apps del catálogo que necesitan la suya propia (n8n, Evolution API, Typebot). Se despliega como stack de Swarm, vive **solo en la red overlay interna** y nunca expone un puerto al host.

## Qué hace

- Un servicio `postgres` (imagen oficial, tag fijo `postgres:16.6`).
- Datos persistentes en un volumen nombrado (`postgres_data`).
- Alcanzable únicamente **dentro de la red overlay** por su nombre de servicio Swarm; el motor conecta la app consumidora (n8n, etc.) inyectándole el host/credenciales.

## Parámetros

| Token | Qué es | Default |
|---|---|---|
| `POSTGRES_USER` | Usuario de la base de datos | `postgres` |
| `POSTGRES_DB` | Nombre de la base de datos | `app` |
| `NETWORK` | Red overlay externa compartida (global de InventOS) | `inventnet` |

## Secretos (los genera el motor, nunca viven en el repo)

| Token | Tipo | Fuerza |
|---|---|---|
| `POSTGRES_PASSWORD` | `hex` · 32 bytes | 256-bit |

El motor genera el password en el momento del deploy, lo guarda en la máquina del operador (`.inventos/<project>/secrets.env`, chmod 600) y lo muestra **una sola vez** al final. En Postgres 16 el password se almacena con `scram-sha-256` por defecto.

## Endurecimiento aplicado

1. **Cero secretos literales** — el único secreto es `${POSTGRES_PASSWORD}`, generado en deploy. No hay ningún default de password en la plantilla (regla 1).
2. **Sin puerto al host** — no existe bloque `ports:`. La DB solo habla por la red overlay interna; nada queda expuesto a internet (regla 3).
3. **Password fuerte** — hex de 32 bytes = 256-bit (regla 4).
4. **Tag de imagen fijo** — `postgres:16.6`, jamás `:latest` (regla 6).
5. **`replicas: 1` + placement en manager** (regla 7); servicio con estado, `update_config: stop-first` para no pelear por el volumen en una actualización.
6. **Healthcheck** `pg_isready -U <user> -d <db>` con `start_period` para el arranque inicial.
7. **Robustez de datos** — `PGDATA` en un subdirectorio del volumen (evita conflictos con el punto de montaje) e `--data-checksums` para detectar corrupción silenciosa en disco.
8. **Apagado limpio** — `stop_grace_period: 1m` da tiempo al shutdown de Postgres antes de forzar el kill.

> No aplica auth de panel (regla 2): Postgres no tiene panel admin web. Su superficie de acceso es el propio puerto de la DB, que aquí **nunca** se publica — la única protección necesaria es red interna + password fuerte, ambas presentes.

## Cómo lo consume otra app

Cada app que necesita su propia DB despliega **su propia instancia** de esta plantilla (no se comparte un alias global, para evitar colisiones de DNS entre stacks). El motor resuelve el host de la DB (nombre de servicio Swarm en la red overlay) y lo inyecta en la app consumidora junto con `POSTGRES_USER` / `POSTGRES_DB` / `POSTGRES_PASSWORD`.

## Cambiar la versión

El tag está pinneado a `postgres:16.6` por reproducibilidad. Para subir de minor, editá `image:` en `stack.yml.tmpl` a otro tag fijo de la serie 16.x (nunca floating ni `:latest`). Un salto de major (17) requiere migración de datos con `pg_upgrade` o dump/restore.
