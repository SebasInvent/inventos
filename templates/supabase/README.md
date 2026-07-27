# Supabase — Plantilla endurecida InventOS

Supabase self-hosted completo como **stack de Docker Swarm** (1 nodo) detrás de **Traefik v3** con TLS
automático (`letsencryptresolver`). Es "el grande": trece servicios orquestados que juntos dan
base de datos Postgres, autenticación, API REST y GraphQL, Realtime, Storage con transformación de
imágenes, Edge Functions y un dashboard de administración (Studio).

> Regla de oro de InventOS: **seguro de fábrica**. Ningún secreto real vive en este repo, ningún panel
> admin queda expuesto sin auth, ninguna base de datos publica puerto al host.

---

## Qué incluye

| Servicio | Imagen (tag fijo) | Rol | Exposición |
|---|---|---|---|
| `db` | `supabase/postgres:15.8.1.020` | Postgres (con WAL lógico para Realtime) | **Interno** |
| `analytics` | `supabase/logflare:1.4.0` | Sink de logs (Logflare) | **Interno** |
| `vector` | `timberio/vector:0.28.1-alpine` | Recolector de logs de Docker | **Interno** |
| `supavisor` | `supabase/supavisor:1.1.56` | Pooler de conexiones | **Interno** |
| `auth` | `supabase/gotrue:v2.164.0` | Autenticación (GoTrue) | Interno (vía Kong `/auth/v1`) |
| `rest` | `postgrest/postgrest:v12.2.3` | API REST/GraphQL | Interno (vía Kong `/rest/v1`) |
| `realtime` | `supabase/realtime:v2.33.70` | Suscripciones en vivo | Interno (vía Kong `/realtime/v1`) |
| `storage` | `supabase/storage-api:v1.14.5` | Almacenamiento de objetos | Interno (vía Kong `/storage/v1`) |
| `imgproxy` | `darthsim/imgproxy:v3.8.0` | Transformación de imágenes | **Interno** |
| `meta` | `supabase/postgres-meta:v0.84.2` | API de metadatos para Studio | **Interno** |
| `functions` | `supabase/edge-runtime:v1.66.5` | Edge Functions (Deno) | Interno (vía Kong `/functions/v1`) |
| `kong` | `kong:2.8.1` | **API gateway** | **Público** → router `supabase_api` |
| `studio` | `supabase/studio:20241202-71e5240` | **Dashboard admin** | **Público** → router `supabase_studio` (**basicauth**) |

Solo dos superficies públicas:

- **API** en `https://${API_SUBDOMAIN}.${ROOT_DOMAIN}` (por defecto `api.…`). Va a Kong; la
  autenticación es por JWT (`anon` / `service_role`), que es el modelo de seguridad nativo de Supabase.
- **Studio** en `https://${STUDIO_SUBDOMAIN}.${ROOT_DOMAIN}` (por defecto `studio.…`), **protegido por
  un middleware `basicauth` de Traefik**.

---

## Endurecimiento aplicado (checklist de reglas)

