// Focus — the web app. Plain JavaScript, no build step.
//
// How data flows:
//   every change is applied on screen straight away (and saved in this browser),
//   then queued and sent to your Supabase function. If you're offline the queue
//   waits and sends itself when you're back. Without a server connected the app
//   still works, it just keeps everything on this one device.
//
// Map of this file: helpers → state → server sync → rendering (tasks, people, info)
// → actions → capture box → editor → weekly review → settings → notifications → start.

import {
  DEFAULT_SETTINGS, parseQuick, parseInfo, parsePerson, completePatch, effectiveDue,
  formatWhen, formatSpan, formatClock, formatMinutes, repeatLabel, partsInTz, zonedToUtc, addDays,
  todayKey, isStarToday, planMilestones, deadlineReminder, birthdayInfo, checkinStatus, eventOccurrence, fitsIn, reviewDue,
} from './shared.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (s, el = document) => el.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('focus.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('focus.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem('focus.' + k); } catch { /* ignore */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const URL_RX = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;
const linkify = (html) => html.replace(URL_RX, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_SETTINGS.tz;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pad2 = (n) => String(n).padStart(2, '0');
const DAY = 86400000;

const ICON = {
  tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a7 7 0 0 1 12-4.9L18 8M20 13a7 7 0 0 1-12 4.9L6 16"/><path d="M18 3.5V8h-4.5M6 20.5V16h4.5"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
  timer: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9.5 2.5h5"/></svg>',
  steps: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3M4 12h3M4 17h3M10 7h10M10 12h10M10 17h10"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z"/></svg>',
  cake: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M5 20v-7h14v7M5 16c2 1 3-1 4.7 0s2.6 1 4.6 0 3 1 4.7 0M12 13V9M12 6.5c-.8-.8-.8-1.7 0-3 .8 1.3.8 2.2 0 3z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12z"/></svg>',
  place: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  items: LS.get('items', []),
  queue: LS.get('queue', []),
  conn: LS.get('conn', null),           // { url, key } once connected
  settings: { ...DEFAULT_SETTINGS, tz: deviceTz, ...LS.get('settings', {}) },
  ui: { view: 'tasks', tag: null, fit: null, showDone: false, showWeek: false, kind: 'task', ...LS.get('ui', {}) },
  pushOn: LS.get('pushOn', false),
  feeds: LS.get('feeds', []),
  query: '',
};

const tz = () => state.settings.tz || deviceTz;
const when = (d) => formatWhen(d, { now: new Date(), tz: tz() });
const clock = (d) => formatClock(d, tz());
const byId = (id) => state.items.find((i) => i.id === id);
const childrenOf = (id) => state.items.filter((i) => i.parent_id === id);
const persist = () => LS.set('items', state.items);
const saveUi = () => LS.set('ui', state.ui);
const today = () => todayKey(new Date(), tz());
const isWide = () => window.innerWidth >= 900;

function endOfDay(offsetDays = 0) {
  const p = partsInTz(new Date(), tz());
  const d = addDays(p.y, p.m, p.d, offsetDays);
  return zonedToUtc(d.y, d.m, d.d, 23, 59, tz());
}

const FIELDS = ['id', 'kind', 'title', 'body', 'tags', 'pinned', 'priority', 'remind_at', 'repeat', 'nag_minutes',
  'snoozed_until', 'done_at', 'due_at', 'ends_at', 'busy', 'lead_minutes', 'star_date', 'effort_minutes',
  'parent_id', 'birthday', 'checkin_days', 'last_contact', 'meta'];

function newItem(fields) {
  const now = new Date().toISOString();
  return {
    id: uuid(), kind: 'task', title: '', body: '', tags: [], pinned: false, priority: false,
    remind_at: null, repeat: null, nag_minutes: null, snoozed_until: null, last_nagged_at: null,
    nag_count: 0, done_at: null, due_at: null, ends_at: null, busy: true, lead_minutes: null,
    star_date: null, effort_minutes: null, parent_id: null, birthday: null, checkin_days: null,
    last_contact: null, source: null, source_uid: null, meta: {}, created_at: now, updated_at: now, ...fields,
  };
}

/* ------------------------------------------------------------------ */
/* Talking to the server                                               */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(action, body = {}, conn = state.conn) {
  if (!conn) throw new ApiError(0, 'Not connected');
  let res;
  try {
    res = await fetch(conn.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-focus-key': conn.key },
      body: JSON.stringify({ ...body, action }),
    });
  } catch {
    throw new ApiError(0, "Can't reach the server");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !data?.ok) throw new ApiError(res.status, data?.error || `The server replied ${res.status}`);
  return data;
}

/** Apply a change to the copy on screen. Mirrors what the server does. */
function applyLocal(op, a) {
  const i = state.items.findIndex((x) => x.id === a.id);
  const it = state.items[i];
  const now = new Date();
  const stamp = { updated_at: now.toISOString() };
  switch (op) {
    case 'add':
      if (i >= 0) state.items.splice(i, 1);
      state.items.unshift(a.item);
      break;
    case 'update': {
      if (!it) break;
      const p = { ...a.patch };
      if ('remind_at' in p) {
        p.last_nagged_at = null; p.nag_count = 0;
        if (!('snoozed_until' in p)) p.snoozed_until = null;
      }
      state.items[i] = { ...it, ...p, ...stamp };
      break;
    }
    case 'complete': {
      if (!it) break;
      const done = { ...it, ...completePatch(it, now, tz()), ...stamp };
      state.items[i] = done;
      if (done.done_at) for (const c of childrenOf(it.id)) if (!c.done_at) Object.assign(c, { done_at: done.done_at });
      break;
    }
    case 'uncomplete':
      if (it) state.items[i] = { ...it, done_at: null, last_nagged_at: null, nag_count: 0, ...stamp };
      break;
    case 'snooze':
      if (it) state.items[i] = { ...it, snoozed_until: a.until, last_nagged_at: null, ...stamp };
      break;
    case 'delete':
      state.items = state.items.filter((x) => x.id !== a.id && x.parent_id !== a.id);
      break;
  }
}

function remoteArgs({ op, args }) {
  if (op === 'add') return Object.fromEntries(FIELDS.map((k) => [k, args.item[k] ?? null]).filter(([, v]) => v !== null));
  return args;
}

/** Change something: show it now, sync it in the background. */
function mutate(op, args) {
  applyLocal(op, args);
  persist();
  render();
  if (state.conn) {
    state.queue.push({ op, args, tries: 0 });
    LS.set('queue', state.queue);
    flush();
  }
}

function mergeServer(item) {
  const later = state.queue.slice(1).some((q) => q.args.id === item.id);
  if (later) return; // we've already changed it again locally
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.unshift(item);
  persist();
}

let flushing = null;
function flush() {
  if (!state.conn) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    setSync('busy');
    while (state.queue.length) {
      const q = state.queue[0];
      try {
        const r = await api(q.op, remoteArgs(q));
        if (r.item) mergeServer(r.item);
      } catch (e) {
        if (e.status === 0) return setSync('offline');
        if (e.status === 401) return setSync('error', 'Key rejected');
        if (e.status >= 500 && ++q.tries < 5) { LS.set('queue', state.queue); return setSync('error', 'Server problem'); }
        toast(`A change couldn't be saved: ${e.message}`);
      }
      state.queue.shift();
      LS.set('queue', state.queue);
    }
    setSync('ok');
    render();
  })().finally(() => { flushing = null; });
  return flushing;
}

async function refresh() {
  if (!state.conn) return setSync('local');
  await flush();
  if (state.queue.length) return;
  try {
    setSync('busy');
    const { items } = await api('list');
    if (state.queue.length || flushing) return; // something changed meanwhile; next refresh will catch up
    state.items = items;
    persist();
    render();
    setSync('ok');
  } catch (e) {
    if (e.status === 0) setSync('offline');
    else if (e.status === 401) setSync('error', 'Key rejected');
    else setSync('error', 'Server problem');
  }
}

