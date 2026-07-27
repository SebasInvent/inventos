# Landing de InventOS

Sitio **100% estático**: un solo `index.html` self-contained (CSS/JS/SVG inline, cero
dependencias, cero build, cero backend). Se abre directo en el navegador y se sube a
cualquier hosting estático gratis.

> InventOS **no necesita un VPS** para su web: el instalador es un CLI (npm) que corre
> en la máquina del usuario, y esta landing es un sitio estático. El VPS solo se usa
> para *probar* el motor de deploy.

## Publicar

### Cloudflare Pages — recomendado (gratis, CDN global, ya usamos Cloudflare)
```bash
npm i -g wrangler
wrangler login
wrangler pages deploy landing --project-name inventos
```
Luego: Cloudflare → Pages → inventos → **Custom domains** → apuntá `inventos.co`
(o `get.inventos.co`).

### Vercel
```bash
npm i -g vercel
cd landing && vercel --prod
```

### Netlify
```bash
npx netlify deploy --dir landing --prod
```

### GitHub Pages
Subí `index.html` a la rama `gh-pages` (o a `/docs` en `main`) y activá Pages.

## Editar
Todo el contenido y los estilos viven en `index.html`. Para iterar: editá el HTML y
volvé a desplegar (o re-publicá el Artifact de claude.ai para previsualizar).

## Notas de marca
Cian `#00D4FF` sobre casi-negro `#0A0A0A`, estética de terminal, dual-theme. La ventana
de terminal del hero se mantiene oscura en ambos temas (como un bloque de código).