1. **Cero secretos reales (regla #1).** Todos los valores sensibles son tokens `${VAR}` que el motor de
   InventOS genera en el deploy. Ningún default de upstream con contraseña/clave sobrevive: `POSTGRES_PASSWORD`,
   `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `DASHBOARD_PASSWORD`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`
   y los tokens de Logflare son todos `${...}`.
2. **Studio nunca público sin login (regla #2 — la lección crítica de la auditoría).** El router
   `supabase_studio` lleva el middleware `supabase_studio_auth` (`basicauth` de Traefik) con
   `${STUDIO_USER}:${STUDIO_PASS_BCRYPT}`. Sin credenciales válidas, el dashboard ni siquiera responde.
   *Esta es exactamente la brecha que la auditoría del server encontró (Studio expuesto sin login) y que
   esta plantilla cierra por diseño.*
3. **DB/cache nunca publican puerto al host (regla #3).** `db` no tiene `ports:`. Además el pooler
   `supavisor` **tampoco** publica `5432/6543`: se mantiene interno para no exponer una vía de acceso
   directo a la base. Todo el tráfico interno viaja por la red overlay cifrada. El puerto **admin de Kong
   (8001)** no se publica: Traefik solo enruta el `8000` (proxy).
4. **Secretos fuertes (regla #4).** Llaves ≥256-bit (`hex 32` / `base64url 64`); el basicauth de Studio
   usa **bcrypt** (`STUDIO_PASS_BCRYPT`). `ANON_KEY` y `SERVICE_ROLE_KEY` son JWT HS256 firmados con
   `JWT_SECRET` (tipo `supabase-jwt` en el manifest).
5. **TLS en todo (regla #5).** Ambos routers públicos usan `entrypoints=websecure` +
   `tls.certresolver=letsencryptresolver`. El redirect global HTTP→HTTPS lo aporta el stack de Traefik.
6. **Tags de imagen fijos (regla #6).** Ninguna imagen usa `:latest`; todas van pinneadas.
7. **`replicas: 1` + placement manager (regla #7).** Vía el anchor `x-deploy-defaults`, cada servicio
   corre replicado a 1 en `node.role == manager`, con `restart_policy: any`.

---

## Secretos que genera el motor

| Secreto | Tipo | Notas |
|---|---|---|
| `POSTGRES_PASSWORD` | hex 32 (256-bit) | Password de Postgres |
| `JWT_SECRET` | hex 32 | Raíz de firma HS256 |
| `ANON_KEY` | supabase-jwt (`anon`, desde `JWT_SECRET`) | JWT público para clientes |
| `SERVICE_ROLE_KEY` | supabase-jwt (`service_role`, desde `JWT_SECRET`) | JWT privilegiado — trátalo como secreto |
| `DASHBOARD_PASSWORD` | base64url 24 | Dashboard interno de Kong |
| `SECRET_KEY_BASE` | base64url 64 | Sesiones Phoenix (Realtime/Supavisor) |
| `VAULT_ENC_KEY` | base64url 32 | Cifrado del vault de Supavisor |
| `DB_ENC_KEY` | hex 8 (16 chars / 128-bit) | Clave AES de Realtime (el campo exige exactamente 16 caracteres) |
| `LOGFLARE_PUBLIC_ACCESS_TOKEN` | base64url 32 | Ingesta de Vector |
| `LOGFLARE_PRIVATE_ACCESS_TOKEN` | base64url 32 | Studio / analytics |
| `STUDIO_PASS` | base64url 24 | Password en claro del basicauth (se muestra una vez) |
| `STUDIO_PASS_BCRYPT` | bcrypt (desde `STUDIO_PASS`) | Hash para el label de Traefik |

> **Nota de escape bcrypt:** el hash bcrypt contiene `$`. En el YAML **renderizado** que consume
> `docker stack deploy`, cada `$` del hash debe emitirse como `$$` (de lo contrario Docker lo interpreta
> como interpolación de variable). El motor (`secrets.ts` / `render.ts`) es el responsable de este escape.

`SMTP_PASS` **no** lo genera el motor: es una credencial externa provista por el operador (param
`sensitive`). Si `SMTP_HOST` queda vacío, el envío de emails queda deshabilitado y Auth funciona igual
para pruebas.

---

## Assets de bootstrap (no-secretos)

Supabase self-hosted necesita unos ficheros de arranque que **no** contienen secretos pero sí son
imprescindibles (crean roles, esquemas `_realtime`/`storage`, base `_supabase`, config de Kong, Vector y
el pooler). Se toman del repo oficial de Supabase **en la versión aquí fijada** y se colocan en el server,
en la ruta del param `SUPABASE_ASSETS_DIR` (por defecto `/opt/inventos/supabase`):

```
${SUPABASE_ASSETS_DIR}/
  db/realtime.sql  db/webhooks.sql  db/roles.sql  db/jwt.sql
  db/_supabase.sql db/logs.sql      db/pooler.sql
  api/kong.yml            # config declarativa de Kong (usa ${SUPABASE_ANON_KEY}/${SUPABASE_SERVICE_KEY})
  logs/vector.yml         # pipeline de Vector → Logflare
  pooler/pooler.exs       # arranque de Supavisor
  functions/main/index.ts # entrypoint de Edge Functions
```

El motor de deploy debe subir este directorio al server antes de `docker stack deploy`. Son ficheros
públicos del proyecto Supabase; los secretos que consumen llegan por variables de entorno en el deploy.

---

## Parámetros principales

- `ROOT_DOMAIN` (obligatorio): dominio raíz. Los DNS `api.` y `studio.` (o los subdominios elegidos) deben
  apuntar (A-record) a la IP del VPS **antes** del deploy, para que el challenge HTTP-01 emita el certificado.
- `NETWORK` (`inventnet`): nombre de la red overlay externa compartida. La crea el stack de `traefik`
  (dependencia `requires: traefik`); todos los stacks de InventOS se unen a ella. Cámbialo solo si tu
  base usa otro nombre de red.
- `API_SUBDOMAIN` (`api`), `STUDIO_SUBDOMAIN` (`studio`).
- `STUDIO_USER` (`admin`): usuario del `basicauth` de Traefik que protege Studio. Su contraseña
  (`STUDIO_PASS`) la **genera el motor** y se muestra una sola vez; el hash bcrypt (`STUDIO_PASS_BCRYPT`)
  es lo que viaja al label de Traefik.
- `SITE_URL` / `ADDITIONAL_REDIRECT_URLS`: base y allow-list de redirects de Auth.
- `DISABLE_SIGNUP`, `ENABLE_EMAIL_*`, `ENABLE_PHONE_*`: política de registro.
- `SMTP_*`: servidor de correo saliente (opcional).
- `FUNCTIONS_VERIFY_JWT`: exige JWT válido en Edge Functions (recomendado `true`).

---

## Despliegue

Lo orquesta el motor de InventOS (modo `plan`/dry-run por defecto; deploy real con `--apply` + target
explícito). El flujo conceptual:

1. `preflight`: Docker + `swarm init`, red overlay `${NETWORK}`, DNS de `api.`/`studio.`, puertos 80/443.
2. `secrets`: genera todos los secretos de arriba (incluido el JWT anon/service desde `JWT_SECRET` y el
   bcrypt de Studio).
3. `render`: rellena `stack.yml.tmpl` → YAML concreto.
4. Subir los assets a `SUPABASE_ASSETS_DIR` en el server.
5. `deploy`: `docker stack deploy -c supabase.yml supabase` y esperar convergencia (empezando por `db`).
6. `report`: muestra **una sola vez** las credenciales (`credentialsOut`) y las guarda en el archivo de
   recuperación local.

**Requiere** que el stack de `traefik` ya exista (red overlay + entrypoints + certresolver).

---

## Post-deploy (operación)

- Guarda `SERVICE_ROLE_KEY` como lo que es: **acceso total** a la base, saltándose RLS. Nunca lo pongas en
  un cliente/navegador; en el front usa solo `ANON_KEY` con Row Level Security activo.
- El acceso a Studio es por las credenciales `STUDIO_USER` / `STUDIO_PASS` del basicauth de Traefik.
- Si necesitas acceso directo a Postgres desde fuera (psql, un ORM externo), **no** publiques el puerto en
  esta plantilla: hazlo de forma deliberada y acotada (túnel SSH o una regla de firewall específica),
  siguiendo el principio de mínima exposición.
- Refuerza el server: `fail2ban`, SSH solo por llave, backups del volumen `db-data`.