function setSync(kind, text) {
  const el = $('#sync');
  const waiting = state.queue.length;
  const label = {
    local: 'This device only',
    busy: 'Syncing',
    ok: 'Synced',
    offline: waiting ? `Offline, ${waiting} to send` : 'Offline',
    error: text || 'Sync problem',
  }[kind];
  el.dataset.state = kind;
  $('.sync-text', el).textContent = label;
  el.title = kind === 'local' ? 'Not connected to a server. Open Settings to set up sync and reminders.' : 'Sync now';
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function visible(items) {
  const q = state.query.trim().toLowerCase();
  const tag = state.ui.tag;
  return items.filter((i) => (!tag || (i.tags || []).includes(tag))
    && (!q || `${i.title} ${i.body} ${(i.tags || []).join(' ')}`.toLowerCase().includes(q)));
}

const tagSpans = (tags) => (tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('');

function taskRow(t, now) {
  const d = effectiveDue(t);
  const overdue = !t.done_at && d && d <= now;
  const snoozed = t.snoozed_until && Date.parse(t.snoozed_until) > now;
  const starred = isStarToday(t, now, tz());
  const meta = [];
  if (t.done_at) meta.push(`<span>Done ${esc(when(new Date(t.done_at)))}</span>`);
  else {
    if (t.due_at) {
      const due = new Date(t.due_at);
      const left = due - now;
      meta.push(`<span class="${left < 0 ? 'late' : left < 2 * DAY ? 'soon' : ''}">${ICON.flag}${left < 0 ? 'Was due ' : 'Due '}${esc(when(due))}</span>`);
    }
    if (d && (!t.due_at || overdue || Math.abs(d - Date.parse(t.due_at)) > 60000)) {
      meta.push(overdue
        ? `<span class="late">${ICON.clock}${now - d < 120000 ? 'Due now' : `${formatSpan(now - d)} overdue`}</span>`
        : `<span>${ICON.clock}${snoozed ? 'Snoozed until ' : ''}${esc(when(d))}</span>`);
    }
  }
  if (t.repeat) meta.push(`<span>${ICON.repeat}${repeatLabel(t.repeat)}</span>`);
  if (t.effort_minutes) meta.push(`<span>${ICON.timer}${formatMinutes(t.effort_minutes)}</span>`);
  const kids = childrenOf(t.id);
  if (kids.length) meta.push(`<span>${ICON.steps}${kids.filter((k) => k.done_at).length} of ${kids.length} check-ins done</span>`);
  const parent = t.parent_id && byId(t.parent_id);
  if (parent) meta.push(`<span>${ICON.steps}Towards ${esc(parent.title)}</span>`);
  if (t.body) meta.push(`<span>${ICON.note}${esc(t.body.split('\n')[0].slice(0, 60))}</span>`);
  meta.push(tagSpans(t.tags));
  const cls = ['task', overdue && 'overdue', t.priority && 'priority', t.done_at && 'done', starred && 'starred'].filter(Boolean).join(' ');
  return `<li class="${cls}" data-id="${t.id}">
    <button class="check" type="button" data-act="check" aria-label="${t.done_at ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}">${ICON.tick}</button>
    <button class="task-main" type="button" data-act="open"><span class="title"><span class="hl">${esc(t.title)}</span></span><span class="meta">${meta.join('')}</span></button>
    <span class="row-actions-inline">
      ${overdue ? '<button class="quick" type="button" data-act="snooze">Snooze 1h</button>' : ''}
      ${t.done_at ? '' : `<button class="star-btn" type="button" data-act="star" aria-pressed="${starred}" aria-label="${starred ? 'Remove from' : 'Add to'} today's 3: ${esc(t.title)}" title="Today's 3">${ICON.star}</button>`}
    </span>
  </li>`;
}

function eventRow(e, o, now) {
  const on = o.start <= now && now < o.end;
  const sameDay = todayKey(o.start, tz()) === todayKey(o.end, tz());
  const meta = [`<span>${on ? `On now, until ${clock(o.end)}` : `${clock(o.start)}–${sameDay ? clock(o.end) : when(o.end)}`}</span>`];
  if (e.body) meta.push(`<span>${ICON.place}${esc(e.body.split('\n')[0].slice(0, 50))}</span>`);
  if (e.repeat) meta.push(`<span>${ICON.repeat}${repeatLabel(e.repeat)}</span>`);
  meta.push(tagSpans(e.tags));
  return `<li class="event${on ? ' now' : ''}" data-id="${e.id}">
    <span class="ev-time">${clock(o.start)}</span>
    <button class="task-main" type="button" data-act="open"><span class="title">${esc(e.title)}</span><span class="meta">${meta.join('')}</span></button>
  </li>`;
}

function group(title, rows, extra = '', button = '') {
  if (!rows.length) return '';
  return `<h3 class="group-head ${extra}">${title} <span class="n">${rows.length}</span>${button}</h3>
    <ul class="list">${rows.join('')}</ul>`;
}

function banner() {
  if (!state.conn) {
    return state.items.length
      ? `<p class="banner">Saved on this device only. <button type="button" data-act="settings">Set up sync and reminders</button></p>`
      : '';
  }
  const canPush = 'Notification' in window && Notification.permission !== 'denied';
  if (!state.pushOn && canPush && !LS.get('hidePushBanner', false)) {
    return `<p class="banner">Turn on notifications so reminders reach this ${isIOS ? 'phone' : 'computer'} even when Focus is closed.
      <button type="button" data-act="push">Turn on</button> &nbsp; <button type="button" data-act="hide-push">Not now</button></p>`;
  }
  if (reviewDue(new Date(), { ...state.settings, quiet_start: '', quiet_end: '' }, LS.get('lastReview', null))) {
    return `<p class="banner">It's review day. Five minutes to set up the week. <button type="button" data-act="review">Start your weekly review</button></p>`;
  }
  return '';
}

function renderTasks() {
  const now = new Date();
  const eod = endOfDay(0);
  const all = visible(state.items);
  const tasks = all.filter((i) => i.kind === 'task');
  const open = tasks.filter((t) => !t.done_at);

  let html = banner();

  // Today's schedule (lectures, shifts, plans)
  const occ = all.filter((i) => i.kind === 'event').map((e) => [e, eventOccurrence(e, now, tz())]).filter(([, o]) => o)
    .sort((a, b) => a[1].start - b[1].start);
  const todays = occ.filter(([, o]) => o.start <= eod);
  if (todays.length && !state.ui.fit) html += group('Today', todays.map(([e, o]) => eventRow(e, o, now)), 'schedule');

  // "Got 15 min?" view
  if (state.ui.fit) {
    const fit = open.filter((t) => fitsIn(t, state.ui.fit)).sort((a, b) =>
      Number(isStarToday(b, now, tz())) - Number(isStarToday(a, now, tz())) || Number(b.priority) - Number(a.priority)
      || (effectiveDue(a) ?? Infinity) - (effectiveDue(b) ?? Infinity));
    html += fit.length
      ? group(`Fits in ${formatMinutes(state.ui.fit)}`, fit.map((t) => taskRow(t, now)))
      : `<p class="empty">Nothing that short on your list. Add <b>~15m</b> when you type a task, or set how long it takes when you edit one.</p>`;
    $('#tasks').innerHTML = html;
    return open.filter((t) => effectiveDue(t) && effectiveDue(t) <= now).length;
  }

  const stars = open.filter((t) => isStarToday(t, now, tz()));
  const rest = open.filter((t) => !stars.includes(t));
  const g = { needs: [], today: [], later: [], anytime: [] };
  for (const t of rest) {
    const d = effectiveDue(t);
    if (!d) g.anytime.push(t);
    else if (d <= now) g.needs.push(t);
    else if (d <= eod) g.today.push(t);
    else g.later.push(t);
  }
  const byDue = (a, b) => effectiveDue(a) - effectiveDue(b);
  g.needs.sort((a, b) => Number(b.priority) - Number(a.priority) || byDue(a, b));
  g.today.sort(byDue);
  g.later.sort(byDue);
  g.anytime.sort((a, b) => Number(b.priority) - Number(a.priority) || b.created_at.localeCompare(a.created_at));
  const done = tasks.filter((t) => t.done_at).sort((a, b) => b.done_at.localeCompare(a.done_at)).slice(0, 30);

  if (stars.length) html += group("Today's 3", stars.map((t) => taskRow(t, now)), 'stars');
  else if (open.length >= 3 && !state.query && !state.ui.tag) {
    html += '<p class="hint-line">Pick up to 3 that matter most today: tap the star on a task.</p>';
  }
  if (!open.length) {
    html += state.query || state.ui.tag
      ? '<p class="empty">No open tasks match.</p>'
      : '<p class="empty">Nothing to do yet. Type above, like <b>Return library books thursday</b> or <b>Essay due 5/12 5pm</b>.</p>';
  }
  html += group('Needs you', g.needs.map((t) => taskRow(t, now)), 'needs') + group('Later today', g.today.map((t) => taskRow(t, now)))
    + group('Coming up', g.later.map((t) => taskRow(t, now))) + group('Anytime', g.anytime.map((t) => taskRow(t, now)));

  const week = occ.filter(([, o]) => o.start > eod && o.start <= endOfDay(7));
  if (week.length) {
    html += `<h3 class="group-head">Schedule this week <span class="n">${week.length}</span>
      <button type="button" data-act="toggle-week" aria-expanded="${state.ui.showWeek}">${state.ui.showWeek ? 'Hide' : 'Show'}</button></h3>`;
    if (state.ui.showWeek) {
      let lastDay = '';
      const rows = week.map(([e, o]) => {
        const day = formatWhen(o.start, { now, tz: tz() }).replace(/\s\d\d:\d\d$/, '');
        const head = day !== lastDay ? `<li class="day-sep">${esc(day.charAt(0).toUpperCase() + day.slice(1))}</li>` : '';
        lastDay = day;
        return head + eventRow(e, o, now);
      });
      html += `<ul class="list">${rows.join('')}</ul>`;
    }
  }
  if (done.length) {
    html += `<h3 class="group-head">Done <span class="n">${done.length}</span>
      <button type="button" data-act="toggle-done" aria-expanded="${state.ui.showDone}">${state.ui.showDone ? 'Hide' : 'Show'}</button></h3>`;
    if (state.ui.showDone) html += `<ul class="list">${done.map((t) => taskRow(t, now)).join('')}</ul>`;
  }
  $('#tasks').innerHTML = html;
  $('#count-tasks').textContent = state.items.filter((i) => i.kind === 'task' && !i.done_at).length || '';
  return g.needs.length + stars.filter((t) => effectiveDue(t) && effectiveDue(t) <= now).length;
}

function personRow(p, now, mode) {
  const b = birthdayInfo(p.birthday, now, tz());
  const c = checkinStatus(p, now);
  const meta = [];
  if (mode === 'catchup') meta.push(`<span class="late">${ICON.chat}${c.daysSince} days since you were in touch</span>`);
  if (b && (mode === 'bday' || b.daysUntil <= 30)) {
    const whenTxt = b.daysUntil === 0 ? 'today' : b.daysUntil === 1 ? 'tomorrow' : b.daysUntil < 7
      ? formatWhen(b.at, { now, tz: tz() }).replace(/\s\d\d:\d\d$/, '') : `in ${b.daysUntil} days`;
    meta.push(`<span class="${b.daysUntil <= 3 ? 'soon' : ''}">${ICON.cake}Birthday ${whenTxt}${b.turning ? ` (${b.turning})` : ''}</span>`);
  } else if (b) meta.push(`<span>${ICON.cake}${b.d}/${b.m}</span>`);
  if (c && mode !== 'catchup') meta.push(`<span>${ICON.chat}${c.daysSince === 0 ? 'In touch today' : `${c.daysSince} days ago`}</span>`);
  if (p.body) meta.push(`<span>${ICON.note}${esc(p.body.split('\n')[0].slice(0, 60))}</span>`);
  meta.push(tagSpans(p.tags));
  return `<li class="person" data-id="${p.id}">
    <span class="initial" aria-hidden="true">${esc(p.title.trim().charAt(0).toUpperCase())}</span>
    <button class="task-main" type="button" data-act="open"><span class="title">${esc(p.title)}</span><span class="meta">${meta.join('')}</span></button>
    ${mode === 'catchup' ? '<button class="quick" type="button" data-act="talked">Talked today</button>' : ''}
  </li>`;
}

function renderPeople() {
  const now = new Date();
  const people = visible(state.items.filter((i) => i.kind === 'person')).sort((a, b) => a.title.localeCompare(b.title));
  let html = '';
  if (!people.length) {
    html = state.query || state.ui.tag
      ? '<p class="empty">No people match.</p>'
      : '<p class="empty">Add the people you want to keep up with. Switch the box above to <b>Person</b> and type <b>Mam weekly</b> or <b>Aoife bday 14/3 every 2 weeks</b>.</p>';
  } else {
    const catchup = people.filter((p) => checkinStatus(p, now)?.due).sort((a, b) => checkinStatus(b, now).daysSince - checkinStatus(a, now).daysSince);
    const bdays = people.filter((p) => { const b = birthdayInfo(p.birthday, now, tz()); return b && b.daysUntil <= 14; })
      .sort((a, b) => birthdayInfo(a.birthday, now, tz()).daysUntil - birthdayInfo(b.birthday, now, tz()).daysUntil);
    html += group('Time to catch up', catchup.map((p) => personRow(p, now, 'catchup')), 'needs');
    html += group('Birthdays soon', bdays.filter((p) => !catchup.includes(p)).map((p) => personRow(p, now, 'bday')));
    const rest = people.filter((p) => !catchup.includes(p) && !bdays.includes(p));
    html += group(rest.length < people.length ? 'Everyone else' : 'Everyone', rest.map((p) => personRow(p, now, 'all')));
  }
  $('#people').innerHTML = html;
  $('#count-people').textContent = state.items.filter((i) => i.kind === 'person').length || '';
}

function renderInfo() {
  const items = visible(state.items.filter((i) => i.kind === 'info'))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at));
  let html;
  if (!items.length) {
    html = state.query || state.ui.tag
      ? '<p class="empty serif">No notes match.</p>'
      : '<p class="empty serif">Keep the little things here: locker codes, room numbers, a lecturer\'s office hours, links to module pages and notes. Switch the box above to <b>Info</b> and type <b>Locker code: 4821</b>.</p>';
  } else {
    html = `<ul class="list">${items.map((i) => {
      const link = (`${i.title} ${i.body}`.match(URL_RX) || [])[0];
      return `
      <li class="info-item" data-id="${i.id}">
        <span class="pin${i.pinned ? '' : ' off'}" ${i.pinned ? 'aria-label="Pinned"' : 'aria-hidden="true"'}>${ICON.pin}</span>
        <button class="info-main" type="button" data-act="open">
          <span class="info-title">${esc(i.title)}</span>
          ${i.body ? `<span class="info-body">${linkify(esc(i.body))}</span>` : ''}
          ${(i.tags || []).length ? `<span class="info-tags">${i.tags.map((t) => '#' + esc(t)).join(' ')}</span>` : ''}
        </button>
        <span class="info-actions">
          ${link ? `<a class="copy" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Open link for ${esc(i.title)}" title="Open link">${ICON.open}</a>` : ''}
          <button class="copy" type="button" data-act="copy" aria-label="Copy ${esc(i.title)}" title="Copy">${ICON.copy}</button>
        </span>
      </li>`;
    }).join('')}</ul>`;
  }
  $('#info').innerHTML = html;
  $('#count-info').textContent = state.items.filter((i) => i.kind === 'info').length || '';
}

