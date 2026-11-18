// @ts-nocheck
// Focus — Supabase Edge Function (the whole backend in one file).
//
// One URL, one secret key. Everything is a POST with a JSON body like
//   { "action": "add", "text": "Submit lab report fri 5pm #college" }
// and the header  x-focus-key: <your FOCUS_KEY>.
// The one exception is your calendar feed (GET ?action=ics&token=…), which calendar
// apps can't send headers for, so it uses a separate read-only token.
//
// Used by: the web app, your iPhone Shortcuts, and the once-a-minute cron job
// (action "tick") that sends reminders, heads-ups and summaries, and syncs your calendars.
//
// Deploy: Supabase → Edge Functions → focus → paste this file → Deploy.
// "Verify JWT" must be OFF (this function checks its own key). Full steps in SETUP.md.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPushHTTPRequest } from 'npm:@pushforge/builder@2.0.4';

// ===== BEGIN SHARED (copied from app/shared.js by `npm run build:function` — edit that file, not this block) =====
// shared.js — logic shared by the web app AND the Supabase edge function.
//
// No imports, no browser- or Deno-specific APIs, so it runs in both places.
// The edge function has a copy of this file pasted between its
// "BEGIN SHARED" / "END SHARED" markers (with the `export ` keywords removed).
// If you change anything here, update that copy too (see README → "Changing the parser").

const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];
const DEFAULT_SETTINGS = {
  tz: 'Europe/Dublin',
  default_nag_minutes: 30, // how often an overdue task re-notifies you (0 = only once)
  quiet_start: '23:00',    // no nags between these times
  quiet_end: '08:00',
  digest_time: '08:30',    // morning summary of open tasks ('' to turn off)
  default_hour: 9,         // time used when you give a day but no time
  hold_during_busy: true,  // hold nags while a lecture/shift is on
  heads_up_minutes: 30,    // warning before your own events (0 = off)
  people_time: '18:00',    // daily nudge about people to catch up with ('' = off)
  review_day: 0,           // weekly review: 0 = Sunday … 6 = Saturday
  review_time: '19:00',    // ('' = off)
};
const KINDS = ['task', 'info', 'person', 'event'];

/* ------------------------------------------------------------------ */
/* Time-zone helpers (no libraries: Intl does the heavy lifting)       */
/* ------------------------------------------------------------------ */

const WD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const _fmtCache = new Map();

function fmt(tz) {
  if (!_fmtCache.has(tz)) {
    _fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  }
  return _fmtCache.get(tz);
}

/** Wall-clock parts of `date` in time zone `tz`. m is 1-12, wd is 0 (Sun) - 6 (Sat). */
function partsInTz(date, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(date)) o[p.type] = p.value;
  return {
    y: +o.year, m: +o.month, d: +o.day,
    h: +o.hour % 24, mi: +o.minute, s: +o.second,
    wd: WD_KEYS.indexOf(o.weekday.toLowerCase().slice(0, 3)),
  };
}

/** The instant when the wall clock in `tz` reads y-m-d h:mi. Handles daylight saving. */
function zonedToUtc(y, m, d, h, mi, tz) {
  const target = Date.UTC(y, m - 1, d, h, mi);
  let t = target;
  for (let i = 0; i < 4; i++) {
    const p = partsInTz(new Date(t), tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - target;
    if (diff === 0) break;
    t -= diff;
  }
  return new Date(t);
}

/** Calendar maths on plain dates (no time zone involved). */
function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/* ------------------------------------------------------------------ */
/* Quick-add parser                                                    */
/*   "Submit lab report fri 5pm #college"                               */
/*   "remind me to call the dentist tomorrow at 10"                     */
/*   "bins out every tuesday 8pm"     "pay rent on 1/12 !"              */
/* ------------------------------------------------------------------ */

const WEEKDAYS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2,
  wednesday: 3, weds: 3, wed: 3, thursday: 4, thurs: 4, thur: 4, thu: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};
const FULL_WEEKDAY = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i;
const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
const PERIOD_HOUR = { morning: 9, afternoon: 14, evening: 18, night: 21, tonight: 20 };

const WD_ALT = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
const MO_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const AT = '(?:\\bat\\s+|@\\s*)?';

const RX = {
  prefix: /^\s*(?:remind me (?:to|that|about)|remember to|don'?t forget to|todo:?)\s+/i,
  tag: /(^|\s)#([\p{L}\p{N}_-]+)/gu,
  priority: /(^|\s)!{1,3}(?=\s|$)/,
  relative: /\bin\s+(\d+|an?|half\s+an?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)\b/i,
  time12: new RegExp(AT + '\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])', 'i'),
  time24: new RegExp(AT + '\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b', 'i'),
  timeAt: /(?:\bat\s+|@\s*)(\d{1,2})(?:[.]([0-5]\d))?\b(?!\s*[/%])/i,
  noon: /\b(?:at\s+)?(?:noon|midday)\b/i,
  dateNum: /\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/i,
  dateDayMonth: new RegExp('\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MO_ALT + ')\\b', 'i'),
  dateMonthDay: new RegExp('\\b(?:on\\s+)?(' + MO_ALT + ')\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b', 'i'),
  dateOrdinal: /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i,
  everyDay: /\b(?:every\s+(day|morning|evening|night)|daily)\b/i,
  everyWeekday: /\b(?:every\s+weekdays?|on\s+weekdays|weekdays)\b/i,
  everyWeek: /\b(?:every\s+week|weekly)\b/i,
  everyMonth: /\b(?:every\s+month|monthly)\b/i,
  dayWord: /\b(today|tonight|tomorrow|tmrw|tmr|tomoz)\b(?:\s+(morning|afternoon|evening|night))?/i,
  weekday: new RegExp('\\b(?:(on|next|this|by|due|every)\\s+)?(' + WD_ALT + ')\\b(?:\\s+(morning|afternoon|evening|night))?', 'gi'),
  period: /\b(?:this|in\s+the)\s+(morning|afternoon|evening)\b/i,
  effort: /(?:^|\s)~\s*(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)?(?![a-z])/i,
  due: /\b(?:due|deadline)\b(?:\s+(?:on|by|at))?/i,
  range: /(?:\bfrom\s+)?\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|–|—|\bto\b|\buntil\b|\btill\b)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?(?![\w/])/i,
  nextWeek: /\bnext\s+week\b/i,                                // → next Monday
  weekend: /\b(?:(?:this|the|at\s+the)\s+)?weekend\b/i,      // → Saturday
};

/**
 * Pull a reminder time, repeat rule, #tags and "!" priority out of a line of text.
 * Returns { title, remindAt (Date|null), repeat, tags, priority, hints[] }.
 */
