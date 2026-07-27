# Evolution API v2 — Gateway de WhatsApp (plantilla endurecida InventOS)

Evolution API es un gateway de WhatsApp multi-instancia (basado en Baileys) con
API REST + webhooks. Sirve para conectar WhatsApp a n8n, Typebot, CRMs y flujos
propios. Esta plantilla lo despliega como stack de Docker Swarm detrás de Traefik,
**seguro de fábrica**.

## Qué levanta

| Servicio    | Imagen (tag fijo)              | Puerto interno | Público |
|-------------|--------------------------------|----------------|---------|
| `evolution` | `evoapicloud/evolution-api:v2.2.3` | 8080           | Sí (Traefik + TLS) |

Depende de los stacks **traefik**, **postgres** y **redis**, todos en la misma
red overlay `${NETWORK}` (default `inventnet`).

- **URL pública:** `https://${EVO_SUBDOMAIN}.${DOMAIN}` (subdominio default `wa`).
- **Manager (UI):** `https://${EVO_SUBDOMAIN}.${DOMAIN}/manager` — pide la API key para entrar.
- **Persistencia:** volumen `evolution_instances` (sesiones/instancias de WhatsApp).

## Qué se endureció

1. **Cero secretos en el repo.** El único secreto propio es `AUTHENTICATION_API_KEY`,
   representado por el token `${EVOLUTION_API_KEY}`. El motor de InventOS genera una
   clave **hex de 32 bytes (256-bit)** en el deploy. La plantilla no contiene ningún
   valor literal.
2. **Panel admin tras auth (login propio de la app).** El manager en `/manager` y
   **todos** los endpoints de la API exigen la `apikey`. Sin ella no se puede crear,
   ver ni operar ninguna instancia. Por eso no se añade basicauth de Traefik: la
   propia app ya cierra la superficie admin (a diferencia del caso Supabase Studio,
   que sí necesita basicauth porque no trae login propio).
   `AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES` queda en `false` para no filtrar la
   key al listar instancias.
3. **DB y cache sin puerto al host.** Postgres y Redis se consumen solo por la red
   overlay interna (`postgres:5432`, `redis:6379`). Esta plantilla **no** declara
   `ports:`; nada de Evolution se publica salvo por Traefik.
4. **Secretos fuertes.** La API key es de 256-bit. Las credenciales de Postgres y
   Redis (`${POSTGRES_PASSWORD}`, `${REDIS_PASSWORD}`) son secretos generados por
   sus propios stacks; aquí se referencian por token, nunca en claro. La conexión a
   Redis viaja con password (`redis://default:${REDIS_PASSWORD}@...`).
5. **TLS en todo.** El router usa `entrypoints=websecure`, `tls=true` y
   `certresolver=letsencryptresolver`. El redirect HTTP->HTTPS lo fuerza Traefik
   de forma global.
6. **Tag de imagen fijo:** `v2.1.1`, jamás `:latest` (reproducibilidad + supply-chain).
7. **`replicas: 1`** y `placement: node.role == manager`; sin privilegios extra ni
   `ports:` publicados.

## Parámetros

| Param            | Prompt                                   | Default     |
|------------------|------------------------------------------|-------------|
| `EVO_SUBDOMAIN`  | Subdominio de Evolution API              | `wa`        |
| `EVOLUTION_DB`   | Base de datos de Evolution en Postgres   | `evolution` |

## Secretos (generados por el motor)

| Secreto              | Tipo    | Fuerza          | Se muestra 1 vez |
|----------------------|---------|-----------------|------------------|
| `EVOLUTION_API_KEY`  | hex     | 32 bytes (256-bit) | Sí (`credentialsOut`) |

## Valores que consume de sus dependencias

Estos NO son secretos de Evolution: el motor los resuelve de los stacks `postgres`
y `redis` (orden topológico de deps) y los inyecta al renderizar.

- `DOMAIN`, `NETWORK` — globales.
- `POSTGRES_HOST` (`postgres`), `POSTGRES_USER` (`postgres`), `POSTGRES_PASSWORD` — del stack postgres.
- `REDIS_HOST` (`redis`), `REDIS_PASSWORD` — del stack redis.

> **Requisito de la base de datos:** Evolution corre migraciones (Prisma) al
> arrancar, pero la base `${EVOLUTION_DB}` debe existir en Postgres. Créala una vez
> (o deja que la reciba el stack postgres), p. ej.:
> `CREATE DATABASE evolution;`

## Post-deploy

1. Entrá a `https://${EVO_SUBDOMAIN}.${DOMAIN}/manager`, pegá la `EVOLUTION_API_KEY`
   que mostró el instalador y creá tu primera instancia (escaneás el QR con WhatsApp).
2. Guardá la API key en tu gestor de secretos: es la llave maestra de todas las
   instancias.
3. Para automatizar, apuntá los webhooks/HTTP de n8n o Typebot a esta URL con el
   header `apikey`.
4. Endurecimiento del host (recomendado por InventOS): fail2ban, SSH solo-llave y
   backups del volumen `evolution_instances` + de la base `${EVOLUTION_DB}`.
