/**
 * Разбор SVG-плана без браузера: считает по каждому элементу геометрию
 * (габариты, площадь, число контуров) и помечает типовые дефекты.
 *
 * Запуск: npm run analyze:svg [путь_к_файлу]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] ?? '1floor.svg');
const svg = readFileSync(file, 'utf8');

/* --------------------------------------------------------------- разбор SVG */

const root = svg.match(/<svg[^>]*>/is)?.[0] ?? '';
const viewBox = (root.match(/viewBox="([^"]+)"/) ?? [])[1] ?? '';
const vb = viewBox.split(/[\s,]+/).map(Number);

const elements = [];
const elementRe = /<path\b([\s\S]*?)\/>/g;
let match;
while ((match = elementRe.exec(svg)) !== null) {
  const attrs = match[1];
  const get = (name) => {
    const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    return found ? found[1] : '';
  };
  const style = get('style');
  const styleValue = (prop) => {
    const found = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(style);
    return found ? found[1].trim() : get(prop);
  };
  elements.push({
    id: get('id'),
    label: get('inkscape:label'),
    d: get('d'),
    transform: get('transform'),
    fill: styleValue('fill'),
    fillRule: styleValue('fill-rule'),
    stroke: styleValue('stroke'),
    strokeWidth: styleValue('stroke-width'),
  });
}

/* ---------------------------------------------------- минимальный парсер d */

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

function parsePath(d, curveSegments = 10) {
  const tokens = d.match(/[a-z][^a-z]*/gi) ?? [];
  const subpaths = [];
  let current = null;
  let point = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let previousControl = null;
  let command = '';

  const push = (p) => {
    current.points.push(p);
    point = p;
  };

  const startSubpath = (p) => {
    current = { points: [], closed: false, hasCurve: false };
    subpaths.push(current);
    start = p;
    point = p;
    current.points.push(p);
  };

  for (const token of tokens) {
    command = token[0];
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const numbers = (token.slice(1).match(NUM) ?? []).map(Number);

    if (upper === 'Z') {
      if (current) {
        current.closed = true;
        point = start;
      }
      continue;
    }

    const stride = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }[upper];
    if (!stride) continue;

    for (let i = 0; i + stride <= numbers.length; i += stride) {
      const n = numbers.slice(i, i + stride);
      const base = relative ? point : { x: 0, y: 0 };

      if (upper === 'M') {
        // после M пары координат трактуются как неявные L
        if (i === 0) startSubpath({ x: base.x + n[0], y: base.y + n[1] });
        else push({ x: base.x + n[0], y: base.y + n[1] });
        previousControl = null;
      } else if (upper === 'L') {
        push({ x: base.x + n[0], y: base.y + n[1] });
        previousControl = null;
      } else if (upper === 'H') {
        push({ x: (relative ? point.x : 0) + n[0], y: point.y });
        previousControl = null;
      } else if (upper === 'V') {
        push({ x: point.x, y: (relative ? point.y : 0) + n[0] });
        previousControl = null;
      } else if (upper === 'C' || upper === 'S' || upper === 'Q' || upper === 'T') {
        if (!current) startSubpath({ x: point.x, y: point.y });
        current.hasCurve = true;
        let c1;
        let c2;
        let end;
        if (upper === 'C' || upper === 'Q') {
          c1 = { x: base.x + n[0], y: base.y + n[1] };
          c2 = { x: base.x + n[2], y: base.y + n[3] };
          end = { x: base.x + n[4], y: base.y + n[5] };
        } else if (upper === 'S') {
          c1 = previousControl
            ? { x: 2 * point.x - previousControl.x, y: 2 * point.y - previousControl.y }
            : { ...point };
          c2 = { x: base.x + n[0], y: base.y + n[1] };
          end = { x: base.x + n[2], y: base.y + n[3] };
        } else {
          c1 = previousControl
            ? { x: 2 * point.x - previousControl.x, y: 2 * point.y - previousControl.y }
            : { ...point };
          c2 = { ...c1 };
          end = { x: base.x + n[0], y: base.y + n[1] };
        }
        for (let s = 1; s <= curveSegments; s += 1) {
          const t = s / curveSegments;
          const mt = 1 - t;
          const x =
            upper === 'Q' || upper === 'T'
              ? mt * mt * point.x + 2 * mt * t * c1.x + t * t * end.x
              : mt ** 3 * point.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t ** 3 * end.x;
          const y =
            upper === 'Q' || upper === 'T'
              ? mt * mt * point.y + 2 * mt * t * c1.y + t * t * end.y
              : mt ** 3 * point.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t ** 3 * end.y;
          current.points.push({ x, y });
        }
        point = end;
        previousControl = upper === 'Q' || upper === 'T' ? c1 : c2;
      } else if (upper === 'A') {
        if (!current) startSubpath({ x: point.x, y: point.y });
        current.hasCurve = true;
        const end = { x: base.x + n[5], y: base.y + n[6] };
        for (let s = 1; s <= curveSegments * 2; s += 1) {
          const t = s / (curveSegments * 2);
          current.points.push({ x: point.x + (end.x - point.x) * t, y: point.y + (end.y - point.y) * t });
        }
        point = end;
        previousControl = null;
      }
    }
  }

  return subpaths;
}

