/**
 * 3D-навигатор по корпусу: точка входа.
 *
 * Сцена собирается из SVG-планов этажей (см. core/plan.js), затем к ней подключаются
 * управление камерой, выбор помещений касанием, поиск с фильтрами по типам
 * и переключатель этажей.
 */
import {
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
// Планы этажей лежат в корне проекта: правьте их в Inkscape и обновляйте страницу.
import PLAN_URL_1 from '../1floor.svg?url';
import PLAN_URL_2 from '../2floor.svg?url';
import PLAN_URL_3 from '../3floor.svg?url';
import PLAN_URL_4 from '../4floor.svg?url';
import PLAN_URL_5 from '../5floor.svg?url';
import { CAMERA, LABEL_FADE, THEMES } from './config.js';
import { loadPlan, parsePlanText } from './core/plan.js';
import { applyTheme, buildModel, setHighlight, setKindVisible } from './core/build.js';
import { LEGEND_ORDER, ROOM_TYPES, pluralRooms, searchRooms } from './core/rooms.js';

const FLOORS = [
  { id: '1', label: '1 этаж', url: PLAN_URL_1 },
  { id: '2', label: '2 этаж', url: PLAN_URL_2 },
  { id: '3', label: '3 этаж', url: PLAN_URL_3 },
  { id: '4', label: '4 этаж', url: PLAN_URL_4 },
  { id: '5', label: '5 этаж', url: PLAN_URL_5 },
];
const FLOOR_BY_ID = new Map(FLOORS.map((floor) => [floor.id, floor]));

const dom = {
  viewport: document.getElementById('viewport'),
  query: document.getElementById('query'),
  queryClear: document.getElementById('query-clear'),
  results: document.getElementById('results'),
  legend: document.getElementById('legend'),
  floors: document.getElementById('floors'),
  card: document.getElementById('card'),
  cardTitle: document.getElementById('card-title'),
  cardSub: document.getElementById('card-sub'),
  cardDot: document.getElementById('card-dot'),
  cardClose: document.getElementById('card-close'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  btnReset: document.getElementById('btn-reset'),
  btnTop: document.getElementById('btn-top'),
  btnLabels: document.getElementById('btn-labels'),
  btnTheme: document.getElementById('btn-theme'),
  themeColor: document.querySelector('meta[name="theme-color"]'),
};

const state = {
  plan: null,
  model: null,
  floorId: FLOORS[0].id,
  floors: new Map(),
  floorToken: 0,
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  selectedId: null,
  hoveredId: null,
  hiddenKinds: new Set(),
  labelsEnabled: true,
  results: [],
  activeIndex: -1,
  tween: null,
  fitDistance: 600,
  radius: 500,
  errors: [],
};

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
const raycaster = new Raycaster();
const pointer = new Vector2();

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/* ------------------------------------------------------------------ сцена */

function createRenderer() {
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (error) {
    showFatal('Браузер не поддерживает WebGL — 3D-карта недоступна.');
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('aria-label', 'Трёхмерный план этажа');
  dom.viewport.appendChild(renderer.domElement);
  return true;
}

function createScene() {
  scene = new Scene();
  camera = new PerspectiveCamera(CAMERA.fov, aspectRatio(), 1, 20000);
  camera.position.set(0, 600, 600);

  controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.9;
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;

  // как только пользователь сам двигает карту — автоперелёт отменяется
  controls.addEventListener('start', () => {
    state.tween = null;
  });

  scene.add(new HemisphereLight(0xffffff, 0xbfc7d4, 1.9));

  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(-350, 620, 300);
  scene.add(key);

  const fill = new DirectionalLight(0xffffff, 0.5);
  fill.position.set(450, 380, -450);
  scene.add(fill);
}

function aspectRatio() {
  const width = dom.viewport.clientWidth || window.innerWidth;
  const height = dom.viewport.clientHeight || window.innerHeight;
  return width / Math.max(height, 1);
}

/* ------------------------------------------------------------------ камера */

function computeFitDistance(radius) {
  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  return (radius / Math.sin(Math.min(vFov, hFov) / 2)) * CAMERA.fitPadding;
}

function animateTo(position, target, duration = 700) {
  // новый перелёт всегда отменяет предыдущий
  state.tween = {
    startPosition: camera.position.clone(),
    endPosition: position.clone(),
    startTarget: controls.target.clone(),
    endTarget: target.clone(),
    elapsed: 0,
    duration,
  };
}

function applyTween(delta) {
  const tween = state.tween;
  if (!tween) return;
  tween.elapsed += delta * 1000;
  const k = easeInOutCubic(clamp(tween.elapsed / tween.duration, 0, 1));
  camera.position.lerpVectors(tween.startPosition, tween.endPosition, k);
  controls.target.lerpVectors(tween.startTarget, tween.endTarget, k);
  if (k >= 1) state.tween = null;
}

function frameModel({ animate = true } = {}) {
  if (!state.model) return;
  state.radius = state.model.fitSphere.radius;
  state.fitDistance = computeFitDistance(state.radius);

  const tilt = (CAMERA.tiltDegrees * Math.PI) / 180;
  const distance = state.fitDistance;
  controls.minDistance = Math.max(25, state.radius * CAMERA.minDistanceFactor);
  controls.maxDistance = Math.max(distance * 1.6, state.radius * CAMERA.maxDistanceFactor);

  const target = new Vector3(0, 0, 0);
  const position = new Vector3(0, Math.sin(tilt) * distance, Math.cos(tilt) * distance);

  if (animate) animateTo(position, target, 800);
  else {
    state.tween = null;
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
  }
}

function focusRoom(view, { animate = true } = {}) {
  const { room } = view;
  const size = room.bounds.getSize(new Vector2());
  const roomRadius = Math.max(size.x, size.y) * 0.5;
  const distance = clamp(roomRadius * 6.5, controls.minDistance, state.fitDistance * 0.85);

  const target = new Vector3(
    room.centroid.x - state.model.center.x,
    1.5,
    room.centroid.y - state.model.center.y,
  );

  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 1e-6) direction.set(0, 1, 0.6);
  direction.normalize();

  const position = target.clone().add(direction.multiplyScalar(distance));
  if (animate) animateTo(position, target, 750);
  else {
    state.tween = null;
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
  }
}

function topView() {
  const distance = camera.position.distanceTo(controls.target);
  const target = controls.target.clone();
  animateTo(target.clone().add(new Vector3(0, distance, 0.001)), target, 650);
}

/* ------------------------------------------------------------------ подписи */

function updateLabels() {
  if (!state.model) return;

  // на телефоне 73 номера сразу — шум, поэтому там они появляются только при приближении
  const compact = dom.viewport.clientWidth < 640;
  const fade = compact ? LABEL_FADE.compact : LABEL_FADE;
  const distance = camera.position.distanceTo(controls.target);
  const near = state.fitDistance * fade.near;
  const far = state.fitDistance * fade.far;
  const closeness = 1 - clamp((distance - near) / Math.max(far - near, 1), 0, 1);

  for (const view of state.model.list) {
    const isSelected = view.room.id === state.selectedId;
    const canShow = state.labelsEnabled && !view.hidden && (closeness > 0.02 || isSelected);
    view.sprite.visible = canShow;
    if (canShow) {
      view.sprite.material.opacity = isSelected ? 1 : 0.12 + 0.88 * closeness;
    }
  }
}

/* ------------------------------------------------------------------ выбор */

function pickRoom(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(state.model.pickables, false);
  for (const hit of hits) {
    const view = state.model.views.get(hit.object.userData.roomId);
    if (view && !view.hidden) return view.room.id;
  }
  return null;
}

function selectRoom(id, { focus = false } = {}) {
  if (!state.model) return;

  if (state.selectedId === id) {
    if (focus) focusRoom(state.model.views.get(id));
    return;
  }

  const previous = state.model.views.get(state.selectedId);
  if (previous) setHighlight(previous, false);

  state.selectedId = id;
  const view = id ? state.model.views.get(id) : null;
  if (view) {
    setHighlight(view, true);
    if (focus) focusRoom(view);
  }

  renderCard(view);
  updateStatus();
}

function renderCard(view) {
  if (!view) {
    dom.card.hidden = true;
    return;
  }
  dom.card.hidden = false;
  dom.cardTitle.textContent = view.room.title;
  dom.cardSub.textContent = `Подпись в плане: ${view.room.label}`;
  dom.cardDot.style.color = view.room.color;
}

/* ------------------------------------------------------------------ поиск */

function hideResults() {
  dom.results.hidden = true;
  dom.results.replaceChildren();
  dom.query.setAttribute('aria-expanded', 'false');
  state.results = [];
  state.activeIndex = -1;
}

function renderResults(rooms, query) {
  dom.results.replaceChildren();

  if (rooms.length === 0) {
    const item = document.createElement('li');
    item.className = 'result result--empty';
    item.textContent = `Ничего не найдено по запросу «${query}»`;
    dom.results.append(item);
  } else {
    rooms.forEach((room, index) => {
      const item = document.createElement('li');
      item.className = 'result';
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);

      const dot = document.createElement('span');
      dot.className = 'result__dot';
      dot.style.color = room.color;

      const title = document.createElement('span');
      title.className = 'result__title';
      title.textContent = room.title;

      const type = document.createElement('span');
      type.className = 'result__type';
      type.textContent = room.label;

      item.append(dot, title, type);
      item.addEventListener('click', () => chooseResult(index));
      dom.results.append(item);
    });
  }

  state.results = rooms;
  state.activeIndex = rooms.length > 0 ? 0 : -1;
  highlightActiveResult();
  dom.results.hidden = false;
  dom.query.setAttribute('aria-expanded', 'true');
}

function highlightActiveResult() {
  Array.from(dom.results.children).forEach((child, index) => {
    const active = index === state.activeIndex;
    child.setAttribute('aria-selected', active ? 'true' : 'false');
    if (active) child.scrollIntoView({ block: 'nearest' });
  });
}

function chooseResult(index) {
  const room = state.results[index];
  if (!room) return;
  selectRoom(room.id, { focus: true });
  hideResults();
  dom.query.blur();
}

function onQueryInput() {
  const query = dom.query.value.trim();
  dom.queryClear.hidden = dom.query.value.length === 0;

  if (!query || !state.plan) {
    hideResults();
    return;
  }

  const rooms = searchRooms(state.plan.rooms, query, 8).filter(
    (room) => !state.hiddenKinds.has(room.kind),
  );
  renderResults(rooms, query);
}

function onQueryKeydown(event) {
  const { results, activeIndex } = state;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (results.length === 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    state.activeIndex = (activeIndex + step + results.length) % results.length;
    highlightActiveResult();
  } else if (event.key === 'Enter') {
    if (activeIndex >= 0) {
      event.preventDefault();
      chooseResult(activeIndex);
    }
  } else if (event.key === 'Escape') {
    dom.query.value = '';
    dom.queryClear.hidden = true;
    hideResults();
    selectRoom(null);
  }
}

/* ------------------------------------------------------------------ интерфейс */

function buildLegend() {
  const counts = new Map();
  for (const room of state.plan.rooms) {
    counts.set(room.kind, (counts.get(room.kind) ?? 0) + 1);
  }

  dom.legend.replaceChildren();
  for (const kind of LEGEND_ORDER) {
    const meta = ROOM_TYPES[kind];
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.kind = kind;
    chip.setAttribute('aria-pressed', 'true');
    chip.title = `${meta.legend}: ${count}`;

    const dot = document.createElement('span');
    dot.className = 'chip__dot';
    dot.style.color = meta.color;

    const text = document.createElement('span');
    text.textContent = meta.legend;

    chip.append(dot, text);
    chip.addEventListener('click', () => toggleKind(kind, chip));
    dom.legend.append(chip);
  }
}

function toggleKind(kind, chip) {
  const visible = chip.getAttribute('aria-pressed') !== 'true';
  chip.setAttribute('aria-pressed', visible ? 'true' : 'false');

  if (visible) state.hiddenKinds.delete(kind);
  else state.hiddenKinds.add(kind);

  for (const view of state.model.list) {
    if (view.room.kind === kind) setKindVisible(view, visible);
  }

  if (!visible && state.selectedId && state.model.views.get(state.selectedId)?.room.kind === kind) {
    selectRoom(null);
  }

  if (dom.query.value.trim()) onQueryInput();
  updateStatus();
}

function floorLabel() {
  return FLOOR_BY_ID.get(state.floorId)?.label ?? '';
}

function updateStatus() {
  if (!state.plan) return;
  const rooms = state.plan.rooms;

  if (state.hoveredId) {
    const view = state.model.views.get(state.hoveredId);
    if (view) {
      dom.status.textContent = `${view.room.title} · ${floorLabel()}`;
      return;
    }
  }

  const hidden = state.hiddenKinds.size > 0 ? ` · скрыто типов: ${state.hiddenKinds.size}` : '';
  const problems = state.plan.warnings.length > 0 ? ` · замечаний к плану: ${state.plan.warnings.length}` : '';
  dom.status.textContent = `${rooms.length} ${pluralRooms(rooms.length)} · ${floorLabel()}${hidden}${problems}`;
  dom.status.title = state.plan.warnings.join('\n');
}

/* ------------------------------------------------------------------ тема */

function currentTheme() {
  return THEMES[state.theme] ?? THEMES.light;
}

function updateThemeButton() {
  const dark = state.theme === 'dark';
  const label = dark ? 'Светлая тема' : 'Тёмная тема';

  document.documentElement.dataset.theme = state.theme;
  dom.btnTheme.setAttribute('aria-pressed', dark ? 'true' : 'false');
  dom.btnTheme.title = label;
  dom.btnTheme.setAttribute('aria-label', label);
  dom.themeColor?.setAttribute('content', dark ? '#0f141d' : '#f2f4f8');
}

function setTheme(theme, { persist = true } = {}) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  updateThemeButton();

  if (persist) {
    try {
      localStorage.setItem('theme', state.theme);
    } catch {
      // приватный режим: выбор просто не запомнится
    }
  }

  for (const entry of state.floors.values()) {
    applyTheme(entry.model, currentTheme());
    entry.theme = state.theme;
  }
  updateLabels();
}