function renderFilters() {
  const counts = new Map();
  for (const i of state.items) if (!i.done_at) for (const t of i.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  if (state.ui.tag && !counts.has(state.ui.tag)) { state.ui.tag = null; saveUi(); }
  const hasEffort = state.items.some((i) => i.kind === 'task' && !i.done_at && i.effort_minutes);
  const showFit = hasEffort && (isWide() || state.ui.view === 'tasks');
  const el = $('#tag-filter');
  if (!counts.size && !showFit) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const none = !state.ui.tag && !state.ui.fit;
  el.innerHTML = `<button type="button" data-tag="" aria-pressed="${none}">All</button>`
    + (showFit ? [15, 60].map((m) => `<button type="button" class="fit" data-fit="${m}" aria-pressed="${state.ui.fit === m}">Got ${m === 15 ? '15 min' : 'an hour'}</button>`).join('') : '')
    + [...counts.keys()].sort().map((t) => `<button type="button" data-tag="${esc(t)}" aria-pressed="${state.ui.tag === t}">#${esc(t)}</button>`).join('');
}

function render() {
  document.body.dataset.view = state.ui.view;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-pressed', String(b.dataset.view === state.ui.view));
  renderFilters();
  const needs = renderTasks();
  renderPeople();
  renderInfo();
  if ($('#review').open) renderReview();
  document.title = needs ? `(${needs}) Focus` : 'Focus';
  try {
    if (needs && navigator.setAppBadge) navigator.setAppBadge(needs);
    else if (navigator.clearAppBadge) navigator.clearAppBadge();
  } catch { /* badges not supported */ }
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, { actions = [], ms = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>` + actions.map((a, n) => `<button type="button" data-n="${n}">${esc(a.label)}</button>`).join('');
  const close = () => el.remove();
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { actions[+b.dataset.n].run(); close(); }
  });
  $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(close, ms);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const NAG_FIELDS = ['remind_at', 'done_at', 'snoozed_until', 'last_nagged_at', 'nag_count'];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

function toggleDone(id, li) {
  const it = byId(id);
  if (!it) return;
  if (it.done_at) { mutate('uncomplete', { id }); return; }
  const before = pick(it, NAG_FIELDS);
  li?.classList.add('completing');
  setTimeout(() => {
    mutate('complete', { id });
    const after = byId(id);
    const msg = after && !after.done_at ? `Done for now. Next: ${when(new Date(after.remind_at))}` : `Done: ${it.title}`;
    toast(msg, { actions: [{ label: 'Undo', run: () => mutate('update', { id, patch: before }) }] });
  }, reduceMotion || !li ? 0 : 380);
}

function snooze(id, minutes = 60) {
  const until = new Date(Date.now() + minutes * 60000);
  mutate('snooze', { id, until: until.toISOString() });
  toast(`Snoozed until ${when(until)}`);
}

function toggleStar(id) {
  const it = byId(id);
  if (!it) return;
  const now = new Date();
  if (isStarToday(it, now, tz())) { mutate('update', { id, patch: { star_date: null } }); return; }
  const count = state.items.filter((t) => isStarToday(t, now, tz())).length;
  if (count >= 3) { toast("You've got 3 for today already. Finish or unstar one first."); return; }
  mutate('update', { id, patch: { star_date: today() } });
  if (count === 2) toast("That's your 3 for today. The rest can wait.");
}

function talked(id) {
  const it = byId(id);
  if (!it) return;
  mutate('update', { id, patch: { last_contact: new Date().toISOString() } });
  toast(`Noted: in touch with ${it.title}`);
}

function planFor(id) {
  const it = byId(id);
  if (!it) return 0;
  if (childrenOf(id).length) { toast('Already planned'); return 0; }
  const due = it.due_at || it.remind_at;
  if (!due) { toast('Add a deadline first'); return 0; }
  const steps = planMilestones(new Date(due), new Date(), tz(), state.settings.default_hour);
  if (!steps.length) { toast("It's too close to split up. Just start it!"); return 0; }
  for (const s of steps) {
    const child = newItem({ kind: 'task', title: `${s.label}: ${it.title}`, tags: [...(it.tags || [])], remind_at: s.at.toISOString(), parent_id: it.id });
    mutate('add', { id: child.id, item: child });
  }
  toast(`Planned ${steps.length} check-ins: ${steps.map((s) => `${s.label.toLowerCase()} ${when(s.at)}`).join(', ')}`, { ms: 6000 });
  return steps.length;
}

function remove(id) {
  const it = byId(id);
  if (!it) return;
  const copies = [{ ...it }, ...childrenOf(id).map((c) => ({ ...c }))];
  mutate('delete', { id });
  toast(`Deleted “${it.title}”`, { actions: [{ label: 'Undo', run: () => copies.forEach((c) => mutate('add', { id: c.id, item: c })) }] });
}

async function copyItem(id) {
  const it = byId(id);
  if (!it) return;
  try {
    await navigator.clipboard.writeText(it.body || it.title);
    toast('Copied');
  } catch {
    toast("Couldn't copy here. Open the note and select the text instead.");
  }
}

/* ------------------------------------------------------------------ */
/* Quick capture                                                       */
/* ------------------------------------------------------------------ */

const capture = $('#capture');
const PLACEHOLDER = {
  task: 'Submit lab report fri 5pm #college',
  info: 'Locker code: 4821 #college',
  person: 'Aoife bday 14/3 every 2 weeks',
};

function setKind(kind) {
  state.ui.kind = kind;
  saveUi();
  for (const b of document.querySelectorAll('.kind-toggle button')) b.setAttribute('aria-checked', String(b.dataset.kind === kind));
  capture.placeholder = PLACEHOLDER[kind];
  updatePreview();
}

const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`;

function updatePreview() {
  const text = capture.value.trim();
  const el = $('#capture-preview');
  if (!text) { el.innerHTML = ''; return; }
  const chips = [];
  const kind = state.ui.kind;
  if (kind === 'task') {
    const p = parseQuick(text, { tz: tz(), defaultHour: state.settings.default_hour });
    if (p.title !== text) chips.push(`<span>${esc(p.title)}</span>`);
    if (p.isEvent && p.remindAt) chips.push(chip(`schedule: ${when(p.remindAt)}–${clock(p.endAt)}`));
    else {
      if (p.dueAt) chips.push(chip(`due ${when(p.dueAt)}`, 'alert'));
      if (p.remindAt) chips.push(chip(`${p.dueAt ? 'reminder ' : ''}${when(p.remindAt)}`, p.remindAt <= new Date() ? 'alert' : ''));
    }
    if (p.repeat) chips.push(chip(repeatLabel(p.repeat)));
    if (p.effortMinutes) chips.push(chip(`takes ${formatMinutes(p.effortMinutes)}`));
    if (p.priority) chips.push(chip('priority', 'alert'));
    for (const t of p.tags) chips.push(chip('#' + t));
  } else if (kind === 'person') {
    const p = parsePerson(text);
    chips.push(`<span>${esc(p.title)}</span>`);
    if (p.birthday) { const b = birthdayInfo(p.birthday, new Date(), tz()); chips.push(chip(`birthday ${b.d}/${b.m}`)); }
    if (p.checkinDays) chips.push(chip(`catch up every ${p.checkinDays} days`));
    if (p.body) chips.push(`<span>${esc(p.body)}</span>`);
    for (const t of p.tags) chips.push(chip('#' + t));
  } else {
    const p = parseInfo(text);
    if (p.body) chips.push(chip(p.title) + `<span>${esc(p.body)}</span>`);
    for (const t of p.tags) chips.push(chip('#' + t));
  }
  el.innerHTML = chips.join('');
}

function addFromCapture() {
  const text = capture.value.trim();
  if (!text) { capture.focus(); return; }
  const kind = state.ui.kind;
  let item;
  if (kind === 'task') {
    const p = parseQuick(text, { tz: tz(), defaultHour: state.settings.default_hour });
    item = newItem({
      kind: p.isEvent ? 'event' : 'task', title: p.title, tags: p.tags, priority: p.priority, repeat: p.repeat,
      remind_at: p.remindAt ? p.remindAt.toISOString() : null, due_at: p.dueAt ? p.dueAt.toISOString() : null,
      ends_at: p.endAt ? p.endAt.toISOString() : null, effort_minutes: p.effortMinutes,
    });
  } else if (kind === 'person') {
    const p = parsePerson(text);
    item = newItem({ kind, title: p.title, body: p.body, tags: p.tags, birthday: p.birthday, checkin_days: p.checkinDays, last_contact: new Date().toISOString() });
  } else {
    const p = parseInfo(text);
    item = newItem({ kind, title: p.title, body: p.body, tags: p.tags });
  }
  if (state.ui.tag && !item.tags.includes(state.ui.tag)) item.tags.push(state.ui.tag); // keep it visible in the filtered list
  if (!isWide()) state.ui.view = { task: 'tasks', event: 'tasks', person: 'people', info: 'info' }[item.kind];
  mutate('add', { id: item.id, item });
  capture.value = '';
  updatePreview();
  let msg = 'Added';
  if (item.kind === 'event') msg = `On your schedule: ${when(new Date(item.remind_at))}`;
  else if (item.due_at) msg = `Deadline ${when(new Date(item.due_at))}, reminder ${when(new Date(item.remind_at))}`;
  else if (item.remind_at) msg = `Added, reminder ${when(new Date(item.remind_at))}`;
  const actions = [{ label: 'Edit', run: () => openEditor(item.id) }];
  if (item.due_at && Date.parse(item.due_at) - Date.now() > 2 * DAY) actions.unshift({ label: 'Plan check-ins', run: () => planFor(item.id) });
  toast(msg, { ms: item.due_at ? 6000 : 2800, actions });
}

$('#capture-form').addEventListener('submit', (e) => { e.preventDefault(); addFromCapture(); });
capture.addEventListener('input', updatePreview);
$('.kind-toggle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (b) { setKind(b.dataset.kind); capture.focus(); }
});

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

const ed = $('#editor');
const edForm = $('#editor-form');
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const nagShort = (m) => (+m === 0 ? 'once' : +m === 60 ? '1 hour' : +m === 120 ? '2 hours' : `${m} min`);
const parseTags = (s) => [...new Set(String(s || '').split(/[\s,]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean))];
const birthdayText = (b) => { const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(b || ''); return m ? `${+m[3]}/${+m[2]}${m[1] ? '/' + m[1] : ''}` : ''; };
function birthdayValue(s) {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?\s*$/.exec(s || '');
  if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) return null;
  return (m[3] ? m[3] + '-' : '') + `${pad2(m[2])}-${pad2(m[1])}`;
}
const setOrBlank = (sel, v) => { sel.value = v == null ? '' : String(v); if (sel.value !== (v == null ? '' : String(v))) sel.value = ''; };

function planStatus(it) {
  const kids = childrenOf(it.id);
  $('#plan-status').textContent = kids.length
    ? `Check-ins: ${kids.map((k) => `${k.title.split(':')[0]} ${when(new Date(k.remind_at))}${k.done_at ? ' (done)' : ''}`).join(', ')}`
    : '';
  $('#ed-plan').hidden = !!kids.length || !!it.done_at;
}

function openEditor(id) {
  const it = byId(id);
  if (!it) { toast('That one has been deleted'); return; }
  ed.dataset.kind = it.kind;
  ed.dataset.id = id;
  $('#editor-heading').textContent = { task: 'Task', info: 'Info', person: 'Person', event: 'On your schedule' }[it.kind];
  $('#title-label').textContent = it.kind === 'person' ? 'Name' : 'Title';
  const feed = it.source && state.feeds.find((f) => f.id === it.source);
  $('#ed-source').hidden = !it.source;
  $('#ed-source').textContent = it.source ? `From ${feed ? `your “${feed.name}” calendar` : 'a calendar you added'}. If it changes there, it updates here too.` : '';
  const f = edForm.elements;
  f.title.value = it.title;
  f.body.value = it.body || '';
  f.tags.value = (it.tags || []).join(' ');
  f.remind_at.value = toLocalInput(it.remind_at);
  f.due_at.value = toLocalInput(it.due_at);
  f.ev_start.value = toLocalInput(it.remind_at);
  f.ev_end.value = toLocalInput(it.ends_at);
  f.repeat.value = it.repeat || '';
  setOrBlank(f.nag_minutes, it.nag_minutes);
  f.nag_minutes.options[0].textContent = `Default (${nagShort(state.settings.default_nag_minutes)})`;
  setOrBlank(f.lead_minutes, it.lead_minutes);
  f.lead_minutes.options[0].textContent = `Default (${state.settings.heads_up_minutes ? state.settings.heads_up_minutes + ' min' : 'none'})`;
  setOrBlank(f.effort_minutes, it.effort_minutes);
  if (it.effort_minutes && !f.effort_minutes.value) {
    f.effort_minutes.add(new Option(formatMinutes(it.effort_minutes), String(it.effort_minutes)));
    f.effort_minutes.value = String(it.effort_minutes);
  }
  f.star.checked = isStarToday(it, new Date(), tz());
  f.priority.checked = !!it.priority;
  f.pinned.checked = !!it.pinned;
  f.busy.checked = it.busy !== false;
  f.birthday.value = birthdayText(it.birthday);
  setOrBlank(f.checkin_days, it.checkin_days);
  const c = checkinStatus({ ...it, checkin_days: 1 }, new Date());
  $('#ed-last').textContent = it.last_contact ? (c.daysSince === 0 ? 'Today' : `${c.daysSince} days ago`) : 'Not recorded yet';
  $('#ed-move').textContent = it.kind === 'task' ? 'Move to Info' : 'Move to Tasks';
  $('#ed-done').textContent = it.done_at ? 'Mark not done' : 'Mark done';
  $('#ed-snooze').hidden = !!it.done_at || !it.remind_at;
  if (it.kind === 'task') planStatus(it);
  ed.showModal();
  if (matchMedia('(pointer: fine)').matches) f.title.focus();
}

edForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return; // "Close" just closes
  e.preventDefault();
  const it = byId(ed.dataset.id);
  if (!it) { ed.close(); return; }
  const f = edForm.elements;
  const patch = { title: f.title.value.trim(), body: f.body.value, tags: parseTags(f.tags.value) };
  if (!patch.title) { f.title.focus(); return; }
  if (it.kind === 'task') {
    patch.repeat = f.repeat.value || null;
    patch.nag_minutes = f.nag_minutes.value === '' ? null : +f.nag_minutes.value;
    patch.effort_minutes = f.effort_minutes.value === '' ? null : +f.effort_minutes.value;
    patch.priority = f.priority.checked;
    const starredNow = isStarToday(it, new Date(), tz());
    if (f.star.checked !== starredNow) {
      const count = state.items.filter((t) => isStarToday(t, new Date(), tz())).length;
      if (f.star.checked && count >= 3) toast("You've got 3 for today already, so it wasn't starred.");
      else patch.star_date = f.star.checked ? today() : null;
    }
    if (f.due_at.value !== toLocalInput(it.due_at)) patch.due_at = fromLocalInput(f.due_at.value);
    let remind = f.remind_at.value;
    if (patch.repeat && !remind) {
      // a repeat needs a time to repeat from: start at the next sensible slot
      const p = parseQuick(patch.repeat, { tz: tz(), defaultHour: state.settings.default_hour });
      remind = toLocalInput(p.remindAt?.toISOString());
    }
    if (!remind && patch.due_at) {
      // a deadline with no reminder gets one the morning before
      remind = toLocalInput(deadlineReminder(new Date(patch.due_at), new Date(), tz(), state.settings.default_hour).toISOString());
    }
    if (remind !== toLocalInput(it.remind_at)) patch.remind_at = fromLocalInput(remind);
  } else if (it.kind === 'event') {
    const start = fromLocalInput(f.ev_start.value);
    let end = fromLocalInput(f.ev_end.value);
    if (!start) { f.ev_start.focus(); return; }
    if (!end || Date.parse(end) <= Date.parse(start)) end = new Date(Date.parse(start) + 3600000).toISOString();
    if (start !== it.remind_at) patch.remind_at = start;
    if (end !== it.ends_at) patch.ends_at = end;
    patch.repeat = f.repeat.value || null;
    patch.lead_minutes = f.lead_minutes.value === '' ? null : +f.lead_minutes.value;
    patch.busy = f.busy.checked;
  } else if (it.kind === 'person') {
    const b = f.birthday.value.trim();
    patch.birthday = b ? birthdayValue(b) : null;
    if (b && !patch.birthday) { toast('Type the birthday like 14/3 or 14/3/2004'); f.birthday.focus(); return; }
    patch.checkin_days = f.checkin_days.value === '' ? null : +f.checkin_days.value;
  } else {
    patch.pinned = f.pinned.checked;
  }
  mutate('update', { id: it.id, patch });
  ed.close();
});

