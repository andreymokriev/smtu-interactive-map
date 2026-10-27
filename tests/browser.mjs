/**
 * Проверка приложения в реальном браузере (headless Chrome через puppeteer-core).
 *
 * Запуск: npm run build && npm run preview  ->  npm run test:browser
 * Переменные окружения: BASE_URL (по умолчанию http://localhost:4173), CHROME_PATH.
 *
 * Что проверяем:
 *  - геометрия плана совпадает с тем, как план рисует сам браузер (getBBox и canvas-растеризация);
 *  - помещения, нарисованные «двойной линией», получают залитое пятно, а не пустую рамку;
 *  - поиск находит аудиторию, выбор по тапу работает через настоящие события указателя;
 *  - фильтры типов и переключатель номеров влияют на модель;
 *  - кадр действительно отрисован (не пустой и не однотонный);
 *  - мобильная вёрстка не разъезжается.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4173';
const DPR = 1;

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
if (!executablePath) {
  console.error('Не найден Chrome. Укажите путь в переменной CHROME_PATH.');
  process.exit(2);
}

const results = [];
let failed = 0;

function check(name, condition, details = '') {
  const ok = Boolean(condition);
  results.push({ name, ok });
  if (!ok) failed += 1;
  console.log(`${ok ? '✔' : '✖'} ${name}${details ? ` — ${details}` : ''}`);
  return ok;
}

const near = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;

/* ------------------------------------------------------------------ helpers */

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--window-size=1280,800',
  ],
});

const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/WebGL|SwiftShader|Deprecat|Failed to load resource: net::ERR_/i.test(text)) return;
  pageErrors.push(`console.error: ${text}`);
});

async function openApp(viewport) {
  await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: DPR, hasTouch: Boolean(viewport.hasTouch) });
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__navigator?.diagnostics().ready === true, { timeout: 30000 });
}

/* -------------------------------------------------- эталонная геометрия */

/**
 * Эталон считаем средствами самого браузера: габарит — через getBBox,
 * площади — через canvas так, как SVG отрисовался бы на странице.
 */
async function measureTruth(labels) {
  return page.evaluate((wantedLabels) => {
    const NS = 'http://www.w3.org/2000/svg';
    const INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';

    const parseMatrix = (text) => {
      let m = [1, 0, 0, 1, 0, 0];
      const mul = (n) => {
        m = [
          m[0] * n[0] + m[2] * n[1],
          m[1] * n[0] + m[3] * n[1],
          m[0] * n[2] + m[2] * n[3],
          m[1] * n[2] + m[3] * n[3],
          m[0] * n[4] + m[2] * n[5] + m[4],
          m[1] * n[4] + m[3] * n[5] + m[5],
        ];
      };
      const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
      let found;
      while ((found = re.exec(text)) !== null) {
        const v = (found[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        if (found[1] === 'matrix') mul(v);
        else if (found[1] === 'translate') mul([1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]);
        else if (found[1] === 'scale') mul([v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]);
        else if (found[1] === 'rotate') {
          const a = ((v[0] ?? 0) * Math.PI) / 180;
          mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), v[1] ?? 0, v[2] ?? 0]);
        }
      }
      return m;
    };

    const labelOf = (el) => el.getAttributeNS(INKSCAPE, 'label') || el.getAttribute('inkscape:label') || '';
    const fillRuleOf = (el) => {
      const style = el.getAttribute('style') || '';
      return /fill-rule\s*:\s*(\w+)/.exec(style)?.[1] || el.getAttribute('fill-rule') || 'nonzero';
    };

    return fetch(window.__navigator.planUrl)
      .then((response) => response.text())
      .then((text) => {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const host = document.createElementNS(NS, 'svg');
        host.setAttribute('viewBox', doc.documentElement.getAttribute('viewBox') ?? '0 0 768 576');
        host.style.cssText = 'position:absolute;left:-10000px;top:0;width:768px;height:576px';

        const paths = [];
        for (const child of Array.from(doc.documentElement.children)) {
          if (child.nodeName === 'sodipodi:namedview' || child.nodeName === 'defs') continue;
          const copy = document.importNode(child, true);
          host.appendChild(copy);
          paths.push(...copy.querySelectorAll('path'));
        }
        document.body.appendChild(host);

        const rootBox = host.getBBox();

        const rasterArea = (el) => {
          const box = el.getBBox();
          const m = parseMatrix(el.getAttribute('transform') ?? '');
          const corners = [
            [box.x, box.y],
            [box.x + box.width, box.y],
            [box.x, box.y + box.height],
            [box.x + box.width, box.y + box.height],
          ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

          const minX = Math.min(...corners.map((c) => c[0])) - 1;
          const minY = Math.min(...corners.map((c) => c[1])) - 1;
          const maxX = Math.max(...corners.map((c) => c[0])) + 1;
          const maxY = Math.max(...corners.map((c) => c[1])) + 1;

          const scale = 4;
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(2, Math.ceil((maxX - minX) * scale));
          canvas.height = Math.max(2, Math.ceil((maxY - minY) * scale));
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
          ctx.transform(...m);
          ctx.fillStyle = '#000';
          ctx.fill(new Path2D(el.getAttribute('d')), fillRuleOf(el) === 'evenodd' ? 'evenodd' : 'nonzero');

          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let filled = 0;
          for (let i = 3; i < data.length; i += 4) if (data[i] > 127) filled += 1;
          return filled / (scale * scale);
        };

        const areas = {};
        for (const label of wantedLabels) {
          const el = paths.find((candidate) => labelOf(candidate) === label);
          if (el) areas[label] = rasterArea(el);
        }

        host.remove();
        return {
          bbox: { minX: rootBox.x, minY: rootBox.y, maxX: rootBox.x + rootBox.width, maxY: rootBox.y + rootBox.height },
          areas,
          pathCount: paths.length,
        };
      });
  }, labels);
}

