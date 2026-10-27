import assert from 'node:assert/strict';
import { test } from 'node:test';

import { elementMatrix, elementToPathData, readLabel } from '../src/core/plan.js';
import { multiplyMatrices, parseSvgMatrix } from '../src/core/raster.js';

/** Минимальная заглушка SVG-элемента: только то, что читает разбор плана. */
function element(tagName, attributes = {}, parent = null) {
  return {
    tagName,
    nodeName: tagName,
    parentElement: parent,
    attrs: attributes,
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    getAttributeNS() {
      return null;
    },
  };
}

test('elementToPathData: rect превращается в замкнутый контур', () => {
  const rect = element('rect', { x: '10', y: '20', width: '30', height: '40' });
  assert.equal(elementToPathData(rect), 'M 10 20 H 40 V 60 H 10 Z');

  const empty = element('rect', { x: '10', y: '20', width: '0', height: '40' });
  assert.equal(elementToPathData(empty), '');
});

test('elementToPathData: polygon и polyline собирают точки парами', () => {
  const polygon = element('polygon', { points: '0,0 10,0 10,5 0,5' });
  assert.equal(elementToPathData(polygon), 'M 0 0 L 10 0 L 10 5 L 0 5 Z');

  const polyline = element('polyline', { points: '1 2 3 4 5 6' });
  assert.equal(elementToPathData(polyline), 'M 1 2 L 3 4 L 5 6');

  assert.equal(elementToPathData(element('polygon', { points: '1,2' })), '');
});

test('elementToPathData: circle и path', () => {
  const circle = element('circle', { cx: '0', cy: '0', r: '5' });
  const data = elementToPathData(circle);
  assert.match(data, /^M .* Z$/);
  assert.equal(data.split(' L ').length, 32);

  const path = element('path', { d: 'M 1 2 L 3 4' });
  assert.equal(elementToPathData(path), 'M 1 2 L 3 4');
  assert.equal(elementToPathData(element('unknown', {})), '');
});

test('elementMatrix: складывает transform группы и элемента', () => {
  const group = element('g', { transform: 'translate(10,20)' });
  const room = element('rect', { transform: 'scale(2)' }, group);
  // сначала масштаб элемента, затем сдвиг группы
  assert.deepEqual(elementMatrix(room), [2, 0, 0, 2, 10, 20]);

  const plain = element('path', {}, element('g', {}, element('svg', {})));
  assert.deepEqual(elementMatrix(plain), [1, 0, 0, 1, 0, 0]);
});

test('parseSvgMatrix: matrix, translate, scale, rotate и цепочки', () => {
  assert.deepEqual(parseSvgMatrix('matrix(1,0,0,-1,0,576)'), [1, 0, 0, -1, 0, 576]);
  assert.deepEqual(parseSvgMatrix('translate(5 7)'), [1, 0, 0, 1, 5, 7]);
  assert.deepEqual(parseSvgMatrix('scale(3)'), [3, 0, 0, 3, 0, 0]);
  assert.deepEqual(parseSvgMatrix(''), [1, 0, 0, 1, 0, 0]);
  // translate затем scale: точка сначала масштабируется, потом сдвигается
  assert.deepEqual(parseSvgMatrix('translate(10,0) scale(2)'), [2, 0, 0, 2, 10, 0]);
});

test('multiplyMatrices: порядок применения как в SVG', () => {
  const translate = parseSvgMatrix('translate(10,0)');
  const scale = parseSvgMatrix('scale(2)');
  const point = { x: 1, y: 0 };
  const apply = (m) => ({ x: m[0] * point.x + m[2] * point.y + m[4], y: m[1] * point.x + m[3] * point.y + m[5] });
  assert.deepEqual(apply(multiplyMatrices(translate, scale)), { x: 12, y: 0 });
  assert.deepEqual(apply(parseSvgMatrix('translate(10,0) scale(2)')), { x: 12, y: 0 });
});

test('readLabel: метка важнее id, служебный id не считается именем', () => {
  const withLabel = element('path', { 'inkscape:label': 'stud_105', id: 'path99' });
  withLabel.getAttributeNS = () => 'stud_105';
  assert.equal(readLabel(withLabel), 'stud_105');

  assert.equal(readLabel(element('path', { id: 'path84' })), '');
  assert.equal(readLabel(element('path', { id: 'walls' })), 'walls');
  assert.equal(readLabel(element('path', { id: 'stud_105' })), 'stud_105');
});
