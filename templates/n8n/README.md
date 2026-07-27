# n8n — Plantilla endurecida InventOS

Automatización de flujos (workflows) auto-hospedada. Esta plantilla despliega n8n
en **modo cola (queue)**, la topología recomendada para producción:

- **main** — editor (UI), API REST y receptor de webhooks. Único servicio con
  ruta pública (vía Traefik + TLS).
- **worker** — ejecuta los workflows que toma de la cola de Redis. Sin ruta
  pública, sin puerto al host.
- **Postgres** — persistencia de workflows, credenciales (cifradas) y ejecuciones.
- **Redis** — backend de la cola Bull que reparte el trabajo main → worker.

## Dependencias (deps)

`traefik`, `postgres`, `redis`. El motor las resuelve en orden topológico y las
despliega antes que n8n. En la red overlay externa (`${NETWORK}`, default
`inventnet`) n8n encuentra a Postgres y Redis por su nombre de servicio.

## Endurecimiento aplicado

| # | Regla | Cómo se cumple aquí |
|---|-------|---------------------|
| 1 | Cero secretos reales | El `.tmpl` solo tiene tokens `${...}`. `N8N_ENCRYPTION_KEY`, `DB_POSTGRESDB_PASSWORD` y `QUEUE_BULL_REDIS_PASSWORD` los **genera el motor** en deploy (ver `manifest.json → secrets`). |
| 2 | Panel admin tras auth | n8n trae **login propio obligatorio** (User Management: la cuenta *owner* se crea en el primer arranque). No se usa `N8N_BASIC_AUTH` legado ni se desactiva el user management. Nada de admin público sin auth. |
| 3 | DB/cache sin puerto al host | Postgres y Redis viven en sus propios stacks y **solo** hablan por la red overlay interna. n8n los consume por DNS de servicio; esta plantilla no publica ningún `ports:`. |
| 4 | Secretos fuertes | `N8N_ENCRYPTION_KEY` = 256-bit (`base64url`, 32 bytes); passwords de DB y Redis = 256-bit (`hex`, 32 bytes). |
| 5 | TLS en todo | Router `websecure` + `tls.certresolver=letsencryptresolver`. El redirect global HTTP→HTTPS lo define Traefik. `N8N_PROTOCOL=https`, `WEBHOOK_URL` en https y `N8N_SECURE_COOKIE=true`. |
| 6 | Tags de imagen fijos | `n8nio/n8n:1.72.1` (nunca `:latest`). |
| 7 | `replicas:1` + placement manager | Ambos servicios: `mode: replicated`, `replicas: 1`, `node.role == manager`, con límites de memoria y `restart_policy`. |

Extras de higiene: telemetría/diagnóstico y banners apagados
(`N8N_DIAGNOSTICS_ENABLED=false`, `N8N_HIRING_BANNER_ENABLED=false`,
`N8N_PERSONALIZATION_ENABLED=false`); `N8N_PROXY_HOPS=1` para IP real de cliente
tras el proxy; `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true` (config a 600); poda
automática de ejecuciones (`EXECUTIONS_DATA_PRUNE`, 14 días); cabeceras de
seguridad en Traefik (HSTS, anti-sniff, anti-clickjacking); task runners
activados (`N8N_RUNNERS_ENABLED=true`).

## Parámetros (`params`)

| Clave | Default | Descripción |
|-------|---------|-------------|
| `N8N_SUBDOMAIN` | `lab` | Subdominio del editor → `lab.<DOMAIN>`. |
| `DB_POSTGRESDB_HOST` | `postgres` | Nombre de servicio overlay de Postgres. |
| `DB_POSTGRESDB_PORT` | `5432` | Puerto de Postgres. |
| `DB_POSTGRESDB_DATABASE` | `n8n` | Base de datos dedicada a n8n. |
| `DB_POSTGRESDB_USER` | `n8n` | Usuario de Postgres para n8n. |
| `QUEUE_BULL_REDIS_HOST` | `redis` | Nombre de servicio overlay de Redis. |
| `QUEUE_BULL_REDIS_PORT` | `6379` | Puerto de Redis. |
| `GENERIC_TIMEZONE` | `America/Bogota` | Zona horaria (IANA) de schedules y logs. |

`${DOMAIN}` y `${NETWORK}` son **globales del proyecto** (no per-app): el motor
los inyecta igual que en las demás plantillas del catálogo.

## Secretos (`secrets`) — generados por el motor

| Clave | Tipo | Nota de composición |
|-------|------|---------------------|
| `N8N_ENCRYPTION_KEY` | `base64url` / 32B | **Crítico.** Cifra las credenciales guardadas. Si se pierde, las credenciales existentes quedan irrecuperables. main y worker **comparten** la misma llave. Se incluye en `credentialsOut` para respaldarla una vez. |
| `DB_POSTGRESDB_PASSWORD` | `hex` / 32B | El motor lo **provisiona en el stack de Postgres** (`provisionIn: postgres`) creando el usuario/DB de n8n con esta clave, y lo inyecta a n8n. |
| `QUEUE_BULL_REDIS_PASSWORD` | `hex` / 32B | Debe **coincidir con el `requirepass` del stack de Redis** (`sharedWith: redis`); el motor comparte el mismo valor entre ambos stacks. |

## Primer arranque

1. Abrir `https://<N8N_SUBDOMAIN>.<DOMAIN>` → n8n pide **crear la cuenta owner**
   (email + contraseña). Ese es el login obligatorio; créala de inmediato.
2. Respaldar el `N8N_ENCRYPTION_KEY` mostrado en el reporte de deploy junto a las
   credenciales de owner (fuera del server).
3. Verificar en *Overview → Settings* que el worker aparece activo y que las
   ejecuciones se reparten a la cola.

## Notas operativas

- **Webhooks**: los recibe `main` en `WEBHOOK_URL=https://<sub>.<DOMAIN>/`. En
  esta topología mínima no se separa un servicio `webhook` dedicado; si el
  volumen lo exige, se puede añadir un tercer servicio con `command: webhook`.
- **Escalar workers**: subir `replicas` del servicio `worker` (o replicar el
  stack) reparte más ejecuciones; todos comparten `N8N_ENCRYPTION_KEY` y la cola.
- **Actualizar versión**: cambiar el tag fijo `n8nio/n8n:1.72.1` en ambos
  servicios del `.tmpl` (siempre pin explícito, nunca `:latest`) y redeployar.
- **Binary data**: se mantiene el modo por defecto (en DB). Para modo
  `filesystem` compartido main↔worker haría falta un volumen común; no se
  activa por defecto para no introducir estado compartido innecesario.
