# Typebot — Constructor de chatbots (plantilla endurecida InventOS)

Typebot es un constructor visual de chatbots conversacionales. Se despliega en
**dos servicios**: el **builder** (la UI donde se arman los bots, con login) y el
**viewer** (el runtime publico que sirve los bots publicados a los usuarios
finales y se embebe en los sitios de los clientes). Esta plantilla lo levanta
como stack de Docker Swarm detras de Traefik, **seguro de fabrica**.

## Que levanta

| Servicio  | Imagen (tag fijo)                     | Puerto interno | Publico |
|-----------|---------------------------------------|----------------|---------|
| `builder` | `baptistearno/typebot-builder:2.27.0` | 3000           | Si (Traefik + TLS) — con login |
| `viewer`  | `baptistearno/typebot-viewer:2.27.0`  | 3000           | Si (Traefik + TLS) — embebible |

Depende de los stacks **traefik** y **postgres**, ambos en la misma red overlay
`${NETWORK}` (default `inventnet`).

- **Builder (panel):** `https://${TYPEBOT_BUILDER_SUBDOMAIN}.${DOMAIN}` (subdominio default `bot`).
- **Viewer (chat):** `https://${TYPEBOT_VIEWER_SUBDOMAIN}.${DOMAIN}` (subdominio default `chat`).
- **Persistencia:** toda la data vive en Postgres (base `${TYPEBOT_DB}`); los servicios son stateless.

## Que se endurecio

1. **Cero secretos en el repo.** El unico secreto propio es `ENCRYPTION_SECRET`
   (token `${ENCRYPTION_SECRET}`), que el motor de InventOS **genera en el deploy**.
   Typebot lo usa como clave AES-256-GCM y **exige exactamente 32 caracteres**: se
   generan **24 bytes en base64url = 32 chars** (256-bit de longitud de clave). La
   misma clave se comparte entre builder y viewer via un anchor YAML — si difieren,
   el viewer no puede desencriptar variables/credenciales de los bots.
2. **Panel admin tras auth (login propio de la app).** El **builder** exige iniciar
   sesion (owner por email / magic-link de Typebot). Por eso **no** se anade
   basicauth de Traefik: la app ya cierra su superficie admin (a diferencia de
   Supabase Studio, que si necesita basicauth porque no trae login propio).
   Endurecimiento extra: `ADMIN_EMAIL` fija el owner y `DISABLE_SIGNUP=true`
   cierra el registro de nuevas cuentas en el builder tras el onboarding.
3. **Postgres sin puerto al host.** La base se consume solo por la red overlay
   interna (`postgres:5432`). Esta plantilla **no** declara `ports:`; nada de
   Typebot se publica al host salvo por Traefik.
4. **Secretos fuertes.** `ENCRYPTION_SECRET` es la clave AES-256-GCM. La password
   de Postgres (`${POSTGRES_PASSWORD}`) es un secreto generado por el stack
   postgres; aqui se referencia por token, nunca en claro. Al ser hex es
   URL-safe dentro de `DATABASE_URL`.
5. **TLS en todo.** Ambos routers usan `entrypoints=websecure`, `tls=true` y
   `certresolver=letsencryptresolver`. El redirect HTTP->HTTPS lo fuerza Traefik
   de forma global.
6. **Tags de imagen fijos:** `2.27.0` en builder y viewer (mismo release), jamas
   `:latest` (reproducibilidad + supply-chain). Ajusta la version pineada segun
   necesites, manteniendo builder y viewer en la misma.
7. **`replicas: 1`** y `placement: node.role == manager` en ambos servicios; sin
   `ports:` publicados ni privilegios extra. Limites de memoria por servicio.
8. **Cabeceras de seguridad diferenciadas.** El **builder** lleva HSTS +
   `contentTypeNosniff` + `frameDeny` (anti-clickjacking: el panel admin no debe
   embeberse). El **viewer** lleva HSTS + `contentTypeNosniff` **pero sin
   `frameDeny`**, porque el chat esta disenado para embeberse en iframes de los
   sitios de los clientes.

