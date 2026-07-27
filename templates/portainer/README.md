# Portainer CE — panel de contenedores/Swarm (plantilla endurecida InventOS)

Portainer CE es un panel web para gestionar Docker y Docker Swarm: contenedores,
stacks, servicios, volúmenes, redes e imágenes desde el navegador. Esta plantilla
lo despliega como stack de Docker Swarm detrás de Traefik, **seguro de fábrica**.

## Qué levanta

| Servicio    | Imagen (tag fijo)               | Puerto interno | Público            |
|-------------|---------------------------------|----------------|--------------------|
| `portainer` | `portainer/portainer-ce:2.21.4` | 9000 (HTTP)    | Sí (Traefik + TLS) |

Depende del stack **traefik**, en la misma red overlay `${NETWORK}` (default
`inventnet`).

- **URL pública:** `https://${PORTAINER_SUBDOMAIN}.${DOMAIN}` (subdominio default `panel`).
- **Login:** propio de Portainer. El usuario **admin se crea en el primer arranque**.
- **Persistencia:** volumen `portainer_data` (usuarios, settings, endpoints).
- **Acceso a Docker:** por el socket del nodo manager (`/var/run/docker.sock`).

Se conecta al Docker/Swarm local por el socket (`-H unix:///var/run/docker.sock`),
sin agente separado: en un Swarm de un nodo es lo más simple y reduce superficie.

## Qué se endureció

1. **Panel admin tras auth (login propio de la app).** Portainer exige crear un
   usuario admin en el primer acceso y pide login para toda operación. Por eso
   **no** se añade `basicauth` de Traefik: la app ya cierra la superficie admin
   (a diferencia de Supabase Studio, que no trae login y sí necesitó basicauth en
   la auditoría del server). Regla de endurecimiento 2 satisfecha.
2. **No publica puertos al host.** El compose oficial de Swarm publica `9443` y
   `8000` al host; aquí se **eliminan**. Al panel solo se llega por Traefik (TLS)
   a través de la red overlay interna, apuntando al puerto `9000` (HTTP) de
   Portainer. Nunca queda un panel de gestión escuchando en un puerto público.
3. **Cero secretos en el repo.** Portainer no trae contraseña por defecto, así que
   no hay ningún valor sensible que neutralizar ni token de credencial que el motor
   deba generar. La contraseña admin la fija el operador en el primer acceso.
4. **TLS en todo.** El router usa `entrypoints=websecure`, `tls=true` y
   `certresolver=letsencryptresolver`. El redirect HTTP->HTTPS lo fuerza Traefik
   globalmente.
5. **Tag de imagen fijo:** `2.21.4` (línea LTS 2.21), jamás `:latest`.
6. **`replicas: 1`** y `placement: node.role == manager`. El manager es obligatorio:
   su socket es el que expone la API de Swarm; sin él Portainer no puede gestionar
   servicios/stacks del clúster. Rollback automático si falla un update.
7. **Socket de Docker con mínimo alcance razonable.** Portainer necesita el socket
   en lectura/escritura porque gestionar contenedores ES su función (no puede ser
   `:ro` como Traefik). Se mitiga con: login propio + TLS + sin puertos al host +
   placement solo en manager + 2FA y RBAC recomendados (abajo).

## Parámetros

| Param                  | Prompt                             | Default |
|------------------------|------------------------------------|---------|
| `PORTAINER_SUBDOMAIN`  | Subdominio del panel de Portainer  | `panel` |

## Secretos

Ninguno. Portainer no arranca con credenciales por defecto: el admin se crea en el
primer arranque, así que el motor de InventOS no genera ni inyecta secretos para
este stack (`secrets: []`, `credentialsOut: []`).

## Valores que consume de sus dependencias

- `DOMAIN`, `NETWORK` — globales (dominio base + red overlay del stack).

## Post-deploy (IMPORTANTE — hacelo apenas termine el deploy)

1. **Creá el admin de inmediato.** Entrá a `https://${PORTAINER_SUBDOMAIN}.${DOMAIN}`
   y definí el usuario admin con una contraseña fuerte. Hay una **ventana breve**
   en la que el primer visitante crea el admin; completarlo enseguida la cierra.
   (Portainer además deshabilita la pantalla de init a los pocos minutos si nadie
   crea el admin; en ese caso reiniciá el servicio: `docker service update --force
   portainer_portainer`.)
2. **Activá 2FA** para el admin: *Settings → Authentication* (o el menú de la
   cuenta) → habilitá autenticación de dos factores.
3. **Usá RBAC**: creá usuarios/equipos con el mínimo privilegio en vez de compartir
   el admin. Reservá el admin para administración.
4. **No expongas el socket de otra forma.** Ya no hay puertos al host; mantenelo así.
5. Endurecimiento del host (recomendado por InventOS): fail2ban, SSH solo-llave y
   backup del volumen `portainer_data`.

## Nota sobre la conexión Traefik → Portainer

Traefik termina TLS de cara a internet y habla **HTTP con Portainer en el puerto
9000**, solo por la red overlay interna (`encrypted`). Ese puerto no se publica al
host. Portainer también sirve HTTPS propio en 9443 con certificado autofirmado; no
lo usamos porque obligaría a `serversTransport.insecureSkipVerify` en Traefik y no
aporta seguridad frente a la overlay ya cifrada.

## Sobre pre-sembrar el admin (opcional, avanzado)

Si querés cerrar por completo la ventana del primer arranque, Portainer soporta
`--admin-password-file /run/secrets/<archivo>` con la contraseña en texto plano en
un **secreto de Swarm** (`docker secret`), o `--admin-password` con un hash
**bcrypt**. Preferí siempre el `--admin-password-file` sobre un secreto de Swarm:
el hash bcrypt inline choca con la interpolación de `$` de `docker stack deploy`.
En cualquier caso, **nunca** pongas la contraseña ni el hash como literal en la
plantilla: declaralo como secreto que el motor genera y muestra una sola vez.

## Deploy manual (referencia)

El motor de InventOS renderiza `stack.yml.tmpl` → YAML concreto y lo despliega. A mano:

```bash
export NETWORK=inventnet
export DOMAIN=tu-dominio.com
export PORTAINER_SUBDOMAIN=panel
envsubst < stack.yml.tmpl > portainer.stack.yml
docker stack deploy -c portainer.stack.yml portainer
docker service ls
```
