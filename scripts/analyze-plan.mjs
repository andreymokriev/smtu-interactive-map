/**
 * Разбор уже загруженного плана: что приложение реально построило.
 *
 * Полезно после правки SVG в Inkscape — показывает, у каких помещений контур
 * тонкий (пришлось запечатывать проёмы), у каких плита не построилась и какие
 * подписи не попадают в схему «тип_номер».
 *
 * Запуск: npm run build && npm run preview  (в отдельном терминале)
 *         npm run analyze:plan
 * Переменные окружения: BASE_URL (по умолчанию http://localhost:4173), CHROME_PATH.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error('Не найден Chrome. Укажите путь в переменной CHROME_PATH.');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

try {
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__navigator?.diagnostics().ready === true, { timeout: 30000 });
} catch (error) {
  console.error(`Не удалось открыть ${BASE_URL}: ${error.message}`);
  console.error('Сначала запустите: npm run build && npm run preview');
  await browser.close();
  process.exit(2);
}

const dump = await page.evaluate(() => ({
  diagnostics: window.__navigator.diagnostics(),
  rooms: window.__navigator.plan.rooms.map((room) => ({
    id: room.id,
    title: room.title,
    kind: room.kind,
    area: room.area,
    width: room.bounds.max.x - room.bounds.min.x,
    height: room.bounds.max.y - room.bounds.min.y,
    contours: room.contours,
    sealRadius: room.sealRadius,
    loops: room.loops,
  })),
}));

await browser.close();

const { diagnostics, rooms } = dump;
console.log(`Помещений: ${rooms.length}, фигур стен: ${diagnostics.wallsShapes}`);
console.log(`Габарит плана: x ${diagnostics.bounds.minX}…${diagnostics.bounds.maxX}, y ${diagnostics.bounds.minY}…${diagnostics.bounds.maxY}`);

console.log('\n--- Замечания приложения к плану ---');
if (diagnostics.warnings.length === 0) console.log('нет');
for (const warning of diagnostics.warnings) console.log(` · ${warning}`);

const withRatio = rooms.map((room) => ({
  ...room,
  ratio: room.area / Math.max(room.width * room.height, 1e-6),
}));

const sealed = withRatio.filter((room) => room.sealRadius !== null && room.sealRadius > 0.7);
console.log(`\n--- Нарисованы тонкой «двойной линией» (пятно приходилось заливать): ${sealed.length} ---`);
for (const room of sealed.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(
    ` ${room.id.padEnd(22)} ${room.width.toFixed(1)}×${room.height.toFixed(1)}`.padEnd(46) +
      `подпись «${room.title}», запечатано радиусом ${room.sealRadius}, контуров ${room.contours}`,
  );
}

const suspicious = withRatio.filter((room) => room.ratio < 0.3 || room.ratio > 1.02);
console.log(`\n--- Подозрительные пятна (площадь/габарит вне 0.3…1.02): ${suspicious.length} ---`);
for (const room of suspicious.sort((a, b) => a.ratio - b.ratio)) {
  console.log(
    ` ${room.id.padEnd(22)} пятно ${room.area.toFixed(1).padStart(8)} при габарите ${(room.width * room.height).toFixed(1).padStart(8)}  ratio=${room.ratio.toFixed(2)}`,
  );
}

console.log('\n--- Все помещения ---');
for (const room of withRatio.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(
    ` ${room.id.padEnd(22)} ${room.kind.padEnd(8)} пятно ${room.area.toFixed(1).padStart(8)}  ratio=${room.ratio.toFixed(2)}  ${room.title}`,
  );
}