$('#remind-presets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-preset]');
  if (!b) return;
  const input = edForm.elements.remind_at;
  const hour = state.settings.default_hour;
  const phrase = { '1h': 'in 1 hour', evening: 'this evening', tomorrow: `tomorrow at ${hour}:00` }[b.dataset.preset];
  input.value = phrase ? toLocalInput(parseQuick(phrase, { tz: tz(), defaultHour: hour }).remindAt.toISOString()) : '';
});

$('#ed-plan').addEventListener('click', () => {
  const it = byId(ed.dataset.id);
  if (!it) return;
  const dueVal = edForm.elements.due_at.value;
  if (dueVal && dueVal !== toLocalInput(it.due_at)) mutate('update', { id: it.id, patch: { due_at: fromLocalInput(dueVal) } });
  if (planFor(it.id)) planStatus(byId(it.id));
});
$('#ed-talked').addEventListener('click', () => { talked(ed.dataset.id); $('#ed-last').textContent = 'Today'; });
$('#ed-done').addEventListener('click', () => { const id = ed.dataset.id; ed.close(); toggleDone(id); });
$('#ed-snooze').addEventListener('click', () => { const id = ed.dataset.id; ed.close(); snooze(id, 60); });
$('#ed-delete').addEventListener('click', () => { const id = ed.dataset.id; ed.close(); remove(id); });
$('#ed-move').addEventListener('click', () => {
  const it = byId(ed.dataset.id);
  if (!it) return;
  const kind = it.kind === 'task' ? 'info' : 'task';
  mutate('update', { id: it.id, patch: { kind } });
  ed.close();
  toast(`Moved to ${kind === 'task' ? 'Tasks' : 'Info'}`);
});