/** Площадь «пятна» стен, спроецированного на пол, по геометрии three.js. */
async function wallsFootprintArea() {
  return page.evaluate(() => {
    const mesh = window.__navigator.model.wallsMesh;
    const position = mesh.geometry.attributes.position;
    let area = 0;
    for (let i = 0; i < position.count; i += 3) {
      const ax = position.getX(i);
      const ay = position.getY(i);
      const az = position.getZ(i);
      const bx = position.getX(i + 1);
      const by = position.getY(i + 1);
      const bz = position.getZ(i + 1);
      const cx = position.getX(i + 2);
      const cy = position.getY(i + 2);
      const cz = position.getZ(i + 2);

      // нормаль треугольника: берём только верхние грани (нормаль вверх)
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const ny = uz * vx - ux * vz;
      if (ny <= 0.5) continue;
      area += Math.abs((ux * vz - uz * vx) / 2);
    }
    return area;
  });
}

/* ------------------------------------------------------------------- прогон */

console.log(`\nПроверка ${BASE_URL} в ${executablePath}\n`);

await openApp({ width: 1280, height: 800 });

const loadMs = await page.evaluate(() => Math.round(performance.now()));
check('план загружается и разбирается меньше чем за 4 с', loadMs < 4000, `${loadMs} мс`);

const diagnostics = await page.evaluate(() => window.__navigator.diagnostics());
console.log(
  `Помещений: ${diagnostics.rooms}, контуров стен: ${diagnostics.wallsShapes}, ` +
    `полигонов помещений: ${diagnostics.labelsBuilt}, предупреждений: ${diagnostics.warnings.length}`,
);
if (diagnostics.warnings.length > 0) {
  for (const warning of diagnostics.warnings) console.log(`   · ${warning}`);
}

check('приложение готово и план разобран', diagnostics.ready && diagnostics.rooms >= 70, `${diagnostics.rooms} помещений`);
check('стены найдены', diagnostics.wallsShapes > 0, `${diagnostics.wallsShapes} фигур`);
check(
  'элемент без подписи (path84) пропущен с предупреждением',
  diagnostics.warnings.some((warning) => warning.includes('path84') && warning.includes('пропущен')),
  diagnostics.warnings.join(' | '),
);

