# Traefik — ingress endurecido (InventOS)

**Rol:** reverse proxy + terminación TLS. Es la **base** del stack: el único servicio
que publica puertos al host (80 y 443) y el que le da HTTPS automático a todas las
demás apps. No tiene dependencias (`requires: []`) — se despliega primero.

## Qué hace

- Escucha en `web` (:80) y `websecure` (:443).
- Redirige **todo** HTTP → HTTPS de forma permanente (301).
- Emite y renueva certificados con **Let's Encrypt** (ACME, challenge HTTP-01) usando
  el resolver `letsencryptresolver`. Los certs viven en `acme.json` dentro de un
  volumen persistente.
- Descubre las apps por el **provider swarm**: lee las labels de Traefik que cada
  stack declara en su `deploy.labels`. Nada se enruta salvo que la app lo pida
  explícitamente (`exposedByDefault=false`).
- Se une a la red overlay compartida `${NETWORK}` (default `inventnet`) y habla con
  el resto de los servicios solo por ahí.

## Qué se endureció

| Regla | Cómo se aplica aquí |
|---|---|
| **Sin superficie admin pública** | Dashboard y API **desactivados** (`--api.dashboard=false`, `--api.insecure=false`). No hay panel expuesto. |
| **TLS en todo** | Redirect global HTTP→HTTPS permanente + TLS por defecto en `websecure` con `letsencryptresolver`. |
| **Puertos al host solo aquí** | Es el único stack con `ports:`. 80/443 en `mode: host` (preserva la IP real del cliente). El resto de las apps nunca publican puertos. |
| **Socket con mínimo privilegio** | `/var/run/docker.sock` montado en **solo lectura** (`:ro`). |
| **Nada se expone por accidente** | `providers.swarm.exposedByDefault=false`: cada router es opt-in por label. |
| **Cero secretos en la plantilla** | Solo tokens `${ACME_EMAIL}` y `${NETWORK}` (params, no secretos). No hay credenciales literales. |
| **Imagen fija** | `traefik:v3.7.6` — nunca `:latest`. |
| **Deploy controlado** | `replicas: 1`, `placement: node.role == manager`, rollback automático en fallo de update. |

## Tokens que rellena el motor

| Token | Qué es | Default |
|---|---|---|
| `${ACME_EMAIL}` | Email para los avisos de Let's Encrypt (vencimiento de certificados). Param obligatorio. | — |
| `${NETWORK}` | Nombre de la red overlay compartida por todos los stacks. | `inventnet` |

No hay secretos que generar para este stack: no expone paneles ni corre bases de datos.

## Requisitos previos (los cubre el preflight del motor)

1. Docker Swarm activo (`docker swarm init` en el nodo).
2. La red overlay externa creada **antes** de desplegar:
   ```bash
   docker network create --driver overlay --attachable --opt encrypted inventnet
   ```
3. DNS: los A-records de los subdominios de tus apps deben apuntar a la IP del VPS
   (necesario para que el challenge HTTP-01 valide y emita los certificados).
4. Puertos 80 y 443 libres en el host.

## Deploy manual (referencia)

El motor de InventOS renderiza `stack.yml.tmpl` → YAML concreto y lo despliega. A mano:

```bash
export NETWORK=inventnet
export ACME_EMAIL=tu-email@dominio.com
# renderizar (interpola los ${...}) y desplegar
envsubst < stack.yml.tmpl > traefik.stack.yml
docker stack deploy -c traefik.stack.yml traefik
# verificar convergencia
docker service ls
docker service logs traefik_traefik --follow
```

## Nota sobre `acme.json`

Se guarda en el volumen `traefik_letsencrypt` (`/etc/traefik/letsencrypt/acme.json`).
Traefik lo crea con permisos `600` automáticamente. Al usar un volumen con nombre
—en vez de un bind mount— evitamos el error clásico de permisos abiertos. Respaldá
este volumen si querés conservar los certificados entre reinstalaciones.

## Dashboard (opcional, solo detrás de auth)

Por defecto el dashboard va **cerrado** — es lo correcto para un ingress de fábrica.
Si necesitás verlo, **jamás** lo habilites con `--api.insecure=true`. Actívalo detrás
del `basicauth` de Traefik:

1. En `command`, cambiá a `--api.dashboard=true` (dejá `--api.insecure=false`).
2. Generá un hash **bcrypt** para el usuario (el motor lo hace por vos):
   ```bash
   htpasswd -nbB admin 'TU_PASSWORD_FUERTE'
   ```
3. Agregá un router interno con middleware `basicauth` en `deploy.labels`, apuntando
   al servicio interno `api@internal`, sobre `websecure` + `letsencryptresolver`.

En ese caso el par usuario/hash se declara como secreto (`type: bcrypt`) en
`manifest.secrets` y el router en `manifest.adminAuth` — nunca como valor literal en
la plantilla.
