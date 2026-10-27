/**
 * Геометрические помощники: контуры SVG-фигур, их площади/центры/габариты
 * и преобразование «SVG-плоскость -> мировая сцена».
 *
 * Соответствие координат: SVG (x, y) -> мир (x, ·, y).
 * Экструзия (в SVG это +Z) становится высотой вверх по +Y.
 */
import { Box2, ExtrudeGeometry, ShapeGeometry, Vector2 } from 'three';

/** Знаковая площадь многоугольника. */
export function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return area / 2;
}

/** Центр масс многоугольника (null, если площадь нулевая). */
export function polygonCentroid(points) {
  let twiceArea = 0;
  let x = 0;
  let y = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const cross = points[j].x * points[i].y - points[i].x * points[j].y;
    twiceArea += cross;
    x += (points[j].x + points[i].x) * cross;
    y += (points[j].y + points[i].y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) return null;
  return new Vector2(x / (3 * twiceArea), y / (3 * twiceArea));
}

export function pointsBounds(points) {
  const box = new Box2();
  for (const point of points) box.expandByPoint(point);
  return box;
}

/**
 * Площадь, центр и габариты фигуры (без учёта отверстий в площади? — отверстия вычитаются).
 */
export function shapeMetrics(shape, divisions = 8) {
  const { shape: outer, holes } = shape.extractPoints(divisions);
  let area = Math.abs(polygonArea(outer));
  for (const hole of holes) area -= Math.abs(polygonArea(hole));

  const centroid = polygonCentroid(outer) ?? pointsBounds(outer).getCenter(new Vector2());
  const bounds = pointsBounds(outer);
  for (const hole of holes) for (const point of hole) bounds.expandByPoint(point);

  return { area: Math.max(area, 0), centroid, bounds };
}

/** Метрики набора фигур: площадь суммируется, центр — взвешенный по площади. */
export function shapesMetrics(shapes, divisions = 8) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  const bounds = new Box2();

  for (const shape of shapes) {
    const metrics = shapeMetrics(shape, divisions);
    area += metrics.area;
    cx += metrics.centroid.x * metrics.area;
    cy += metrics.centroid.y * metrics.area;
    bounds.union(metrics.bounds);
  }

  const centroid = area > 0 ? new Vector2(cx / area, cy / area) : bounds.getCenter(new Vector2());
  return { area, centroid, bounds };
}

/** Переносит геометрию из плоскости SVG в мировые координаты сцены. */
export function placeGeometry(geometry, depth, center) {
  geometry.rotateX(Math.PI / 2);
  geometry.translate(-center.x, depth, -center.y);
  geometry.computeVertexNormals();
  return geometry;
}

/** Объёмная плита из фигур плана. */
export function extrudeShapes(shapes, { depth, center, curveSegments = 8 }) {
  const geometry = new ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: false,
    steps: 1,
    curveSegments,
  });
  return placeGeometry(geometry, depth, center);
}

/** Плоская фигура из фигур плана (для контура выделения). */
export function flattenShapes(shapes, { center, curveSegments = 8 }) {
  const geometry = new ShapeGeometry(shapes, curveSegments);
  return placeGeometry(geometry, 0, center);
}
