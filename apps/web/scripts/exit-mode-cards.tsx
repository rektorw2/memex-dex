/**
 * Экспорт карточек правил выхода.
 *
 * Собирает то же, что показывает сайт, но в высоком разрешении и без
 * браузера: фон рисуется программно (SVG → растр), сцена берётся из
 * того же `buildExitScene`, что и у компонента, текст накладывается
 * векторно. Результат:
 *
 *   apps/web/public/exit-modes/<mode>-{desktop,mobile}.{webp,avif}  — фоны для сайта
 *   artifacts/exit-modes/<mode>-{desktop,mobile}.png                — полные карточки, 2400 px
 *   artifacts/exit-modes/layers/<mode>-{art,scene,text}.png          — слои
 *
 * Запуск из apps/web:  npx tsx scripts/exit-mode-cards.tsx
 *
 * Здесь нет случайных элементов: два запуска дают одинаковые файлы.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { createElement } from 'react';
void React;
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { PAPER_EXIT_PRESETS, describePaperExitPlan, type PaperExitMode } from '@memex/core';
import { buildExitScene, type SceneFrame } from '../lib/exit-scene';
import { EXIT_MODE_COPY, ExitModeScene } from '../components/agent/ExitModeCard';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ROOT = resolve(WEB, '../..');
const PUBLIC_DIR = resolve(WEB, 'public/exit-modes');
const OUT_DIR = resolve(ROOT, 'artifacts/exit-modes');
const LAYERS_DIR = resolve(OUT_DIR, 'layers');

const C = { bg: '#080B0F', panel: '#11151B', raised: '#171B22', border: '#252B35', white: '#F5F7FA', muted: '#8F98A7', accent: '#8B5CF6', up: '#22C7B8', down: '#FF5C6C', warn: '#E8B84A' };
const FONT = "'Inter', 'DejaVu Sans', 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono', 'DejaVu Sans Mono', Menlo, monospace";

type Size = { w: number; h: number; kind: 'desktop' | 'mobile' };
const SIZES: Size[] = [
  { w: 2400, h: 1350, kind: 'desktop' },
  { w: 1350, h: 2400, kind: 'mobile' },
];

/* ───────────────────────────── Фоны ───────────────────────────── */

/**
 * Авторский фон режима: графит, мягкий свет и один узнаваемый образ —
 * цель, защита, ступени, сопровождение после фиксации, сопровождение
 * с самого входа. Всё низкой плотности: фон должен уступать тексту.
 */