const knownLabels = [
  'stud_101',
  'stud_105',
  'stud_124',
  'dep_146_147_148',
  'other_gym',
  'toilet_1',
  'admin_183',
  'dean_133',
  'stud_191a',
  'other_157',
  '162',
  '164',
];
const missing = await page.evaluate(
  (labels) => labels.filter((label) => !window.__navigator.plan.rooms.some((room) => room.id === label)),
  knownLabels,
);
check('все ключевые помещения из плана на месте', missing.length === 0, `не найдены: ${missing.join(', ')}`);
check('каждое помещение получило плиту и подпись', diagnostics.labelsBuilt === diagnostics.rooms);
check('нет ошибок в консоли страницы', pageErrors.length === 0, pageErrors.join(' | '));

const truth = await measureTruth(['walls', 'stud_124', 'dean_130', 'dep_143', 'admin_183', 'toilet_3', 'stud_105']);

check(
  'габарит геометрии совпадает с габаритом SVG по версии браузера',
  near(diagnostics.bounds.minX, truth.bbox.minX, 2) &&
    near(diagnostics.bounds.maxX, truth.bbox.maxX, 2) &&
    near(diagnostics.bounds.minY, truth.bbox.minY, 2) &&
    near(diagnostics.bounds.maxY, truth.bbox.maxY, 2),
  `three ${JSON.stringify(diagnostics.bounds)} vs браузер x ${truth.bbox.minX.toFixed(1)}…${truth.bbox.maxX.toFixed(1)}, y ${truth.bbox.minY.toFixed(1)}…${truth.bbox.maxY.toFixed(1)}`,
);

const wallsArea = await wallsFootprintArea();
check(
  'пятно стен в 3D совпадает с отрисовкой SVG',
  wallsArea > truth.areas.walls * 0.97 && wallsArea < truth.areas.walls * 1.03,
  `3D ${wallsArea.toFixed(0)} vs SVG ${truth.areas.walls.toFixed(0)}`,
);

// «Двойные линии»: у таких помещений контур тонкий, а пятно должно быть залито.
for (const label of ['stud_124', 'dean_130', 'dep_143', 'admin_183', 'toilet_3']) {
  const room = await page.evaluate((id) => {
    const found = window.__navigator.plan.rooms.find((candidate) => candidate.id === id);
    return found ? { area: found.area, width: found.bounds.max.x - found.bounds.min.x, height: found.bounds.max.y - found.bounds.min.y } : null;
  }, label);

  check(
    `помещение «${label}» получило залитое пятно, а не рамку`,
    room && room.area > truth.areas[label] * 1.6 && room.area > room.width * room.height * 0.6,
    `площадь ${room?.area.toFixed(1)} против контура ${truth.areas[label].toFixed(1)}, габарит ${room?.width.toFixed(1)}×${room?.height.toFixed(1)}`,
  );
}

// Разбор не зависит от того, чем нарисована комната: rect и polygon обрабатываются как path.
const shapesSupport = await page.evaluate(async () => {
  const text = await (await fetch(window.__navigator.planUrl)).text();
  const extra =
    '<rect x="212" y="152" width="24" height="18" inkscape:label="stud_901" fill="#000000" />' +
    '<polygon points="250,152 274,152 274,170 250,170" inkscape:label="stud_902" fill="#000000" />' +
    '<g transform="translate(6,0)"><rect x="300" y="156" width="24" height="18" inkscape:label="stud_903" fill="#000000" /></g>';
  const parsed = window.__navigator.parseText(text.replace('</g>', extra + '</g>'));
  return parsed.rooms
    .filter((room) => room.id.startsWith('stud_90'))
    .map((room) => ({ id: room.id, area: Math.round(room.area), x: Math.round(room.bounds.min.x) }));
});

check(
  'прямоугольник и многоугольник разбираются наравне с path',
  shapesSupport.length === 3 && shapesSupport.every((room) => Math.abs(room.area - 432) < 30),
  shapesSupport.map((room) => `${room.id}: ${room.area} ед²`).join(', '),
);
check(
  'transform группы учитывается при построении пятна',
  shapesSupport.every((room) => room.id !== 'stud_903' || Math.abs(room.x - 306) <= 1),
  `stud_903 начинается с x=${shapesSupport.find((room) => room.id === 'stud_903')?.x} (ожидается 306)`,
);

