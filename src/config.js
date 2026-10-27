/**
 * Настройки приложения.
 *
 * Все размеры — в единицах SVG-плана. Их масштаб удобно оценивать по аудиториям:
 * типичная аудитория на плане занимает ~20×23 единицы, то есть 1 единица ≈ 0.3 м.
 */

// План первого этажа лежит в корне проекта: правьте его в Inkscape и обновляйте страницу.
import planUrl from '../1floor.svg?url';

export const PLAN_URL = planUrl;

// Слой/элемент со стенами: имя в inkscape:label (или в id) файла плана.
export const WALLS_LABEL = 'walls';

export const WALL_HEIGHT = 11; // высота стен (≈3.3 м)
export const SLAB_HEIGHT = 1.1; // толщина цветной плиты помещения
// разброс высоты плит: меньшие помещения лежат выше (одновременно решает перекрытия)
export const PLATE_STACK = 0.35;
export const LABEL_HEIGHT = 4.6; // высота, на которой висят номера помещений
export const LABEL_SIZE = 6.4; // высота «таблетки» с номером в единицах сцены
export const FLOOR_MARGIN = 70; // запас подложки пола вокруг корпуса

export const COLORS = {
  floor: '#e9edf3',
  floorEdge: '#dde2ea',
  walls: '#d8dee7',
  label: '#101623',
  labelBg: 'rgba(255, 255, 255, 0.92)',
  selection: '#2563eb',
};

// Размеры для камеры
export const CAMERA = {
  fov: 45,
  fitPadding: 1.16,
  tiltDegrees: 52, // наклон камеры от вертикали
  minDistanceFactor: 0.12,
  maxDistanceFactor: 4,
};

export const LABEL_FADE = {
  // подписи проявляются при приближении к этому множителю авто-масштаба
  near: 0.95,
  far: 2.1,
};
