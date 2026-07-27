// InventOS — selector de menú con flechas (TTY) y fallback numérico. Cero deps.
import readline from 'node:readline';
import { cyan, dim, gray, bold, step } from './ui.mjs';

// options: [{ label, hint }]
export function select(title, options) {
  return new Promise((resolve) => {
    const isTTY = process.stdin.isTTY;
    if (!isTTY) {
      // Fallback no-interactivo: elige la primera opción.
      resolve(0);
      return;
    }
    let idx = 0;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    const render = (first = false) => {
      if (!first) process.stdout.write(`\x1b[${options.length + 1}A`);
      process.stdout.write(`\x1b[J`);
      process.stdout.write(`  ${bold(title)}\n`);
      options.forEach((o, i) => {
        const on = i === idx;
        const marker = on ? cyan('❯ ◉') : gray('  ○');
        const label = on ? cyan(o.label) : o.label;
        const hint = o.hint ? `  ${dim(o.hint)}` : '';
        process.stdout.write(`  ${marker} ${label}${hint}\n`);
      });
    };
    render(true);

    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up') idx = (idx - 1 + options.length) % options.length;
      else if (key.name === 'down') idx = (idx + 1) % options.length;
      else if (key.name === 'return') return finish();
      else if (key.name === 'c' && key.ctrl) { cleanup(); process.exit(130); }
      render();
    };
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener('keypress', onKey);
      process.stdin.pause();
    };
    const finish = () => { cleanup(); resolve(idx); };
    process.stdin.on('keypress', onKey);
    process.stdin.resume();
  });
}

export function ask(question, def = '') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const q = `  ${step(question)}${def ? dim(` (${def})`) : ''} `;
    let done = false;
    const finish = (v) => { if (done) return; done = true; rl.close(); resolve(v); };
    rl.question(q, (answer) => finish(answer.trim() || def));
    rl.on('close', () => finish(def)); // EOF / stdin no interactivo → usa el default
  });
}