/* ------------------------------------------------------------------ этажи */

function buildFloorSwitcher() {
  dom.floors.replaceChildren();
  for (const floor of FLOORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'floor';
    button.dataset.floor = floor.id;
    button.textContent = floor.id;
    button.setAttribute('aria-label', floor.label);
    button.title = floor.label;
    button.addEventListener('click', () => showFloor(floor.id, { animate: true }));
    dom.floors.append(button);
  }
  updateFloorSwitcher();
}

function updateFloorSwitcher() {
  for (const button of dom.floors.children) {
    const active = button.dataset.floor === state.floorId;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function setFloorSwitcherDisabled(disabled) {
  for (const button of dom.floors.children) button.disabled = disabled;
}

function showLoading(text) {
  dom.loadingText.textContent = text;
  if (!dom.loading.querySelector('.loading__spinner')) {
    const spinner = document.createElement('div');
    spinner.className = 'loading__spinner';
    dom.loading.prepend(spinner);
  }
  dom.loading.classList.remove('loading--done');
}

function hideLoading() {
  dom.loading.classList.add('loading--done');
}

/**
 * Показывает этаж, загружая и собирая его модель при первом обращении.
 * Разобранные этажи кешируются, поэтому повторное переключение мгновенное.
 */
async function showFloor(id, { animate = false, initial = false } = {}) {
  const floor = FLOOR_BY_ID.get(id);
  if (!floor) return;
  if (!initial && state.model && state.floorId === id) return;

  const token = (state.floorToken += 1);
  let shown = false;
  setFloorSwitcherDisabled(true);
  if (!initial) showLoading(`Загружаем ${floor.label}…`);

  try {
    let entry = state.floors.get(id);
    if (!entry) {
      const plan = await loadPlan(floor.url);
      if (token !== state.floorToken) return;

      if (plan.rooms.length === 0) {
        throw new Error(`На плане «${floor.label}» не найдено ни одного помещения: проверьте подписи inkscape:label.`);
      }

      entry = { plan, model: buildModel(plan, currentTheme()), theme: state.theme };
      state.floors.set(id, entry);
      scene.add(entry.model.group);

      if (plan.warnings.length > 0) {
        console.warn(`План «${floor.label}» загружен с замечаниями (${plan.warnings.length}):`);
        for (const warning of plan.warnings) console.warn(' ·', warning);
      }
    }

    // этаж мог быть собран под другую тему — перекрашиваем перед показом
    if (entry.theme !== state.theme) {
      applyTheme(entry.model, currentTheme());
      entry.theme = state.theme;
    }

    // смена этажа: плиты предыдущего просто прячем целиком
    if (state.model) {
      selectRoom(null);
      state.model.group.visible = false;
    }

    state.floorId = id;
    state.plan = entry.plan;
    state.model = entry.model;
    state.model.group.visible = true;
    state.hiddenKinds.clear();
    state.hoveredId = null;
    state.selectedId = null;
    dom.card.hidden = true;

    // на другом этаже набор типов иной: фильтры сбрасываем, все плиты показываем
    for (const view of state.model.list) setKindVisible(view, true);

    updateFloorSwitcher();
    buildLegend();
    updateStatus();
    document.title = `3D-навигатор · ${floor.label}`;
    frameModel({ animate });
    updateLabels();

    if (dom.query.value.trim()) onQueryInput();
    else hideResults();
    shown = true;
  } catch (error) {
    if (token !== state.floorToken) return;
    state.errors.push(String(error));

    if (initial) {
      showFatal(error.message);
    } else {
      console.error(error);
      hideLoading();
      dom.status.hidden = false;
      dom.status.textContent = `Не удалось открыть ${floor.label}: ${error.message}`;
    }
  } finally {
    if (token === state.floorToken) {
      setFloorSwitcherDisabled(false);
      if (shown) hideLoading();
    }
  }
}

function bindUi() {
  dom.query.addEventListener('input', onQueryInput);
  dom.query.addEventListener('keydown', onQueryKeydown);
  dom.queryClear.addEventListener('click', () => {
    dom.query.value = '';
    dom.queryClear.hidden = true;
    hideResults();
    dom.query.focus();
  });
  dom.cardClose.addEventListener('click', () => selectRoom(null));
  dom.btnReset.addEventListener('click', () => {
    selectRoom(null);
    hideResults();
    frameModel({ animate: true });
  });
  dom.btnTop.addEventListener('click', topView);
  dom.btnLabels.addEventListener('click', () => {
    state.labelsEnabled = !state.labelsEnabled;
    dom.btnLabels.classList.toggle('is-on', state.labelsEnabled);
    dom.btnLabels.setAttribute('aria-pressed', state.labelsEnabled ? 'true' : 'false');
    updateLabels();
  });
  dom.btnTheme.addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== dom.query) {
      event.preventDefault();
      dom.query.focus();
    }
  });

  // касание/клик по плану: отличаем выбор от перетаскивания
  let tap = null;
  const canvas = renderer.domElement;

  canvas.addEventListener('pointerdown', (event) => {
    tap = { x: event.clientX, y: event.clientY, time: performance.now(), pointerId: event.pointerId };
  });

  canvas.addEventListener('pointerup', (event) => {
    if (!tap || event.pointerId !== tap.pointerId) return;
    const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
    const elapsed = performance.now() - tap.time;
    tap = null;
    if (moved > 8 || elapsed > 700) return;
    selectRoom(pickRoom(event.clientX, event.clientY));
    hideResults();
  });

  canvas.addEventListener('pointercancel', () => {
    tap = null;
  });

  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    canvas.addEventListener('pointermove', (event) => {
      const id = pickRoom(event.clientX, event.clientY);
      canvas.style.cursor = id ? 'pointer' : 'grab';
      if (id !== state.hoveredId) {
        state.hoveredId = id;
        updateStatus();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      state.hoveredId = null;
      updateStatus();
    });
  }

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(dom.viewport);
  window.addEventListener('orientationchange', onResize);
}