/* ------------------------------------------------------------------ */
/* Weekly review                                                       */
/* ------------------------------------------------------------------ */

const reviewDlg = $('#review');

function reviewRow(item, buttons, meta = '') {
  return `<li class="review-row" data-id="${item.id}">
    <div><b>${esc(item.title)}</b>${meta ? `<span class="meta">${meta}</span>` : ''}</div>
    <div class="chips">${buttons.map(([act, label]) => `<button type="button" data-ract="${act}">${esc(label)}</button>`).join('')}</div>
  </li>`;
}

function renderReview() {
  const now = new Date();
  const tasks = state.items.filter((i) => i.kind === 'task' && !i.done_at);
  const overdue = tasks.filter((t) => effectiveDue(t) && effectiveDue(t) <= now);
  const undated = tasks.filter((t) => !t.remind_at && !t.due_at);
  const weekEnd = endOfDay(7);
  const upcoming = [
    ...tasks.filter((t) => { const d = t.due_at ? new Date(t.due_at) : effectiveDue(t); return d && d > now && d <= weekEnd; })
      .map((t) => [t.due_at ? new Date(t.due_at) : effectiveDue(t), t.due_at ? `Due: ${t.title}` : t.title]),
    ...state.items.filter((i) => i.kind === 'event').map((e) => [eventOccurrence(e, now, tz()), e])
      .filter(([o]) => o && o.start <= weekEnd).map(([o, e]) => [o.start, `${e.title} (${clock(o.start)}–${clock(o.end)})`]),
  ].sort((a, b) => a[0] - b[0]);
  const deadlines = tasks.filter((t) => t.due_at && Date.parse(t.due_at) - now > 2 * DAY && Date.parse(t.due_at) - now < 30 * DAY && !childrenOf(t.id).length);
  const people = state.items.filter((i) => i.kind === 'person');
  const catchup = people.filter((p) => checkinStatus(p, now)?.due);
  const bdays = people.filter((p) => { const b = birthdayInfo(p.birthday, now, tz()); return b && b.daysUntil <= 14; });
  const doneWeek = state.items.filter((i) => i.kind === 'task' && i.done_at && now - Date.parse(i.done_at) < 7 * DAY).length;

  const section = (title, body, empty) => `<section class="set-group"><h3>${title}</h3>${body || `<p class="hint">${empty}</p>`}</section>`;
  const list = (rows) => (rows.length ? `<ul class="review-list">${rows.join('')}</ul>` : '');
  let lastDay = '';
  const weekRows = upcoming.map(([d, label]) => {
    const day = formatWhen(d, { now, tz: tz() }).replace(/\s\d\d:\d\d$/, '');
    const head = day !== lastDay ? `<li class="day-sep">${esc(day.charAt(0).toUpperCase() + day.slice(1))}</li>` : '';
    lastDay = day;
    return `${head}<li class="week-row"><span class="ev-time">${clock(d)}</span>${esc(label)}</li>`;
  });

  $('#review-body').innerHTML = `
    <p class="hint review-intro">${doneWeek ? `You finished ${doneWeek} ${doneWeek === 1 ? 'task' : 'tasks'} in the last 7 days. ` : ''}Go through each part, then you're set for the week.</p>
    ${section('1. Clear what slipped', list(overdue.map((t) => reviewRow(t, [['done', 'Done'], ['tomorrow', 'Tomorrow'], ['nextweek', 'Next week'], ['delete', 'Drop it']], `${formatSpan(now - effectiveDue(t))} overdue`))), 'Nothing overdue. Nice.')}
    ${section('2. Give these a day', list(undated.slice(0, 12).map((t) => reviewRow(t, [['tomorrow', 'Tomorrow'], ['weekend', 'Weekend'], ['nextweek', 'Next week'], ['done', 'Done']]))), 'Every task has a time.')}
    ${section('3. Get ahead of deadlines', list(deadlines.map((t) => reviewRow(t, [['plan', 'Plan check-ins']], `Due ${esc(when(new Date(t.due_at)))}`))), 'No big deadlines waiting to be split up.')}
    ${section('4. People', list([
      ...bdays.map((p) => { const b = birthdayInfo(p.birthday, now, tz()); return reviewRow(p, [['bdaytask', 'Remind me to get something']], `Birthday ${b.daysUntil === 0 ? 'today' : `in ${b.daysUntil} days`}`); }),
      ...catchup.map((p) => reviewRow(p, [['talked', 'Talked already'], ['plancall', 'Plan a catch-up']], `${checkinStatus(p, now).daysSince} days since you were in touch`)),
    ]), 'Nobody waiting to hear from you.')}
    ${section('5. Your week', weekRows.length ? `<ul class="review-list">${weekRows.join('')}</ul>` : '', 'Nothing scheduled yet.')}
    <div class="row-actions review-finish"><button type="button" class="primary" id="review-finish">Done reviewing</button></div>`;
}

