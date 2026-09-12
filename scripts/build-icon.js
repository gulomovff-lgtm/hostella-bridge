'use strict';
/**
 * Значок Hosti Bridge из фирменного знака Hosti (assets/hosti-mark.svg —
 * копия public/favicon.svg кассы: Void-квадрат со скруглением, знак Mint,
 * точка Amber). Без внешних зависимостей: рисует сам Electron.
 *
 *   npx electron scripts/build-icon.js
 *
 * Пишет assets/icon.png (512×512, для установщика и окна — electron-builder
 * соберёт из него .ico) и assets/tray.png (32×32, значок в трее).
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SVG = fs.readFileSync(path.join(ROOT, 'assets', 'hosti-mark.svg'), 'utf8');

app.whenReady().then(async () => {
  const size = 512;
  const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden">${SVG.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const png = img.toPNG();
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), png);
  fs.writeFileSync(path.join(ROOT, 'assets', 'tray.png'), nativeImage.createFromBuffer(png).resize({ width: 32, height: 32 }).toPNG());
  console.log(JSON.stringify({ icon: img.getSize(), bytes: png.length }));
  app.exit(0);
});
