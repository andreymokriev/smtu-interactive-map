/**
 * Извлечение «пятна» помещения из SVG-контура.
 *
 * Проблема: в плане помещения нарисованы по-разному — где-то одинарной линией
 * с проёмом двери, где-то замкнутой «двойной линией» (контур стены толщиной ~0.3).
 * Если такие фигуры просто залить, комната превратится в пустую рамку.
 *
 * Поэтому контур сначала растрируется так, как его нарисовал бы браузер
 * (Path2D + fill-rule), затем внутренние «дыры» заливаются, а контур полученной
 * области восстанавливается трассировкой и упрощается.
 */
import { Path, Shape, Vector2 } from 'three';
import { polygonArea } from './geometry.js';

const PADDING = 3; // запас вокруг фигуры в единицах плана (больше радиуса запечатывания)
const MAX_SIDE = 1600; // предохранитель по размеру растра
const SIMPLIFY_EPSILON = 0.45; // упрощение контура, единицы плана
const ALPHA_THRESHOLD = 32; // пиксель считается залитым при заметном покрытии
const DEFAULT_PX_PER_UNIT = 8;
/**
 * В плане есть два вида узких проходов: проём двери в контуре комнаты (нужно
 * запечатать) и щель между соседними комнатами (запечатывать не нужно, иначе
 * плита расползётся на соседей). Радиус запечатывания начинаем с минимального
 * и увеличиваем только для комнат, нарисованных тонкой «рамкой».
 */
const SEAL_RADII = [0.7, 1.1, 1.7];
const RING_RATIO = 0.5; // залитая часть оболочки, ниже которой контур считается тонкой рамкой
const FILLED_RATIO = 0.5; // пятно считается полным, когда покрыло половину оболочки

/* --------------------------------------------------------- матрица SVG */

/** Произведение матриц a ∘ b (сначала применяется b). */
export function multiplyMatrices(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Разбирает transform="matrix(...) translate(...) scale(...) rotate(...)". */
export function parseSvgMatrix(text) {
  let matrix = [1, 0, 0, 1, 0, 0];
  if (!text) return matrix;

  const re = /(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g;
  let found;
  while ((found = re.exec(text)) !== null) {
    const values = (found[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let step = [1, 0, 0, 1, 0, 0];
    if (found[1] === 'matrix') step = values;
    else if (found[1] === 'translate') step = [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0];
    else if (found[1] === 'scale') step = [values[0] ?? 1, 0, 0, values[1] ?? values[0] ?? 1, 0, 0];
    else if (found[1] === 'rotate') {
      const angle = ((values[0] ?? 0) * Math.PI) / 180;
      step = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), values[1] ?? 0, values[2] ?? 0];
    }
    matrix = multiplyMatrices(matrix, step);
  }
  return matrix;
}

/* ------------------------------------------------------------ растр */

let scratch = { canvas: null, context: null, width: 0, height: 0 };

function getScratch(width, height) {
  if (!scratch.canvas) {
    scratch.canvas = document.createElement('canvas');
    scratch.context = scratch.canvas.getContext('2d', { willReadFrequently: true });
  }
  if (scratch.width < width || scratch.height < height) {
    scratch.width = Math.max(scratch.width, width);
    scratch.height = Math.max(scratch.height, height);
    scratch.canvas.width = scratch.width;
    scratch.canvas.height = scratch.height;
    scratch.context = scratch.canvas.getContext('2d', { willReadFrequently: true });
  }
  return scratch;
}

/**
 * Расстояние от каждого фонового пикселя до ближайшего закрашенного
 * (двухпроходный chamfer 3–4, значения в третьих долях пикселя).
 */
function distanceTransform(grid, width, height) {
  const INF = 1 << 28;
  const distance = new Int32Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) distance[i] = grid[i] === 1 ? 0 : INF;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let best = distance[i];
      if (x > 0) best = Math.min(best, distance[i - 1] + 3);
      if (y > 0) {
        best = Math.min(best, distance[i - width] + 3);
        if (x > 0) best = Math.min(best, distance[i - width - 1] + 4);
        if (x < width - 1) best = Math.min(best, distance[i - width + 1] + 4);
      }
      distance[i] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      let best = distance[i];
      if (x < width - 1) best = Math.min(best, distance[i + 1] + 3);
      if (y < height - 1) {
        best = Math.min(best, distance[i + width] + 3);
        if (x > 0) best = Math.min(best, distance[i + width - 1] + 4);
        if (x < width - 1) best = Math.min(best, distance[i + width + 1] + 4);
      }
      distance[i] = best;
    }
  }

  return distance;
}

/**
 * Превращает контур в залитое пятно.
 *
 * Из края растра распространяем «внешний» фон, но не через узкие проходы
 * (ширина меньше двух SEAL_RADIUS) — так затягиваются проёмы дверей. Всё, что
 * осталось недостижимым, принадлежит помещению: и контур стены, и его внутренность.
 */