function openReview() {
  renderReview();
  if (!reviewDlg.open) reviewDlg.showModal();
}

function atNext(phrase) {
  return parseQuick(phrase, { tz: tz(), defaultHour: state.settings.default_hour }).remindAt.toISOString();
}

$('#review-body').addEventListener('click', (e) => {
  if (e.target.id === 'review-finish') {
    LS.set('lastReview', today());
    reviewDlg.close();
    render();
    toast("That's the week sorted. See you next review.");
    return;
  }
  const b = e.target.closest('[data-ract]');
  if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  const it = byId(id);
  if (!it) return;
  switch (b.dataset.ract) {
    case 'done': toggleDone(id); break;
    case 'delete': remove(id); break;
    case 'tomorrow': mutate('update', { id, patch: { remind_at: atNext('tomorrow') } }); break;
    case 'weekend': mutate('update', { id, patch: { remind_at: atNext('this weekend') } }); break;
    case 'nextweek': mutate('update', { id, patch: { remind_at: atNext('next week') } }); break;
    case 'plan': planFor(id); break;
    case 'talked': talked(id); break;
    case 'plancall': {
      const t = newItem({ kind: 'task', title: `Catch up with ${it.title}`, remind_at: atNext('tomorrow evening'), tags: ['people'] });
      mutate('add', { id: t.id, item: t });
      toast(`Added: catch up with ${it.title}, ${when(new Date(t.remind_at))}`);
      break;
    }
    case 'bdaytask': {
      const b2 = birthdayInfo(it.birthday, new Date(), tz());
      const at = new Date(Math.max(Date.now() + 3600000, b2.at.getTime() - 3 * DAY + state.settings.default_hour * 3600000));
      const t = newItem({ kind: 'task', title: `Get something for ${it.title}'s birthday`, remind_at: at.toISOString(), tags: ['people'] });
      mutate('add', { id: t.id, item: t });
      toast(`Added, reminder ${when(at)}`);
      break;
    }
  }
  setTimeout(renderReview, 420);
});
$('#close-review').addEventListener('click', () => reviewDlg.close());

/* ------------------------------------------------------------------ */
/* Lists: clicks, tabs, filters, search                                */
/* ------------------------------------------------------------------ */

function onListClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const li = b.closest('[data-id]');
  const id = li?.dataset.id;
  switch (b.dataset.act) {
    case 'check': return toggleDone(id, li);
    case 'open': return openEditor(id);
    case 'snooze': return snooze(id, 60);
    case 'star': return toggleStar(id);
    case 'talked': return talked(id);
    case 'copy': return copyItem(id);
    case 'toggle-done': state.ui.showDone = !state.ui.showDone; saveUi(); return render();
    case 'toggle-week': state.ui.showWeek = !state.ui.showWeek; saveUi(); return render();
    case 'settings': return openSettings();
    case 'review': return openReview();
    case 'push': return enablePush();
    case 'hide-push': LS.set('hidePushBanner', true); return render();
  }
}
for (const sel of ['#tasks', '#people', '#info']) $(sel).addEventListener('click', onListClick);

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  state.ui.view = b.dataset.view;
  setKind({ tasks: 'task', people: 'person', info: 'info' }[state.ui.view]); // on a phone, the box adds to the list you're looking at
  saveUi();
  render();
});

$('#tag-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tag], button[data-fit]');
  if (!b) return;
  if (b.dataset.fit) {
    const m = +b.dataset.fit;
    state.ui.fit = state.ui.fit === m ? null : m;
    state.ui.tag = null;
    if (!isWide()) state.ui.view = 'tasks';
  } else {
    state.ui.tag = b.dataset.tag || null;
    state.ui.fit = null;
  }
  saveUi();
  render();
});