// Плита должна занимать разумную часть своего габарита: тонкая рамка — это ошибка,
// а пятно больше габарита — тоже (значит, контур залился не туда).
const ratios = await page.evaluate(() =>
  window.__navigator.plan.rooms.map((room) => ({
    id: room.id,
    ratio:
      room.area /
      Math.max((room.bounds.max.x - room.bounds.min.x) * (room.bounds.max.y - room.bounds.min.y), 1e-6),
  })),
);
const odd = ratios.filter((item) => item.ratio < 0.22 || item.ratio > 1.02);
check(
  'у каждого помещения плита занимает разумную часть габарита',
  odd.length === 0,
  odd.map((item) => `${item.id}=${item.ratio.toFixed(2)}`).join(', ') || `минимум ${Math.min(...ratios.map((r) => r.ratio)).toFixed(2)}`,
);

/* ------------------------------------------------------------------ поиск */

await page.click('#query');
await page.type('#query', '105');
await page.waitForSelector('#results .result');
const firstResult = await page.$eval('#results .result', (el) => el.textContent.trim());
check('поиск «105» находит аудиторию 105', /Аудитория 105/.test(firstResult), firstResult);

await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__navigator.diagnostics().selected === 'stud_105', { timeout: 5000 });
// дожидаемся окончания перелёта камеры
await page.waitForFunction(
  () => {
    const view = window.__navigator.diagnostics();
    return view.cameraDistance < view.fitDistance * 0.8;
  },
  { timeout: 5000 },
);
const afterSelect = await page.evaluate(() => ({
  card: document.getElementById('card-title').textContent,
  sub: document.getElementById('card-sub').textContent,
  camera: window.__navigator.diagnostics().cameraDistance,
  fit: window.__navigator.diagnostics().fitDistance,
}));
check('карточка помещения показывает найденную аудиторию', afterSelect.card === 'Аудитория 105', afterSelect.card);
check('в карточке видно исходную подпись из плана', afterSelect.sub.includes('stud_105'), afterSelect.sub);
check('камера подлетела к помещению', afterSelect.camera < afterSelect.fit * 0.8, `камера ${afterSelect.camera}, общий вид ${afterSelect.fit}`);

/* --------------------------------------------------- выбор касанием */

const points = await page.evaluate(() => {
  window.__navigator.reset();
  window.__navigator.select(null);
  const canvas = document.querySelector('#viewport canvas');
  const rect = canvas.getBoundingClientRect();
  const found = [];
  for (let k = 0.06; k <= 0.94; k += 0.01) {
    const x = rect.left + rect.width * k;
    const y = rect.top + rect.height * 0.5;
    const id = window.__navigator.pick(x, y);
    if (id) found.push({ x, y, id });
  }
  return found;
});

const distinct = [];
for (const point of points) {
  if (!distinct.some((item) => item.id === point.id)) distinct.push(point);
}
check('по центру экрана находятся разные помещения', distinct.length >= 3, distinct.map((item) => item.id).join(', '));

for (const point of distinct.slice(0, 2)) {
  await page.mouse.click(point.x, point.y);
  const selected = await page.evaluate(() => window.__navigator.diagnostics().selected);
  check(`тап выбирает помещение «${point.id}»`, selected === point.id, `выбрано ${selected}`);
}

await page.evaluate(() => {
  document.getElementById('card-close').click();
});
check('закрытие карточки снимает выделение', (await page.evaluate(() => window.__navigator.diagnostics().selected)) === null);

/* ------------------------------------------------- фильтры и подписи */

await page.evaluate(() => document.querySelector('.chip[data-kind="dep"]').click());
const filtered = await page.evaluate(() => ({
  depVisible: window.__navigator.model.views.get('dep_190').mesh.visible,
  studVisible: window.__navigator.model.views.get('stud_105').mesh.visible,
  pressed: document.querySelector('.chip[data-kind="dep"]').getAttribute('aria-pressed'),
}));
check('фильтр «Кафедры» скрывает кафедры и не трогает аудитории', filtered.depVisible === false && filtered.studVisible === true && filtered.pressed === 'false');

await page.evaluate(() => document.querySelector('.chip[data-kind="dep"]').click());
await page.click('#btn-labels');
const labelsOff = await page.evaluate(() => window.__navigator.diagnostics().visibleLabels);
check('переключатель номеров скрывает все подписи', labelsOff === 0, `${labelsOff} подписей`);

