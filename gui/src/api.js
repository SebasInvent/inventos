// Cliente del puente local (`inventos --gui`). Cero lógica de deploy — solo llama al
// motor vía HTTP y lee el stream NDJSON de eventos.

export async function getRecipes() {
  const r = await fetch('/api/recipes');
  return (await r.json()).recipes;
}

export async function getPlan(recipe, domain) {
  const r = await fetch('/api/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe, domain }),
  });
  return r.json();
}

/** Lanza el apply y llama `onMessage` por cada línea NDJSON (evento / done / error). */
export async function streamApply(body, onMessage) {
  const r = await fetch('/api/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { onMessage(JSON.parse(line)); } catch { /* línea parcial */ } }
    }
  }
}