/* ------------------------------------------------------------- трансформация */

function parseMatrix(text) {
  if (!text) return [1, 0, 0, 1, 0, 0];
  const matrix = [1, 0, 0, 1, 0, 0];
  const multiply = (m) => {
    const [a, b, c, d, e, f] = m;
    const next = [
      matrix[0] * a + matrix[2] * b,
      matrix[1] * a + matrix[3] * b,
      matrix[0] * c + matrix[2] * d,
      matrix[1] * c + matrix[3] * d,
      matrix[0] * e + matrix[2] * f + matrix[4],
      matrix[1] * e + matrix[3] * f + matrix[5],
    ];
    for (let i = 0; i < 6; i += 1) matrix[i] = next[i];
  };

  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let found;
  while ((found = re.exec(text)) !== null) {
    const v = (found[2].match(NUM) ?? []).map(Number);
    if (found[1] === 'matrix') multiply(v);
    else if (found[1] === 'translate') multiply([1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]);
    else if (found[1] === 'scale') multiply([v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]);
    else if (found[1] === 'rotate') {
      const a = ((v[0] ?? 0) * Math.PI) / 180;
      multiply([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), v[1] ?? 0, v[2] ?? 0]);
    }
  }
  return matrix;
}

const applyMatrix = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/* ---------------------------------------------------------------- метрики */

const signedArea = (points) => {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return area / 2;
};