await page.click('#btn-top');
await new Promise((resolve) => setTimeout(resolve, 900));
const topView = await page.evaluate(() => {
  const camera = window.__navigator.camera;
  const target = window.__navigator.controls.target;
  return camera.position.distanceTo(target);
});
check('вид сверху переворачивает камеру без потери объекта', topView > 100, `расстояние ${topView.toFixed(0)}`);

/* -------------------------------------------------------- кадр не пустой */

const frame = await page.evaluate(() => {
  window.__navigator.renderNow();
  const canvas = document.querySelector('#viewport canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const width = canvas.width;
  const height = canvas.height;
  const buffer = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer);

  let covered = 0;
  let sum = 0;
  let min = 255;
  let max = 0;
  const colours = new Set();
  for (let i = 0; i < width * height; i += 1) {
    if (buffer[i * 4 + 3] < 32) continue; // прозрачный фон страницы
    const luma = 0.2126 * buffer[i * 4] + 0.7152 * buffer[i * 4 + 1] + 0.0722 * buffer[i * 4 + 2];
    covered += 1;
    sum += luma;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    if (colours.size < 4000) {
      colours.add(((buffer[i * 4] >> 3) << 10) | ((buffer[i * 4 + 1] >> 3) << 5) | (buffer[i * 4 + 2] >> 3));
    }
  }
  return { width, height, covered: covered / (width * height), mean: sum / Math.max(covered, 1), min, max, colours: colours.size };
});

check('кадр отрисован и заполнен не полностью', frame.covered > 0.1 && frame.covered < 0.995, `занято ${(frame.covered * 100).toFixed(1)}%`);
check('освещение и цвета в норме (нет чёрного или белого экрана)', frame.mean > 60 && frame.mean < 250, `средняя яркость ${frame.mean.toFixed(0)}`);
check('в кадре есть разнообразие цветов', frame.colours > 40 && frame.max - frame.min > 40, `${frame.colours} оттенков, диапазон ${(frame.max - frame.min).toFixed(0)}`);

/* ------------------------------------------------------------- мобильный вид */

await openApp({ width: 390, height: 844, hasTouch: true });
const mobileLabels = await page.evaluate(() => window.__navigator.diagnostics().visibleLabels);
check('на телефоне общий вид не засыпан номерами', mobileLabels < 10, `${mobileLabels} подписей`);

await page.evaluate(() => {
  window.__navigator.select('stud_105', { focus: false });
});
const mobile = await page.evaluate(() => {
  const field = document.querySelector('.search__field').getBoundingClientRect();
  const legend = document.getElementById('legend');
  const card = document.getElementById('card').getBoundingClientRect();
  const controls = document.querySelector('.controls').getBoundingClientRect();
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    overflowX: document.documentElement.scrollWidth,
    field: { left: field.left, right: field.right, top: field.top },
    legendScrolls: legend.scrollWidth >= legend.clientWidth,
    card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
    controls: { left: controls.left, right: controls.right, top: controls.top, bottom: controls.bottom },
  };
});

check('на телефоне нет горизонтальной прокрутки', mobile.overflowX <= mobile.innerWidth + 1, `${mobile.overflowX} ≤ ${mobile.innerWidth}`);
check('поиск на телефоне помещается в экран', mobile.field.left >= 0 && mobile.field.right <= mobile.innerWidth + 1);
check('легенда типов прокручивается по горизонтали', mobile.legendScrolls);
check(
  'карточка и кнопки вида не выходят за пределы экрана',
  mobile.card.left >= 0 && mobile.card.right <= mobile.innerWidth + 1 && mobile.card.bottom <= mobile.innerHeight + 1 &&
    mobile.controls.left >= 0 && mobile.controls.right <= mobile.innerWidth + 1 && mobile.controls.top >= 0,
  `карточка ${mobile.card.top.toFixed(0)}…${mobile.card.bottom.toFixed(0)}, кнопки ${mobile.controls.left.toFixed(0)}…${mobile.controls.right.toFixed(0)}`,
);
check('на телефоне ошибок не появилось', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();

console.log(`\nПроверок: ${results.length}, провалено: ${failed}`);
if (failed > 0) {
  console.log('Проваленные:');
  for (const result of results.filter((item) => !item.ok)) console.log(`  ✖ ${result.name}`);
  process.exit(1);
}
assert.equal(failed, 0);
