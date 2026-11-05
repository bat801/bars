const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

const dayFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
});

const shortDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
});

export function formatTime(value) {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : '';
}

export function formatDay(value) {
  const date = toDate(value);
  if (!date) return '';

  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((today - target) / 86_400_000);

  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Вчера';
  if (diffDays > 1 && diffDays < 7) {
    return new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(date);
  }
  return dayFormatter.format(date);
}

export function formatListTime(value) {
  const date = toDate(value);
  if (!date) return '';

  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((today - target) / 86_400_000);

  if (diffDays === 0) return timeFormatter.format(date);
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) {
    return new Intl.DateTimeFormat('ru-RU', { weekday: 'short' }).format(date);
  }
  return shortDateFormatter.format(date);
}

export function formatDeviceDate(value) {
  const date = toDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function initials(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return 'B';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function pluralRu(count, one, few, many) {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