function fillHoles(grid, width, height, scale, sealRadius) {
  const distance = distanceTransform(grid, width, height);
  const limit = sealRadius * scale * 3;
  const outside = new Uint8Array(grid.length);
  const queue = [];

  for (let x = 0; x < width; x += 1) {
    queue.push(x, x + (height - 1) * width);
  }
  for (let y = 0; y < height; y += 1) {
    queue.push(y * width, y * width + width - 1);
  }

  while (queue.length > 0) {
    const index = queue.pop();
    if (outside[index] === 1 || grid[index] === 1 || distance[index] < limit) continue;
    outside[index] = 1;
    const x = index % width;
    if (x > 0 && outside[index - 1] === 0) queue.push(index - 1);
    if (x < width - 1 && outside[index + 1] === 0) queue.push(index + 1);
    if (index - width >= 0 && outside[index - width] === 0) queue.push(index - width);
    if (index + width < grid.length && outside[index + width] === 0) queue.push(index + width);
  }

  for (let i = 0; i < grid.length; i += 1) grid[i] = outside[i] === 1 ? 0 : 1;
  return countFilled(grid);
}

/** Счётчик заполненных пикселей. */
function countFilled(grid) {
  let filled = 0;
  for (let i = 0; i < grid.length; i += 1) filled += grid[i];
  return filled;
}

/**
 * Убирает с залитого пятна кромку толщиной radius — возвращает границы плиты
 * к исходному контуру комнаты (без этого плита заняла бы щели между соседями).
 */
function erode(grid, width, height, scale, radius) {
  const inverted = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i += 1) inverted[i] = grid[i] === 1 ? 0 : 1;
  const distance = distanceTransform(inverted, width, height);
  const limit = radius * scale * 3;

  for (let i = 0; i < grid.length; i += 1) {
    if (grid[i] === 1 && distance[i] < limit) grid[i] = 0;
  }
  return countFilled(grid);
}

/** Обход границы бинарного растра: единичные отрезки, сшитые в замкнутые контуры. */
function traceLoops(grid, width, height) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : grid[y * width + x]);
  const segments = new Map();
  const key = (x, y) => x * 1e6 + y;

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const left = at(x - 1, y);
      const right = at(x, y);
      if (left !== right) {
        // закрашенная область всегда справа от направления движения
        if (right === 1) segments.set(key(x, y + 1), [x, y]);
        else segments.set(key(x, y), [x, y + 1]);
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const above = at(x, y - 1);
      const below = at(x, y);
      if (above !== below) {
        if (below === 1) segments.set(key(x, y), [x + 1, y]);
        else segments.set(key(x + 1, y), [x, y]);
      }
    }
  }

  const loops = [];
  while (segments.size > 0) {
    const [startKey] = segments.keys();
    const loop = [];
    let currentKey = startKey;

    while (segments.has(currentKey)) {
      const point = segments.get(currentKey);
      segments.delete(currentKey);
      loop.push(point);
      currentKey = key(point[0], point[1]);
    }

    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/* ------------------------------------------------- упрощение контура */

function squaredDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end[0];
      y = end[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyStep(points, first, last, epsilon, output) {
  let maxDistance = 0;
  let index = 0;
  for (let i = first + 1; i < last; i += 1) {
    const distance = squaredDistance(points[i], points[first], points[last]);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }
  if (maxDistance > epsilon * epsilon && index > first) {
    simplifyStep(points, first, index, epsilon, output);
    output.push(points[index]);
    simplifyStep(points, index, last, epsilon, output);
  }
}

/** Упрощение замкнутого контура (алгоритм Дугласа — Пекера). */
function simplify(points, epsilon) {
  if (points.length < 4) return points;
  const flat = points.map(([x, y]) => [x, y]);
  flat.push([flat[0][0], flat[0][1]]);
  const output = [flat[0]];
  simplifyStep(flat, 0, flat.length - 1, epsilon, output);
  output.push([flat[0][0], flat[0][1]]);

  // убираем дубли и замыкающую точку
  const cleaned = [];
  for (const point of output) {
    const previous = cleaned[cleaned.length - 1];
    if (!previous || Math.abs(previous[0] - point[0]) > 1e-6 || Math.abs(previous[1] - point[1]) > 1e-6) {
      cleaned.push(point);
    }
  }
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) cleaned.pop();
  }
  return cleaned;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Площадь выпуклой оболочки закрашенных пикселей (оценка «настоящего» габарита фигуры). */
function hullArea(grid, width, height) {
  const points = [];
  for (let y = 0; y < height; y += 1) {
    let min = -1;
    let max = -1;
    for (let x = 0; x < width; x += 1) {
      if (grid[y * width + x] === 0) continue;
      if (min < 0) min = x;
      max = x;
    }
    if (min >= 0) {
      points.push([min, y]);
      if (max !== min) points.push([max, y]);
    }
  }
  if (points.length < 3) return 0;

  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list) => {
    const stack = [];
    for (const point of list) {
      while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], point) <= 0) stack.pop();
      stack.push(point);
    }
    return stack;
  };

  const lower = chain(points);
  const upper = chain([...points].reverse());
  const hull = lower.concat(upper.slice(1, -1));

  let area = 0;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    area += hull[j][0] * hull[i][1] - hull[i][0] * hull[j][1];
  }
  return Math.abs(area / 2);
}

