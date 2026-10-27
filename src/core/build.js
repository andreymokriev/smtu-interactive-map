/**
 * Сборка 3D-модели этажа из разобранного плана.
 *
 * Плиты помещений лежат на полу и поднимаются на SLAB_HEIGHT, стены вытянуты на WALL_HEIGHT,
 * поэтому сверху видна привычная цветная планировка, а под углом — объём корпуса.
 */
import {
  Box3,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Sphere,
  Vector2,
} from 'three';
import { COLORS, FLOOR_MARGIN, LABEL_HEIGHT, PLATE_STACK, SLAB_HEIGHT, WALL_HEIGHT } from '../config.js';
import { extrudeShapes, flattenShapes } from './geometry.js';
import { createLabelSprite } from './labels.js';

const hsl = { h: 0, s: 0, l: 0 };

/**
 * Оттенки считаем в sRGB — так результат предсказуем и совпадает с цветом в макете.
 * Серые типы («Прочие») остаются серыми, остальные получают мягкую пастель.
 */
function tint(hex, { saturation, lightness, fallbackSaturation }) {
  const color = new Color(hex);
  color.getHSL(hsl, SRGBColorSpace);
  color.setHSL(hsl.h, hsl.s < 0.1 ? fallbackSaturation : saturation, lightness, SRGBColorSpace);
  return color;
}

/** Мягкий, «минималистичный» оттенок плиты. */
function slabColor(hex) {
  return tint(hex, { saturation: 0.46, lightness: 0.64, fallbackSaturation: 0.06 });
}

/** Насыщенный оттенок для выделенного помещения, контура и маркеров интерфейса. */
function vividColor(hex) {
  return tint(hex, { saturation: 0.85, lightness: 0.5, fallbackSaturation: 0.1 });
}

/**
 * @param {ReturnType<import('./plan.js').parsePlanDocument>} plan
 * @returns {{group: Group, views: Map<string, object>, list: object[], pickables: Mesh[], fitSphere: Sphere, center: Vector2, size: Vector2}}
 */
export function buildModel(plan) {
  const center = plan.bounds.getCenter(new Vector2());
  const size = plan.bounds.getSize(new Vector2());
  const group = new Group();
  group.name = 'floor';

  const views = new Map();
  const list = [];
  const pickables = [];

  // --- стены ---
  let wallsMesh = null;
  if (plan.walls) {
    const geometry = extrudeShapes(plan.walls.shapes, {
      depth: WALL_HEIGHT,
      center,
      curveSegments: plan.curveSegments,
    });
    wallsMesh = new Mesh(
      geometry,
      new MeshLambertMaterial({ color: COLORS.walls, side: DoubleSide }),
    );
    wallsMesh.name = 'walls';
    group.add(wallsMesh);
  }

  // --- помещения ---
  // Плиты не строго на одной высоте: меньшие помещения лежат чуть выше.
  // Так перекрывающиеся контуры (например, комната внутри общего блока)
  // и выбираются, и выглядят корректно.
  const areas = plan.rooms.map((room) => room.area);
  const minArea = Math.min(...areas);
  const areaSpan = Math.max(Math.max(...areas) - minArea, 1e-6);

  for (const room of plan.rooms) {
    const depth = SLAB_HEIGHT - ((room.area - minArea) / areaSpan) * PLATE_STACK;
    const geometry = extrudeShapes(room.shapes, {
      depth,
      center,
      curveSegments: plan.curveSegments,
    });
    const material = new MeshLambertMaterial({ color: slabColor(room.color) });
    const mesh = new Mesh(geometry, material);
    mesh.name = `room:${room.id}`;
    mesh.userData.roomId = room.id;
    group.add(mesh);

    // контур выделения лежит чуть выше плиты
    const outlineGeometry = flattenShapes(room.shapes, { center, curveSegments: plan.curveSegments });
    outlineGeometry.translate(0, depth + 0.08, 0);
    const outline = new LineSegments(
      new EdgesGeometry(outlineGeometry, 1),
      new LineBasicMaterial({ color: COLORS.selection }),
    );
    outline.visible = false;
    outline.renderOrder = 2;
    group.add(outline);

    const labelText = room.numbers.length > 0 ? room.numbers.join(' ') : room.title;
    const sprite = createLabelSprite(labelText);
    sprite.position.set(room.centroid.x - center.x, LABEL_HEIGHT, room.centroid.y - center.y);
    group.add(sprite);

    const view = {
      room,
      mesh,
      outline,
      sprite,
      baseColor: material.color.clone(),
      baseLabelScale: sprite.scale.clone(),
      hidden: false,
    };
    views.set(room.id, view);
    list.push(view);
    pickables.push(mesh);
  }

  // --- подложка пола ---
  const floor = new Mesh(
    new PlaneGeometry(size.x + FLOOR_MARGIN * 2, size.y + FLOOR_MARGIN * 2),
    new MeshLambertMaterial({ color: COLORS.floor }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.35;
  floor.name = 'floor';
  group.add(floor);

  // --- рамка вокруг корпуса для аккуратной границы плана ---
  const frameGeometry = new EdgesGeometry(
    new PlaneGeometry(size.x + FLOOR_MARGIN * 2, size.y + FLOOR_MARGIN * 2),
    1,
  );
  const frame = new LineSegments(
    frameGeometry,
    new LineBasicMaterial({ color: COLORS.floorEdge }),
  );
  frame.rotation.x = -Math.PI / 2;
  frame.position.y = -0.3;
  frame.name = 'floor-frame';
  group.add(frame);

  group.updateMatrixWorld(true);

  const fitBox = new Box3();
  for (const view of list) fitBox.expandByObject(view.mesh);
  if (wallsMesh) fitBox.expandByObject(wallsMesh);
  const fitSphere = fitBox.getBoundingSphere(new Sphere());

  return { group, views, list, pickables, wallsMesh, center, size, fitSphere };
}

/** Подсветка выбранного помещения: насыщенный цвет, приподнятая плита, заметный номер. */
export function setHighlight(view, on) {
  if (!view) return;
  const factor = on ? 1.22 : 1;

  view.mesh.material.color.copy(on ? vividColor(view.room.color) : view.baseColor);
  view.mesh.material.emissive.setRGB(on ? 0.07 : 0, on ? 0.09 : 0, on ? 0.14 : 0);
  view.mesh.position.y = on ? 0.9 : 0;
  view.outline.visible = on;
  view.sprite.scale.copy(view.baseLabelScale).multiplyScalar(factor);
}

/** Скрывает/показывает помещения выбранного типа. */
export function setKindVisible(view, visible) {
  view.hidden = !visible;
  view.mesh.visible = visible;
  if (!visible) view.outline.visible = false;
}