function parseQuick(input, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const tz = opts.tz || DEFAULT_SETTINGS.tz;
  const defaultHour = opts.defaultHour ?? DEFAULT_SETTINGS.default_hour;
  const today = partsInTz(now, tz);

  let s = ' ' + String(input || '').replace(/\s+/g, ' ').trim() + ' ';
  const out = {
    title: '', remindAt: null, repeat: null, tags: [], priority: false, hints: [],
    dueAt: null, isEvent: false, endAt: null, effortMinutes: null,
  };
  const cut = (m) => { s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); };

  let m;
  // "remind me to …" / "remember to …"
  s = ' ' + s.trim().replace(RX.prefix, '') + ' ';

  // #tags
  s = s.replace(RX.tag, (_, lead, tag) => { out.tags.push(tag.toLowerCase()); return lead; });
  out.tags = [...new Set(out.tags)];

  // ! priority
  if ((m = RX.priority.exec(s))) { out.priority = true; cut(m); }

  // ~15m  ~1h  (how long it takes)
  if ((m = RX.effort.exec(s))) {
    const n = parseFloat(m[1]);
    out.effortMinutes = Math.max(1, Math.round(/^h/i.test(m[2] || '') ? n * 60 : n));
    cut(m);
  }

  // "due" / "deadline": the time is a deadline, and the reminder comes earlier
  let isDue = false;
  if ((m = RX.due.exec(s))) { isDue = true; cut(m); }

  // "in 20 minutes", "in an hour", "in 3 days"
  let instant = null;
  let dayOffset = null;
  if ((m = RX.relative.exec(s))) {
    const raw = m[1].toLowerCase();
    const n = /^half/.test(raw) ? 0.5 : /^an?$/.test(raw) ? 1 : parseInt(raw, 10);
    const unit = m[2].toLowerCase()[0];
    if (unit === 'm') instant = new Date(now.getTime() + n * 60000);
    else if (unit === 'h') instant = new Date(now.getTime() + n * 3600000);
    else dayOffset = Math.round(unit === 'w' ? n * 7 : n);
    cut(m);
  }

  // Times
  let hour = null, minute = 0, hourFromPeriod = false;
  let endHour = null, endMinute = 0;

  // A time range ("5-10pm", "9:00-11:00", "from 2 to 4pm") means a block of time: an event
  if ((m = RX.range.exec(s)) && (m[3] || m[6] || m[2] || m[5] || /^from/i.test(m[0].trim()))) {
    const to24 = (h, mer) => (mer ? (h % 12) + (/^p/i.test(mer) ? 12 : 0) : h);
    const flip = (mer) => (/^p/i.test(mer) ? 'am' : 'pm');
    let sh = parseInt(m[1], 10), eh = parseInt(m[4], 10);
    const sm = m[3], em = m[6];
    if (!sm && em) {
      const e = to24(eh, em); let st = to24(sh, em);
      if (st >= e) st = to24(sh, flip(em));
      sh = st; eh = e;
    } else if (sm && !em) {
      sh = to24(sh, sm); let e = to24(eh, sm);
      if (e <= sh) e = to24(eh, flip(sm));
      eh = e;
    } else { sh = to24(sh, sm); eh = to24(eh, em); }
    if (sh <= 23 && eh <= 24) {
      hour = sh; minute = m[2] ? parseInt(m[2], 10) : 0;
      endHour = eh % 24; endMinute = m[5] ? parseInt(m[5], 10) : 0;
      out.isEvent = true;
      cut(m);
    }
  }
  if (hour === null && (m = RX.time12.exec(s))) {
    let h = parseInt(m[1], 10) % 12;
    if (/^p/i.test(m[3])) h += 12;
    if (parseInt(m[1], 10) <= 12) { hour = h; minute = m[2] ? parseInt(m[2], 10) : 0; cut(m); }
  }
  if (hour === null && (m = RX.time24.exec(s))) {
    hour = parseInt(m[1], 10); minute = parseInt(m[2], 10); cut(m);
  }
  if (hour === null && (m = RX.noon.exec(s))) { hour = 12; minute = 0; cut(m); }
  if (hour === null && (m = RX.timeAt.exec(s))) {
    const h = parseInt(m[1], 10);
    if (h <= 23) {
      hour = h >= 1 && h <= 6 ? h + 12 : h; // "at 3" means 3pm, "at 9" means 9am
      minute = m[2] ? parseInt(m[2], 10) : 0;
      cut(m);
    }
  }

  // Dates
  let date = null; // {y,m,d}
  let explicitYear = false;
  const pickYear = (mo, d) => {
    let y = today.y;
    if (Date.UTC(y, mo - 1, d) < Date.UTC(today.y, today.m - 1, today.d)) y += 1;
    return y;
  };
  if ((m = RX.dateNum.exec(s))) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let y = m[3] ? parseInt(m[3], 10) : pickYear(mo, d);
      if (y < 100) y += 2000;
      explicitYear = !!m[3];
      date = { y, m: mo, d: Math.min(d, daysInMonth(y, mo)) };
      cut(m);
    }
  }
  if (!date && (m = RX.dateDayMonth.exec(s))) {
    const d = parseInt(m[1], 10), mo = MONTHS[m[2].toLowerCase()];
    if (d >= 1 && d <= 31) { const y = pickYear(mo, d); date = { y, m: mo, d: Math.min(d, daysInMonth(y, mo)) }; cut(m); }
  }
  if (!date && (m = RX.dateMonthDay.exec(s))) {
    const mo = MONTHS[m[1].toLowerCase()], d = parseInt(m[2], 10);
    if (d >= 1 && d <= 31) { const y = pickYear(mo, d); date = { y, m: mo, d: Math.min(d, daysInMonth(y, mo)) }; cut(m); }
  }
  if (!date && (m = RX.dateOrdinal.exec(s))) {
    const d = parseInt(m[1], 10);
    if (d >= 1 && d <= 31) {
      let y = today.y, mo = today.m;
      if (d < today.d) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
      date = { y, m: mo, d: Math.min(d, daysInMonth(y, mo)) };
      cut(m);
    }
  }

  // Repeats
  let weekdayTarget = null, weekdayNext = false;
  if ((m = RX.everyDay.exec(s))) {
    out.repeat = 'daily';
    if (m[1] && PERIOD_HOUR[m[1].toLowerCase()] && hour === null) { hour = PERIOD_HOUR[m[1].toLowerCase()]; hourFromPeriod = true; }
    cut(m);
  } else if ((m = RX.everyWeekday.exec(s))) { out.repeat = 'weekdays'; cut(m); }

  // Weekday names ("fri", "next monday", "every tuesday", "thursday evening")
  if (!out.repeat && (m = RX.everyWeek.exec(s))) { out.repeat = 'weekly'; cut(m); }
  if (!out.repeat && (m = RX.everyMonth.exec(s))) { out.repeat = 'monthly'; cut(m); }

  // Short forms ("sun", "sat", "wed") only count when they clearly mean a day,
  // so "buy sun cream" stays as it is but "essay due fri" gets a reminder.
  for (const wm of s.matchAll(RX.weekday)) {
    const word = wm[2].toLowerCase();
    const prefix = (wm[1] || '').toLowerCase();
    const rest = s.slice(wm.index + wm[0].length);
    const before = s.slice(0, wm.index);
    const ok = (FULL_WEEKDAY.test(word) || prefix || wm[3] || /^\s*($|\d|at\b|@|[,.;!?])/i.test(rest))
      && !/\babout\s*$/i.test(before); // "chat about Saturday" is a topic, not a date
    if (!ok) continue;
    weekdayTarget = WEEKDAYS[word];
    weekdayNext = prefix === 'next';
    if (prefix === 'every') out.repeat = 'weekly';
    if (wm[3] && hour === null) { hour = PERIOD_HOUR[wm[3].toLowerCase()]; hourFromPeriod = true; }
    cut(wm);
    break;
  }
  if (weekdayTarget === null && (m = RX.nextWeek.exec(s))) { weekdayTarget = 1; weekdayNext = true; cut(m); }
  if (weekdayTarget === null && (m = RX.weekend.exec(s))) { weekdayTarget = 6; cut(m); }

  // today / tonight / tomorrow (+ morning/evening…)
  let dayWord = null;
  if ((m = RX.dayWord.exec(s))) {
    dayWord = m[1].toLowerCase();
    if (hour === null) {
      if (m[2]) { hour = PERIOD_HOUR[m[2].toLowerCase()]; hourFromPeriod = true; }
      else if (dayWord === 'tonight') { hour = PERIOD_HOUR.tonight; hourFromPeriod = true; }
    }
    cut(m);
  }
  if ((m = RX.period.exec(s))) {
    if (hour === null) { hour = PERIOD_HOUR[m[1].toLowerCase()]; hourFromPeriod = true; }
    cut(m);
  }

  // ---- Combine into one instant ----
  const at = (ymd, h, mi) => zonedToUtc(ymd.y, ymd.m, ymd.d, h, mi, tz);
  const hasTime = hour !== null;
  const h = hasTime ? hour : defaultHour;
  const mi = hasTime ? minute : 0;

  if (instant) {
    out.remindAt = instant;
  } else if (date) {
    out.remindAt = at(date, h, mi);
    if (!explicitYear && out.remindAt <= now && date.y === today.y && !hasTime) {
      // "25/11" when it's already the 25th: keep today, just later on
      out.remindAt = new Date(Math.max(out.remindAt.getTime(), now.getTime() + 3600000));
    }
  } else if (weekdayTarget !== null) {
    let delta = (weekdayTarget - today.wd + 7) % 7;
    if (delta === 0 && (weekdayNext || at(today, h, mi) <= now)) delta = 7;
    out.remindAt = at(addDays(today.y, today.m, today.d, delta), h, mi);
  } else if (dayWord) {
    const off = /^(tomorrow|tmrw|tmr|tomoz)$/.test(dayWord) ? 1 : 0;
    out.remindAt = at(addDays(today.y, today.m, today.d, off), h, mi);
    // "today" / "tonight" when that time has already gone: nudge in an hour instead
    if (off === 0 && out.remindAt <= now && (!hasTime || hourFromPeriod)) out.remindAt = new Date(now.getTime() + 3600000);
  } else if (dayOffset !== null) {
    const base = addDays(today.y, today.m, today.d, dayOffset);
    out.remindAt = hasTime ? at(base, h, mi) : at(base, today.h, today.mi);
  } else if (hasTime || out.repeat) {
    out.remindAt = at(today, h, mi);
    if (out.remindAt <= now) {
      out.remindAt = out.repeat
        ? nextOccurrence(out.remindAt, out.repeat, tz, now)
        : at(addDays(today.y, today.m, today.d, 1), h, mi);
    }
  }
  if (out.repeat === 'weekdays' && out.remindAt) {
    const p = partsInTz(out.remindAt, tz);
    if (p.wd === 0 || p.wd === 6) out.remindAt = nextOccurrence(out.remindAt, 'weekdays', tz, out.remindAt);
  }

  // An event's end time
  if (out.isEvent && out.remindAt) {
    const p = partsInTz(out.remindAt, tz);
    out.endAt = zonedToUtc(p.y, p.m, p.d, endHour, endMinute, tz);
    if (out.endAt <= out.remindAt) out.endAt = new Date(out.endAt.getTime() + 86400000);
  }

  // A deadline: keep the time as the deadline (end of day if no time) and remind before it
  if (isDue && out.remindAt && !out.isEvent) {
    out.dueAt = out.remindAt;
    if (!hasTime && !instant) {
      const p = partsInTz(out.remindAt, tz);
      out.dueAt = zonedToUtc(p.y, p.m, p.d, 23, 59, tz);
    }
    out.remindAt = deadlineReminder(out.dueAt, now, tz, defaultHour);
  }

  // ---- Tidy the title ----
  let title = s.replace(/\s+/g, ' ').trim();
  const connector = /^(?:at|on|by|for|in|every|next|this|due|the|and|,|-|–)$/i;
  let words = title.split(' ');
  while (words.length > 1 && connector.test(words[words.length - 1])) words.pop();
  while (words.length > 1 && /^(?:,|-|–)$/.test(words[0])) words.shift();
  title = words.join(' ').replace(/\s+([,.;!?])/g, '$1').replace(/[,;\-–]\s*$/, '').trim();
  if (!title) title = String(input || '').trim();
  out.title = title.charAt(0).toUpperCase() + title.slice(1);

  if (out.dueAt) out.hints.push('📅 due ' + formatWhen(out.dueAt, { now, tz }));
  if (out.isEvent && out.endAt) out.hints.push(`🗓 ${formatWhen(out.remindAt, { now, tz })}–${formatClock(out.endAt, tz)}`);
  else if (out.remindAt) out.hints.push('⏰ ' + formatWhen(out.remindAt, { now, tz }));
  if (out.effortMinutes) out.hints.push('⏱ ' + formatMinutes(out.effortMinutes));
  if (out.repeat) out.hints.push('🔁 ' + repeatLabel(out.repeat));
  if (out.priority) out.hints.push('❗ priority');
  for (const t of out.tags) out.hints.push('#' + t);
  return out;
}

/** "Locker code: 4821 #college" → { title: 'Locker code', body: '4821', tags: ['college'] } */
function parseInfo(input) {
  const tags = [];
  let s = String(input || '').replace(RX.tag, (_, lead, tag) => { tags.push(tag.toLowerCase()); return lead; }).trim();
  let title = s, body = '';
  const nl = s.indexOf('\n');
  const colon = s.indexOf(':');
  if (nl > 0) { title = s.slice(0, nl); body = s.slice(nl + 1); }
  else if (colon > 0 && colon < 60 && !/^https?$/i.test(s.slice(0, colon))) {
    title = s.slice(0, colon); body = s.slice(colon + 1);
  }
  title = title.trim(); body = body.trim();
  if (!title) { title = body; body = ''; }
  return { title, body, tags: [...new Set(tags)] };
}

/* ------------------------------------------------------------------ */
/* Repeats, completing, nagging                                        */
/* ------------------------------------------------------------------ */

function repeatLabel(r) {
  return { daily: 'every day', weekdays: 'every weekday', weekly: 'every week', monthly: 'every month' }[r] || '';
}

/** Next time a repeating task comes round, strictly after `after`. */
function nextOccurrence(from, repeat, tz, after = new Date()) {
  if (!REPEATS.includes(repeat)) return null;
  const p = partsInTz(new Date(from), tz);
  let { y, m, d } = p;
  const origDay = d;
  let t, guard = 0;
  do {
    if (repeat === 'daily') ({ y, m, d } = addDays(y, m, d, 1));
    else if (repeat === 'weekly') ({ y, m, d } = addDays(y, m, d, 7));
    else if (repeat === 'weekdays') {
      let n;
      do { n = addDays(y, m, d, 1); ({ y, m, d } = n); } while (n.wd === 0 || n.wd === 6);
    } else if (repeat === 'monthly') {
      m += 1; if (m > 12) { m = 1; y += 1; }
      d = Math.min(origDay, daysInMonth(y, m));
    }
    t = zonedToUtc(y, m, d, p.h, p.mi, tz);
  } while (t <= after && ++guard < 2000);
  return t;
}

/** Fields to change when a task is ticked off. Repeating tasks roll forward instead of closing. */
function completePatch(item, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  if (item.repeat && item.remind_at) {
    const next = nextOccurrence(item.remind_at, item.repeat, tz, now);
    return { remind_at: next.toISOString(), done_at: null, snoozed_until: null, last_nagged_at: null, nag_count: 0 };
  }
  return { done_at: now.toISOString(), snoozed_until: null };
}

/** When the task next wants your attention (its time, or the end of a snooze). */
function effectiveDue(item) {
  if (!item.remind_at) return null;
  const due = Date.parse(item.remind_at);
  const snooze = item.snoozed_until ? Date.parse(item.snoozed_until) : 0;
  return new Date(Math.max(due, snooze));
}