/* ------------------------------------------------------------- API */

/**
 * @param {object} options
 * @param {string} options.d данные контура (для path — атрибут d, для rect/ellipse — синтезированные)
 * @param {number[]} [options.matrix] матрица элемента вместе с трансформациями групп
 * @param {string} [options.fillRule] fill-rule элемента
 * @param {{min: Vector2, max: Vector2}} options.bounds габариты в координатах плана
 * @param {number} [options.pxPerUnit] плотность растра
 * @returns {{shapes: Shape[], filledCells: number, loops: number}}
 */
export function extractFootprint({ d, matrix = [1, 0, 0, 1, 0, 0], fillRule = 'nonzero', bounds, pxPerUnit = DEFAULT_PX_PER_UNIT }) {
  const unitsW = bounds.max.x - bounds.min.x + PADDING * 2;
  const unitsH = bounds.max.y - bounds.min.y + PADDING * 2;
  const scale = Math.min(pxPerUnit, MAX_SIDE / Math.max(unitsW, unitsH));
  const width = Math.max(2, Math.ceil(unitsW * scale));
  const height = Math.max(2, Math.ceil(unitsH * scale));
  const originX = bounds.min.x - PADDING;
  const originY = bounds.min.y - PADDING;

  const { canvas, context } = getScratch(width, height);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(scale, 0, 0, scale, -originX * scale, -originY * scale);
  context.transform(...matrix);
  context.fillStyle = '#000';
  context.fill(new Path2D(d), fillRule === 'evenodd' ? 'evenodd' : 'nonzero');

  const pixels = context.getImageData(0, 0, width, height).data;
  const grid = new Uint8Array(width * height);
  let filledCells = 0;
  for (let i = 0; i < grid.length; i += 1) {
    if (pixels[i * 4 + 3] > ALPHA_THRESHOLD) {
      grid[i] = 1;
      filledCells += 1;
    }
  }
  context.setTransform(1, 0, 0, 1, 0, 0);

  if (filledCells === 0) return { shapes: [], filledCells: 0, loops: 0, sealRadius: null };

  const rawGrid = grid.slice();
  // Оболочка показывает реальный габарит фигуры: у повёрнутой комнаты она почти
  // совпадает с заливкой, а у тонкой рамки — во много раз больше.
  const hull = hullArea(rawGrid, width, height);
  const isRing = filledCells < hull * RING_RATIO;

  let best = null;
  for (const radius of SEAL_RADII) {
    grid.set(rawGrid);
    fillHoles(grid, width, height, scale, radius);
    const sealedGrid = grid.slice();
    const sealed = countFilled(grid);
    let filled = erode(grid, width, height, scale, radius);

    // очень тонкую фигуру эрозия может съесть целиком — тогда оставляем как есть
    if (filled < sealed * 0.15) {
      grid.set(sealedGrid);
      filled = sealed;
    }

    if (!best || filled > best.filled) best = { radius, filled, grid: grid.slice() };
    // радиус растём, только если контур — тонкая рамка и внутренность ещё не залита
    if (!isRing || filled >= hull * FILLED_RATIO) break;
  }

  grid.set(best.grid);
  const sealRadius = best.radius;
  const filledAfterSeal = best.filled;

  const rawLoops = traceLoops(grid, width, height).map((loop) =>
    simplify(loop, SIMPLIFY_EPSILON * scale).map(([x, y]) => [x / scale + originX, y / scale + originY]),
  );

  // контуры с положительной площадью — внешние, с отрицательной — отверстия
  const oriented = rawLoops
    .filter((loop) => loop.length >= 3)
    .map((loop) => {
      const points = loop.map(([x, y]) => new Vector2(x, y));
      return { loop, points, area: polygonArea(points) };
    });

  const outerSign = oriented.length > 0
    ? Math.sign(oriented.reduce((widest, item) => (Math.abs(item.area) > Math.abs(widest.area) ? item : widest)).area) || 1
    : 1;

  const outerLoops = oriented.filter((item) => Math.sign(item.area) === outerSign || item.area === 0);
  const holeLoops = oriented.filter((item) => Math.sign(item.area) !== outerSign && item.area !== 0);

  const shapes = outerLoops.map((item) => new Shape(item.points));
  for (const hole of holeLoops) {
    const host = shapes.find((shape) => pointInPolygon(hole.loop[0], shape.getPoints().map((p) => [p.x, p.y])));
    if (host) host.holes.push(new Path(hole.points));
  }

  return { shapes, filledCells, filledAfterSeal, sealRadius, isRing, loops: rawLoops.length };
}
