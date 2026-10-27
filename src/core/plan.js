/**
 * Чтение плана этажа из SVG.
 *
 * Что делает модуль:
 *  1. получает текст SVG;
 *  2. находит элементы с подписью inkscape:label (стены — "walls", помещения — "<тип>_<номер>");
 *  3. аккуратно «заливает» контуры (в исходнике помещения нарисованы обводкой с проёмом двери)
 *     и отдаёт полученный SVG в three.js SVGLoader, который сам разбирает кривые, дуги и transform;
 *  4. считает метрики помещений: площадь, центр (для подписи и перелёта камеры), габариты.
 */
import { Box2 } from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { PLAN_URL, WALLS_LABEL } from '../config.js';
import { kindColor, normalize, parseRoomLabel } from './rooms.js';
import { shapesMetrics } from './geometry.js';
import { extractFootprint } from './raster.js';

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
const CURVE_SEGMENTS = 8;

// автоматические id Inkscape/редактора (path1, rect12…) — это не имя помещения
const AUTO_ID = /^(path|rect|circle|ellipse|line|polyline|polygon|use|image|text|tspan|g|layer|svg)\d*$/i;

/**
 * Подпись элемента: inkscape:label, а если её нет — id, но только осмысленный
 * (например «walls» или «stud_105», но не служебный «path84»).
 */
export function readLabel(element) {
  const label =
    element.getAttributeNS(INKSCAPE_NS, 'label') ||
    element.getAttribute('inkscape:label') ||
    element.getAttribute('label');
  if (label) return label;

  const id = element.getAttribute('id') || '';
  return AUTO_ID.test(id) ? '' : id;
}

/** Значение SVG-свойства: сначала из атрибута style, затем из presentation-атрибута. */
function readPaint(element, property) {
  const inline = element.getAttribute('style') || '';
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(inline);
  if (match) return match[1].trim();
  return (element.getAttribute(property) || '').trim();
}

/**
 * Готовит элемент к разбору: убирает обводку и задаёт заливку,
 * чтобы SVGLoader построил из контура заполненную фигуру.
 */
function setFill(element, color) {
  element.removeAttribute('style');
  element.setAttribute('fill', color);
  element.setAttribute('fill-rule', 'nonzero');
  element.setAttribute('stroke', 'none');
}

