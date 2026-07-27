// InventOS — catálogo de apps y recetas por vertical.
// v1 arranca con lo que Invent ya corre en producción, endurecido: cada panel
// admin va detrás de auth por defecto.

export const APPS = {
  traefik:   { name: 'Traefik',        role: 'Reverse proxy + SSL',      sub: null,        admin: false, note: 'Dashboard cerrado; SSL Let\'s Encrypt automático' },
  portainer: { name: 'Portainer',      role: 'Panel de contenedores',    sub: 'panel',     admin: true,  note: 'Requiere login + se sugiere 2FA' },
  supabase:  { name: 'Supabase',       role: 'DB + Auth + Storage + API', sub: 'db',       admin: true,  note: 'Studio detrás de basicauth (lección de la auditoría), no expuesto' },
  postgres:  { name: 'PostgreSQL',     role: 'Base de datos',            sub: null,        admin: false, note: 'Solo red interna, nunca puerto público' },
  redis:     { name: 'Redis',          role: 'Cache / colas',            sub: null,        admin: false, note: 'Solo red interna + password' },
  n8n:       { name: 'n8n',            role: 'Automatización / workflows', sub: 'flujos',  admin: true,  note: 'Login obligatorio + se sugiere 2FA' },
  evolution: { name: 'Evolution API',  role: 'Gateway de WhatsApp',      sub: 'wa',        admin: true,  note: 'API key generada; manager protegido' },
  minio:     { name: 'MinIO',          role: 'Almacenamiento S3',        sub: 'files',     admin: true,  note: 'Consola con credenciales; bucket público solo si lo pedís' },
  typebot:   { name: 'Typebot',        role: 'Chatbots / formularios',   sub: 'bot',       admin: true,  note: 'Builder detrás de login' },
  baserow:   { name: 'Baserow',        role: 'Base de datos no-code',    sub: 'tablas',    admin: true,  note: 'Login obligatorio' },
};

export const RECIPES = [
  {
    id: 'agencia',
    name: 'Stack Agencia',
    tagline: 'El que ya corrés — todo lo que una agencia necesita',
    apps: ['traefik', 'supabase', 'n8n', 'evolution', 'minio', 'portainer'],
    aria: [
      'Supabase Studio va tras basicauth por defecto — no repetimos el hallazgo de tu auditoría.',
      'Genero secretos fuertes para Postgres, JWT y las API keys; no quedan valores de plantilla.',
      'Sugiero activar fail2ban y SSH solo-llave al terminar (mismo endurecimiento del server).',
    ],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Automation',
    tagline: 'Mensajería + bots + automatización, listo para vender',
    apps: ['traefik', 'evolution', 'n8n', 'typebot', 'redis'],
    aria: [
      'Conecto Evolution ↔ n8n con la API key generada, sin pegar tokens a mano.',
      'Redis queda solo en red interna: nada de puertos abiertos.',
    ],
  },
  {
    id: 'datos',
    name: 'Base de datos',
    tagline: 'Postgres + Supabase + cache, para apps a medida',
    apps: ['traefik', 'supabase', 'postgres', 'redis'],
    aria: [
      'Ningún motor de base de datos expone puerto público; todo pasa por la red overlay.',
      'Backups diarios sugeridos desde el día uno.',
    ],
  },
  {
    id: 'minimo',
    name: 'Mínimo',
    tagline: 'El stack más liviano con app real: n8n + su DB (ideal para probar)',
    apps: ['traefik', 'n8n'],
    aria: [
      'Trae solo lo esencial: Traefik, n8n y sus dependencias (Postgres, Redis).',
      'Perfecto para un primer deploy de prueba: imágenes livianas, provisioning real.',
    ],
  },
  {
    id: 'custom',
    name: 'Elegir a mano',
    tagline: 'Armá tu propio stack desde el catálogo',
    apps: [],
    aria: ['Te propongo dependencias faltantes (ej: si elegís Supabase, sumo Traefik).'],
  },
];

export function recipeById(id) {
  return RECIPES.find((r) => r.id === id);
}
