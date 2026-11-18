// shared.js — logic shared by the web app AND the Supabase edge function.
//
// No imports, no browser- or Deno-specific APIs, so it runs in both places.
// The edge function has a copy of this file pasted between its
// "BEGIN SHARED" / "END SHARED" markers (with the `export ` keywords removed).
// If you change anything here, update that copy too (see README → "Changing the parser").

export const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];
export const DEFAULT_SETTINGS = {
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
export const KINDS = ['task', 'info', 'person', 'event'];

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
export function partsInTz(date, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(date)) o[p.type] = p.value;
  return {
    y: +o.year, m: +o.month, d: +o.day,
    h: +o.hour % 24, mi: +o.minute, s: +o.second,
    wd: WD_KEYS.indexOf(o.weekday.toLowerCase().slice(0, 3)),
  };
}

/** The instant when the wall clock in `tz` reads y-m-d h:mi. Handles daylight saving. */
export function zonedToUtc(y, m, d, h, mi, tz) {
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
export function addDays(y, m, d, n) {
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
export function parseQuick(input, opts = {}) {
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
export function parseInfo(input) {
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

export function repeatLabel(r) {
  return { daily: 'every day', weekdays: 'every weekday', weekly: 'every week', monthly: 'every month' }[r] || '';
}

/** Next time a repeating task comes round, strictly after `after`. */
export function nextOccurrence(from, repeat, tz, after = new Date()) {
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
export function completePatch(item, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  if (item.repeat && item.remind_at) {
    const next = nextOccurrence(item.remind_at, item.repeat, tz, now);
    return { remind_at: next.toISOString(), done_at: null, snoozed_until: null, last_nagged_at: null, nag_count: 0 };
  }
  return { done_at: now.toISOString(), snoozed_until: null };
}

/** When the task next wants your attention (its time, or the end of a snooze). */
export function effectiveDue(item) {
  if (!item.remind_at) return null;
  const due = Date.parse(item.remind_at);
  const snooze = item.snoozed_until ? Date.parse(item.snoozed_until) : 0;
  return new Date(Math.max(due, snooze));
}

/** Should this task send a notification right now? */
export function shouldNag(item, now, settings = DEFAULT_SETTINGS) {
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

export function inQuietHours(now, settings = DEFAULT_SETTINGS) {
  const start = minutesOf(settings.quiet_start), end = minutesOf(settings.quiet_end);
  if (start === null || end === null || start === end) return false;
  const p = partsInTz(now, settings.tz || DEFAULT_SETTINGS.tz);
  const cur = p.h * 60 + p.mi;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Once-a-day jobs: returns today's key when it's time and it hasn't run yet today. */
export function dailyDue(now, settings, hhmm, lastKey) {
  const at = minutesOf(hhmm);
  if (at === null) return false;
  const p = partsInTz(now, settings.tz || DEFAULT_SETTINGS.tz);
  const key = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  return lastKey !== key && p.h * 60 + p.mi >= at && !inQuietHours(now, settings) ? key : false;
}

/** Is it time for today's morning summary? */
export function digestDue(now, settings, lastDigestDate) {
  return dailyDue(now, settings, settings.digest_time, lastDigestDate);
}

/** Is it time for the weekly review (on review_day at review_time)? */
export function reviewDue(now, settings, lastKey) {
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
export function formatWhen(date, { now = new Date(), tz = DEFAULT_SETTINGS.tz } = {}) {
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
export function formatClock(date, tz = DEFAULT_SETTINGS.tz) {
  const p = partsInTz(new Date(date), tz);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

/** 15 → "15 min", 60 → "1 hour", 90 → "1.5 hours" */
export function formatMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.round((min / 60) * 10) / 10;
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/** "5 min", "2 h", "3 days" */
export function formatSpan(ms) {
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
export function todayKey(now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  const p = partsInTz(now, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function isStarToday(item, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
  return item.kind === 'task' && !item.done_at && item.star_date === todayKey(now, tz);
}

/** When to start reminding about a deadline: the morning before, or 3 hours before if that's too late. */
export function deadlineReminder(due, now = new Date(), tz = DEFAULT_SETTINGS.tz, defaultHour = DEFAULT_SETTINGS.default_hour) {
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
export function planMilestones(due, now = new Date(), tz = DEFAULT_SETTINGS.tz, defaultHour = DEFAULT_SETTINGS.default_hour) {
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
export function fitsIn(item, minutes) {
  return item.kind === 'task' && !item.done_at && item.effort_minutes > 0 && item.effort_minutes <= minutes;
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

/** "Aoife bday 14/3 every 2 weeks: exam Thursday #friends" */
export function parsePerson(input) {
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
export function birthdayInfo(birthday, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
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
export function checkinStatus(person, now = new Date()) {
  if (!person.checkin_days) return null;
  const last = Date.parse(person.last_contact || person.created_at || now.toISOString());
  const daysSince = Math.floor((now - last) / 86400000);
  return { due: daysSince >= person.checkin_days, daysSince };
}

/* ------------------------------------------------------------------ */
/* Events (lectures, shifts, plans)                                    */
/* ------------------------------------------------------------------ */

/** The current or next occurrence of an event: { start, end }, or null once it's over. */
export function eventOccurrence(item, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
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
export function busyNow(items, now = new Date(), tz = DEFAULT_SETTINGS.tz) {
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
export function parseICS(text) {
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
export function icsTime(v, fallbackTz = DEFAULT_SETTINGS.tz) {
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
export function expandEvent(ev, from, to, fallbackTz = DEFAULT_SETTINGS.tz) {
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
export function stripHtml(s) {
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
export function icsOccurrences(text, from, to, fallbackTz = DEFAULT_SETTINGS.tz) {
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
export function cleanEventTitle(t) {
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
export function filterOccurrences(occ, type, skip = []) {
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
export function isCourseContent(o) {
  const where = `${o.url || ''} ${o.body || ''}`;
  if (/\/(?:dropbox|quizzing|quiz|assign|assignment|discussions?|forum)\b/i.test(where)) return false;
  return /\/d2l\/le\/content\/|\/mod\/(?:resource|page|folder|url|book)\b|^\s*units:/im.test(where);
}

/** "assignment" gets check-ins planned; a "test" just gets the reminder. */
export function deadlineKind(o) {
  const text = `${o.rawTitle || o.title} ${o.url || ''}`;
  if (/\/quizzing\/|\/quiz\b|\b(?:quiz|test|exam|mcq|midterm)\b/i.test(text)) return 'test';
  return 'assignment';
}

/** Text for a .ics file (calendar export). */
export function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
}
export function icsStamp(d) {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