export async function loadPlan(url = PLAN_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось загрузить план (${response.status}): ${url}`);
  const text = await response.text();
  return parsePlanText(text);
}

export function parsePlanText(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) throw new Error(`SVG не удалось разобрать: ${parserError.textContent?.trim()}`);
  return parsePlanDocument(doc);
}

/**
 * @param {Document} svgDoc
 * @returns {{rooms: object[], walls: object|null, bounds: Box2, warnings: string[], counts: object}}
 */
export function parsePlanDocument(svgDoc) {
  const warnings = [];
  const elements = Array.from(svgDoc.querySelectorAll('path'));
  const entries = [];
  const seenIds = new Map();

  for (const element of elements) {
    const elementId = element.getAttribute('id') || '(без id)';
    const label = readLabel(element);
    const isWalls = normalize(label) === WALLS_LABEL || normalize(elementId) === WALLS_LABEL;
    const sourceFill = readPaint(element, 'fill');
    const sourceStroke = readPaint(element, 'stroke');
    const sourceFillRule = readPaint(element, 'fill-rule') || 'nonzero';
    const d = element.getAttribute('d') || '';
    const transform = element.getAttribute('transform') || '';

    if (!label) {
      warnings.push(
        `Элемент без подписи inkscape:label (id="${elementId}") пропущен — добавьте подпись вида «тип_номер» или «${WALLS_LABEL}».`,
      );
      continue;
    }

    if (isWalls) {
      setFill(element, sourceFill && sourceFill !== 'none' ? sourceFill : '#1a1a18');
      element.setAttribute('data-kind', 'walls');
      entries.push({ kind: 'walls', label, elementId, sourceFill, sourceStroke });
      continue;
    }

    if (!d) {
      warnings.push(`Помещение «${label}» (id="${elementId}") без атрибута d — пропущено.`);
      continue;
    }

    const meta = parseRoomLabel(label);
    let roomId = meta.raw;
    if (seenIds.has(roomId)) {
      const count = seenIds.get(roomId) + 1;
      seenIds.set(roomId, count);
      warnings.push(`Имя «${meta.raw}» встречается в плане несколько раз (id="${elementId}") — переименуйте, чтобы не путать поиск.`);
      roomId = `${meta.raw}#${count}`;
    } else {
      seenIds.set(roomId, 1);
    }

    if (meta.type === 'other' && meta.kind === 'other' && !/^\d/.test(meta.numbers[0] ?? '')) {
      warnings.push(`Имя «${meta.raw}» (id="${elementId}") не по схеме «тип_номер» — помещение попало в «Прочие».`);
    }

    setFill(element, sourceFill && sourceFill !== 'none' ? sourceFill : kindColor(meta.kind));
    element.setAttribute('data-kind', 'room');
    element.setAttribute('data-room', roomId);
    entries.push({
      kind: 'room',
      label: meta.raw,
      elementId,
      roomId,
      meta,
      color: kindColor(meta.kind),
      sourceFill,
      sourceStroke,
      d,
      transform,
      fillRule: sourceFillRule,
    });
  }

  const serialized = new XMLSerializer().serializeToString(svgDoc.documentElement);
  const parsed = new SVGLoader().parse(serialized);

  const shapesByRoom = new Map();
  let wallShapes = [];
  let unlabelled = 0;

  for (const shapePath of parsed.paths) {
    const node = shapePath.userData?.node;
    const kind = node?.getAttribute('data-kind');
    if (kind === 'room') {
      const roomId = node.getAttribute('data-room');
      const shapes = shapesByRoom.get(roomId) ?? [];
      shapes.push(...SVGLoader.createShapes(shapePath));
      shapesByRoom.set(roomId, shapes);
    } else if (kind === 'walls') {
      wallShapes = wallShapes.concat(SVGLoader.createShapes(shapePath));
    } else {
      unlabelled += 1;
    }
  }

  const rooms = [];
  const bounds = new Box2();

  for (const entry of entries) {
    if (entry.kind !== 'room') continue;
    const contourShapes = shapesByRoom.get(entry.roomId) ?? [];

    if (contourShapes.length === 0) {
      warnings.push(`Помещение «${entry.roomId}» (id="${entry.elementId}") не дало ни одного контура: проверьте атрибут d.`);
      continue;
    }

    // Пятно помещения: контур растрируется как в браузере, внутренние «дыры»
    // заливаются — иначе комнаты, нарисованные двойной линией, остаются рамкой.
    const contourBounds = shapesMetrics(contourShapes, CURVE_SEGMENTS).bounds;
    let shapes = [];
    let footprint = null;
    try {
      footprint = extractFootprint({
        d: entry.d,
        transform: entry.transform,
        fillRule: entry.fillRule,
        bounds: contourBounds,
      });
      shapes = footprint.shapes;
    } catch (error) {
      warnings.push(`Помещение «${entry.roomId}» (id="${entry.elementId}"): не удалось построить пятно (${error.message}), взят исходный контур.`);
    }

    if (shapes.length === 0) {
      shapes = contourShapes;
      warnings.push(`Помещение «${entry.roomId}» (id="${entry.elementId}") пустое после заливки контура — проверьте, что фигура замкнута.`);
    }

    const metrics = shapesMetrics(shapes, CURVE_SEGMENTS);

    if (metrics.area < 4) {
      warnings.push(`Помещение «${entry.roomId}» (id="${entry.elementId}") почти нулевой площади (${metrics.area.toFixed(1)}) — вероятно, контур схлопнут.`);
    }

    rooms.push({
      id: entry.roomId,
      label: entry.meta.raw,
      type: entry.meta.type,
      kind: entry.meta.kind,
      numbers: entry.meta.numbers,
      title: entry.meta.title,
      normNumbers: entry.meta.normNumbers,
      normTitle: entry.meta.normTitle,
      normRaw: entry.meta.normRaw,
      color: entry.color,
      otherColors: [],
      elementId: entry.elementId,
      sourceStroke: entry.sourceStroke,
      shapes,
      area: metrics.area,
      centroid: metrics.centroid,
      bounds: metrics.bounds,
      // диагностика извлечения пятна (видна в window.__navigator.plan.rooms)
      sealRadius: footprint?.sealRadius ?? null,
      contours: contourShapes.length,
      loops: footprint?.loops ?? 0,
    });

    bounds.union(metrics.bounds);
  }

  let walls = null;
  if (wallShapes.length > 0) {
    const metrics = shapesMetrics(wallShapes, CURVE_SEGMENTS);
    walls = { label: WALLS_LABEL, shapes: wallShapes, area: metrics.area, bounds: metrics.bounds };
    bounds.union(metrics.bounds);
  } else {
    warnings.push(`В плане не найден элемент со стенами (ожидается подпись «${WALLS_LABEL}»).`);
  }

  return {
    rooms,
    walls,
    bounds,
    warnings,
    counts: {
      elements: elements.length,
      rooms: rooms.length,
      wallElements: wallShapes.length,
      unlabelled,
      skipped: entries.filter((entry) => entry.kind === 'room').length - rooms.length,
    },
    curveSegments: CURVE_SEGMENTS,
  };
}
