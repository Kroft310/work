// WORK: перевіряє, чи настав час якогось нагадування чи задачі, і надсилає пуш через ntfy.
// Запускається з GitHub Actions кожні 5 хвилин (див. .github/workflows/remind.yml).

const fs = require('fs');

const TZ = 'Europe/Kyiv';   // усі часи в нагадуваннях — за київським часом
const WINDOW = 120;         // GitHub іноді запускає із запізненням, тому дивимось на 2 години назад
const TOPIC = process.env.NTFY_TOPIC;

if (!TOPIC) { console.error('Не задано секрет NTFY_TOPIC'); process.exit(1); }

// Нагадування з кількома часами (times) розгортаємо: окремо на кожен час, як у застосунку
// Дані лежать у ПРИВАТНОМУ репозиторії: workflow кладе його в теку DATA_DIR
const DIR = process.env.DATA_DIR || '.';
let raw = { reminders: [] };
try { raw = JSON.parse(fs.readFileSync(`${DIR}/reminders.json`, 'utf8')); } catch { /* файлу ще немає — нагадувань нема */ }
const reminders = (raw.reminders || []).flatMap(r =>
  r.times && r.times.length > 1
    ? r.times.map(t => ({ ...r, id: `${r.id}@${t}`, time: t, doneUntil: (r.doneBy || {})[t] ?? r.doneUntil }))
    : [r]);
let state = { sent: {} };
try { state = JSON.parse(fs.readFileSync(`${DIR}/state.json`, 'utf8')); } catch { /* перший запуск */ }

// Поточна дата й час у Києві
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(p => [p.type, p.value])
);
const nowMin = +parts.hour * 60 + +parts.minute;

// Опис календарного дня: сьогодні (shift = 0) або вчора (shift = -1)
function dayInfo(shift) {
  const d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + shift));
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    wd: d.getUTCDay() || 7, // 1 = понеділок … 7 = неділя
    str: d.toISOString().slice(0, 10)
  };
}

function matches(r, day) {
  if (r.type === 'daily') return true;
  if (r.type === 'weekly') return (r.days || []).includes(day.wd);
  if (r.type === 'monthly') {
    const last = new Date(Date.UTC(day.y, day.m, 0)).getUTCDate();
    return day.d === (r.last ? last : Math.min(r.day, last)); // r.last — останній день; 31-го у квітні → 30-го
  }
  if (r.type === 'once' || r.type === 'task') return r.date === day.str;   // задача — у свій термін
  return false;
}

// Текст «за скільки»: 30 хв, 2 год, 1 день, 3 дні, 1 тиждень
function leadText(min) {
  if (min % 10080 === 0) { const w = min / 10080; return w === 1 ? '1 тиждень' : `${w} тиж.`; }
  if (min % 1440 === 0) { const d = min / 1440; return `${d} ${d === 1 ? 'день' : d < 5 ? 'дні' : 'днів'}`; }
  if (min % 60 === 0) return `${min / 60} год`;
  if (min > 60) return `${Math.floor(min / 60)} год ${min % 60} хв`;
  return `${min} хв`;
}

const DAY_NAMES = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

// kind: 'pre' — заздалегідь, 'due' — у час виконання
async function send(r, kind, day) {
  const when = `${DAY_NAMES[day.wd % 7]}, ${day.d} ${MONTHS_GEN[day.m - 1]} о ${r.time}`;
  const title = kind === 'pre' ? `⏰ За ${leadText(r.lead)}: ${when}` : `⏰ ${r.time} — час виконати`;
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    // JSON замість заголовків — щоб кирилиця в заголовку не ламалась.
    // Причина і «куди здати» (якщо є) ідуть наступними рядками сповіщення
    body: JSON.stringify({ topic: TOPIC, title, message: [r.title, r.note, r.dest && `Куди: ${r.dest}`].filter(Boolean).join('\n'),
      priority: kind === 'due' ? 4 : 3, tags: ['alarm_clock'] })
  });
  if (!res.ok) throw new Error(`ntfy відповів ${res.status}`);
}

(async () => {
  let changed = false, sentCount = 0;
  for (const r of reminders) {
    if (!r.active) continue;
    const [h, m] = r.time.split(':').map(Number);
    const tMin = h * 60 + m;
    const lead = r.lead || 0; // за скільки хвилин нагадати заздалегідь
    // Дивимось від учора до дня, що настане через «lead» (заздалегідь може бути аж за тиждень)
    const ahead = Math.ceil(lead / 1440) + 1;
    for (let shift = -1; shift <= ahead; shift++) {
      const day = dayInfo(shift);
      if (!matches(r, day)) continue;
      const key = `${day.str} ${r.time}`;
      if (r.doneUntil && key <= r.doneUntil) continue; // позначено «Виконав» — не нагадуємо
      const dueMin = shift * 1440 + tMin;              // хвилини від сьогоднішньої півночі
      const events = [['due', dueMin]];
      if (lead) events.push(['pre', dueMin - lead]);
      for (const [kind, at] of events) {
        const ago = nowMin - at;                       // скільки хвилин тому мало спрацювати
        if (ago < 0 || ago > WINDOW) continue;
        if (kind === 'pre' && nowMin >= dueMin) continue; // термін уже настав — заздалегідь пізно
        const sk = `${r.id}|${kind}`;
        if (state.sent[sk] === key) continue;          // уже надіслано
        try {
          await send(r, kind, day);
          state.sent[sk] = key;
          changed = true;
          sentCount++;
        } catch (e) { console.error('Помилка надсилання:', e.message); }   // без назви справи — журнал публічний
      }
    }
  }
  // Прибираємо записи про видалені нагадування
  const ids = new Set(reminders.map(r => r.id));
  for (const sk of Object.keys(state.sent)) if (!ids.has(sk.split('|')[0]) || !sk.includes('|')) { delete state.sent[sk]; changed = true; }   // id тут уже з «@час»

  if (changed) fs.writeFileSync(`${DIR}/state.json`, JSON.stringify(state, null, 2) + '\n');
  console.log(`Надіслано сповіщень: ${sentCount}`);
})();
