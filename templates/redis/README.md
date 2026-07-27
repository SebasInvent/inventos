# Redis 7 — Plantilla endurecida (InventOS)

Cache / almacen en memoria (key-value) usado como backend de colas, cache y
sesiones por otras apps del catalogo (n8n, Typebot, Supabase, etc.).

Este es un **servicio interno**: no tiene interfaz web ni router publico. Solo
existe dentro de la red overlay `${NETWORK}` y solo lo consumen otras apps del
mismo Swarm.

## Como se conectan otras apps

Desde cualquier otro stack unido a la red `${NETWORK}`:

- **Host:** `redis`
- **Puerto:** `6379` (interno, nunca publicado al host)
- **Password:** `${REDIS_PASSWORD}` (generado por el motor en el deploy)
- **URL de conexion:** `redis://:${REDIS_PASSWORD}@redis:6379`

## Que se endurecio

| # | Regla | Como se aplica aqui |
|---|-------|---------------------|
| 1 | Cero secretos reales | La clave vive solo como token `${REDIS_PASSWORD}`; la genera el motor en deploy y se declara en `manifest.secrets`. |
| 2 | Admin tras auth | `requirepass` obliga autenticacion en TODA conexion. Redis no tiene panel admin, asi que no hay superficie web que exponer. |
| 3 | DB/cache sin puerto al host | **No hay seccion `ports:`**. Redis solo es alcanzable por la red overlay interna; imposible conectarse desde fuera del Swarm. |
| 4 | Secretos fuertes | `REDIS_PASSWORD` = `hex` de 24 bytes (192 bits de entropia). El healthcheck usa `REDISCLI_AUTH` para no filtrar la clave en los argumentos del proceso. |
| 5 | TLS global | No aplica a un servicio interno sin router; el trafico nunca sale del host ni de la red overlay cifrada. |
| 6 | Tags fijos | Imagen anclada a `redis:7.4.1-alpine`, nunca `:latest`. |
| 7 | replicas:1 + manager | `deploy.replicas: 1` con `placement: node.role == manager`. |

## Persistencia

- AOF activado (`--appendonly yes`): cada escritura se registra en el append-only
  file para recuperacion tras reinicio.
- Datos en el volumen nombrado `redis_data` montado en `/data`.

## Secretos (los genera el motor, nunca viven en el repo)

| Clave | Tipo | Tamano |
|-------|------|--------|
| `REDIS_PASSWORD` | hex | 24 bytes (192 bits) |

## Deploy

El motor de InventOS renderiza `stack.yml.tmpl` (interpolando `${REDIS_PASSWORD}`
y `${NETWORK}`) y ejecuta:

```bash
docker stack deploy -c redis.yml redis
```

La red overlay `${NETWORK}` debe existir previamente (la crea el preflight del
motor). El `REDIS_PASSWORD` se muestra una sola vez al final del deploy y se
guarda en el archivo de recuperacion local del operador.
