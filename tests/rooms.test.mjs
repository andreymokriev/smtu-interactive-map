import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  kindColor,
  kindTitle,
  matchScore,
  normalize,
  parseRoomLabel,
  pluralRooms,
  searchRooms,
} from '../src/core/rooms.js';

test('parseRoomLabel: тип, подтип и номера', () => {
  const stud = parseRoomLabel('stud_105');
  assert.equal(stud.type, 'stud');
  assert.equal(stud.kind, 'stud');
  assert.deepEqual(stud.numbers, ['105']);
  assert.equal(stud.title, 'Аудитория 105');

  const group = parseRoomLabel('dep_146_147_148');
  assert.deepEqual(group.numbers, ['146', '147', '148']);
  assert.equal(group.title, 'Кафедра 146, 147, 148');

  const letter = parseRoomLabel('stud_191a');
  assert.deepEqual(letter.numbers, ['191a']);
  assert.equal(letter.kind, 'stud');

  const gym = parseRoomLabel('other_gym');
  assert.equal(gym.type, 'other');
  assert.equal(gym.kind, 'gym');
  assert.equal(gym.title, 'Спортзал');
  assert.deepEqual(gym.numbers, []);

  const medical = parseRoomLabel('other_medical_1');
  assert.equal(medical.kind, 'medical');
  assert.equal(medical.title, 'Медпункт 1');

  const legacy = parseRoomLabel('dep_6_yu');
  assert.equal(legacy.kind, 'dep');
  assert.deepEqual(legacy.numbers, ['6']);
  assert.equal(legacy.title, 'Кафедра 6');
});

test('parseRoomLabel: имя без типа и сломанное имя не ломают разбор', () => {
  const bare = parseRoomLabel('162');
  assert.equal(bare.type, 'other');
  assert.deepEqual(bare.numbers, ['162']);
  assert.equal(bare.title, 'Помещение 162');

  const empty = parseRoomLabel('');
  assert.equal(empty.type, 'other');
  assert.deepEqual(empty.numbers, []);
  assert.equal(empty.title, 'Помещение');
});

test('normalize: регистр, ё и кириллические двойники латиницы', () => {
  // «е» и «к» — кириллические двойники латинских e и k, поэтому в результате латиница
  assert.equal(normalize('ЁЛКА'), 'eлka');
  assert.equal(normalize('  105  '), '105');
  assert.equal(normalize('110а'), normalize('110a'));
  assert.equal(normalize('Студ_105'), 'ctyд_105');
});

test('помещение с буквой находится и по «110a», и по «110а»', () => {
  const room = parseRoomLabel('dep_110a');
  assert.equal(matchScore(room, '110a'), 0);
  assert.equal(matchScore(room, '110а'), 0);
});

test('matchScore: приоритет точного номера', () => {
  const room = parseRoomLabel('stud_105');
  assert.equal(matchScore(room, '105'), 0);
  assert.equal(matchScore(room, '10'), 1);
  assert.equal(matchScore(room, 'аудитория 105'), 2);
  assert.equal(matchScore(room, 'аудитория'), 2);
  assert.equal(matchScore(room, 'stud'), 4);
  assert.equal(matchScore(room, '205'), -1);
});

test('searchRooms: точное совпадение выше частичного, сортировка по номеру', () => {
  const rooms = ['stud_105', 'stud_1051', 'dep_105', 'stud_205'].map(parseRoomLabel);
  const found = searchRooms(rooms, '105', 10);
  assert.equal(found[0].raw, 'stud_105');
  assert.equal(found[1].raw, 'dep_105');
  assert.deepEqual(
    found.map((room) => room.raw),
    ['stud_105', 'dep_105', 'stud_1051'],
  );

  assert.deepEqual(searchRooms(rooms, '', 10), []);
  assert.deepEqual(searchRooms(rooms, 'Ничего', 10), []);
});

test('searchRooms: поиск по русскому названию типа работает по подписи', () => {
  const rooms = ['dep_146_147_148', 'other_gym', 'toilet_1'].map(parseRoomLabel);
  assert.equal(searchRooms(rooms, 'кафедра', 10)[0].raw, 'dep_146_147_148');
  assert.equal(searchRooms(rooms, 'спортзал', 10)[0].raw, 'other_gym');
  // синонимы типа: «туалет» находит санузел
  assert.equal(searchRooms(rooms, 'туалет', 10)[0].raw, 'toilet_1');
});

test('подписи и цвета типов', () => {
  assert.equal(kindTitle('stud'), 'Аудитория');
  assert.equal(kindTitle('gym'), 'Спортзал');
  assert.equal(kindTitle('неизвестный'), 'Помещение');
  assert.match(kindColor('dep'), /^#[0-9a-f]{6}$/i);
  assert.equal(kindColor('деп'), kindColor('other'));
});

test('pluralRooms: русские склонения', () => {
  assert.equal(pluralRooms(1), 'помещение');
  assert.equal(pluralRooms(2), 'помещения');
  assert.equal(pluralRooms(5), 'помещений');
  assert.equal(pluralRooms(11), 'помещений');
  assert.equal(pluralRooms(21), 'помещение');
  assert.equal(pluralRooms(73), 'помещения');
  assert.equal(pluralRooms(112), 'помещений');
});
