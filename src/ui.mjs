// InventOS — helpers de UI (ANSI, marca Invent). Cero dependencias.
// Color de marca: cian eléctrico #00D4FF · fondo oscuro.

import { BRAND } from './brand.mjs';

const ON = process.env.NO_COLOR ? false : true;
const e = (code, s) => (ON ? `\x1b[${code}m${s}\x1b[0m` : String(s));

// Truecolor de marca
export const cyan = (s) => e('38;2;0;212;255', s);
export const green = (s) => e('38;2;63;185;80', s);
export const amber = (s) => e('38;2;227;160;8', s);
export const red = (s) => e('38;2;240;85;92', s);
export const violet = (s) => e('38;2;163;113;247', s);
export const gray = (s) => e('38;2;120;134;146', s);
export const dim = (s) => e('2', s);
export const bold = (s) => e('1', s);
export const white = (s) => e('38;2;234;241;245', s);

export const b = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };

export function banner() {
  const w = bold(cyan('INVENT') + white('OS'));
  return [
    '',
    `  ${w}  ${dim('·')}  ${gray('self-hosting sin fricción')}`,
    `  ${dim('open-source · seguro de fábrica · por')} ${cyan(BRAND.company)} ${dim('· ' + BRAND.tagline)}`,
    '',
  ].join('\n');
}

export function box(title, lines, color = cyan) {
  const width = Math.max(title.length + 4, ...lines.map((l) => visibleLen(l) + 4), 44);
  const top = `${color(b.tl)}${color(b.h)} ${bold(title)} ${color(b.h.repeat(Math.max(0, width - title.length - 4)))}${color(b.tr)}`;
  const body = lines.map((l) => `${color(b.v)} ${l}${' '.repeat(Math.max(0, width - visibleLen(l) - 3))}${color(b.v)}`);
  const bot = `${color(b.bl)}${color(b.h.repeat(width - 1))}${color(b.br)}`;
  return [top, ...body, bot].join('\n');
}

// longitud visible ignorando códigos ANSI
export function visibleLen(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

export const ok = (s) => `${green('✔')} ${s}`;
export const warnGuard = (s) => `${amber('◆')} ${s}`;
export const step = (s) => `${cyan('❯')} ${s}`;
export const aria = (s) => `${violet('◆ ARIA')} ${gray('·')} ${s}`;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