function onResize() {
  if (!renderer) return;
  const width = dom.viewport.clientWidth || window.innerWidth;
  const height = dom.viewport.clientHeight || window.innerHeight;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  camera.aspect = width / Math.max(height, 1);
  camera.updateProjectionMatrix();

  if (state.radius) state.fitDistance = computeFitDistance(state.radius);
}

function showFatal(message) {
  dom.loading.classList.remove('loading--done');
  dom.loadingText.textContent = message;
  dom.loading.querySelector('.loading__spinner')?.remove();
}

/* ------------------------------------------------------------------ запуск */

async function start() {
  if (!createRenderer()) return;
  createScene();
  bindUi();
  buildFloorSwitcher();
  updateThemeButton();

  const touch = window.matchMedia('(hover: none)').matches;
  dom.hint.textContent = touch
    ? 'Один палец — сдвинуть · два пальца — зум и поворот · приблизьте, чтобы увидеть номера'
    : 'ЛКМ — сдвинуть · колесо — зум · ПКМ — поворот · / — поиск';
  dom.hint.hidden = false;

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;

    applyTween(delta);
    controls.update();
    updateLabels();
    renderer.render(scene, camera);
  });

  onResize();

  await showFloor(FLOORS[0].id, { initial: true });
  if (!state.plan || !state.model) return;

  dom.status.hidden = false;

  // отладочная ручка: пригодится, чтобы проверять план и разбираться с ошибками в SVG
  window.__navigator = {
    get plan() {
      return state.plan;
    },
    get model() {
      return state.model;
    },
    get planUrl() {
      return FLOOR_BY_ID.get(state.floorId).url;
    },
    floors: FLOORS.map(({ id, label }) => ({ id, label })),
    get floor() {
      return state.floorId;
    },
    // переключить этаж программно (переключатель в интерфейсе делает то же самое)
    setFloor: (id) => showFloor(id, { animate: true }),
    // проверить произвольный текст плана тем же разбором (для отладки правок в SVG)
    parseText: parsePlanText,
    get scene() {
      return scene;
    },
    get camera() {
      return camera;
    },
    get controls() {
      return controls;
    },
    select: selectRoom,
    pick: pickRoom,
    reset: () => frameModel({ animate: false }),
    renderNow: () => renderer.render(scene, camera),
    diagnostics,
  };
}