function artSvg(mode: PaperExitMode, w: number, h: number): string {
  const cx = w * 0.72;
  const cy = h * 0.46;
  const s = Math.min(w, h);
  const grid = Array.from({ length: Math.ceil(w / (s * 0.08)) + 1 }, (_, i) => `<line x1="${i * s * 0.08}" y1="0" x2="${i * s * 0.08}" y2="${h}"/>`).join('')
    + Array.from({ length: Math.ceil(h / (s * 0.08)) + 1 }, (_, i) => `<line x1="0" y1="${i * s * 0.08}" x2="${w}" y2="${i * s * 0.08}"/>`).join('');
  const motif: Record<PaperExitMode, string> = {
    TARGET: [1, 0.78, 0.56, 0.34, 0.14].map((r, i) =>
      `<circle cx="${cx}" cy="${cy}" r="${s * 0.34 * r}" fill="none" stroke="${C.accent}" stroke-opacity="${0.14 + i * 0.05}" stroke-width="${i === 4 ? 3 : 1.5}"/>`).join('')
      + `<circle cx="${cx + s * 0.34 * 0.56 * Math.cos(-0.9)}" cy="${cy + s * 0.34 * 0.56 * Math.sin(-0.9)}" r="${s * 0.012}" fill="${C.up}" fill-opacity="0.9"/>`,
    PROTECTED: `<path d="M${cx - s * 0.34} ${cy + s * 0.08} Q${cx} ${cy + s * 0.36} ${cx + s * 0.34} ${cy + s * 0.08}" fill="none" stroke="${C.down}" stroke-opacity="0.35" stroke-width="3" stroke-dasharray="14 10"/>`
      + `<rect x="${cx - s * 0.3}" y="${cy - s * 0.26}" width="${s * 0.6}" height="${s * 0.34}" rx="${s * 0.05}" fill="${C.accent}" fill-opacity="0.12" stroke="${C.accent}" stroke-opacity="0.3" stroke-width="1.5"/>`
      + Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; const r1 = s * 0.115; const r2 = i % 3 === 0 ? s * 0.095 : s * 0.105; const px = cx + s * 0.2; const py = cy - s * 0.09; return `<line x1="${px + r1 * Math.cos(a)}" y1="${py + r1 * Math.sin(a)}" x2="${px + r2 * Math.cos(a)}" y2="${py + r2 * Math.sin(a)}" stroke="${C.warn}" stroke-opacity="0.45" stroke-width="2"/>`; }).join(''),
    LADDER: [0, 1, 2].map((i) => {
      const bw = s * 0.2; const bh = s * 0.11 * (i + 1); const bx = cx - s * 0.32 + i * bw * 1.08; const by = cy + s * 0.22 - bh;
      return `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${s * 0.012}" fill="${C.accent}" fill-opacity="${0.12 + i * 0.06}" stroke="${C.accent}" stroke-opacity="0.3"/>`
        + `<line x1="${bx}" y1="${by}" x2="${bx + bw}" y2="${by}" stroke="${C.up}" stroke-opacity="0.7" stroke-width="3"/>`;
    }).join(''),
    TRAILING: [0, 1, 2].map((i) => {
      const off = i * s * 0.05;
      return `<path d="M${cx - s * 0.4} ${cy + s * 0.2 + off} C${cx - s * 0.15} ${cy + s * 0.18 + off} ${cx - s * 0.1} ${cy - s * 0.2 + off} ${cx + s * 0.1} ${cy - s * 0.18 + off} S${cx + s * 0.32} ${cy - s * 0.1 + off} ${cx + s * 0.4} ${cy - s * 0.06 + off}" fill="none" stroke="${C.accent}" stroke-opacity="${0.26 - i * 0.06}" stroke-width="${8 - i * 2}" stroke-linecap="round"/>`;
    }).join('')
      + `<path d="M${cx + s * 0.02} ${cy + s * 0.14} H${cx + s * 0.14} V${cy + s * 0.08} H${cx + s * 0.26} V${cy + s * 0.03} H${cx + s * 0.4}" fill="none" stroke="${C.down}" stroke-opacity="0.5" stroke-width="3" stroke-dasharray="12 8"/>`
      + `<circle cx="${cx + s * 0.02}" cy="${cy - s * 0.02}" r="${s * 0.014}" fill="${C.up}"/>`,
    TRAILING_PURE: `<path d="M${cx - s * 0.42} ${cy + s * 0.3} C${cx - s * 0.2} ${cy + s * 0.28} ${cx - s * 0.18} ${cy - s * 0.02} ${cx} ${cy - s * 0.08} S${cx + s * 0.3} ${cy - s * 0.3} ${cx + s * 0.42} ${cy - s * 0.26}" fill="none" stroke="${C.accent}" stroke-opacity="0.3" stroke-width="10" stroke-linecap="round"/>`
      + `<path d="M${cx - s * 0.42} ${cy + s * 0.42} H${cx - s * 0.3} V${cy + s * 0.32} H${cx - s * 0.16} V${cy + s * 0.18} H${cx - s * 0.02} V${cy + s * 0.06} H${cx + s * 0.16} V${cy - s * 0.06} H${cx + s * 0.42}" fill="none" stroke="${C.down}" stroke-opacity="0.5" stroke-width="3" stroke-dasharray="12 8"/>`
      + `<circle cx="${cx}" cy="${cy - s * 0.08}" r="${s * 0.014}" fill="${C.up}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="light" cx="${cx / w}" cy="${cy / h}" r="0.75"><stop offset="0" stop-color="#1B2029"/><stop offset="0.55" stop-color="#11151B"/><stop offset="1" stop-color="${C.bg}"/></radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.06"/><stop offset="0.5" stop-color="${C.accent}" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#light)"/>
  <g stroke="${C.white}" stroke-opacity="0.025" stroke-width="1">${grid}</g>
  <rect width="${w}" height="${h}" fill="url(#sheen)"/>
  ${motif[mode]}
</svg>`;
}

/* ───────────────────────────── Сцена ───────────────────────────── */

