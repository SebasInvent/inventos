// InventOS — vista de deploy EN VIVO. Consume los ApplyEvent del motor y pinta el
// avance en tiempo real: cada paso terminado queda como línea estática (✔), y el
// paso activo anima con spinner al pie (una sola línea, se redibuja en su lugar).
// Cero dependencias — control de cursor ANSI. En no-TTY imprime líneas planas.

import { cyan, green, amber, gray, dim } from './ui.mjs';

const FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const ICON = {
  preflight: '◆', upload: '↑', provision: '▦', deploy: '▸', converge: '∴', warn: '!',
};

export function createLiveView() {
  const tty = process.stdout.isTTY === true;
  let cur = null;      // { label, stepKind }
  let suffix = '';     // p. ej. "2/2" en convergencia
  let frame = 0;
  let timer = null;

  const glyph = (k) => gray(ICON[k] ?? '·');
  const liveLine = () => {
    const sp = cyan(FRAMES[frame % FRAMES.length]);
    return `  ${sp} ${glyph(cur.stepKind)} ${cur.label}${suffix ? dim(' · ' + suffix) : ''}`;
  };
  const draw = () => { if (tty && cur) process.stdout.write('\r\x1b[K' + liveLine()); };
  const startTimer = () => { if (tty && !timer) timer = setInterval(() => { frame++; draw(); }, 90); };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };

  const commit = (mark, stepKind, label) => {
    const sfx = suffix ? dim(' · ' + suffix) : '';
    const txt = `  ${mark} ${glyph(stepKind)} ${label}${sfx}`;
    process.stdout.write((tty ? '\r\x1b[K' : '') + txt + '\n');
    cur = null; suffix = '';
  };

  return {
    /** Recibe un ApplyEvent del motor. */
    on(e) {
      if (e.type === 'start') {
        cur = { label: e.label, stepKind: e.stepKind }; suffix = '';
        startTimer(); draw();
      } else if (e.type === 'converge') {
        if (e.desired) suffix = `${e.running}/${e.desired}`;
        draw();
      } else if (e.type === 'done') {
        commit(green('✔'), e.stepKind, e.label);
      } else if (e.type === 'warn') {
        commit(amber('◆'), e.stepKind, e.label);
      } else if (e.type === 'fail') {
        commit(amber('✗'), e.stepKind, e.label);
      }
    },
    /** Cierra la vista (detiene el spinner, limpia la línea activa). */
    end() {
      stopTimer();
      if (tty && cur) process.stdout.write('\r\x1b[K');
    },
  };
}
