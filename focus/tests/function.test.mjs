// Runs the real edge function code under Node with an in-memory database and fake push service.
//   node --test tests/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdirSync, copyFileSync } from 'node:fs';

register('./mocks/loader.mjs', import.meta.url);

const ENV = { FOCUS_KEY: 'test-key-123', SUPABASE_URL: 'http://db.local', SUPABASE_SERVICE_ROLE_KEY: 'service' };
let handler;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const feedsServed = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (feedsServed[u] !== undefined) return new Response(feedsServed[u], { status: 200, headers: { 'content-type': 'text/calendar' } });
  return new Response('', { status: u.includes('gone') ? 410 : 201 });
};

const { tables } = await import('./mocks/supabase.mjs');
const { pushed } = await import('./mocks/pushforge.mjs');

before(async () => {
  mkdirSync(new URL('./.tmp/', import.meta.url), { recursive: true });
  const dest = new URL('./.tmp/focus.mjs', import.meta.url);
  copyFileSync(new URL('../supabase/functions/focus/index.ts', import.meta.url), dest);
  await import(dest.href);
});

async function call(body, { key = ENV.FOCUS_KEY, method = 'POST' } = {}) {
  const res = await handler(new Request('http://fn.local/functions/v1/focus', {
    method, headers: { 'content-type': 'application/json', ...(key ? { 'x-focus-key': key } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, ...(method === 'OPTIONS' ? {} : await res.json()), headers: res.headers };
}
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

test('rejects a missing or wrong key, answers CORS preflight', async () => {
  assert.equal((await call({ action: 'ping' }, { key: '' })).status, 401);
  assert.equal((await call({ action: 'ping' }, { key: 'nope' })).status, 401);
  const pre = await call(null, { method: 'OPTIONS' });
  assert.equal(pre.status, 200);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-focus-key/);
});

test('ping creates push keys once and returns settings', async () => {
  const a = await call({ action: 'ping' });
  assert.equal(a.ok, true);
  assert.match(a.vapidPublicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.equal(a.settings.tz, 'Europe/Dublin');
  const b = await call({ action: 'ping' });
  assert.equal(b.vapidPublicKey, a.vapidPublicKey);
  // turn quiet hours + digest off so tests don't depend on the real clock
  const s = await call({ action: 'settings', patch: { quiet_start: '00:00', quiet_end: '00:00', digest_time: '', people_time: '', review_time: '', heads_up_minutes: 30 } });
  assert.equal(s.settings.digest_time, '');
});

test('add: parses quick text for tasks and info', async () => {
  const t = await call({ action: 'add', text: 'Submit lab report fri 5pm #college' });
  assert.equal(t.item.title, 'Submit lab report');
  assert.deepEqual(t.item.tags, ['college']);
  assert.ok(t.item.remind_at);
  assert.match(t.message, /^Added: Submit lab report — ⏰ .*17:00 — #college$/);

  const i = await call({ action: 'add', type: 'info', text: 'Locker code: 4821 #college' });
  assert.equal(i.item.kind, 'info');
  assert.equal(i.item.body, '4821');
  assert.match(i.message, /^Saved: Locker code/);

  const w = await call({ action: 'add', text: 'Call the bank', when: 'tomorrow 10am' });
  assert.equal(w.item.title, 'Call the bank');
  assert.ok(w.item.remind_at);

  const id = crypto.randomUUID();
  const c = await call({ action: 'add', id, kind: 'task', title: 'Client-made id' });
  assert.equal(c.item.id, id);
  assert.equal((await call({ action: 'add' })).status, 400);
});

test('list, update, complete, snooze, delete', async () => {
  const { items } = await call({ action: 'list' });
  assert.equal(items.length, 4);
  const task = items.find((x) => x.title === 'Submit lab report');

  const u = await call({ action: 'update', id: task.id, patch: { remind_at: ago(5), title: 'Submit lab report v2' } });
  assert.equal(u.item.title, 'Submit lab report v2');
  assert.equal(u.item.last_nagged_at, null);

  const sn = await call({ action: 'snooze', id: task.id, minutes: 15 });
  assert.ok(Date.parse(sn.item.snoozed_until) > Date.now());
  assert.match(sn.message, /^Snoozed until/);

  const d = await call({ action: 'complete', match: 'lab report' });
  assert.ok(d.item.done_at);
  assert.equal(d.message, 'Done: Submit lab report v2 ✓');
  const miss = await call({ action: 'complete', match: 'zzz' });
  assert.equal(miss.item, null);

  const rep = await call({ action: 'add', text: 'Vitamins every day 8am' });
  const r2 = await call({ action: 'complete', id: rep.item.id });
  assert.equal(r2.item.done_at, null);
  assert.ok(Date.parse(r2.item.remind_at) > Date.now());
  assert.match(r2.message, /^Done for now: Vitamins — next /);

  const un = await call({ action: 'uncomplete', id: task.id });
  assert.equal(un.item.done_at, null);

  await call({ action: 'delete', id: rep.item.id });
  assert.equal((await call({ action: 'update', id: rep.item.id, patch: { title: 'x' } })).status, 404);
  assert.equal((await call({ action: 'nope' })).status, 400);
});

test('push: subscribe, test message, dead devices are removed', async () => {
  const none = await call({ action: 'test' });
  assert.match(none.message, /No devices/);
  await call({ action: 'subscribe', device: 'iPhone', subscription: { endpoint: 'https://push.apple.com/abc', keys: { p256dh: 'x', auth: 'y' } } });
  await call({ action: 'subscribe', device: 'Old PC', subscription: { endpoint: 'https://fcm.example/gone', keys: { p256dh: 'x', auth: 'y' } } });
  const r = await call({ action: 'test' });
  assert.equal(r.sent, 1);
  assert.equal(r.devices, 2);
  assert.equal(tables.push_subs.length, 1);
  assert.equal(pushed.at(-1).payload.title, 'Focus is connected 🎯');
});

test('tick: nags until done, respects the interval, batches big piles', async () => {
  tables.items = tables.items.filter(() => false);
  const a = (await call({ action: 'add', kind: 'task', title: 'Overdue thing', remind_at: ago(10) })).item;
  await call({ action: 'add', kind: 'task', title: 'Future thing', remind_at: new Date(Date.now() + 3600000).toISOString() });
  await call({ action: 'add', kind: 'task', title: 'No date' });

  pushed.length = 0;
  let t = await call({ action: 'tick' });
  assert.equal(t.nagged, 1);
  assert.equal(pushed[0].payload.title, 'Overdue thing');
  assert.match(pushed[0].payload.body, /10 min overdue/);
  assert.equal(pushed[0].payload.url, './?task=' + a.id);

  t = await call({ action: 'tick' });
  assert.equal(t.nagged, 0, 'not again straight away');

  tables.items.find((i) => i.id === a.id).last_nagged_at = ago(31);
  t = await call({ action: 'tick' });
  assert.equal(t.nagged, 1, 'again after 30 min');
  assert.match(pushed.at(-1).payload.body, /reminder 3|reminder 2/);

  await call({ action: 'complete', id: a.id });
  tables.items.find((i) => i.id === a.id).last_nagged_at = ago(60);
  t = await call({ action: 'tick' });
  assert.equal(t.nagged, 0, 'stops once done');

  for (let i = 0; i < 5; i++) await call({ action: 'add', kind: 'task', title: 'Pile ' + i, remind_at: ago(1) });
  pushed.length = 0;
  t = await call({ action: 'tick' });
  assert.equal(t.nagged, 5);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.title, '5 tasks need you');
});

test('tick: quiet hours and morning digest', async () => {
  await call({ action: 'settings', patch: { quiet_start: '00:00', quiet_end: '23:59' } });
  assert.equal((await call({ action: 'tick' })).quiet, true);
  await call({ action: 'settings', patch: { quiet_start: '00:00', quiet_end: '00:00', digest_time: '00:00' } });
  pushed.length = 0;
  const t = await call({ action: 'tick' });
  assert.equal(t.digest, true);
  assert.ok(pushed.some((p) => p.payload.type === 'digest'));
  assert.equal((await call({ action: 'tick' })).digest, false, 'only once a day');
});

test('due and search answer in plain sentences for Siri', async () => {
  const due = await call({ action: 'due' });
  assert.match(due.message, /^\d+ tasks? for today:\n• /);
  const tagged = await call({ action: 'due', scope: 'all', tag: '#nonexistent' });
  assert.equal(tagged.count, 0);
  const all = await call({ action: 'due', scope: 'all' });
  assert.ok(all.count >= due.count);
  await call({ action: 'add', type: 'info', text: 'Locker code: 4821' });
  const s = await call({ action: 'search', q: "what's my locker code" });
  assert.equal(s.message.split('\n')[0], 'Locker code: 4821');
});

test('import and export', async () => {
  const id = crypto.randomUUID();
  const r = await call({ action: 'import', items: [{ id, kind: 'info', title: 'Imported', body: 'hi', created_at: '2026-01-01T00:00:00Z' }] });
  assert.equal(r.imported, 1);
  const e = await call({ action: 'export' });
  assert.ok(e.items.some((i) => i.id === id && i.created_at === '2026-01-01T00:00:00.000Z'));
});

// ---------------- version 2 ----------------
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const inMin = (m) => new Date(Date.now() + m * 60000);

test('add understands people, events, deadlines and effort', async () => {
  const p = await call({ action: 'add', type: 'person', text: 'Aoife bday 14/3 every 2 weeks: exam Thursday #friends' });
  assert.equal(p.item.kind, 'person');
  assert.equal(p.item.birthday, '03-14');
  assert.equal(p.item.checkin_days, 14);
  assert.match(p.message, /^Added person: Aoife/);
  const e = await call({ action: 'add', text: 'Work 5-10pm fri every week #work' });
  assert.equal(e.item.kind, 'event');
  assert.ok(e.item.ends_at);
  assert.match(e.message, /^Added to your schedule: Work — 🗓/);
  const d = await call({ action: 'add', text: 'Stats essay due 5/12 5pm ~2h #college' });
  assert.ok(d.item.due_at);
  assert.equal(d.item.effort_minutes, 120);
  assert.ok(Date.parse(d.item.remind_at) < Date.parse(d.item.due_at));
});

test('star: up to three a day', async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await call({ action: 'add', kind: 'task', title: 'Star me ' + i })).item.id);
  for (let i = 0; i < 3; i++) assert.match((await call({ action: 'star', id: ids[i] })).message, /^★/);
  const fourth = await call({ action: 'star', id: ids[3] });
  assert.match(fourth.message, /already got 3/);
  assert.equal(fourth.item.star_date, null);
  await call({ action: 'star', id: ids[0], on: false });
  assert.match((await call({ action: 'star', match: 'star me 3' })).message, /^★ Star me 3/);
  const today = await call({ action: 'today' });
  assert.match(today.message, /Today's 3: /);
});

test('plan: check-ins before a deadline, finished together', async () => {
  const due = new Date(Date.now() + 14 * 86400000);
  const t = (await call({ action: 'add', kind: 'task', title: 'Big project', due_at: due.toISOString(), remind_at: new Date(due - 86400000).toISOString() })).item;
  const r = await call({ action: 'plan', id: t.id });
  assert.equal(r.items.length, 3);
  assert.ok(r.items.every((x) => x.parent_id === t.id && x.title.endsWith(': Big project')));
  assert.equal((await call({ action: 'plan', id: t.id })).message, 'Already planned');
  await call({ action: 'complete', id: t.id });
  const { items } = await call({ action: 'list' });
  assert.ok(items.filter((x) => x.parent_id === t.id).every((x) => x.done_at), 'check-ins closed with the parent');
  await call({ action: 'delete', id: t.id });
  assert.equal((await call({ action: 'list' })).items.filter((x) => x.parent_id === t.id).length, 0);
});

test('free: tasks that fit the gap', async () => {
  await call({ action: 'add', text: 'Reply to Moodle forum ~10m' });
  await call({ action: 'add', text: 'Write report ~3h' });
  const f = await call({ action: 'free', minutes: 15 });
  assert.match(f.message, /^In 15 min you could:\n• Reply to Moodle forum \(~10 min\)/);
  assert.ok(!f.message.includes('Write report'));
});

test('people: catch-ups, contacted, birthday nudges', async () => {
  const mam = (await call({ action: 'add', type: 'person', text: 'Mam weekly' })).item;
  await call({ action: 'update', id: mam.id, patch: { last_contact: new Date(Date.now() - 9 * 86400000).toISOString() } });
  const soon = new Date(Date.now() + 3 * 86400000);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', day: '2-digit', month: '2-digit' }).formatToParts(soon);
  const dd = parts.find((x) => x.type === 'day').value, mm = parts.find((x) => x.type === 'month').value;
  await call({ action: 'add', type: 'person', title: 'Ciara', birthday: `${mm}-${dd}` });
  const c = await call({ action: 'catchup' });
  assert.match(c.message, /🎂 Ciara: in 3 days/);
  assert.match(c.message, /• Mam \(9 days\)/);
  await call({ action: 'settings', patch: { people_time: '00:00' } });
  pushed.length = 0;
  const t = await call({ action: 'tick' });
  assert.equal(t.people, true);
  const n = pushed.find((x) => x.payload.type === 'people');
  assert.match(n.payload.body, /Ciara's birthday in 3 days/);
  assert.match(n.payload.body, /Mam: 9 days since/);
  assert.equal(n.payload.url, './?view=people');
  const done = await call({ action: 'contacted', match: 'mam' });
  assert.equal(done.message, 'Noted: you were in touch with Mam');
  assert.ok(!(await call({ action: 'catchup' })).message.includes('Mam'));
  await call({ action: 'settings', patch: { people_time: '' } });
});

test('events: heads-up before, and nags held while busy', async () => {
  tables.items = tables.items.filter((i) => i.kind !== 'task');
  const lec = (await call({ action: 'add', kind: 'event', title: 'Physics lecture', body: 'Theatre L', remind_at: inMin(20).toISOString(), ends_at: inMin(80).toISOString() })).item;
  pushed.length = 0;
  let t = await call({ action: 'tick' });
  assert.equal(t.headsUp, 1);
  assert.match(pushed[0].payload.title, /^Physics lecture at \d\d:\d\d$/);
  assert.match(pushed[0].payload.body, /^In 20 min · Theatre L$/);
  t = await call({ action: 'tick' });
  assert.equal(t.headsUp, 0, 'only once per occurrence');
  // now make it be on right now, with an overdue task waiting
  await call({ action: 'update', id: lec.id, patch: { remind_at: inMin(-10).toISOString(), ends_at: inMin(50).toISOString() } });
  await call({ action: 'add', kind: 'task', title: 'Waiting nag', remind_at: inMin(-5).toISOString() });
  pushed.length = 0;
  t = await call({ action: 'tick' });
  assert.equal(t.held, true);
  assert.equal(t.nagged, 0);
  await call({ action: 'update', id: lec.id, patch: { busy: false } });
  t = await call({ action: 'tick' });
  assert.equal(t.nagged, 1, 'comes through once you are free');
});

test('calendars: import a timetable and Moodle deadlines, keep in sync', async () => {
  const day = 86400000;
  const nextLecture = new Date(Date.now() + 2 * day);
  const ics = (extra = '') => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:lec@uni', `DTSTART:${stamp(nextLecture)}`, `DTEND:${stamp(new Date(+nextLecture + 3600000))}`,
    'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:STAT20010 Lecture', 'LOCATION:Room 2.14', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:hol@uni', `DTSTART;VALUE=DATE:${stamp(new Date(Date.now() + 10 * day)).slice(0, 8)}`, 'SUMMARY:Holiday', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const sec = (ms) => new Date(Math.floor(ms / 1000) * 1000);
  const dueA = sec(Date.now() + 10 * day), dueB = sec(Date.now() + 20 * day);
  const moodle = (b = dueB) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:a1@moodle', `DTSTART:${stamp(dueA)}`, 'SUMMARY:Assignment 1 is due', 'CATEGORIES:STAT20010', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a2@moodle', `DTSTART:${stamp(b)}`, 'SUMMARY:Lab report is due', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  feedsServed['https://uni.example/timetable.ics'] = ics();
  feedsServed['https://moodle.example/export.ics'] = moodle();

  const bad = await call({ action: 'feed_save', feed: { name: 'Nope', url: 'ftp://x' } });
  assert.equal(bad.status, 400);

  const tt = await call({ action: 'feed_save', feed: { name: 'Timetable', url: 'webcal://uni.example/timetable.ics', type: 'timetable', lead_minutes: 10 } });
  assert.equal(tt.result.found, 5);
  assert.equal(tt.result.added, 4, 'all-day holiday skipped');
  const ttId = tt.feed.id;
  const dl = await call({ action: 'feed_save', feed: { name: 'Moodle', url: 'https://moodle.example/export.ics', type: 'deadlines' } });
  assert.equal(dl.result.added, 2);
  const dlId = dl.feed.id;

  let { items } = await call({ action: 'list' });
  const lectures = items.filter((i) => i.source === ttId);
  assert.equal(lectures.length, 4);
  assert.ok(lectures.every((l) => l.kind === 'event' && l.lead_minutes === 10 && l.body === 'Room 2.14'));
  const a1 = items.find((i) => i.title === 'Assignment 1');
  assert.deepEqual(a1.tags, ['college', 'stat20010']);
  assert.equal(a1.due_at, dueA.toISOString());
  assert.equal(items.filter((i) => i.parent_id === a1.id).length, 3, 'auto-planned check-ins');

  // you finish Assignment 1; the deadline for the lab report moves; a resync keeps your edits
  await call({ action: 'complete', id: a1.id });
  const moved = sec(Date.now() + 25 * day);
  feedsServed['https://moodle.example/export.ics'] = moodle(moved);
  const again = await call({ action: 'feed_sync', id: dlId });
  assert.equal(again.results[0].result.added, 0);
  ({ items } = await call({ action: 'list' }));
  assert.ok(items.find((i) => i.id === a1.id).done_at, 'still done after resync');
  assert.equal(items.find((i) => i.title === 'Lab report').due_at, moved.toISOString());

  // an assignment removed from Moodle disappears (with its check-ins)
  feedsServed['https://moodle.example/export.ics'] = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';
  await call({ action: 'feed_sync', id: dlId });
  ({ items } = await call({ action: 'list' }));
  assert.ok(!items.some((i) => i.title === 'Lab report'));
  assert.ok(items.some((i) => i.id === a1.id), 'finished ones stay as history');

  // broken link: error is saved, not thrown
  feedsServed['https://uni.example/timetable.ics'] = '<html>login</html>';
  const broken = await call({ action: 'feed_sync', id: ttId });
  assert.match(broken.feeds.find((f) => f.id === ttId).last_error, /didn't return a calendar/);

  const list = await call({ action: 'feeds' });
  assert.equal(list.feeds.length, 2);
  const del = await call({ action: 'feed_delete', id: ttId });
  assert.equal(del.removed, 4);
});

test('calendar feed: read-only token, includes tasks, events and birthdays', async () => {
  await call({ action: 'add', text: 'Stats essay due 5/12 5pm' });
  const { token } = await call({ action: 'calendar' });
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  const get = (t) => handler(new Request(`http://fn.local/functions/v1/focus?action=ics&token=${t}`));
  assert.equal((await get('wrong')).status, 404);
  const res = await get(token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const text = await res.text();
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(text, /SUMMARY:Due: Stats essay/);
  assert.match(text, /SUMMARY:Work\r\n/);
  assert.match(text, /RRULE:FREQ=WEEKLY/);
  assert.match(text, /SUMMARY:Aoife's birthday/);
  assert.ok(!text.includes('Assignment 1'), "calendar imports aren't echoed back");
  // the feed is parseable by our own reader
  const { parseICS } = await import('../app/shared.js');
  assert.ok(parseICS(text).length >= 3);
});

test('weekly review push', async () => {
  const wd = new Date().toLocaleDateString('en-US', { timeZone: 'Europe/Dublin', weekday: 'short' });
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  await call({ action: 'settings', patch: { review_day: idx, review_time: '00:00' } });
  pushed.length = 0;
  const t = await call({ action: 'tick' });
  assert.equal(t.review, true);
  const r = pushed.find((x) => x.payload.type === 'review');
  assert.equal(r.payload.url, './?review=1');
  assert.match(r.payload.body, /due this week/);
  assert.equal((await call({ action: 'tick' })).review, false, 'once a week');
});