/** Tailwind-классы сцены → явные атрибуты: растеризатор CSS не знает. */
function inlineSceneStyles(svg: string): string {
  const color: Record<string, [attr: 'fill' | 'stroke', value: string, opacity?: string]> = {
    'stroke-accent': ['stroke', C.accent], 'stroke-down': ['stroke', C.down], 'stroke-up/70': ['stroke', C.up, '0.7'],
    'stroke-white/15': ['stroke', C.white, '0.15'], 'stroke-white/25': ['stroke', C.white, '0.25'], 'stroke-white/70': ['stroke', C.white, '0.7'],
    'fill-up': ['fill', C.up], 'fill-down': ['fill', C.down], 'fill-down/80': ['fill', C.down, '0.8'], 'fill-white': ['fill', C.white],
    'fill-white/40': ['fill', C.white, '0.4'], 'fill-white/80': ['fill', C.white, '0.8'], 'fill-white/10': ['fill', C.white, '0.1'],
    'fill-panel': ['fill', C.panel], 'fill-panel/50': ['fill', C.panel, '0.5'], 'fill-none': ['fill', 'none'],
  };
  return svg.replace(/class="([^"]*)"/g, (_, classes: string) => {
    const attrs: string[] = [];
    let mono = false;
    for (const cls of classes.split(/\s+/)) {
      const rule = color[cls];
      if (rule) { attrs.push(`${rule[0]}="${rule[1]}"`); if (rule[2]) attrs.push(`${rule[0]}-opacity="${rule[2]}"`); }
      if (cls === 'num') mono = true;
      if (cls === 'agent-scene-halo') attrs.push(`stroke="${C.panel}" stroke-width="3" paint-order="stroke" stroke-linejoin="round"`);
    }
    attrs.push(`font-family="${mono ? MONO : FONT}"`);
    return attrs.join(' ');
  });
}

function sceneSvg(mode: PaperExitMode, frame: SceneFrame, label: string): string {
  const scene = buildExitScene(PAPER_EXIT_PRESETS[mode]);
  const markup = renderToStaticMarkup(createElement(ExitModeScene, { scene, play: 'static', label, frame }));
  return inlineSceneStyles(markup).replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

/* ───────────────────────────── Текст ───────────────────────────── */

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Простой перенос по ширине: символов на строку из размера шрифта. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxChars && line) { lines.push(line); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

function textSvg(mode: PaperExitMode, size: Size): string {
  const copy = EXIT_MODE_COPY.find((item) => item.key === mode)!;
  const { w, h } = size;
  const u = w / 100; // единица масштаба
  const pad = size.kind === 'desktop' ? u * 5 : u * 7;
  const titleSize = size.kind === 'desktop' ? u * 4.2 : u * 6.4;
  const bodySize = size.kind === 'desktop' ? u * 1.9 : u * 3.1;
  const chipSize = size.kind === 'desktop' ? u * 1.5 : u * 2.5;
  const maxChars = size.kind === 'desktop' ? 46 : 38;
  let y = pad + titleSize;
  const parts: string[] = [];
  parts.push(`<text x="${pad}" y="${y}" font-family="${FONT}" font-weight="700" font-size="${titleSize}" fill="${C.white}">${esc(copy.label)}</text>`);
  const tagW = copy.tag.length * chipSize * 0.62 + chipSize * 1.6;
  const tagX = pad + copy.label.length * titleSize * 0.66 + u * 2;
  if (size.kind === 'desktop') {
    parts.push(`<rect x="${tagX}" y="${y - chipSize * 1.25}" width="${tagW}" height="${chipSize * 1.7}" rx="${chipSize * 0.85}" fill="${C.accent}" fill-opacity="0.18"/>`);
    parts.push(`<text x="${tagX + tagW / 2}" y="${y - chipSize * 0.05}" text-anchor="middle" font-family="${FONT}" font-size="${chipSize}" fill="${C.accent}">${esc(copy.tag)}</text>`);
  } else {
    y += chipSize * 2.4;
    parts.push(`<rect x="${pad}" y="${y - chipSize * 1.25}" width="${tagW}" height="${chipSize * 1.7}" rx="${chipSize * 0.85}" fill="${C.accent}" fill-opacity="0.18"/>`);
    parts.push(`<text x="${pad + tagW / 2}" y="${y - chipSize * 0.05}" text-anchor="middle" font-family="${FONT}" font-size="${chipSize}" fill="${C.accent}">${esc(copy.tag)}</text>`);
  }
  y += bodySize * 1.9;
  for (const line of wrap(copy.summary, maxChars)) {
    parts.push(`<text x="${pad}" y="${y}" font-family="${FONT}" font-size="${bodySize}" fill="${C.muted}">${esc(line)}</text>`);
    y += bodySize * 1.45;
  }
  y += chipSize * 0.8;
  let cx = pad;
  for (const chip of copy.chips.slice(0, 4)) {
    const cw = chip.length * chipSize * 0.62 + chipSize * 1.6;
    if (cx + cw > (size.kind === 'desktop' ? w * 0.47 : w - pad)) { cx = pad; y += chipSize * 2.3; }
    parts.push(`<rect x="${cx}" y="${y}" width="${cw}" height="${chipSize * 1.8}" rx="${chipSize * 0.4}" fill="${C.bg}" fill-opacity="0.5" stroke="${C.white}" stroke-opacity="0.14"/>`);
    parts.push(`<text x="${cx + cw / 2}" y="${y + chipSize * 1.28}" text-anchor="middle" font-family="${MONO}" font-size="${chipSize}" fill="${C.white}" fill-opacity="0.9">${esc(chip)}</text>`);
    cx += cw + chipSize * 0.7;
  }
  // Подвал: полное описание правила из ядра, мелко.
  const foot = describePaperExitPlan(PAPER_EXIT_PRESETS[mode]);
  const footSize = size.kind === 'desktop' ? u * 1.25 : u * 2;
  const footLines = wrap(foot, size.kind === 'desktop' ? 95 : 60);
  let fy = h - pad - footSize * (footLines.length - 1) * 1.4;
  for (const line of footLines) {
    parts.push(`<text x="${pad}" y="${fy}" font-family="${FONT}" font-size="${footSize}" fill="${C.muted}" fill-opacity="0.8">${esc(line)}</text>`);
    fy += footSize * 1.4;
  }
  parts.push(`<text x="${w - pad}" y="${h - pad}" text-anchor="end" font-family="${FONT}" font-size="${footSize}" fill="${C.muted}" fill-opacity="0.6">memex · PAPER · правило выхода</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

/* ───────────────────────────── Сборка ───────────────────────────── */

function veilSvg(size: Size): string {
  const { w, h } = size;
  const g = size.kind === 'desktop'
    ? `<linearGradient id="v" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.panel}" stop-opacity="0.9"/><stop offset="0.5" stop-color="${C.panel}" stop-opacity="0.62"/><stop offset="1" stop-color="${C.panel}" stop-opacity="0.2"/></linearGradient>`
    : `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.panel}" stop-opacity="0.9"/><stop offset="1" stop-color="${C.panel}" stop-opacity="0.45"/></linearGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>${g}</defs><rect width="${w}" height="${h}" fill="url(#v)"/></svg>`;
}

async function png(svg: string, w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 96 }).resize(w, h).png().toBuffer();
}