function openSearch() {
  $('#search-wrap').hidden = false;
  $('#capture-form').hidden = true;
  $('#search').focus();
}
function closeSearch() {
  state.query = '';
  $('#search').value = '';
  $('#search-wrap').hidden = true;
  $('#capture-form').hidden = false;
  render();
}
$('#open-search').addEventListener('click', () => ($('#search-wrap').hidden ? openSearch() : closeSearch()));
$('#close-search').addEventListener('click', closeSearch);
$('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); if (!$('#search-wrap').hidden) closeSearch(); capture.focus(); }
  if (e.key === '/') { e.preventDefault(); openSearch(); }
});

$('#sync').addEventListener('click', () => (state.conn ? refresh() : openSettings()));

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const setDlg = $('#settings');
const connForm = $('#conn-form');
const prefsForm = $('#prefs-form');
const feedForm = $('#feed-form');

for (let h = 5; h <= 21; h++) prefsForm.elements.default_hour.add(new Option(`${pad2(h)}:00`, String(h)));

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : isIOS ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os} ${br}`.trim();
}

function pushStatus() {
  const el = $('#push-status');
  let text, cls = '', canTurnOn = false;
  if (!state.conn) text = 'Connect to your server first. Notifications are sent from there.';
  else if (isIOS && !isStandalone) text = 'On iPhone: tap Share, then Add to Home Screen, and open Focus from your Home Screen. Notifications only work from there.';
  else if (!('serviceWorker' in navigator) || !('PushManager' in window)) text = "This browser can't receive push notifications.";
  else if (Notification.permission === 'denied') { text = 'Notifications are blocked for Focus. Allow them in the browser\'s site settings (on iPhone: Settings → Notifications → Focus).'; cls = 'bad'; }
  else if (state.pushOn && Notification.permission === 'granted') { text = 'On. Reminders reach this device even when Focus is closed.'; cls = 'good'; }
  else { text = 'Off on this device.'; canTurnOn = true; }
  el.textContent = text;
  el.className = 'hint ' + cls;
  $('#push-on').hidden = !canTurnOn;
  $('#push-test').hidden = !(state.conn && state.pushOn);
}

function connStatus(msg, cls = '') {
  const el = $('#conn-status');
  el.textContent = msg || (state.conn
    ? 'Connected. Changes sync between your devices, and the server sends your reminders.'
    : 'Not connected. Everything is saved on this device only, and reminders only show while Focus is open.');
  el.className = 'hint ' + (cls || (state.conn ? 'good' : ''));
}

function fillPrefs() {
  const f = prefsForm.elements;
  const s = state.settings;
  for (const k of ['default_nag_minutes', 'default_hour', 'review_day', 'heads_up_minutes']) setOrBlank(f[k], s[k]);
  for (const k of ['quiet_start', 'quiet_end', 'digest_time', 'people_time', 'review_time']) f[k].value = s[k] || '';
  f.hold_during_busy.checked = !!s.hold_during_busy;
  $('#tz-line').textContent = `Times are in ${s.tz}${s.tz === deviceTz ? '' : ` (this device is on ${deviceTz})`}.`
    + (state.conn ? '' : ' Summaries and nudges need the server.');
}

const ago = (iso) => {
  if (!iso) return 'not synced yet';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 2 ? 'synced just now' : m < 60 ? `synced ${m} min ago` : `synced ${Math.round(m / 60)} h ago`;
};

function renderFeeds() {
  const connected = !!state.conn;
  feedForm.hidden = !connected;
  $('#cal-intro').textContent = connected
    ? 'Add calendar links and Focus keeps them in sync every few hours. Classes and shifts give you a heads-up and hold other reminders while they\'re on. Assignment deadlines become tasks, with check-ins planned before them.'
    : 'Connect to your server first: it fetches your calendars every few hours, even when your phone is asleep.';
  $('#feed-list').innerHTML = state.feeds.map((f) => `
    <li data-feed-id="${f.id}">
      <div><b>${esc(f.name)}</b> <span class="hint small">${f.type === 'deadlines' ? 'Deadlines' : 'Classes and shifts'}${f.tag ? `, #${esc(f.tag)}` : ''}</span>
      <div class="hint small ${f.last_error ? 'bad' : ''}">${f.last_error ? `Problem: ${esc(f.last_error)}` : `${f.count || 0} items, ${ago(f.last_sync)}`}</div></div>
      <div class="chips"><button type="button" data-fact="sync">Sync now</button><button type="button" data-fact="filter">Filter</button><button type="button" data-fact="remove">Remove</button></div>
      <form class="skip-form" hidden>
        <label class="field"><span>Skip anything containing (separate with commas)</span>
          <input name="skip" value="${esc((f.skip || []).join(', '))}" placeholder="announcement, optional" autocapitalize="off"></label>
        <button type="submit" class="ghost small">Save filter and resync</button>
      </form>
    </li>`).join('');
  $('#cal-link').disabled = !connected;
}

function syncFeedFormType() {
  const type = feedForm.elements.type.value;
  for (const el of feedForm.querySelectorAll('[data-feed]')) el.hidden = el.dataset.feed !== type;
  feedForm.elements.tag.placeholder = type === 'deadlines' ? 'college' : 'college or work';
}
feedForm.elements.type.addEventListener('change', syncFeedFormType);

async function loadFeeds() {
  if (!state.conn) return;
  try {
    state.feeds = (await api('feeds')).feeds;
    LS.set('feeds', state.feeds);
    renderFeeds();
  } catch { /* shown elsewhere */ }
}

feedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = feedForm.elements;
  const feed = {
    name: f.name.value.trim(), url: f.url.value.trim(), type: f.type.value, tag: f.tag.value.trim(),
    lead_minutes: +f.lead_minutes.value, busy: f.busy.checked, auto_plan: f.auto_plan.checked, skip: f.skip.value,
  };
  if (!feed.url) { f.url.focus(); return; }
  const btn = feedForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Adding and syncing…';
  try {
    const r = await api('feed_save', { feed });
    toast(r.message, { ms: 6000 });
    if (!r.result.error) feedForm.reset();
    syncFeedFormType();
    await loadFeeds();
    await refresh();
  } catch (err) {
    toast(`Couldn't add it: ${err.message}`, { ms: 6000 });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add calendar';
  }
});

$('#feed-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fact]');
  if (!b) return;
  const li = b.closest('[data-feed-id]');
  const id = li.dataset.feedId;
  if (b.dataset.fact === 'filter') {
    const form = li.querySelector('.skip-form');
    form.hidden = !form.hidden;
    if (!form.hidden) form.elements.skip.focus();
    return;
  }
  b.disabled = true;
  try {
    if (b.dataset.fact === 'sync') {
      const r = await api('feed_sync', { id });
      const res = r.results[0]?.result || {};
      toast(res.error ? `Sync failed: ${res.error}` : `Synced: ${res.added} new, ${res.updated} updated, ${res.removed} removed`, { ms: 5000 });
    } else {
      const r = await api('feed_delete', { id });
      toast(`Removed the calendar and ${r.removed} items from it`);
    }
    await loadFeeds();
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

$('#feed-list').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('.skip-form');
  const id = form.closest('[data-feed-id]').dataset.feedId;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const r = await api('feed_save', { feed: { id, skip: form.elements.skip.value } });
    toast(r.result.error ? `Saved, but syncing failed: ${r.result.error}` : `Filter saved: ${r.result.removed} removed, ${r.result.found} kept`, { ms: 5000 });
    await loadFeeds();
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#cal-link').addEventListener('click', async () => {
  try {
    const { token } = await api('calendar');
    const url = `${state.conn.url}?action=ics&token=${token}`;
    const webcal = url.replace(/^https?:\/\//, 'webcal://');
    $('#cal-out').hidden = false;
    $('#cal-url').textContent = webcal;
    $('#cal-open').href = webcal;
  } catch (e) { toast(e.message); }
});
$('#cal-copy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('#cal-url').textContent).then(() => toast('Calendar link copied'), () => toast('Select the link and copy it'));
});

async function openSettings() {
  const f = connForm.elements;
  f.url.value = state.conn?.url || '';
  f.key.value = state.conn?.key || '';
  $('#conn-save').textContent = state.conn ? 'Save' : 'Connect';
  $('#conn-forget').hidden = !state.conn;
  const local = state.items.length;
  $('#upload-wrap').hidden = !!state.conn || !local;
  $('#upload-label').textContent = `Upload the ${local} ${local === 1 ? 'item' : 'items'} already on this device`;
  $('#new-key').hidden = true;
  connStatus();
  pushStatus();
  fillPrefs();
  syncFeedFormType();
  renderFeeds();
  if (!setDlg.open) setDlg.showModal();
  if (state.conn) {
    try {
      const r = await api('ping');
      state.settings = { ...state.settings, ...r.settings };
      LS.set('settings', state.settings);
      fillPrefs();
      loadFeeds();
    } catch (e) { connStatus(`Connected, but the server didn't answer: ${e.message}`, 'bad'); }
  }
}

