# InventOS — Arquitectura & Spec de Plantillas (v1)

> Backbone técnico de la Fase 1: formato de plantillas endurecidas + motor de deploy.
> Regla de oro: **seguro de fábrica**. Ningún secreto real vive en el repo; ningún panel admin queda expuesto sin auth; ninguna base de datos publica puerto al host.

## 1. Arquitectura de despliegue

- **Docker Swarm de un nodo** (probado en el server de Invent). `docker swarm init` si no está activo.
- **Traefik v3** como único servicio con puertos publicados al host (`80`, `443`). Provider `swarm`. Entrypoints `web`(80)→redirect→`websecure`(443). Certresolver `letsencryptresolver` (HTTP-01 challenge).
- **Red overlay compartida** (nombre configurable, default `inventnet`, `attachable`, `encrypted`). Todos los stacks se unen a ella. Los servicios internos (DB, cache) **solo** hablan por esta red.
- Cada app = un **stack de Swarm** desplegado con `docker stack deploy -c <rendered>.yml <name>`.
- Compatible con Portainer (mismo formato que ya corre el server).

## 2. Formato de plantilla

Cada app vive en `templates/<id>/`:

```
templates/<id>/
  stack.yml.tmpl    # docker stack (compose 3.8) con tokens ${PLACEHOLDER}
  manifest.json     # metadatos que el motor consume
  README.md         # qué es + qué se endureció
```

### 2.1 `manifest.json` (esquema)

```jsonc
{
  "id": "supabase",
  "name": "Supabase",
  "role": "DB + Auth + Storage + API",
  "category": "backend",
  "requires": ["traefik"],                 // deps: otros ids que deben existir
  "params": [                              // valores por receta/usuario
    { "key": "STUDIO_SUBDOMAIN", "prompt": "Subdominio del Studio", "default": "db" }
  ],
  "secrets": [                             // el motor los GENERA en deploy; nunca en el repo
    { "key": "POSTGRES_PASSWORD", "type": "hex", "bytes": 32 },
    { "key": "JWT_SECRET",        "type": "hex", "bytes": 32 },
    { "key": "ANON_KEY",          "type": "supabase-jwt", "role": "anon",         "from": "JWT_SECRET" },
    { "key": "SERVICE_ROLE_KEY",  "type": "supabase-jwt", "role": "service_role", "from": "JWT_SECRET" }
  ],
  "adminAuth": [                           // paneles que el motor protege con basicauth de Traefik
    { "router": "supabase_studio", "user": "STUDIO_USER", "pass": "STUDIO_PASS" }
  ],
  "exposes": [                             // routers públicos (Traefik + TLS)
    { "name": "studio", "subdomainParam": "STUDIO_SUBDOMAIN", "servicePort": 3000 }
  ],
  "internalOnly": ["supabase_db"],         // servicios sin ruta pública
  "healthcheck": { "service": "supabase_db", "cmd": "pg_isready" },
  "credentialsOut": ["STUDIO_USER", "STUDIO_PASS", "SERVICE_ROLE_KEY"]  // se muestran 1 vez al final
}
```

### 2.2 `stack.yml.tmpl`

- `version: "3.8"`, servicios en `deploy` mode replicated, `replicas: 1`, `placement: node.role == manager`.
- Labels de Traefik en `deploy.labels` (provider swarm lee labels de servicio).
- Tokens `${VAR}` para todo secreto/param. El motor los rellena por interpolación de env.
- **Ningún valor de secreto literal.** Si upstream trae un default, se reemplaza por `${...}`.
- Imágenes con **tag fijo** (nunca `:latest` en v1 — reproducibilidad y supply-chain).
- Se une a la red overlay externa `${NETWORK}`.

## 3. Reglas de endurecimiento (OBLIGATORIAS)

1. **Cero secretos reales** en plantillas — solo `${...}` que el motor genera en deploy.
2. **Todo panel admin tras auth**: o el login propio y obligatorio de la app (n8n, Portainer, MinIO console) **o** un middleware `basicauth` de Traefik (Supabase Studio ← lección de la auditoría del server). Nunca una superficie admin pública sin auth.
3. **DB/cache nunca publican puerto al host** (`ports:` prohibido para postgres/redis); solo red overlay interna.
4. **Secretos fuertes**: ≥256-bit para llaves; **bcrypt** para basicauth.
5. **TLS en todo** vía `letsencryptresolver`; redirect HTTP→HTTPS global.
6. **Tags de imagen fijos**, no `:latest`.
7. `deploy.replicas: 1`, placement manager; sin privilegios innecesarios.

## 4. Convención de secretos

- El motor genera secretos en el momento del deploy (crypto seguro).
- Se guardan en la **máquina del operador** en `.inventos/<project>/secrets.env` (chmod 600), nunca en el repo ni en el server destino más de lo necesario.
- Se inyectan por env-interpolation al renderizar el stack.
- Los `credentialsOut` se muestran **una sola vez** al final + se guardan en un archivo de recuperación local.

## 5. Motor de deploy (`src/engine/`, TypeScript, ejecutable por npx)

| Módulo | Responsabilidad |
|---|---|
| `target.ts` | Conexión al VPS destino vía cliente `ssh`/`scp` del sistema (child_process): correr comandos remotos, subir archivos renderizados. |
| `preflight.ts` | Verificar/instalar Docker, `swarm init`, crear red overlay, chequear DNS (A-records → IP del VPS), puertos 80/443 libres. |
| `secrets.ts` | Generadores crypto (hex, base64url, bcrypt) + JWT de Supabase (anon/service HS256 desde `JWT_SECRET`). |
| `render.ts` | Leer manifest, resolver deps (orden topológico), juntar params, generar secretos, renderizar `stack.yml.tmpl` → YAML concreto. |
| `deploy.ts` | `docker stack deploy` en orden de deps, esperar convergencia (`docker service ls/ps`), rollback en fallo. |
| `report.ts` | Mostrar URLs + credenciales una vez, próximos pasos (fail2ban, SSH solo-llave, backups), escribir archivo de recuperación. |
| `plan.ts` | **Dry-run**: mostrar todo lo que se HARÍA (alimenta la UX del v0). |

- **Seguridad de operación**: el modo por defecto es **plan/dry-run**. El deploy real exige `--apply` + target explícito. Nunca toca la infra propia del operador.
- Dependencia externa aceptada en Fase 1: cliente `ssh`/`scp` del sistema (documentado). El resto, stdlib de Node.

## 6. Catálogo v1 (9 apps)

`traefik` (base/proxy), `postgres`, `redis`, `supabase` (multi-servicio), `n8n`, `evolution` (WhatsApp), `minio`, `portainer`, `typebot`.

## 7. Recetas (composición)

Definidas en `src/recipes.mjs`. Una receta = lista ordenada de ids; el motor resuelve deps y despliega en orden. Ej: `agencia` = traefik → postgres → redis → supabase → minio → n8n → evolution → portainer.
