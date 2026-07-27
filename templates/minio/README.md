# MinIO — Plantilla endurecida (InventOS)

Servidor de **almacenamiento de objetos compatible con S3** (la API de AWS S3).
Sirve archivos/backups/media a otras apps del catalogo y a clientes externos via
la API S3, y trae una **consola web** de administracion.

Expone dos superficies, cada una en su propio subdominio con TLS via Traefik:

| Superficie | Puerto interno | Subdominio (default) | Auth |
|-----------|----------------|----------------------|------|
| API S3    | 9000 | `${MINIO_API_SUBDOMAIN}` → `files` | Firma AWS SigV4 (access key / secret) |
| Consola   | 9001 | `${MINIO_CONSOLE_SUBDOMAIN}` → `files-console` | Login propio de MinIO |

`requires: traefik` — necesita el proxy base para el TLS y el enrutado.

## Como se conectan otras apps (cliente S3)

Desde cualquier stack unido a la red `${NETWORK}`, o desde clientes externos:

- **Endpoint (interno, mismo Swarm):** `http://minio:9000`
- **Endpoint (publico / externo):** `https://${MINIO_API_SUBDOMAIN}.${BASE_DOMAIN}`
- **Access key:** `${MINIO_ROOT_USER}` (generado por el motor en el deploy)
- **Secret key:** `${MINIO_ROOT_PASSWORD}` (generado por el motor en el deploy)
- **Region:** `us-east-1` (valor por convencion; MinIO lo ignora)
- **Force path style:** `true` (MinIO usa rutas `/bucket`, no virtual-host)

> Para produccion se recomienda **no** repartir la credencial root: crea un
> usuario/policy IAM por app desde la consola o con `mc admin user add`.

## Que se endurecio

| # | Regla | Como se aplica aqui |
|---|-------|---------------------|
| 1 | Cero secretos reales | `MINIO_ROOT_USER` y `MINIO_ROOT_PASSWORD` viven solo como tokens `${...}`. Reemplazan el default publico de upstream (`minioadmin`/`minioadmin`). Los genera el motor en deploy y se declaran en `manifest.secrets`. |
| 2 | Admin tras auth | La **consola** (9001) queda detras del **login propio de MinIO**: nadie entra sin credenciales root o un usuario IAM. La API S3 (9000) exige firma SigV4 en cada request. Sin acceso anonimo por default. |
| 3 | DB/cache sin puerto al host | No aplica a la DB/cache, pero se cumple el espiritu: **no hay seccion `ports:`**. Todo el trafico entra por Traefik; MinIO nunca publica 9000/9001 al host. |
| 4 | Secretos fuertes | `MINIO_ROOT_PASSWORD` = `hex` de 32 bytes (256 bits). `MINIO_ROOT_USER` = `hex` de 8 bytes (access key aleatorio de 16 chars, nunca el default). |
| 5 | TLS global | Ambos routers (`minio_api`, `minio_console`) usan `entrypoints=websecure` + `certresolver=letsencryptresolver`. El redirect HTTP→HTTPS lo aplica Traefik globalmente. |
| 6 | Tags fijos | Imagen anclada a `minio/minio:RELEASE.2025-04-22T22-12-26Z`, nunca `:latest`. |
| 7 | replicas:1 + manager | `deploy.replicas: 1` con `placement: node.role == manager`. |

## Buckets publicos (solo bajo demanda — NO por default)

Por seguridad, la plantilla **no crea ningun bucket ni ninguna policy anonima**.
Todo bucket nace privado. Si un caso concreto necesita un bucket con lectura
publica (p. ej. assets estaticos de un sitio), hazlo de forma explicita despues
del deploy con `mc`:

```bash
# 1) Configurar alias apuntando al MinIO (dentro de un contenedor con mc)
mc alias set inv https://${MINIO_API_SUBDOMAIN}.${BASE_DOMAIN} "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"

# 2) Crear el bucket (privado)
mc mb inv/assets

# 3) SOLO si se pide: exponer lectura publica de ese bucket concreto
mc anonymous set download inv/assets
```

Deja el resto de buckets privados. Nunca apliques `mc anonymous set public` (da
lectura + escritura anonima) salvo requisito explicito y acotado.

## Secretos (los genera el motor, nunca viven en el repo)

| Clave | Tipo | Tamano | Rol |
|-------|------|--------|-----|
| `MINIO_ROOT_USER` | hex | 8 bytes (16 chars) | Access key root |
| `MINIO_ROOT_PASSWORD` | hex | 32 bytes (256 bits) | Secret key root |

Ambos se muestran **una sola vez** al final del deploy y se guardan en el archivo
de recuperacion local del operador.

## Parametros

| Clave | Prompt | Default |
|-------|--------|---------|
| `MINIO_API_SUBDOMAIN` | Subdominio de la API S3 | `files` |
| `MINIO_CONSOLE_SUBDOMAIN` | Subdominio de la consola | `files-console` |

`${BASE_DOMAIN}` es el token global de dominio raiz que inyecta el motor; los
routers arman el Host como `<subdominio>.${BASE_DOMAIN}`.

## Persistencia

Los objetos y la metadata viven en el volumen nombrado `minio_data` montado en
`/data`. Sobrevive a reinicios y redeploys del stack.

## DNS (previo al deploy)

Ambos subdominios deben resolver a la IP del VPS para que el challenge HTTP-01 de
Let's Encrypt emita el certificado:

- `A  ${MINIO_API_SUBDOMAIN}      → IP_DEL_VPS`
- `A  ${MINIO_CONSOLE_SUBDOMAIN}  → IP_DEL_VPS`

## Deploy

El motor de InventOS renderiza `stack.yml.tmpl` (interpolando las credenciales,
los subdominios, `${BASE_DOMAIN}` y `${NETWORK}`) y ejecuta:

```bash
docker stack deploy -c minio.yml minio
```

La red overlay `${NETWORK}` y el stack `traefik` deben existir previamente (los
prepara el preflight del motor y el orden de deps de la receta).