function diagnostics() {
  const plan = state.plan;
  const model = state.model;
  const kinds = {};
  for (const room of plan?.rooms ?? []) kinds[room.kind] = (kinds[room.kind] ?? 0) + 1;

  const bounds = plan?.bounds;
  return {
    ready: Boolean(model),
    floor: state.floorId,
    rooms: plan?.rooms.length ?? 0,
    wallsShapes: plan?.walls?.shapes.length ?? 0,
    labelsBuilt: model?.list.length ?? 0,
    pickables: model?.pickables.length ?? 0,
    kinds,
    warnings: plan?.warnings ?? [],
    errors: state.errors,
    bounds: bounds && !bounds.isEmpty()
      ? { minX: round(bounds.min.x), minY: round(bounds.min.y), maxX: round(bounds.max.x), maxY: round(bounds.max.y) }
      : null,
    fitDistance: round(state.fitDistance),
    cameraDistance: round(camera.position.distanceTo(controls.target)),
    visibleLabels: model ? model.list.filter((view) => view.sprite.visible).length : 0,
    selected: state.selectedId,
    sample: (plan?.rooms ?? []).slice(0, 6).map((room) => ({
      id: room.id,
      title: room.title,
      kind: room.kind,
      area: round(room.area),
      centroid: { x: round(room.centroid.x), y: round(room.centroid.y) },
      shapes: room.shapes.length,
    })),
  };
}

const round = (value) => Math.round(value * 100) / 100;

start();
