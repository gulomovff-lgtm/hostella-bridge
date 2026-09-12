'use strict';
/**
 * Черновик релиза на GitHub из уже собранного `release/` — вместо
 * `electron-builder --publish always`.
 *
 * Почему не штатная публикация: electron-builder 26 грузит exe и blockmap
 * параллельно, и каждая загрузка сама ищет/создаёт черновик — оба раза
 * «не находит» и получаются ДВА черновика v0.3.1: в одном blockmap, в другом
 * exe и latest.yml. Опубликованный вручную первый оставался без установщика,
 * и автообновление у кассиров не находило файл (было в 0.2.3, 0.2.4, 0.3.0,
 * 0.3.1 — каждый раз чинили руками через `gh release upload`).
 *
 *   npm run release        → npm run dist && node scripts/publish.js
 *   затем, посмотрев черновик: gh release edit vX.Y.Z --draft=false --latest
 *
 * Нужен `gh` со входом в аккаунт владельца репозитория.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { version, productName } = { version: pkg.version, productName: pkg.build.productName };
const [owner, repo] = [pkg.build.publish[0].owner, pkg.build.publish[0].repo];
const REPO = `${owner}/${repo}`;
const TAG = `v${version}`;
const OUT = path.join(ROOT, 'release');

const gh = (args, opts = {}) => {
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
  return out == null ? '' : String(out).trim(); // при stdio:'inherit' вывод идёт в консоль, а не сюда
};

// electron-updater ищет файл под именем из latest.yml: пробелы заменены дефисами.
const built = path.join(OUT, `${productName} Setup ${version}.exe`);
const dashed = `${productName.replace(/\s+/g, '-')}-Setup-${version}.exe`;
const latest = path.join(OUT, 'latest.yml');
if (!fs.existsSync(built)) { console.error(`нет ${built} — сначала npm run dist`); process.exit(2); }
if (!fs.existsSync(latest) || !fs.readFileSync(latest, 'utf8').includes(`version: ${version}`)) {
  console.error(`release/latest.yml не от версии ${version} — сначала npm run dist`); process.exit(2);
}
if (!fs.readFileSync(latest, 'utf8').includes(`url: ${dashed}`)) { console.error(`latest.yml ждёт другое имя файла, не ${dashed}`); process.exit(2); }

const staged = path.join(OUT, dashed);
fs.copyFileSync(built, staged);
const blockmap = `${built}.blockmap`;
const stagedMap = `${staged}.blockmap`;
if (fs.existsSync(blockmap)) fs.copyFileSync(blockmap, stagedMap);

try {
  let exists = true;
  try { gh(['release', 'view', TAG, '--repo', REPO, '--json', 'isDraft']); } catch { exists = false; }
  if (!exists) {
    gh(['release', 'create', TAG, '--repo', REPO, '--draft', '--title', `${productName} ${version}`, '--notes', `${productName} ${version}`]);
    console.log(`создан черновик ${TAG}`);
  }
  const files = [staged, latest, ...(fs.existsSync(stagedMap) ? [stagedMap] : [])];
  gh(['release', 'upload', TAG, ...files, '--repo', REPO, '--clobber'], { stdio: 'inherit' });
  const assets = JSON.parse(gh(['release', 'view', TAG, '--repo', REPO, '--json', 'assets,isDraft,url']));
  const names = assets.assets.map((a) => a.name);
  const missing = [dashed, 'latest.yml'].filter((n) => !names.includes(n));
  if (missing.length) { console.error(`в релизе нет: ${missing.join(', ')}`); process.exit(1); }
  console.log(JSON.stringify({ tag: TAG, draft: assets.isDraft, assets: names, url: assets.url }));
  console.log(`опубликовать: gh release edit ${TAG} --repo ${REPO} --draft=false --latest --notes-file <заметки.md>`);
} finally {
  for (const f of [staged, stagedMap]) { try { fs.unlinkSync(f); } catch { /* не было */ } }
}