$('#open-settings').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', () => setDlg.close());
$('#start-review').addEventListener('click', () => { setDlg.close(); openReview(); });

connForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = connForm.elements;
  const url = f.url.value.trim().replace(/\/+$/, '');
  const key = f.key.value.trim();
  const secureOrLocal = /^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  if (!secureOrLocal || !/\/functions\/v1\/[\w-]+$/.test(url)) {
    connStatus('That URL doesn\'t look right. It should end in /functions/v1/focus.', 'bad');
    return f.url.focus();
  }
  if (!key) { connStatus('Paste your Focus key too.', 'bad'); return f.key.focus(); }
  const cand = { url, key };
  connStatus('Checking…');
  try {
    const r = await api('ping', {}, cand);
    const firstTime = !state.conn;
    state.conn = cand;
    LS.set('conn', cand);
    await writeSwConfig();
    state.settings = { ...state.settings, ...r.settings };
    if (firstTime && r.settings.tz !== deviceTz && r.settings.tz === DEFAULT_SETTINGS.tz) {
      const s = await api('settings', { patch: { tz: deviceTz } });
      state.settings = { ...state.settings, ...s.settings };
    }
    LS.set('settings', state.settings);
    if (firstTime && f.upload.checked && state.items.length) {
      const res = await api('import', { items: state.items });
      toast(`Uploaded ${res.imported} items`);
    }
    if (firstTime) { state.queue = []; LS.set('queue', state.queue); }
    await refresh();
    openSettings();
  } catch (err) {
    connStatus(err.status === 401
      ? 'The server rejected that key. It must match the FOCUS_KEY secret in Supabase exactly.'
      : err.status === 0
        ? "Couldn't reach that URL. Check it, and that the function is deployed with Verify JWT turned off."
        : `The server said: ${err.message}`, 'bad');
  }
});

$('#conn-forget').addEventListener('click', async () => {
  await disablePush();
  state.conn = null;
  state.queue = [];
  state.feeds = [];
  LS.del('conn');
  LS.set('queue', []);
  LS.set('feeds', []);
  await writeSwConfig();
  setSync('local');
  render();
  openSettings();
  toast('Disconnected. What you see stays on this device.');
});

$('#gen-key').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = 'fk_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const box = $('#new-key');
  box.hidden = false;
  box.textContent = key;
  connForm.elements.key.value = key;
  connForm.elements.key.type = 'text';
  navigator.clipboard?.writeText(key).then(() => toast('New key copied. Save it as FOCUS_KEY in Supabase.'), () => {});
});

prefsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = prefsForm.elements;
  const patch = {
    default_nag_minutes: +f.default_nag_minutes.value,
    default_hour: +f.default_hour.value,
    heads_up_minutes: +f.heads_up_minutes.value,
    review_day: +f.review_day.value,
    hold_during_busy: f.hold_during_busy.checked,
  };
  for (const k of ['quiet_start', 'quiet_end', 'digest_time', 'people_time', 'review_time']) patch[k] = f[k].value;
  try {
    if (state.conn) {
      const r = await api('settings', { patch });
      state.settings = { ...state.settings, ...r.settings };
    } else state.settings = { ...state.settings, ...patch };
    LS.set('settings', state.settings);
    toast('Reminder settings saved');
    render();
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
});

/* Backup */
$('#export').addEventListener('click', async () => {
  let items = state.items;
  try { if (state.conn) items = (await api('export')).items; } catch (e) { toast(`Using this device's copy (${e.message})`); }
  const blob = new Blob([JSON.stringify({ app: 'focus', version: 2, exportedAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `focus-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items)) throw new Error('No items in that file');
    if (state.conn) {
      const r = await api('import', { items });
      await refresh();
      toast(`Restored ${r.imported} items`);
    } else {
      const ids = new Set(items.map((i) => i.id));
      state.items = [...items.map((i) => newItem(i)), ...state.items.filter((i) => !ids.has(i.id))];
      persist();
      render();
      toast(`Restored ${items.length} items`);
    }
  } catch (err) {
    toast(`Couldn't restore: ${err.message}`);
  }
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const sameKey = (buf, bytes) => buf && new Uint8Array(buf).every((v, i) => v === bytes[i]);

async function enablePush() {
  if (!state.conn) { openSettings(); return; }
  if (isIOS && !isStandalone) { openSettings(); return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast("This browser can't receive push notifications"); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications were not allowed'); pushStatus(); return; }
    const reg = await navigator.serviceWorker.ready;
    const { vapidPublicKey } = await api('ping');
    const key = b64ToBytes(vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('subscribe', { subscription: sub.toJSON(), device: deviceName() });
    state.pushOn = true;
    LS.set('pushOn', true);
    await writeSwConfig();
    toast('Notifications are on for this device', { actions: [{ label: 'Send a test', run: sendTest }] });
  } catch (e) {
    toast(`Couldn't turn on notifications: ${e.message}`);
  }
  pushStatus();
  render();
}

async function disablePush() {
  if (!state.pushOn) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* ignore */ }
  state.pushOn = false;
  LS.set('pushOn', false);
}

async function sendTest() {
  try { toast((await api('test')).message); } catch (e) { toast(`Test failed: ${e.message}`); }
}

$('#push-on').addEventListener('click', enablePush);
$('#push-test').addEventListener('click', sendTest);

/** The service worker reads this to handle Done / Snooze buttons on notifications. */
async function writeSwConfig() {
  try {
    const c = await caches.open('focus-config');
    const url = new URL('./__config', location.href);
    if (state.conn) await c.put(url, new Response(JSON.stringify(state.conn)));
    else await c.delete(url);
  } catch { /* Cache Storage unavailable */ }
}

/* While Focus is open without push, remind in the page itself. */
let lastCheck = Date.now();
function inPageReminders() {
  const now = Date.now();
  if (!state.pushOn) {
    for (const t of state.items) {
      if (t.done_at) continue;
      if (t.kind === 'task') {
        const d = effectiveDue(t);
        if (d && d.getTime() > lastCheck && d.getTime() <= now) {
          toast(`⏰ ${t.title}`, { ms: 15000, actions: [
            { label: 'Done', run: () => toggleDone(t.id) },
            { label: 'Snooze', run: () => snooze(t.id, 60) },
          ] });
        }
      } else if (t.kind === 'event') {
        const o = eventOccurrence(t, new Date(now), tz());
        const lead = (t.lead_minutes ?? state.settings.heads_up_minutes) * 60000;
        if (o && lead && o.start - lead > lastCheck && o.start - lead <= now) toast(`🗓 ${t.title} at ${clock(o.start)}`, { ms: 15000 });
      }
    }
  }
  lastCheck = now;
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker not registered', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.id) refresh().then(() => openEditor(e.data.id));
    if (e.data?.type === 'open-url' && e.data.url) handleParams(new URL(e.data.url, location.href).searchParams);
    if (e.data?.type === 'refresh') refresh();
  });
}

function handleParams(params) {
  if (params.has('task')) {
    const id = params.get('task');
    (state.conn ? refresh() : Promise.resolve()).then(() => byId(id) && openEditor(id));
  }
  if (params.has('view') && ['tasks', 'people', 'info'].includes(params.get('view'))) {
    state.ui.view = params.get('view');
    saveUi();
    render();
  }
  if (params.has('review')) (state.conn ? refresh() : Promise.resolve()).then(openReview);
  if (params.has('add')) {
    const k = params.get('kind');
    setKind(['info', 'person'].includes(k) ? k : 'task');
    capture.value = params.get('add');
    updatePreview();
    capture.focus();
  }
}

setKind(state.ui.kind);
render();
setSync(state.conn ? 'ok' : 'local');
writeSwConfig();
refresh();

// Links from notifications and Shortcuts:  ?task=<id>  ?review=1  ?view=people  ?add=<text>&kind=info
const params = new URLSearchParams(location.search);
handleParams(params);
if ([...params.keys()].length) history.replaceState(null, '', location.pathname);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); refresh(); }
});
addEventListener('online', () => refresh());
addEventListener('resize', () => renderFilters());
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
setInterval(() => { inPageReminders(); if (document.visibilityState === 'visible' && !document.querySelector('.task.completing')) render(); }, 20000);
