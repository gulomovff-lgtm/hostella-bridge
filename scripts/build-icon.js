'use strict';
/**
 * Значок Hosti Bridge из фирменного знака Hosti (assets/hosti-mark.svg —
 * копия public/favicon.svg кассы: Void-квадрат со скруглением, знак Mint,
 * точка Amber). Без внешних зависимостей: рисует сам Electron.
 *
 *   npx electron scripts/build-icon.js
 *
 * Пишет:
 *   assets/icon.ico — многоразмерный (16…256): Windows берёт готовый кадр
 *                     нужного размера в установщике, трее и панели задач,
 *                     а не ужимает единственный большой на лету;
 *   assets/icon.png — 512×512 для уведомлений и запасной вариант;
 *   assets/tray.png — 32×32.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'hosti-mark.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** Один кадр 512 CSS-пикселей (на экране 2× — 1024 растровых); размеры ниже — качественным уменьшением. */
async function renderBase() {
  const size = 512;
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" shape-rendering="geometricPrecision" `)}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img;
}
const sized = (base, n) => base.resize({ width: n, height: n, quality: 'best' }).toPNG();

/** ICO из PNG-кадров: заголовок 6 байт, по 16 байт на кадр, затем сами PNG. */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

app.whenReady().then(async () => {
  const base = await renderBase();
  const frames = ICO_SIZES.map((size) => ({ size, png: sized(base, size) }));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), buildIco(frames));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), sized(base, 512));
  fs.writeFileSync(path.join(ROOT, 'assets', 'tray.png'), frames.find((f) => f.size === 32).png);
  const check = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.ico'));
  console.log(JSON.stringify({ ico: { frames: ICO_SIZES, bytes: fs.statSync(path.join(ROOT, 'assets', 'icon.ico')).size, readable: !check.isEmpty(), size: check.getSize() } }));
  app.exit(0);
});