## Parametros

| Param                         | Prompt                                                        | Default   |
|-------------------------------|--------------------------------------------------------------|-----------|
| `TYPEBOT_BUILDER_SUBDOMAIN`   | Subdominio del builder                                       | `bot`     |
| `TYPEBOT_VIEWER_SUBDOMAIN`    | Subdominio del viewer                                        | `chat`    |
| `TYPEBOT_DB`                  | Base de datos de Typebot en Postgres                         | `typebot` |
| `ADMIN_EMAIL`                 | Email del administrador/owner                                | (vacio)   |
| `DISABLE_SIGNUP`              | Cerrar el registro en el builder (`true` tras onboarding)    | `false`   |
| `SMTP_HOST`                   | Host SMTP para el login por email                            | (vacio)   |
| `SMTP_PORT`                   | Puerto SMTP                                                  | `587`     |
| `SMTP_USERNAME`               | Usuario SMTP                                                 | (vacio)   |
| `SMTP_PASSWORD`               | Password SMTP (credencial del operador, no se genera)       | (vacio)   |
| `SMTP_SECURE`                 | TLS directo (`true` para 465, `false` para STARTTLS en 587) | `false`   |
| `NEXT_PUBLIC_SMTP_FROM`       | Remitente de los emails                                     | (vacio)   |

## Secretos (generados por el motor)

| Secreto             | Tipo      | Fuerza                              | Se muestra 1 vez |
|---------------------|-----------|-------------------------------------|------------------|
| `ENCRYPTION_SECRET` | base64url | 24 bytes -> 32 chars (clave AES-256)| Si (`credentialsOut`) |

> El motor comparte el **mismo** `ENCRYPTION_SECRET` entre builder y viewer.

## Valores que consume de sus dependencias

No son secretos de Typebot: el motor los resuelve del stack `postgres` (orden
topologico de deps) y los inyecta al renderizar.

- `DOMAIN`, `NETWORK` — globales.
- `POSTGRES_HOST` (`postgres`), `POSTGRES_USER` (`postgres`), `POSTGRES_PASSWORD` — del stack postgres.

> **Requisito de la base de datos:** la base `${TYPEBOT_DB}` debe existir en
> Postgres antes del primer arranque. Typebot corre sus migraciones (Prisma) al
> iniciar. Crea la base una vez, p. ej.: `CREATE DATABASE typebot;`

## Sobre el login por email (SMTP)

El unico metodo de login documentado en esta plantilla es **email / magic-link**,
que **requiere SMTP**. Sin SMTP configurado el builder arranca igual, pero no
podras iniciar sesion por email. Para habilitarlo:

1. Completa `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
   `SMTP_SECURE` y `NEXT_PUBLIC_SMTP_FROM` (remitente).
2. Pon tu correo en `ADMIN_EMAIL` para recibir privilegios de administrador al
   registrarte.

## Post-deploy

1. Entra a `https://${TYPEBOT_BUILDER_SUBDOMAIN}.${DOMAIN}`, registrate con el
   email de `ADMIN_EMAIL` (llega un magic-link por SMTP) y crea tu primer bot.
2. Publica el bot: quedara servido por el **viewer** en
   `https://${TYPEBOT_VIEWER_SUBDOMAIN}.${DOMAIN}` y podras embeberlo en el sitio
   del cliente (el viewer permite iframes a proposito).
3. **Endurecimiento recomendado:** una vez creado tu usuario admin, pon
   `DISABLE_SIGNUP=true` y re-despliega para que nadie mas registre cuentas en el
   builder publico.
4. Los bloques de subida de archivos requieren almacenamiento S3 (p. ej. el stack
   `minio`): se cablea por env `S3_*` cuando lo necesites (fuera del alcance base
   de esta plantilla).
5. Endurecimiento del host (recomendado por InventOS): fail2ban, SSH solo-llave y
   backups de la base `${TYPEBOT_DB}` en Postgres.