const bboxOf = (points) =>
  points.reduce(
    (box, p) => ({
      minX: Math.min(box.minX, p.x),
      minY: Math.min(box.minY, p.y),
      maxX: Math.max(box.maxX, p.x),
      maxY: Math.max(box.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function hasSelfIntersection(points) {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 1; j < n; j += 1) {
      if (j === i || (j + 1) % n === i || j === (i + 1) % n) continue;
      if (segmentsCross(a, b, points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ отчёт */

const rows = [];
let totalArea = 0;

for (const element of elements) {
  const matrix = parseMatrix(element.transform);
  const subpaths = parsePath(element.d).map((subpath) => ({
    ...subpath,
    points: subpath.points.map((p) => applyMatrix(matrix, p)),
  }));

  const allPoints = subpaths.flatMap((s) => s.points);
  const box = bboxOf(allPoints.length ? allPoints : [{ x: 0, y: 0 }]);
  const area = subpaths.reduce((sum, s) => sum + Math.abs(signedArea(s.points)), 0);
  const boxArea = Math.max((box.maxX - box.minX) * (box.maxY - box.minY), 1e-6);
  const ratio = area / boxArea;
  const selfIntersecting = subpaths.some((s) => (s.closed ? hasSelfIntersection(s.points) : false));

  const flags = [];
  if (!element.label) flags.push('БЕЗ ПОДПИСИ');
  if (element.fill === 'none') flags.push('только обводка');
  if (subpaths.some((s) => !s.closed)) flags.push('контур не замкнут');
  if (subpaths.length > 1) flags.push(`контуров: ${subpaths.length}`);
  if (ratio < 0.45 && area > 0) flags.push('тонкая рамка');
  if (box.maxX - box.minX < 14 && box.maxY - box.minY < 14) flags.push('очень мелкий');
  if (selfIntersecting) flags.push('самопересечение');
  if (element.label && !/^[a-z]+_\d/.test(element.label)) flags.push('имя вне схемы');

  totalArea += area;
  rows.push({
    id: element.id,
    label: element.label || '—',
    box,
    size: `${round(box.maxX - box.minX)}×${round(box.maxY - box.minY)}`,
    area: round(area),
    ratio: Math.round(ratio * 100) / 100,
    flags,
  });
}

function round(value) {
  return Math.round(value * 100) / 100;
}

const fileBox = {
  minX: Math.min(...rows.map((r) => r.box.minX)),
  minY: Math.min(...rows.map((r) => r.box.minY)),
  maxX: Math.max(...rows.map((r) => r.box.maxX)),
  maxY: Math.max(...rows.map((r) => r.box.maxY)),
};

console.log(`Файл: ${file}`);
console.log(`viewBox: ${viewBox}`);
console.log(`Элементов <path>: ${elements.length}`);
console.log(`Общий габарит геометрии: x ${round(fileBox.minX)}…${round(fileBox.maxX)}, y ${round(fileBox.minY)}…${round(fileBox.maxY)}`);

const byFlag = (flag) => rows.filter((r) => r.flags.some((f) => f.startsWith(flag)));
console.log(`\nБез подписи inkscape:label: ${byFlag('БЕЗ').length}`);
console.log(`Только обводка (fill:none): ${byFlag('только').length}`);
console.log(`Незамкнутые контуры: ${byFlag('контур').length}`);
console.log(`Тонкие рамки (площадь < 45% габарита): ${byFlag('тонкая').length}`);
console.log(`Очень мелкие (<14×14): ${byFlag('очень').length}`);
console.log(`Самопересечения: ${byFlag('самопересеч').length}`);
console.log(`Имена вне схемы «тип_номер»: ${byFlag('имя').length}`);

console.log('\n--- Тонкие рамки / мелкие элементы ---');
for (const row of rows.filter((r) => r.flags.some((f) => f.startsWith('тонкая') || f.startsWith('очень')))) {
  console.log(
    `${row.label.padEnd(22)} ${row.id.padEnd(9)} ${row.size.padStart(12)}  S=${String(row.area).padStart(9)}  ratio=${row.ratio}  ${row.flags.join(', ')}`,
  );
}

console.log('\n--- Незамкнутые контуры ---');
for (const row of byFlag('контур')) {
  console.log(`${row.label.padEnd(22)} ${row.id.padEnd(9)} ${row.size.padStart(12)}  S=${String(row.area).padStart(9)}  ratio=${row.ratio}`);
}

console.log('\n--- Полная таблица (сортировка сверху-вниз, слева-направо) ---');
rows.sort((a, b) => (a.box.minY - b.box.minY) || (a.box.minX - b.box.minX));
for (const row of rows) {
  const pos = `x ${round(row.box.minX)}…${round(row.box.maxX)}  y ${round(row.box.minY)}…${round(row.box.maxY)}`;
  console.log(
    `${row.label.padEnd(22)} ${row.id.padEnd(9)} ${pos.padEnd(34)} S=${String(row.area).padStart(9)} ratio=${row.ratio}  ${row.flags.join(', ')}`,
  );
}