async function main() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  mkdirSync(LAYERS_DIR, { recursive: true });
  const modes = EXIT_MODE_COPY.map((copy) => copy.key);

  for (const mode of modes) {
    const slug = EXIT_MODE_COPY.find((c) => c.key === mode)!.art;
    for (const size of SIZES) {
      // Фон для сайта: меньше и сжатый.
      const art = artSvg(mode, size.w, size.h);
      const siteW = size.kind === 'desktop' ? 1600 : 900;
      const siteH = Math.round(siteW * size.h / size.w);
      const artPng = await png(art, siteW, siteH);
      await sharp(artPng).webp({ quality: 72 }).toFile(resolve(PUBLIC_DIR, `${slug}-${size.kind}.webp`));
      await sharp(artPng).avif({ quality: 48 }).toFile(resolve(PUBLIC_DIR, `${slug}-${size.kind}.avif`));

      // Полная карточка: фон + пелена + сцена + текст.
      const frame: SceneFrame = size.kind === 'desktop'
        ? { width: 320, height: 150, padding: { top: 14, right: 14, bottom: 12, left: 14 }, minMultiple: 0.45, maxMultiple: 2.6 }
        : { width: 320, height: 170, padding: { top: 14, right: 14, bottom: 12, left: 14 }, minMultiple: 0.45, maxMultiple: 2.6 };
      const label = EXIT_MODE_COPY.find((c) => c.key === mode)!.label;
      const sceneW = size.kind === 'desktop' ? Math.round(size.w * 0.46) : Math.round(size.w * 0.86);
      const sceneH = Math.round(sceneW * frame.height / frame.width);
      const sceneX = size.kind === 'desktop' ? size.w - sceneW - Math.round(size.w * 0.05) : Math.round(size.w * 0.07);
      const sceneY = size.kind === 'desktop' ? Math.round((size.h - sceneH) / 2) : Math.round(size.h * 0.5);
      const scenePng = await png(sceneSvg(mode, frame, label), sceneW, sceneH);
      const sceneLayer = await sharp({ create: { width: size.w, height: size.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: scenePng, left: sceneX, top: sceneY }]).png().toBuffer();
      const artFull = await png(art, size.w, size.h);
      const veil = await png(veilSvg(size), size.w, size.h);
      const text = await png(textSvg(mode, size), size.w, size.h);
      const card = await sharp(artFull).composite([{ input: veil }, { input: sceneLayer }, { input: text }]).png({ compressionLevel: 9 }).toBuffer();
      writeFileSync(resolve(OUT_DIR, `${slug}-${size.kind}.png`), card);
      if (size.kind === 'desktop') {
        writeFileSync(resolve(LAYERS_DIR, `${slug}-art.png`), artFull);
        writeFileSync(resolve(LAYERS_DIR, `${slug}-scene.png`), sceneLayer);
        writeFileSync(resolve(LAYERS_DIR, `${slug}-text.png`), text);
      }
    }
    console.log(`✓ ${mode}`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
