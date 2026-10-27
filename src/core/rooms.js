/**
 * Типы помещений и разбор имён из inkscape:label.
 *
 * Соглашение об именах в плане: "<тип>_<номер>", например stud_105, dep_146_147_148.
 * Здесь же — единственное место, где меняются русские подписи и цвета типов.
 */

export const ROOM_TYPES = {
  stud: { title: 'Аудитория', legend: 'Аудитории', color: '#1e88d0', synonyms: ['лекционная', 'класс'] },
  dean: { title: 'Деканат', legend: 'Деканаты', color: '#7c6eb0', synonyms: [] },
  dep: { title: 'Кафедра', legend: 'Кафедры', color: '#c02e93', synonyms: [] },
  admin: { title: 'Администрация', legend: 'Администрация', color: '#ef7c00', synonyms: ['админ', 'дирекция'] },
  toilet: { title: 'Санузел', legend: 'Санузлы', color: '#12a150', synonyms: ['туалет', 'уборная', 'wc'] },
  gym: { title: 'Спортзал', legend: 'Спортзал', color: '#0f9b8e', synonyms: ['спортивный зал'] },
  medical: { title: 'Медпункт', legend: 'Медпункт', color: '#e0575b', synonyms: ['медицинский пункт', 'врач'] },
  other: { title: 'Помещение', legend: 'Прочие', color: '#8f949c', synonyms: ['прочее'] },
};

/** Второе слово в имени, если это не номер: other_gym -> спортзал, other_medical_1 -> медпункт 1. */
export const ROOM_SUBTYPES = ['gym', 'medical'];

/** Порядок чипов-фильтров в интерфейсе. */
export const LEGEND_ORDER = ['stud', 'dep', 'dean', 'admin', 'toilet', 'gym', 'medical', 'other'];

/** Типы, которые считаются аудиториями с номером (для подписи на плане). */
const HOMOGLYPHS = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
};

/**
 * Приводит строку к виду, удобному для поиска: нижний регистр, ё -> е,
 * кириллические двойники латинских букв -> латиница (чтобы «110а» и «110a» совпадали).
 */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[а-я]/g, (ch) => HOMOGLYPHS[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Разбирает имя помещения из плана.
 *
 * @param {string} raw значение inkscape:label, например "dep_146_147_148"
 * @returns {{raw: string, type: string, kind: string, numbers: string[], title: string, normNumbers: string[], normTitle: string, normRaw: string}}
 */
export function parseRoomLabel(raw) {
  const label = String(raw || '').trim();
  const tokens = label.split(/[_\s]+/).filter(Boolean);

  const first = (tokens[0] || '').toLowerCase();
  const hasType = Object.prototype.hasOwnProperty.call(ROOM_TYPES, first);
  const type = hasType ? first : 'other';
  const rest = hasType ? tokens.slice(1) : tokens;

  // Номера — токены, в которых есть цифры (105, 146, 110a, 2).
  const numbers = rest.filter((token) => /\d/.test(token));
  // Подтип — известное слово-уточнение (gym, medical).
  const subtype = rest.find((token) => ROOM_SUBTYPES.includes(token.toLowerCase()));

  const kind = subtype ? subtype : type;
  const meta = ROOM_TYPES[kind] ?? ROOM_TYPES.other;

  const title =
    kind === 'other' && numbers.length === 0
      ? ROOM_TYPES.other.title
      : numbers.length
        ? `${meta.title} ${numbers.join(', ')}`
        : meta.title;

  // синонимы типа добавляем в текст поиска, чтобы «туалет» находил санузел
  const synonyms = meta.synonyms ?? [];
  const searchText = synonyms.length > 0 ? `${title} ${synonyms.join(' ')}` : title;

  return {
    raw: label,
    type,
    kind,
    numbers,
    title,
    normNumbers: numbers.map(normalize),
    normTitle: normalize(searchText),
    normRaw: normalize(label.replace(/_/g, ' ')),
  };
}

export function kindColor(kind) {
  return (ROOM_TYPES[kind] ?? ROOM_TYPES.other).color;
}

export function kindTitle(kind) {
  return (ROOM_TYPES[kind] ?? ROOM_TYPES.other).title;
}

/**
 * Оценка соответствия помещения поисковому запросу.
 * Меньше — лучше, -1 — не подходит.
 */
export function matchScore(room, query) {
  const q = normalize(query);
  if (!q) return -1;

  if (room.normNumbers.includes(q)) return 0;
  if (room.normNumbers.some((n) => n.startsWith(q))) return 1;
  if (room.normTitle.startsWith(q)) return 2;
  if (room.normTitle.includes(q)) return 3;
  if (room.normRaw.includes(q)) return 4;
  return -1;
}

/** Поиск по всем помещениям с сортировкой по релевантности. */
export function searchRooms(rooms, query, limit = 8) {
  const scored = [];
  for (const room of rooms) {
    const score = matchScore(room, query);
    if (score >= 0) scored.push({ room, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const na = parseInt(a.room.numbers[0] ?? '', 10);
    const nb = parseInt(b.room.numbers[0] ?? '', 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.room.title.localeCompare(b.room.title, 'ru');
  });
  return scored.slice(0, limit).map((item) => item.room);
}

/** Русское склонение: 1 помещение, 2 помещения, 5 помещений. */
export function pluralRooms(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'помещение';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'помещения';
  return 'помещений';
}