/** Should this task send a notification right now? */
function shouldNag(item, now, settings = DEFAULT_SETTINGS) {
  if (item.kind !== 'task' || item.done_at || !item.remind_at) return false;
  const due = effectiveDue(item);
  if (due.getTime() > now.getTime()) return false;
  if (!item.last_nagged_at) return true;
  const every = item.nag_minutes ?? (item.priority ? 10 : settings.default_nag_minutes ?? 30);
  if (!every) return false; // "remind once"
  return now.getTime() - Date.parse(item.last_nagged_at) >= every * 60000 - 30000;
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function inQuietHours(now, settings = DEFAULT_SETTINGS) {
  const start = minutesOf(settings.quiet_start), end = minutesOf(settings.quiet_end);
  if (start === null || end === null || start === end) return false;
  const p = partsInTz(now, settings.tz || DEFAULT_SETTINGS.tz);
  const cur = p.h * 60 + p.mi;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Once-a-day jobs: returns today's key when it's time and it hasn't run yet today. */
function dailyDue(now, settings, hhmm, lastKey) {
  const at = minutesOf(hhmm);
  if (at === null) return false;
  const p = partsInTz(now, settings.tz || DEFAULT_SETTINGS.tz);
  const key = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return lastKey !== key && p.h * 60 + p.mi >= at && !inQuietHours(now, settings) ? key : false;
}

/** Is it time for today's morning summary? */
function digestDue(now, settings, lastDigestDate) {
  return dailyDue(now, settings, settings.digest_time, lastDigestDate);
}

/** Is it time for the weekly review (on review_day at review_time)? */
function reviewDue(now, settings, lastKey) {
  const p = partsInTz(now, settings.tz || DEFAULT_SETTINGS.tz);
  if (p.wd !== Number(settings.review_day ?? 0)) return false;
  return dailyDue(now, settings, settings.review_time, lastKey);
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "today 17:00", "tomorrow 09:00", "Fri 17:00", "25 Nov 17:00" */
function formatWhen(date, { now = new Date(), tz = DEFAULT_SETTINGS.tz } = {}) {
  const p = partsInTz(new Date(date), tz);
  const t = partsInTz(new Date(now), tz);
  const time = `${pad(p.h)}:${pad(p.mi)}`;
  const dayDiff = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff === -1) return `yesterday ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${WD_SHORT[p.wd]} ${time}`;
  const year = p.y !== t.y ? ` ${p.y}` : '';
  return `${WD_SHORT[p.wd]} ${p.d} ${MO_SHORT[p.m - 1]}${year} ${time}`;
}

/** "17:00" */
function formatClock(date, tz = DEFAULT_SETTINGS.tz) {
  const p = partsInTz(new Date(date), tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** 15 → "15 min", 60 → "1 hour", 90 → "1.5 hours" */
function formatMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/** "5 min", "2 h", "3 days" */
function formatSpan(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/* ------------------------------------------------------------------ */
/* Days, deadlines and Today's 3                                       */
/* ------------------------------------------------------------------ */

/** "2026-11-18" in your time zone. */
function todayKey(now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  const p = partsInTz(now, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

function isStarToday(item, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  return item.kind === 'task' && !item.done_at && item.star_date === todayKey(now, tz);
}

/** When to start reminding about a deadline: the morning before, or 3 hours before if that's too late. */
function deadlineReminder(due, now = new Date(), tz = DEFAULT_SETTINGS.tz, defaultHour = DEFAULT_SETTINGS.default_hour) {
  const d = new Date(due);
  const p = partsInTz(d, tz);
  const before = addDays(p.y, p.m, p.d, -1);
  let r = zonedToUtc(before.y, before.m, before.d, defaultHour, 0, tz);
  if (r > now && d - r >= 12 * 3600000) return r;
  r = new Date(d.getTime() - 3 * 3600000);
  return r > now ? r : d;
}

/**
 * Break a deadline into check-ins so it doesn't all land the night before.
 * Returns [{ label, at }] — e.g. Start, First draft, Final check — skipping any already past.
 */
function planMilestones(due, now = new Date(), tz = DEFAULT_SETTINGS.tz, defaultHour = DEFAULT_SETTINGS.default_hour) {
  const d = new Date(due);
  const days = (d - now) / 86400000;
  if (days < 1.5) return [];
  const steps = [
    ['Start', Math.min(14, Math.round(days * 0.75))],
    ['First draft', Math.max(2, Math.round(days * 0.35))],
    ['Final check', 1],
  ];
  const p = partsInTz(d, tz);
  const out = [];
  let prev = Infinity;
  for (const [label, off] of steps) {
    if (off >= prev || off < 1) continue;
    const day = addDays(p.y, p.m, p.d, -off);
    const at = zonedToUtc(day.y, day.m, day.d, defaultHour, 0, tz);
    if (at.getTime() <= now.getTime() + 3600000 || at >= d) continue;
    out.push({ label, at });
    prev = off;
  }
  return out;
}

/** Tasks that fit in the time you've got (only those you've given a length). */
function fitsIn(item, minutes) {
  return item.kind === 'task' && !item.done_at && item.effort_minutes > 0 && item.effort_minutes <= minutes;
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

/** "Aoife bday 14/3 every 2 weeks: exam Thursday #friends" */
function parsePerson(input) {
  const tags = [];
  let s = String(input || '').replace(RX.tag, (_, lead, tag) => { tags.push(tag.toLowerCase()); return lead; });
  let body = '';
  const colon = s.indexOf(':');
  if (colon > 0) { body = s.slice(colon + 1).trim(); s = s.slice(0, colon); }
  s = ' ' + s.replace(/\s+/g, ' ') + ' ';
  const cut = (m) => { s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); };
  let m, checkinDays = null, birthday = null;

  if ((m = /\b(?:(?:catch\s*up|check\s*in|see|call|text|ring)\s+)?every\s+(\d+)?\s*(days?|weeks?|months?)\b/i.exec(s))) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const u = m[2][0].toLowerCase();
    checkinDays = n * (u === 'd' ? 1 : u === 'w' ? 7 : 30);
    cut(m);
  } else if ((m = /\b(daily|weekly|fortnightly|monthly)\b/i.exec(s))) {
    checkinDays = { daily: 1, weekly: 7, fortnightly: 14, monthly: 30 }[m[1].toLowerCase()];
    cut(m);
  }

  const kw = /\b(?:bday|b'day|birthday|born)\b(?:\s+(?:on|is))?/i;
  if ((m = kw.exec(s))) cut(m);
  if ((m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/.exec(s))) {
    const d = +m[1], mo = +m[2];
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) { birthday = (m[3] ? m[3] + '-' : '') + `${pad(mo)}-${pad(d)}`; cut(m); }
  } else if ((m = RX.dateDayMonth.exec(s) || RX.dateMonthDay.exec(s))) {
    const dayFirst = m[0] === (RX.dateDayMonth.exec(s) || [])[0];
    const d = parseInt(dayFirst ? m[1] : m[2], 10), mo = MONTHS[(dayFirst ? m[2] : m[1]).toLowerCase()];
    const yr = /^,?\s*(\d{4})\b/.exec(s.slice(m.index + m[0].length));
    if (d >= 1 && d <= 31) {
      birthday = (yr ? yr[1] + '-' : '') + `${pad(mo)}-${pad(d)}`;
      if (yr) s = s.slice(0, m.index + m[0].length) + s.slice(m.index + m[0].length + yr[0].length);
      cut(m);
    }
  }

  let name = s.replace(/\s+/g, ' ').trim()
    .replace(/^(?:with|and|,|call|ring|text|see|visit|catch up with|check in with)\s+/i, '')
    .replace(/\s+(?:on|is|,|-)$/i, '').trim();
  if (!name) name = String(input || '').split(':')[0].trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return { title: name, body, tags: [...new Set(tags)], birthday, checkinDays };
}

/** Next birthday: { at (local midnight), daysUntil, turning (age, if the year is known) } */
function birthdayInfo(birthday, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(birthday || '');
  if (!m) return null;
  const t = partsInTz(now, tz);
  const mo = +m[2], d = +m[3];
  let y = t.y;
  const fits = (yy) => Math.min(d, daysInMonth(yy, mo));
  if (Date.UTC(y, mo - 1, fits(y)) < Date.UTC(t.y, t.m - 1, t.d)) y += 1;
  const daysUntil = Math.round((Date.UTC(y, mo - 1, fits(y)) - Date.UTC(t.y, t.m - 1, t.d)) / 86400000);
  return { y, m: mo, d: fits(y), daysUntil, turning: m[1] ? y - +m[1] : null, at: zonedToUtc(y, mo, fits(y), 0, 0, tz) };
}

/** Are you due to get in touch? { due, daysSince } or null if no catch-up rhythm is set. */
function checkinStatus(person, now = new Date()) {
  if (!person.checkin_days) return null;
  const last = Date.parse(person.last_contact || person.created_at || now.toISOString());
  const daysSince = Math.floor((now - last) / 86400000);
  return { due: daysSince >= person.checkin_days, daysSince };
}

/* ------------------------------------------------------------------ */
/* Events (lectures, shifts, plans)                                    */
/* ------------------------------------------------------------------ */

/** The current or next occurrence of an event: { start, end }, or null once it's over. */
function eventOccurrence(item, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  if (!item.remind_at) return null;
  let start = new Date(item.remind_at);
  const end0 = item.ends_at ? new Date(item.ends_at) : new Date(start.getTime() + 3600000);
  const dur = Math.max(0, end0 - start);
  if (start.getTime() + dur > now.getTime()) return { start, end: new Date(start.getTime() + dur) };
  if (!item.repeat) return null;
  start = nextOccurrence(start, item.repeat, tz, new Date(now.getTime() - dur));
  return start ? { start, end: new Date(start.getTime() + dur) } : null;
}

/** Is a lecture or shift on right now? */
function busyNow(items, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  return items.some((i) => {
    if (i.kind !== 'event' || i.busy === false) return false;
    const o = eventOccurrence(i, now, tz);
    return o && o.start <= now && now < o.end;
  });
}

/* ------------------------------------------------------------------ */
/* Calendar files (.ics) — college timetables, Moodle/Brightspace/     */
/* Canvas deadlines, Google/Outlook/iCloud calendars                   */
/* ------------------------------------------------------------------ */

const WINDOWS_TZ = {
  'gmt standard time': 'Europe/London', 'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin', 'romance standard time': 'Europe/Paris',
  'central europe standard time': 'Europe/Budapest', 'central european standard time': 'Europe/Warsaw',
  'eastern standard time': 'America/New_York', 'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver', 'pacific standard time': 'America/Los_Angeles',
  utc: 'UTC', 'coordinated universal time': 'UTC',
};

function validTz(name) {
  if (!name) return null;
  const candidates = [name, WINDOWS_TZ[name.toLowerCase()], name.split('/').slice(-2).join('/')];
  for (const c of candidates) {
    if (!c) continue;
    try { new Intl.DateTimeFormat('en-US', { timeZone: c }); return c; } catch { /* not a zone */ }
  }
  return null;
}

function splitProp(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ':' && !q) break;
  }
  const parts = line.slice(0, i).split(';');
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const e = p.indexOf('=');
    if (e > 0) params[p.slice(0, e).toUpperCase()] = p.slice(e + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value: line.slice(i + 1) };
}

const icsUnescape = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

/** Read a .ics file into a list of VEVENT/VTODO objects. */
function parseICS(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (const l of raw) {
    if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += l.slice(1);
    else lines.push(l);
  }
  const out = [];
  let cur = null, nested = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const { name, params, value } = splitProp(line);
    if (name === 'BEGIN') {
      if (!cur && (value === 'VEVENT' || value === 'VTODO')) cur = { type: value, exdates: [] };
      else if (cur) nested++;
      continue;
    }
    if (name === 'END') {
      if (cur && nested) nested--;
      else if (cur && (value === 'VEVENT' || value === 'VTODO')) { out.push(cur); cur = null; }
      continue;
    }
    if (!cur || nested) continue;
    const v = { value: value.trim(), params };
    switch (name) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = icsUnescape(value); break;
      case 'DESCRIPTION': cur.description = icsUnescape(value); break;
      case 'LOCATION': cur.location = icsUnescape(value); break;
      case 'URL': cur.url = value.trim(); break;
      case 'STATUS': cur.status = value.trim().toUpperCase(); break;
      case 'CATEGORIES': cur.categories = value.split(',').map(icsUnescape).filter(Boolean); break;
      case 'DTSTART': cur.dtstart = v; break;
      case 'DTEND': cur.dtend = v; break;
      case 'DUE': cur.due = v; break;
      case 'DURATION': cur.duration = value.trim(); break;
      case 'RRULE': cur.rrule = value.trim(); break;
      case 'RECURRENCE-ID': cur.recurrenceId = v; break;
      case 'EXDATE': for (const x of value.split(',')) cur.exdates.push({ value: x.trim(), params }); break;
    }
  }
  return out;
}

/** One ICS date/time → { at: Date, allDay, tz } */
function icsTime(v, fallbackTz = DEFAULT_SETTINGS.tz) {
  if (!v || !v.value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
  const allDay = v.params?.VALUE === 'DATE' || !m[4];
  if (m[7]) return { at: new Date(Date.UTC(y, mo - 1, d, h, mi, sec)), allDay: false, tz: 'UTC' };
  const tz = validTz(v.params?.TZID) || fallbackTz;
  return { at: zonedToUtc(y, mo, d, h, mi, tz), allDay, tz };
}

function icsDuration(s) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s || '');
  if (!m) return 0;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/** All occurrences of one event between `from` and `to`, following its repeat rule. */
function expandEvent(ev, from, to, fallbackTz = DEFAULT_SETTINGS.tz) {
  const st = icsTime(ev.dtstart || ev.due, fallbackTz);
  if (!st) return [];
  let endAt = ev.dtend ? icsTime(ev.dtend, fallbackTz)?.at : null;
  if (!endAt) endAt = new Date(st.at.getTime() + (ev.duration ? icsDuration(ev.duration) : st.allDay ? 86400000 : 0));
  const dur = Math.max(0, endAt - st.at);
  const ex = new Set(ev.exdates.map((x) => icsTime(x, st.tz === 'UTC' ? fallbackTz : st.tz)?.at.getTime()));
  const inWindow = (at) => at < to && at.getTime() + dur >= from.getTime();
  if (!ev.rrule) return inWindow(st.at) ? [{ start: st.at, end: new Date(st.at.getTime() + dur), allDay: st.allDay }] : [];

  const r = Object.fromEntries(ev.rrule.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
  let until = null;
  if (r.UNTIL) {
    const u = icsTime({ value: r.UNTIL, params: {} }, st.tz === 'UTC' ? fallbackTz : st.tz);
    if (u) until = u.allDay ? new Date(u.at.getTime() + 86400000 - 1) : u.at;
  }
  const tz = st.tz === 'UTC' ? fallbackTz : st.tz;
  const w = partsInTz(st.at, tz);
  const out = [];
  let n = 0;
  const emit = (y, mo, d) => {
    const at = zonedToUtc(y, mo, d, w.h, w.mi, tz);
    if (at < st.at) return true;
    if ((until && at > until) || n >= count || at >= to) return false;
    n++;
    if (!ex.has(at.getTime()) && inWindow(at)) out.push({ start: at, end: new Date(at.getTime() + dur), allDay: st.allDay });
    return true;
  };
  let guard = 0;
  if (r.FREQ === 'DAILY') {
    for (let i = 0; guard++ < 4000; i += interval) { const x = addDays(w.y, w.m, w.d, i); if (!emit(x.y, x.m, x.d)) break; }
  } else if (r.FREQ === 'WEEKLY') {
    const code = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const fromMon = (wd) => (wd + 6) % 7;
    const days = (r.BYDAY ? r.BYDAY.split(',').map((x) => code[x.replace(/^[+-]?\d+/, '')]).filter((x) => x !== undefined) : [w.wd])
      .sort((a, b) => fromMon(a) - fromMon(b));
    const mon = addDays(w.y, w.m, w.d, -fromMon(w.wd));
    outer: for (let wk = 0; guard++ < 1000; wk += interval) {
      for (const wd of days) {
        const x = addDays(mon.y, mon.m, mon.d, wk * 7 + fromMon(wd));
        if (!emit(x.y, x.m, x.d)) break outer;
      }
    }
  } else if (r.FREQ === 'MONTHLY' || r.FREQ === 'YEARLY') {
    const step = r.FREQ === 'MONTHLY' ? interval : interval * 12;
    for (let i = 0; guard++ < 600; i += step) {
      const total = w.m - 1 + i;
      const y = w.y + Math.floor(total / 12), mo = (total % 12) + 1;
      if (w.d > daysInMonth(y, mo)) continue;
      if (!emit(y, mo, w.d)) break;
    }
  } else if (inWindow(st.at)) {
    out.push({ start: st.at, end: new Date(st.at.getTime() + dur), allDay: st.allDay });
  }
  return out;
}

/** Brightspace puts HTML in descriptions: keep just the text. */
function stripHtml(s) {
  return String(s || '').replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24);

/**
 * Everything in a calendar file that happens between `from` and `to`, one entry per occurrence:
 * { key, title, body, location, start, end, allDay, moduleTag }.
 * Moved or cancelled single occurrences (RECURRENCE-ID) are handled.
 */
function icsOccurrences(text, from, to, fallbackTz = DEFAULT_SETTINGS.tz) {
  const events = parseICS(text);
  const overrides = events.filter((e) => e.recurrenceId);
  const masters = events.filter((e) => !e.recurrenceId);
  for (const o of overrides) {
    const master = masters.find((e) => e.uid === o.uid);
    if (master) master.exdates.push(o.recurrenceId);
  }
  const out = [];
  for (const ev of [...masters, ...overrides]) {
    if (ev.status === 'CANCELLED') continue;
    const title = (ev.summary || '').replace(/\s+(?:is due|-\s*due)$/i, '').replace(/^due:\s*/i, '').trim();
    for (const occ of expandEvent(ev, from, to, fallbackTz)) {
      out.push({
        // one-off items keep the same key even if their time moves; repeats are told apart by date
        key: ev.rrule || ev.recurrenceId
          ? `${ev.uid || title}|${(ev.recurrenceId ? icsTime(ev.recurrenceId, fallbackTz)?.at : occ.start)?.toISOString()}`
          : ev.uid || `${title}|${occ.start.toISOString()}`,
        title: title || 'Untitled',
        rawTitle: ev.summary || '',
        url: ev.url || '',
        body: [stripHtml(ev.description), ev.url].filter(Boolean).join('\n').slice(0, 1000),
        location: ev.location || '',
        moduleTag: ev.categories?.length ? slug(ev.categories[0]) : null,
        type: ev.type,
        ...occ,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---- Cleaning up noisy calendars (Brightspace publishes "Available", "Start Date", "End Date"
        and "Due" entries for the same assignment, sometimes more than once) ---- */

const DUE_RX = /\b(?:due|deadline|submission)\b/i;
const END_RX = /\b(?:end\s*date|ends|availability\s+ends|closes|close\s*date)\b/i;
const START_RX = /\b(?:available|availability(?:\s+(?:starts|begins|opens))?|opens?|start(?:s|\s*date)?|unlocks?|visible|released?|begins)\b/i;
const MARKER_RX = /\s*(?:[-–—:|(]\s*)?(?:is\s+)?(?:due(?:\s+date)?|deadline|availability\s+(?:ends|starts|begins|opens)|available(?:\s+from)?|start\s*date|end\s*date|starts|ends|opens|closes|close\s*date)\s*\)?\s*$/i;

/** "Assignment 1 - Availability Ends" → "Assignment 1" */
function cleanEventTitle(t) {
  let s = String(t || '').trim();
  for (let i = 0; i < 2; i++) s = s.replace(MARKER_RX, '').trim();
  return s || String(t || '').trim();
}

/**
 * Drop the noise from a calendar before importing it.
 * Deadlines: one task per assignment and day, preferring the "Due" entry; "available"/"starts"
 * entries are dropped, and when there's no Due entry the latest "ends" one stands in for it.
 * Timetables: identical entries (same title, same time) are merged.
 * `skip`: words — anything whose title or notes contains one is left out.
 */
function filterOccurrences(occ, type, skip = []) {
  const words = (Array.isArray(skip) ? skip : String(skip || '').split(','))
    .map((w) => String(w).trim().toLowerCase()).filter(Boolean);
  let list = occ.filter((o) => !words.some((w) => `${o.rawTitle || o.title} ${o.body}`.toLowerCase().includes(w)));
  const dayKey = (o) => o.start.toISOString().slice(0, 10);
  const once = (arr, keyFn) => { const seen = new Set(); return arr.filter((o) => { const k = keyFn(o); if (seen.has(k)) return false; seen.add(k); return true; }); };

  if (type !== 'deadlines') {
    return once(list, (o) => `${o.title.toLowerCase()}|${+o.start}|${+o.end}`);
  }
  const groups = new Map();
  for (const o of list) {
    const raw = o.rawTitle || o.title;
    const k = `${cleanEventTitle(o.title).toLowerCase()}|${o.moduleTag || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...o, title: cleanEventTitle(o.title), _due: DUE_RX.test(raw), _end: END_RX.test(raw), _start: !END_RX.test(raw) && START_RX.test(raw) });
  }
  const out = [];
  for (const g of groups.values()) {
    const due = g.filter((o) => o._due);
    let keep = due.length ? due : g.filter((o) => !o._start);
    // Course content (lecture notes, topics) only has availability dates: that's not something you hand in
    if (!due.length && g.every((o) => isCourseContent(o))) continue;
    if (!due.length && keep.some((o) => o._end)) keep = [keep.reduce((a, b) => (b.start > a.start ? b : a))];
    out.push(...once(keep, dayKey).map((o) => ({ ...o, kind: deadlineKind(o) })));
  }
  return out.map(({ _due, _end, _start, ...o }) => o).sort((a, b) => a.start - b.start);
}

/** A Brightspace/Moodle content page (notes, slides, a topic) rather than an assignment or quiz. */
function isCourseContent(o) {
  const where = `${o.url || ''} ${o.body || ''}`;
  if (/\/(?:dropbox|quizzing|quiz|assign|assignment|discussions?|forum)\b/i.test(where)) return false;
  return /\/d2l\/le\/content\/|\/mod\/(?:resource|page|folder|url|book)\b|^\s*units:/im.test(where);
}

/** "assignment" gets check-ins planned; a "test" just gets the reminder. */
function deadlineKind(o) {
  const text = `${o.rawTitle || o.title} ${o.url || ''}`;
  if (/\/quizzing\/|\/quiz\b|\b(?:quiz|test|exam|mcq|midterm)\b/i.test(text)) return 'test';
  return 'assignment';
}

/** Text for a .ics file (calendar export). */
function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
function icsStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
// ===== END SHARED =====

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

const FOCUS_KEY = Deno.env.get('FOCUS_KEY') || '';
const PUSH_CONTACT = Deno.env.get('PUSH_CONTACT') || 'mailto:focus-app@example.com';
const FEED_REFRESH_HOURS = 6;

function serverKey() {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) return JSON.parse(keys).default;
  throw new Error('No server key found in the function environment');
}

const db = createClient(Deno.env.get('SUPABASE_URL'), serverKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-focus-key, authorization, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function must({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Read-only token for the calendar feed, derived from your key (changing the key changes it). */
let _calToken = null;
async function calendarToken() {
  if (_calToken) return _calToken;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(FOCUS_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  _calToken = b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode('focus-calendar-v1'))).slice(0, 32);
  return _calToken;
}

/* ------------------------------------------------------------------ */
/* Config, settings, push keys                                         */
/* ------------------------------------------------------------------ */

async function getConfig(key) {
  const row = must(await db.from('app_config').select('value').eq('key', key).maybeSingle());
  return row ? row.value : null;
}

async function setConfig(key, value) {
  must(await db.from('app_config').upsert({ key, value, updated_at: new Date().toISOString() }));
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await getConfig('settings')) || {}) };
}

/** Push (VAPID) keys are created automatically the first time they're needed. */
async function getVapid() {
  const existing = await getConfig('vapid');
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const value = {
    privateJWK: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    publicKey: b64url(raw),
  };
  // If two requests race, keep whichever was saved first.
  must(await db.from('app_config').upsert({ key: 'vapid', value }, { onConflict: 'key', ignoreDuplicates: true }));
  return await getConfig('vapid');
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

const EDITABLE = ['kind', 'title', 'body', 'tags', 'pinned', 'priority', 'remind_at', 'repeat',
  'nag_minutes', 'snoozed_until', 'done_at', 'last_nagged_at', 'nag_count', 'due_at', 'ends_at',
  'busy', 'lead_minutes', 'star_date', 'effort_minutes', 'parent_id', 'birthday', 'checkin_days',
  'last_contact', 'meta'];
const DATE_FIELDS = ['remind_at', 'snoozed_until', 'done_at', 'last_nagged_at', 'due_at', 'ends_at', 'last_contact'];
const INT_FIELDS = { nag_minutes: [0, 1440], lead_minutes: [0, 1440], effort_minutes: [1, 10000], checkin_days: [1, 3650], nag_count: [0, 1e6] };

// Every column with its default, so batch writes always send the same columns.
const ROW_DEFAULTS = {
  kind: 'task', body: '', tags: [], pinned: false, priority: false, remind_at: null, repeat: null,
  nag_minutes: null, snoozed_until: null, last_nagged_at: null, nag_count: 0, done_at: null,
  due_at: null, ends_at: null, busy: true, lead_minutes: null, star_date: null, effort_minutes: null,
  parent_id: null, birthday: null, checkin_days: null, last_contact: null, source: null, source_uid: null, meta: {},
};

function clean(input, { creating = false } = {}) {
  const out = {};
  for (const k of EDITABLE) if (k in input) out[k] = input[k];
  if (creating && input.id) out.id = String(input.id);
  if ('kind' in out && !KINDS.includes(out.kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  if ('title' in out) {
    out.title = String(out.title || '').trim().slice(0, 500);
    if (!out.title) throw new HttpError(400, 'A title is needed');
  }
  if ('body' in out) out.body = String(out.body ?? '');
  if ('tags' in out) {
    out.tags = [...new Set((Array.isArray(out.tags) ? out.tags : String(out.tags || '').split(/[\s,]+/))
      .map((t) => String(t).replace(/^#/, '').trim().toLowerCase()).filter(Boolean))];
  }
  if ('repeat' in out && out.repeat && !REPEATS.includes(out.repeat)) throw new HttpError(400, 'Unknown repeat');
  if ('repeat' in out && !out.repeat) out.repeat = null;
  for (const k of DATE_FIELDS) {
    if (k in out && out[k]) {
      const d = new Date(out[k]);
      if (isNaN(d)) throw new HttpError(400, `${k} is not a valid date`);
      out[k] = d.toISOString();
    } else if (k in out) out[k] = null;
  }
  for (const [k, [lo, hi]] of Object.entries(INT_FIELDS)) {
    if (k in out && out[k] !== null && out[k] !== '') {
      const n = parseInt(out[k], 10);
      out[k] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
    } else if (k in out) out[k] = null;
  }
  for (const k of ['pinned', 'priority', 'busy']) if (k in out) out[k] = out[k] === true || out[k] === 'true';
  if ('star_date' in out && out.star_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.star_date)) throw new HttpError(400, 'star_date must be YYYY-MM-DD');
  if ('star_date' in out && !out.star_date) out.star_date = null;
  if ('birthday' in out && out.birthday && !/^(\d{4}-)?\d{2}-\d{2}$/.test(out.birthday)) throw new HttpError(400, 'birthday must be MM-DD or YYYY-MM-DD');
  if ('birthday' in out && !out.birthday) out.birthday = null;
  if ('parent_id' in out && !out.parent_id) out.parent_id = null;
  if ('meta' in out && (typeof out.meta !== 'object' || out.meta === null || Array.isArray(out.meta))) out.meta = {};
  return out;
}

/** A complete row (every column present) for batch upserts. */
function fullRow(r) {
  const out = { id: r.id || crypto.randomUUID(), title: r.title, created_at: r.created_at || new Date().toISOString() };
  for (const [k, d] of Object.entries(ROW_DEFAULTS)) {
    out[k] = r[k] !== undefined ? r[k] : Array.isArray(d) ? [] : d && typeof d === 'object' ? {} : d;
  }
  return out;
}

async function getItem(id) {
  const item = must(await db.from('items').select('*').eq('id', id).maybeSingle());
  if (!item) throw new HttpError(404, 'Not found — it may have been deleted');
  return item;
}

async function updateItem(id, patch) {
  const item = must(await db.from('items').update(patch).eq('id', id).select('*').maybeSingle());
  if (!item) throw new HttpError(404, 'Not found — it may have been deleted');
  return item;
}

async function allItems() {
  return must(await db.from('items').select('*'));
}

async function openTasks() {
  return must(await db.from('items').select('*').eq('kind', 'task').is('done_at', null));
}

function describe(item, settings, now = new Date()) {
  const tz = settings.tz;
  const bits = [item.title];
  if (item.kind === 'event' && item.remind_at) {
    bits.push(`🗓 ${formatWhen(new Date(item.remind_at), { now, tz })}${item.ends_at ? '–' + formatClock(item.ends_at, tz) : ''}`);
  } else {
    if (item.due_at) bits.push(`📅 due ${formatWhen(new Date(item.due_at), { now, tz })}`);
    if (item.remind_at) bits.push(`⏰ ${formatWhen(effectiveDue(item), { now, tz })}`);
  }
  if (item.repeat) bits.push(`🔁 ${repeatLabel(item.repeat)}`);
  if (item.effort_minutes) bits.push(`⏱ ${formatMinutes(item.effort_minutes)}`);
  if (item.birthday) { const b = birthdayInfo(item.birthday, now, tz); if (b) bits.push(`🎂 ${b.d}/${b.m}`); }
  if (item.checkin_days) bits.push(`catch up every ${item.checkin_days} days`);
  if (item.tags?.length) bits.push(item.tags.map((t) => '#' + t).join(' '));
  return bits.join(' — ');
}

/** Find something by (part of) its name, for Siri ("mark lab report as done"). */
function bestMatch(list, q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return null;
  const score = (t) => {
    const title = t.title.toLowerCase();
    if (title === s) return 3;
    if (title.startsWith(s)) return 2;
    if (title.includes(s)) return 1;
    const words = s.split(/\s+/).filter((w) => w.length > 2);
    return words.length && words.every((w) => title.includes(w)) ? 0.5 : 0;
  };
  return list.map((t) => [score(t), t]).filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0] || Date.parse(b[1].created_at) - Date.parse(a[1].created_at))[0]?.[1] || null;
}

async function createMilestones(parent, settings, now = new Date()) {
  const due = parent.due_at || parent.remind_at;
  if (!due) return [];
  const steps = planMilestones(new Date(due), now, settings.tz, settings.default_hour);
  if (!steps.length) return [];
  const rows = steps.map((s) => fullRow({
    kind: 'task', title: `${s.label}: ${parent.title}`, tags: parent.tags || [], remind_at: s.at.toISOString(), parent_id: parent.id,
  }));
  return must(await db.from('items').upsert(rows).select('*'));
}

/* ------------------------------------------------------------------ */
/* Push                                                                */
/* ------------------------------------------------------------------ */

async function sendToAll(payload, { ttl = 3600 } = {}) {
  const subs = must(await db.from('push_subs').select('*'));
  if (!subs.length) return { sent: 0, failed: 0, devices: 0 };
  const vapid = await getVapid();
  let sent = 0, failed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK: vapid.privateJWK,
        subscription: s.subscription,
        message: { payload, adminContact: PUSH_CONTACT, options: { ttl, urgency: 'high' } },
      });
      const res = await fetch(endpoint, { method: 'POST', headers, body });
      if (res.status === 404 || res.status === 410) {
        // That browser/phone unsubscribed or was reset — forget it.
        await db.from('push_subs').delete().eq('endpoint', s.endpoint);
        failed++;
      } else if (!res.ok) {
        console.error('push failed', res.status, await res.text());
        failed++;
      } else sent++;
    } catch (e) {
      console.error('push error', e);
      failed++;
    }
  }));
  return { sent, failed, devices: subs.length };
}

/* ------------------------------------------------------------------ */
/* Calendars you subscribe to (timetable, Moodle, work rota, Google…)  */
/* ------------------------------------------------------------------ */

const slugTag = (s) => String(s || '').toLowerCase().replace(/^#/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 24);

function cleanFeed(f, existing = {}) {
  const url = String(f.url ?? existing.url ?? '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\/\S+$/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
    throw new HttpError(400, 'The calendar link should start with https:// or webcal://');
  }
  const type = (f.type ?? existing.type) === 'deadlines' ? 'deadlines' : 'timetable';
  return {
    id: existing.id || f.id || crypto.randomUUID(),
    name: String(f.name ?? existing.name ?? '').trim().slice(0, 60) || (type === 'deadlines' ? 'Deadlines' : 'Timetable'),
    url, type,
    tag: slugTag(f.tag ?? existing.tag ?? (type === 'deadlines' ? 'college' : '')),
    lead_minutes: Math.max(0, Math.min(240, parseInt(f.lead_minutes ?? existing.lead_minutes ?? 15, 10) || 0)),
    busy: (f.busy ?? existing.busy ?? true) !== false,
    auto_plan: (f.auto_plan ?? existing.auto_plan ?? true) !== false,
    skip: (Array.isArray(f.skip ?? existing.skip) ? (f.skip ?? existing.skip) : String(f.skip ?? existing.skip ?? '').split(','))
      .map((w) => String(w).trim()).filter(Boolean).slice(0, 30),
    last_sync: existing.last_sync || null,
    last_error: existing.last_error || null,
    count: existing.count || 0,
  };
}

async function syncFeed(feed, settings, now = new Date()) {
  const tz = settings.tz;
  const res = await fetch(feed.url, { headers: { 'user-agent': 'Focus/2 (personal calendar sync)', accept: 'text/calendar, */*' } });
  if (!res.ok) throw new Error(`The calendar link replied ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link didn't return a calendar (.ics) file");

  const from = new Date(now.getTime() - 86400000);
  const to = new Date(now.getTime() + 150 * 86400000);
  const occ = filterOccurrences(icsOccurrences(text, from, to, tz), feed.type, feed.skip || []);
  const existing = must(await db.from('items').select('*').eq('source', feed.id));
  const byKey = new Map(existing.map((i) => [i.source_uid, i]));
  const seen = new Set();
  const rows = [];
  const toPlan = [];
  let added = 0;

  for (const o of occ) {
    const tags = [...new Set([feed.tag, o.moduleTag].filter(Boolean))];
    const ex = byKey.get(o.key);
    if (feed.type === 'timetable') {
      if (o.allDay) continue; // holidays, reading weeks: not busy blocks
      seen.add(o.key);
      if (!ex) added++;
      rows.push(fullRow({
        ...(ex || {}), id: ex?.id, kind: 'event', title: o.title, body: o.location || o.body.split('\n')[0] || '',
        tags, remind_at: o.start.toISOString(), ends_at: o.end.toISOString(),
        lead_minutes: feed.lead_minutes, busy: feed.busy, source: feed.id, source_uid: o.key, meta: ex?.meta || {},
      }));
    } else {
      seen.add(o.key);
      const due = o.allDay ? zonedToUtc(...(() => { const p = partsInTz(o.start, tz); return [p.y, p.m, p.d]; })(), 23, 59, tz) : o.start;
      if (ex) {
        const moved = ex.due_at !== due.toISOString();
        if (!moved && ex.title === o.title && ex.body === o.body) continue; // nothing changed; keep your edits
        rows.push(fullRow({
          ...ex, title: o.title, body: o.body, due_at: due.toISOString(),
          remind_at: moved && !ex.done_at ? deadlineReminder(due, now, tz, settings.default_hour).toISOString() : ex.remind_at,
          last_nagged_at: moved ? null : ex.last_nagged_at,
        }));
      } else {
        if (due <= now) continue; // already past: don't add old deadlines
        const id = crypto.randomUUID();
        added++;
        rows.push(fullRow({
          id, kind: 'task', title: o.title, body: o.body, tags, due_at: due.toISOString(),
          remind_at: deadlineReminder(due, now, tz, settings.default_hour).toISOString(),
          source: feed.id, source_uid: o.key,
        }));
        // big pieces of work get check-ins; quick quizzes just get the reminder the morning before
        if (feed.auto_plan && o.kind !== 'test' && due - now > 7 * 86400000) toPlan.push({ id, title: o.title, tags, due_at: due.toISOString() });
      }
    }
  }
  if (rows.length) must(await db.from('items').upsert(rows));
  for (const p of toPlan) await createMilestones(p, settings, now);

  // Remove what's gone from the calendar (but keep finished deadlines as history)
  let removed = 0;
  for (const ex of existing) {
    if (seen.has(ex.source_uid)) continue;
    const gone = ex.kind === 'event' || (!ex.done_at && (!ex.due_at || Date.parse(ex.due_at) > now.getTime() || Date.parse(ex.due_at) < now.getTime() - 7 * 86400000));
    if (!gone) continue;
    await db.from('items').delete().eq('parent_id', ex.id);
    await db.from('items').delete().eq('id', ex.id);
    removed++;
  }
  return { found: occ.length, added, updated: rows.length - added, removed };
}

async function runFeedSync(feedId, now = new Date()) {
  const settings = await getSettings();
  const feeds = (await getConfig('feeds')) || [];
  const feed = feeds.find((f) => f.id === feedId);
  if (!feed) throw new HttpError(404, 'That calendar was removed');
  let result;
  try {
    result = await syncFeed(feed, settings, now);
    feed.last_error = null;
    feed.count = result.found;
  } catch (e) {
    feed.last_error = e.message || String(e);
    result = { error: feed.last_error };
  }
  feed.last_sync = now.toISOString();
  const latest = (await getConfig('feeds')) || [];
  await setConfig('feeds', latest.map((f) => (f.id === feed.id ? { ...f, last_sync: feed.last_sync, last_error: feed.last_error, count: feed.count } : f)));
  return { feed, result };
}

/* ------------------------------------------------------------------ */
/* Your calendar feed (Focus → Apple Calendar / Outlook)               */
/* ------------------------------------------------------------------ */

const RRULE = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY' };

function localStamp(d, tz) {
  const p = partsInTz(new Date(d), tz);
  const z = (n) => String(n).padStart(2, '0');
  return `${p.y}${z(p.m)}${z(p.d)}T${z(p.h)}${z(p.mi)}00`;
}

function fold(line) {
  if (line.length <= 74) return line;
  let out = line.slice(0, 74);
  for (let i = 74; i < line.length; i += 73) out += '\r\n ' + line.slice(i, i + 73);
  return out;
}

async function buildIcs() {
  const settings = await getSettings();
  const tz = settings.tz;
  const now = new Date();
  const items = await allItems();
  const stamp = icsStamp(now);
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Focus//Focus app//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Focus', `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const ev = (uid, startLine, endLine, summary, body, rrule) => {
    L.push('BEGIN:VEVENT', `UID:${uid}@focus`, `DTSTAMP:${stamp}`, startLine, endLine, `SUMMARY:${icsEscape(summary)}`);
    if (body) L.push(`DESCRIPTION:${icsEscape(body)}`);
    if (rrule) L.push(`RRULE:${rrule}`);
    L.push('END:VEVENT');
  };
  const timed = (i, start, end, summary) => {
    const rr = i.repeat ? RRULE[i.repeat] : null;
    if (rr) ev(i.id, `DTSTART;TZID=${tz}:${localStamp(start, tz)}`, `DTEND;TZID=${tz}:${localStamp(end, tz)}`, summary, i.body, rr);
    else ev(i.id, `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`, summary, i.body);
  };
  for (const i of items) {
    if (i.source) continue; // it's already in the calendar it came from
    if (i.kind === 'event' && i.remind_at) {
      timed(i, i.remind_at, i.ends_at || new Date(Date.parse(i.remind_at) + 3600000), i.title);
    } else if (i.kind === 'task' && !i.done_at && (i.due_at || i.remind_at)) {
      const start = i.due_at || i.remind_at;
      timed(i, start, new Date(Date.parse(start) + 15 * 60000), (i.due_at ? 'Due: ' : '') + i.title);
    } else if (i.kind === 'person' && i.birthday) {
      const b = birthdayInfo(i.birthday, now, tz);
      const z = (n) => String(n).padStart(2, '0');
      const next = addDays(b.y, b.m, b.d, 1);
      ev(i.id, `DTSTART;VALUE=DATE:${b.y}${z(b.m)}${z(b.d)}`, `DTEND;VALUE=DATE:${next.y}${z(next.m)}${z(next.d)}`, `${i.title}'s birthday`, '', 'FREQ=YEARLY');
    }
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ */
/* The reminder clock (called every minute by cron)                    */
/* ------------------------------------------------------------------ */

async function tick() {
  const now = new Date();
  const settings = await getSettings();
  const tz = settings.tz;
  const result = { nagged: 0, headsUp: 0, digest: false, people: false, review: false, quiet: false, held: false, synced: null };

  // 1. Calendars: refresh the one that's been waiting longest (every few hours), even in quiet hours
  const feeds = (await getConfig('feeds')) || [];
  const stale = feeds
    .filter((f) => !f.last_sync || now - Date.parse(f.last_sync) > (f.last_error ? 1 : FEED_REFRESH_HOURS) * 3600000)
    .sort((a, b) => Date.parse(a.last_sync || 0) - Date.parse(b.last_sync || 0))[0];
  if (stale) result.synced = (await runFeedSync(stale.id, now)).result;

  const items = await allItems();
  const tasks = items.filter((i) => i.kind === 'task' && !i.done_at);
  const events = items.filter((i) => i.kind === 'event');
  const people = items.filter((i) => i.kind === 'person');

  // 2. Tidy events: finished one-offs go after two days; repeating ones move to their next time
  for (const e of events) {
    const o = eventOccurrence(e, now, tz);
    if (!o && !e.repeat && Date.parse(e.ends_at || e.remind_at) < now - 2 * 86400000) await db.from('items').delete().eq('id', e.id);
    else if (o && e.repeat && Date.parse(e.remind_at) !== o.start.getTime() && Date.parse(e.ends_at || e.remind_at) < now.getTime()) {
      await updateItem(e.id, { remind_at: o.start.toISOString(), ends_at: o.end.toISOString() });
    }
  }

  if (inQuietHours(now, settings)) { result.quiet = true; return result; }

  // 3. Heads-ups before lectures, shifts and plans
  for (const e of events) {
    const o = eventOccurrence(e, now, tz);
    const lead = e.lead_minutes ?? settings.heads_up_minutes;
    if (!o || !lead) continue;
    const startIso = o.start.toISOString();
    if (o.start - now > lead * 60000 || now - o.start > 5 * 60000 || e.meta?.notified_start === startIso) continue;
    const mins = Math.max(0, Math.round((o.start - now) / 60000));
    await sendToAll({
      type: 'event', title: `${e.title} at ${formatClock(o.start, tz)}`,
      body: [mins ? `In ${mins} min` : 'Starting now', e.body?.split('\n')[0]].filter(Boolean).join(' · '),
      tag: 'event-' + e.id, url: './',
    }, { ttl: 1800 });
    await updateItem(e.id, { meta: { ...(e.meta || {}), notified_start: startIso } });
    result.headsUp++;
  }

  // 4. Nags — held while a lecture or shift is on, then they come through afterwards
  const busy = settings.hold_during_busy && busyNow(events, now, tz);
  const overdue = tasks.filter((t) => t.remind_at && effectiveDue(t) <= now);
  if (busy) result.held = true;
  else {
    const due = tasks.filter((t) => shouldNag(t, now, settings))
      .sort((a, b) => Number(b.priority) - Number(a.priority) || effectiveDue(a) - effectiveDue(b));
    const mark = (t) => updateItem(t.id, { last_nagged_at: now.toISOString(), nag_count: (t.nag_count || 0) + 1 });
    if (due.length > 3) {
      await sendToAll({
        type: 'batch', title: `${due.length} tasks need you`,
        body: due.slice(0, 5).map((t) => '• ' + t.title).join('\n'),
        tag: 'focus-batch', url: './', badge: overdue.length,
      });
      await Promise.all(due.map(mark));
    } else {
      for (const t of due) {
        const n = (t.nag_count || 0) + 1;
        const late = now - effectiveDue(t);
        const when = t.due_at ? `Due ${formatWhen(new Date(t.due_at), { now, tz })}` : late < 120000 ? 'Due now' : `${formatSpan(late)} overdue`;
        const note = (t.body || '').split('\n')[0].slice(0, 80);
        await sendToAll({
          type: 'nag', id: t.id,
          title: (t.priority ? '❗ ' : '') + t.title,
          body: [n > 1 ? `${when} · reminder ${n}` : when, note].filter(Boolean).join(' · '),
          tag: 'task-' + t.id, url: './?task=' + t.id, badge: overdue.length,
        });
        await mark(t);
      }
    }
    result.nagged = due.length;
  }

  const p = partsInTz(now, tz);
  const endOfToday = zonedToUtc(p.y, p.m, p.d, 23, 59, tz);

  // 5. Morning summary
  const digestKey = digestDue(now, settings, await getConfig('last_digest'));
  if (digestKey) {
    await setConfig('last_digest', digestKey);
    const schedule = events.map((e) => [e, eventOccurrence(e, now, tz)])
      .filter(([, o]) => o && o.start <= endOfToday).sort((a, b) => a[1].start - b[1].start);
    const stars = tasks.filter((t) => isStarToday(t, now, tz));
    const today = tasks.filter((t) => !stars.includes(t) && t.remind_at && effectiveDue(t) <= endOfToday)
      .sort((a, b) => effectiveDue(a) - effectiveDue(b));
    const bdays = people.filter((x) => birthdayInfo(x.birthday, now, tz)?.daysUntil === 0);
    const lines = [];
    if (schedule.length) lines.push('🗓 ' + schedule.slice(0, 4).map(([e, o]) => `${formatClock(o.start, tz)} ${e.title}`).join(', '));
    for (const t of [...stars, ...today].slice(0, 5)) {
      const d = effectiveDue(t);
      lines.push(`${stars.includes(t) ? '★' : '•'} ${t.title}${d ? ` (${d <= now ? 'overdue' : formatClock(d, tz)})` : ''}`);
    }
    for (const b of bdays) lines.push(`🎂 ${b.title}'s birthday today`);
    if (!stars.length && tasks.length) lines.push('Pick your 3 for today');
    if (lines.length) {
      await sendToAll({
        type: 'digest',
        title: stars.length ? 'Your 3 for today' : today.length ? `${today.length} for today` : 'Good morning',
        body: lines.join('\n'), tag: 'focus-digest', url: './', badge: overdue.length,
      }, { ttl: 6 * 3600 });
      result.digest = true;
    }
  }

  // 6. People: catch-ups that are due, and birthdays coming up
  const peopleKey = dailyDue(now, settings, settings.people_time, await getConfig('last_people'));
  if (peopleKey) {
    await setConfig('last_people', peopleKey);
    const catchUp = people.map((x) => [x, checkinStatus(x, now)]).filter(([, c]) => c?.due).sort((a, b) => b[1].daysSince - a[1].daysSince);
    const soon = people.map((x) => [x, birthdayInfo(x.birthday, now, tz)]).filter(([, b]) => b && (b.daysUntil === 1 || b.daysUntil === 3));
    const lines = [
      ...soon.map(([x, b]) => `🎂 ${x.title}'s birthday ${b.daysUntil === 1 ? 'tomorrow' : 'in 3 days'}${b.turning ? ` (${b.turning})` : ''}`),
      ...catchUp.slice(0, 4).map(([x, c]) => `• ${x.title}: ${c.daysSince} days since you were in touch`),
    ];
    if (lines.length) {
      await sendToAll({
        type: 'people', title: soon.length && !catchUp.length ? 'Birthday coming up' : 'Time to catch up',
        body: lines.join('\n'), tag: 'focus-people', url: './?view=people',
      }, { ttl: 6 * 3600 });
      result.people = true;
    }
  }

  // 7. Weekly review
  const reviewKey = reviewDue(now, settings, await getConfig('last_review'));
  if (reviewKey) {
    await setConfig('last_review', reviewKey);
    const weekEnd = new Date(now.getTime() + 7 * 86400000);
    const thisWeek = tasks.filter((t) => { const d = t.due_at ? new Date(t.due_at) : effectiveDue(t); return d && d > now && d <= weekEnd; }).length;
    const catchUp = people.filter((x) => checkinStatus(x, now)?.due).length;
    const parts = [
      overdue.length && `${overdue.length} overdue`,
      `${thisWeek} due this week`,
      catchUp && `${catchUp} ${catchUp === 1 ? 'person' : 'people'} to catch up with`,
    ].filter(Boolean);
    await sendToAll({
      type: 'review', title: 'Your weekly review',
      body: `${parts.join(', ')}. Five minutes now makes the week easier.`,
      tag: 'focus-review', url: './?review=1',
    }, { ttl: 12 * 3600 });
    result.review = true;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const ACTIONS = {
  async ping() {
    const [settings, vapid] = await Promise.all([getSettings(), getVapid()]);
    return { settings, vapidPublicKey: vapid.publicKey, serverTime: new Date().toISOString(), version: 2 };
  },

  async list({ all = false }) {
    let items = must(await db.from('items').select('*').order('created_at', { ascending: false }));
    if (!all) {
      const cutoff = Date.now() - 30 * 86400000; // done tasks older than 30 days stay in the database but aren't sent
      items = items.filter((i) => !i.done_at || Date.parse(i.done_at) > cutoff);
    }
    return { items };
  },

  async add(b) {
    const settings = await getSettings();
    let kind = b.kind || b.type || 'task';
    let fields = {};
    if (b.text) {
      if (kind === 'info') {
        const p = parseInfo(b.text);
        fields = { title: p.title, body: p.body, tags: p.tags };
      } else if (kind === 'person') {
        const p = parsePerson(b.text);
        fields = { title: p.title, body: p.body, tags: p.tags, birthday: p.birthday, checkin_days: p.checkinDays, last_contact: new Date().toISOString() };
      } else {
        const p = parseQuick(b.text, { tz: settings.tz, defaultHour: settings.default_hour });
        if (p.isEvent) kind = 'event';
        fields = {
          title: p.title, tags: p.tags, priority: p.priority, repeat: p.repeat,
          remind_at: p.remindAt ? p.remindAt.toISOString() : null,
          due_at: p.dueAt ? p.dueAt.toISOString() : null,
          ends_at: p.endAt ? p.endAt.toISOString() : null,
          effort_minutes: p.effortMinutes,
        };
      }
    }
    if (b.when) {
      const w = parseQuick(String(b.when), { tz: settings.tz, defaultHour: settings.default_hour });
      if (w.remindAt) fields.remind_at = w.remindAt.toISOString();
      if (w.repeat) fields.repeat = w.repeat;
    }
    const explicit = clean(b, { creating: true });
    delete explicit.kind;
    if (b.tags && fields.tags) explicit.tags = [...new Set([...fields.tags, ...explicit.tags])];
    const row = clean({ kind, ...fields, ...explicit }, { creating: true });
    if (!row.title) throw new HttpError(400, 'Nothing to add — send "text" or "title"');
    const item = must(await db.from('items').upsert(row).select('*').single());
    const label = { info: 'Saved', person: 'Added person', event: 'Added to your schedule' }[item.kind] || 'Added';
    return { item, message: `${label}: ${describe(item, settings)}` };
  },

  async update({ id, patch = {} }) {
    if (!id) throw new HttpError(400, 'id is needed');
    const p = clean(patch);
    if ('remind_at' in p) { p.last_nagged_at = null; p.nag_count = 0; if (!('snoozed_until' in p)) p.snoozed_until = null; }
    if ('remind_at' in p || 'ends_at' in p) p.meta = { ...(p.meta || (await getItem(id)).meta || {}), notified_start: null };
    return { item: await updateItem(id, p) };
  },

  async complete({ id, match }) {
    const settings = await getSettings();
    let item;
    if (id) item = await getItem(id);
    else {
      item = bestMatch(await openTasks(), match);
      if (!item) return { item: null, message: `Couldn't find an open task matching "${match ?? ''}"` };
    }
    item = await updateItem(item.id, completePatch(item, new Date(), settings.tz));
    if (item.done_at) {
      // finishing a deadline finishes its check-ins too
      must(await db.from('items').update({ done_at: item.done_at }).eq('parent_id', item.id).is('done_at', null));
    }
    const message = item.done_at
      ? `Done: ${item.title} ✓`
      : `Done for now: ${item.title} — next ${formatWhen(new Date(item.remind_at), { tz: settings.tz })}`;
    return { item, message };
  },

  async uncomplete({ id }) {
    return { item: await updateItem(id, { done_at: null, last_nagged_at: null, nag_count: 0 }) };
  },

  async snooze({ id, minutes = 60, until }) {
    const settings = await getSettings();
    const end = until ? new Date(until) : new Date(Date.now() + Number(minutes) * 60000);
    if (isNaN(end)) throw new HttpError(400, 'Bad snooze time');
    const item = await updateItem(id, { snoozed_until: end.toISOString(), last_nagged_at: null });
    return { item, message: `Snoozed until ${formatWhen(end, { tz: settings.tz })}` };
  },

  async delete({ id }) {
    must(await db.from('items').delete().eq('parent_id', id));
    must(await db.from('items').delete().eq('id', id));
    return { deleted: id };
  },

  /** Star a task as one of today's 3 (on: false to unstar). */
  async star({ id, match, on = true }) {
    const settings = await getSettings();
    const tasks = await openTasks();
    const item = id ? await getItem(id) : bestMatch(tasks, match);
    if (!item) return { item: null, message: `Couldn't find an open task matching "${match ?? ''}"` };
    const key = todayKey(new Date(), settings.tz);
    if (on && item.star_date !== key && tasks.filter((t) => t.star_date === key).length >= 3) {
      return { item, message: "You've already got 3 for today. Finish or unstar one first." };
    }
    const updated = await updateItem(item.id, { star_date: on ? key : null });
    return { item: updated, message: on ? `★ ${updated.title} is one of today's 3` : `Unstarred ${updated.title}` };
  },

  /** Break a deadline into check-ins. */
  async plan({ id }) {
    const settings = await getSettings();
    const parent = await getItem(id);
    const kids = must(await db.from('items').select('*').eq('parent_id', id));
    if (kids.length) return { items: kids, message: 'Already planned' };
    const items = await createMilestones(parent, settings);
    return { items, message: items.length ? `Planned ${items.length} check-ins before ${parent.title}` : 'Too close to the deadline to split up' };
  },

  /** For Siri / Shortcuts: your day in one message. */
  async today() {
    const settings = await getSettings();
    const tz = settings.tz;
    const now = new Date();
    const p = partsInTz(now, tz);
    const eod = zonedToUtc(p.y, p.m, p.d, 23, 59, tz);
    const items = await allItems();
    const tasks = items.filter((i) => i.kind === 'task' && !i.done_at);
    const schedule = items.filter((i) => i.kind === 'event').map((e) => [e, eventOccurrence(e, now, tz)])
      .filter(([, o]) => o && o.start <= eod).sort((a, b) => a[1].start - b[1].start);
    const stars = tasks.filter((t) => isStarToday(t, now, tz));
    const due = tasks.filter((t) => !stars.includes(t) && t.remind_at && effectiveDue(t) <= eod);
    const bdays = items.filter((i) => i.kind === 'person' && birthdayInfo(i.birthday, now, tz)?.daysUntil === 0);
    const lines = [];
    if (schedule.length) lines.push('On today: ' + schedule.map(([e, o]) => `${formatClock(o.start, tz)} ${e.title}`).join(', '));
    if (stars.length) lines.push("Today's 3: " + stars.map((t) => t.title).join(', '));
    if (due.length) lines.push('Also due: ' + due.map((t) => t.title).join(', '));
    if (bdays.length) lines.push('Birthdays: ' + bdays.map((b) => b.title).join(', '));
    return { schedule: schedule.map(([e, o]) => ({ ...e, start: o.start, end: o.end })), stars, due, message: lines.join('\n') || 'A clear day. Nothing scheduled or due.' };
  },

  /** For Siri / Shortcuts: "I've got 15 minutes" */
  async free({ minutes = 15 }) {
    const settings = await getSettings();
    const now = new Date();
    const mins = Math.max(1, parseInt(minutes, 10) || 15);
    const fit = (await openTasks()).filter((t) => fitsIn(t, mins));
    const rank = (t) => [isStarToday(t, now, settings.tz) ? 0 : 1, t.remind_at && effectiveDue(t) <= now ? 0 : 1, t.priority ? 0 : 1, t.due_at ? Date.parse(t.due_at) : Infinity];
    fit.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
    const top = fit.slice(0, 3);
    return {
      tasks: top,
      message: top.length
        ? `In ${formatMinutes(mins)} you could:\n` + top.map((t) => `• ${t.title} (~${formatMinutes(t.effort_minutes)})`).join('\n')
        : 'Nothing that short on your list. Add ~15m to quick tasks and they\'ll show up here.',
    };
  },

  /** For Siri / Shortcuts: who to catch up with, and birthdays this week. */
  async catchup() {
    const settings = await getSettings();
    const now = new Date();
    const people = must(await db.from('items').select('*').eq('kind', 'person'));
    const due = people.map((x) => [x, checkinStatus(x, now)]).filter(([, c]) => c?.due).sort((a, b) => b[1].daysSince - a[1].daysSince);
    const bdays = people.map((x) => [x, birthdayInfo(x.birthday, now, settings.tz)]).filter(([, b]) => b && b.daysUntil <= 7).sort((a, b) => a[1].daysUntil - b[1].daysUntil);
    const lines = [
      ...bdays.map(([x, b]) => `🎂 ${x.title}: ${b.daysUntil === 0 ? 'today' : b.daysUntil === 1 ? 'tomorrow' : `in ${b.daysUntil} days`}`),
      ...due.map(([x, c]) => `• ${x.title} (${c.daysSince} days)`),
    ];
    return { people: due.map(([x]) => x), message: lines.join('\n') || "You're up to date with everyone." };
  },

  /** For Siri / Shortcuts: "I talked to Mam" */
  async contacted({ id, match }) {
    const people = must(await db.from('items').select('*').eq('kind', 'person'));
    const person = id ? people.find((x) => x.id === id) : bestMatch(people, match);
    if (!person) return { item: null, message: `Couldn't find "${match ?? ''}" in your people` };
    const item = await updateItem(person.id, { last_contact: new Date().toISOString() });
    return { item, message: `Noted: you were in touch with ${item.title}` };
  },

  /** For Siri / Shortcuts: what's due today (or everything with scope "all"). */
  async due({ scope = 'today', tag }) {
    const settings = await getSettings();
    const now = new Date();
    const p = partsInTz(now, settings.tz);
    const end = zonedToUtc(p.y, p.m, p.d, 23, 59, settings.tz);
    const tasks = (await openTasks())
      .filter((t) => scope === 'all' || (t.remind_at && effectiveDue(t) <= end))
      .filter((t) => !tag || (t.tags || []).includes(String(tag).replace(/^#/, '').toLowerCase()))
      .sort((a, b) => (effectiveDue(a) ?? Infinity) - (effectiveDue(b) ?? Infinity));
    const lines = tasks.map((t) => {
      const d = effectiveDue(t);
      const when = !d ? '' : d <= now ? ' (overdue)' : ` (${formatWhen(d, { now, tz: settings.tz })})`;
      return `• ${t.title}${when}`;
    });
    const head = tasks.length
      ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}${scope === 'all' ? ' open' : ' for today'}:`
      : scope === 'all' ? 'Your list is empty.' : 'Nothing due today.';
    return { tasks, count: tasks.length, message: [head, ...lines].join('\n') };
  },

  /** For Siri / Shortcuts: "what's my locker code?" */
  async search({ q = '' }) {
    const s = String(q).toLowerCase().trim();
    const stop = ['my', 'the', 'what', 'whats', "what's", 'is', 'for', 'when', 'where'];
    const words = s.split(/\s+/).filter((w) => w.length > 1 && !stop.includes(w));
    const items = await allItems();
    const hits = items
      .filter((i) => !i.done_at)
      .map((i) => {
        const hay = `${i.title} ${i.body} ${(i.tags || []).join(' ')}`.toLowerCase();
        return [words.filter((w) => hay.includes(w)).length, i];
      })
      .filter(([n]) => n > 0)
      .sort((a, b) => b[0] - a[0] || (a[1].kind === 'info' ? -1 : 1))
      .slice(0, 5)
      .map(([, i]) => i);
    const message = hits.length
      ? hits.map((i) => (i.body ? `${i.title}: ${i.body}` : i.title)).join('\n')
      : `Nothing found for "${q}"`;
    return { items: hits, message };
  },

  async subscribe({ subscription, device }) {
    if (!subscription?.endpoint) throw new HttpError(400, 'subscription is needed');
    must(await db.from('push_subs').upsert({ endpoint: subscription.endpoint, subscription, device: device || null }));
    return { message: 'Notifications are on for this device' };
  },

  async unsubscribe({ endpoint }) {
    must(await db.from('push_subs').delete().eq('endpoint', endpoint));
    return {};
  },

  async devices() {
    return { devices: must(await db.from('push_subs').select('endpoint, device, created_at')) };
  },

  async settings({ patch }) {
    if (patch && typeof patch === 'object') {
      const current = await getSettings();
      const next = { ...current };
      for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(k in patch)) continue;
        const v = patch[k];
        if (typeof def === 'number') next[k] = Number.isFinite(+v) ? +v : def;
        else if (typeof def === 'boolean') next[k] = v === true || v === 'true';
        else next[k] = String(v ?? '');
      }
      try { partsInTz(new Date(), next.tz); } catch { throw new HttpError(400, 'Unknown time zone'); }
      for (const k of ['quiet_start', 'quiet_end', 'digest_time', 'people_time', 'review_time']) {
        if (next[k] && !/^\d{1,2}:\d{2}$/.test(next[k])) throw new HttpError(400, `${k} should look like 08:30`);
      }
      next.default_nag_minutes = Math.max(0, Math.min(1440, Math.round(next.default_nag_minutes)));
      next.heads_up_minutes = Math.max(0, Math.min(240, Math.round(next.heads_up_minutes)));
      next.default_hour = Math.max(0, Math.min(23, Math.round(next.default_hour)));
      next.review_day = Math.max(0, Math.min(6, Math.round(next.review_day)));
      await setConfig('settings', Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, next[k]])));
    }
    return { settings: await getSettings() };
  },

  async test() {
    const r = await sendToAll({ type: 'test', title: 'Focus is connected 🎯', body: 'Reminders will arrive like this.', tag: 'focus-test', url: './' });
    return { ...r, message: r.devices ? `Sent to ${r.sent} of ${r.devices} device(s)` : 'No devices have notifications turned on yet' };
  },

  /* --- Calendars --- */

  async feeds() {
    return { feeds: (await getConfig('feeds')) || [] };
  },

  async feed_save({ feed = {} }) {
    const feeds = (await getConfig('feeds')) || [];
    const existing = feeds.find((f) => f.id === feed.id) || {};
    const clean = cleanFeed(feed, existing);
    if (feeds.some((f) => f.url === clean.url && f.id !== clean.id)) throw new HttpError(400, "You've already added that calendar");
    await setConfig('feeds', existing.id ? feeds.map((f) => (f.id === clean.id ? clean : f)) : [...feeds, clean]);
    const r = await runFeedSync(clean.id);
    return { ...r, message: r.result.error ? `Saved, but syncing failed: ${r.result.error}` : `Synced ${clean.name}: ${r.result.found} items` };
  },

  async feed_delete({ id }) {
    const feeds = (await getConfig('feeds')) || [];
    await setConfig('feeds', feeds.filter((f) => f.id !== id));
    const items = must(await db.from('items').select('id').eq('source', id));
    for (const i of items) {
      await db.from('items').delete().eq('parent_id', i.id);
      await db.from('items').delete().eq('id', i.id);
    }
    return { removed: items.length };
  },

  async feed_sync({ id }) {
    const feeds = (await getConfig('feeds')) || [];
    const targets = id ? feeds.filter((f) => f.id === id) : feeds;
    const results = [];
    for (const f of targets) results.push(await runFeedSync(f.id));
    return { results, feeds: (await getConfig('feeds')) || [] };
  },

  /** The read-only token for subscribing to Focus in your calendar app. */
  async calendar() {
    return { token: await calendarToken() };
  },

  /* --- Backups --- */

  async import({ items = [] }) {
    if (!Array.isArray(items)) throw new HttpError(400, 'items must be a list');
    const rows = items.map((i) => {
      const r = clean(i, { creating: true });
      if (!r.title) return null;
      return fullRow({ ...r, source: i.source ?? null, source_uid: i.source_uid ?? null, created_at: i.created_at ? new Date(i.created_at).toISOString() : undefined });
    }).filter(Boolean);
    // parents before their check-ins
    rows.sort((a, b) => Number(!!a.parent_id) - Number(!!b.parent_id));
    if (rows.length) must(await db.from('items').upsert(rows));
    return { imported: rows.length };
  },

  async export() {
    return { items: must(await db.from('items').select('*').order('created_at')), exportedAt: new Date().toISOString() };
  },

  tick,
};

/* ------------------------------------------------------------------ */
/* HTTP entry point                                                    */
/* ------------------------------------------------------------------ */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!FOCUS_KEY) throw new HttpError(500, 'The FOCUS_KEY secret is not set (Supabase → Edge Functions → Secrets)');
    const params = new URL(req.url).searchParams;

    // Calendar apps fetch your feed with a plain GET and a read-only token
    if (params.get('action') === 'ics') {
      if (!safeEqual(params.get('token') || '', await calendarToken())) return new Response('Not found', { status: 404 });
      return new Response(await buildIcs(), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=900' } });
    }

    let body = {};
    if (req.method === 'POST') {
      const text = await req.text();
      try { body = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'Body must be JSON'); }
    }
    for (const [k, v] of params) if (!(k in body) && k !== 'key') body[k] = v;
    const key = req.headers.get('x-focus-key') || body.key || '';
    if (!safeEqual(key, FOCUS_KEY)) throw new HttpError(401, 'Wrong or missing key');
    const action = body.action || 'ping';
    const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
    if (!run) throw new HttpError(400, `Unknown action "${action}"`);
    return json({ ok: true, ...(await run(body)) });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    return json({ ok: false, error: e.message || String(e), message: e.message || String(e) }, status);
  }
});
