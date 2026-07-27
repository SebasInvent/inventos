# InventOS

> Instalador de terminal para stacks open-source. **Seguro de fábrica, español-first, en tu propio servidor.** Un producto público y gratuito de [Invent Agency](https://inventagency.co).

InventOS empaqueta software open-source (Supabase, n8n, Evolution API, MinIO, Traefik, Portainer…) y lo despliega en un VPS limpio con un solo comando — con SSL automático, secretos fuertes generados solos y **todos los paneles admin detrás de login por defecto**.

Es la respuesta a un hueco real: los instaladores que existen hoy son en portugués y dejan paneles abiertos a internet (una de esas instalaciones dejó el Supabase Studio de la propia Invent expuesto sin login — el origen de este proyecto).

## Instalar

Necesitás Node ≥ 18 en tu equipo, y **Docker con Swarm activo** en el destino.

```bash
# Modo guiado: elegís receta y dominio, ves el plan y podés instalar ahí mismo.
npx inventos

# Ver el plan sin tocar nada
npx inventos plan --recipe agencia --domain cliente.com

# Instalar en tu VPS
npx inventos apply --recipe agencia --domain cliente.com --target root@1.2.3.4 --execute

# Instalar en el Docker de este equipo (para probar)
npx inventos apply --recipe minimo --domain local.test --target local --execute

# Wizard web (para no-técnicos): mismo motor, en el navegador
npx inventos gui

npx inventos --help
```

Recetas: `agencia`, `whatsapp`, `datos`, `minimo`.

## Desarrollo (desde el repo)

```bash
npm install

# plan (dry-run): carga plantillas, orden topológico, render y valida 0 tokens sueltos
node bin/inventos.mjs plan --recipe agencia --domain cliente.com

# apply (dry-apply, default): imprime la secuencia EXACTA de comandos remotos
# (network → por app: subir YAML → provisionar DB → stack deploy → convergencia).
# No toca ningún server. Sin secretos en la salida.
node bin/inventos.mjs apply --recipe agencia --domain cliente.com

# apply REAL: despliega por SSH a un VPS limpio (exige --target + --execute)
node bin/inventos.mjs apply --recipe whatsapp --domain cliente.com \
  --target root@1.2.3.4 --execute

# apply LOCAL: despliega en un Docker Swarm de tu máquina (sin SSH, sin VPS).
# Ideal para probar. Requiere Docker corriendo + `docker swarm init`
# (en Mac sirve Docker Desktop, o `brew install colima docker && colima start`).
node bin/inventos.mjs apply --recipe minimo --domain app.midominio.co --target local --execute

# GUI: wizard web local (para no-técnicos). Abre el navegador; toda la lógica corre
# local sobre el MISMO motor — nada sale de tu equipo. Antesala de la app de escritorio.
node bin/inventos.mjs gui          # (requiere `npm run build:gui` la primera vez)

# interactivo (TTY) / demo
node bin/inventos.mjs
node bin/inventos.mjs --demo
```

> **Estado — Fase 1 ✅ · Fase 1.5 (dry-apply) ✅ · assets de Supabase ✅ · marca Invent ✅.**
> Plantillas endurecidas y verificadas adversarialmente; motor de deploy completo.
> `plan` valida el render E2E; `apply` (dry) arma e imprime la secuencia real de
> comandos SSH — subida de YAML **y de los assets estáticos** por stdin (secretos
> nunca en el comando), provisioning de usuarios/DB dedicados (n8n), `docker stack
> deploy` en orden y espera de convergencia. Los **11 assets de Supabase**
> (kong.yml, vector.yml, SQL init, pooler.exs, functions/main) están autorados
> fieles al canónico self-hosted de las versiones fijadas → Supabase ya es
> desplegable. Todo el stack arranca con identidad **Invent** (Studio org/proyecto,
> remitente de emails, banner y credenciales). Único pendiente real: probar
> **`--execute` contra un VPS de prueba limpio** (no producción).

## Recetas por vertical (v1)

| Receta | Apps |
|---|---|
| **Stack Agencia** | Traefik · Supabase · n8n · Evolution · MinIO · Portainer |
| **WhatsApp Automation** | Traefik · Evolution · n8n · Typebot · Redis |
| **Base de datos** | Traefik · Supabase · Postgres · Redis |
| **A mano** | Elegir del catálogo (5–10 apps endurecidas) |

## Cómo se mantiene gratis para Invent

El producto es gratis para el mundo **y** de costo ~cero para Invent:

- **Instalador + CLI** corren en el servidor del usuario, no en el nuestro. Distribución por npm/GitHub = $0.
- **Landing + docs + script `get.`** en tiers gratis (Vercel / Cloudflare Pages).
- **ARIA** (el asistente) no quema tokens: en v1 es **determinista** (mejores prácticas y validaciones codificadas). Para IA real, **BYOK** (el usuario pone su propia API key). Más adelante, **ARIA hosted** como tier de pago → la IA pasa de costo a ingreso.
- Costo real para Invent: el dominio (~$10–40/año). Se monetiza arriba: hosting gestionado, academia, afiliados VPS, ARIA premium.

## Arquitectura

**Docker Swarm + Traefik + Let's Encrypt** sobre una red overlay — la misma que Invent ya corre en producción. Cada app es un stack parametrizable y **endurecido de fábrica** (ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) para el spec completo: formato de plantilla, `manifest.json`, las 7 reglas de endurecimiento, y los módulos del motor). Ninguna plantilla trae secretos: el motor los genera en el deploy.

## Roadmap

- **Fase 0** — nombre, dominio, socials, cuña. *(nombre + cuña ✅)*
- **Fase 1 ✅** — 9 plantillas endurecidas (verificación adversarial de seguridad) + motor de deploy + `inventos plan` (dry-run E2E validado).
- **Fase 1.5 ✅ (dry-apply)** — `inventos apply` sobre un solo camino SSH (`target.ts`): preflight (red overlay) → por app: subir YAML + assets por stdin + provisionar DB (n8n) + `docker stack deploy` + convergencia. Dry-apply imprime la secuencia exacta sin secretos y sin tocar el server; `--execute` la ejecuta. Assets de Supabase autorados (canónico self-hosted) y marca Invent alineada en todo el stack.
- **Fase 1.5b ✅ (validado local)** — deploy REAL probado en un Docker Swarm local (colima). `--target local` corre sin SSH. Resultado: 5 servicios 1/1, provisioning de la DB de n8n OK, n8n ruteado por Traefik (HTTP 200), y `apply` idempotente (re-aplicar reusa los secretos de `.inventos/<proj>/secrets.json`, no rota claves). Dos fixes salidos de la prueba: Traefik `v3.3.4→v3.7.6` (compat API Docker moderno) y persistencia de secretos.
- **Fase 1.5c** — único pendiente: probar `--execute` contra un VPS real (para validar TLS/Let's Encrypt + DNS, lo único que el local no cubre).
- **Fase 2** — YouTube en español, docs, crecer catálogo, landing on-brand.
- **Fase 3** — hosting gestionado, academia, afiliados.
- **Fase 4** — TUI pulido (Ink), updates 1-click, backups, dashboard web, ARIA hosted.

## Estructura

```
bin/inventos.mjs      CLI (plan / interactivo / demo)
src/ui.mjs            helpers de UI (ANSI, marca Invent)
src/recipes.mjs       recetas por vertical
src/menu.mjs          selector con flechas + prompts
src/engine/           motor de deploy (TypeScript, Node 24 type-stripping)
  index.ts            orquestador de plan: load → plan → render(validar)
  apply.ts            orquestador de deploy: preflight → upload → provision → deploy → converge
  plan.ts             dry-run puro (orden topológico, URLs, avisos)
  render.ts           manifest + params + secretos → YAML concreto
  secrets.ts          generadores crypto (hex, base64url, bcrypt, JWT Supabase)
  provision.ts        rol/base dedicados en Postgres (n8n) · SQL por stdin
  target.ts           camino SSH único al VPS (dual-mode plan/apply)
  preflight.ts        checks del VPS (docker, swarm, red, DNS, puertos)
  deploy.ts           helper de convergencia/rollback (referencia)
  report.ts           URLs + credenciales (1 vez, chmod 600) + próximos pasos
  types.ts            tipos compartidos
templates/<app>/      stack.yml.tmpl + manifest.json + README (9 apps)
docs/ARCHITECTURE.md  spec de plantillas + motor
landing/index.html    landing estática on-brand (deploy: Cloudflare Pages · ver landing/README.md)
```

---

MIT · Invent Agency
