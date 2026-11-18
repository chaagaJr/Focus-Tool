// Run with:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseQuick, parseInfo, nextOccurrence, completePatch, shouldNag,
  inQuietHours, digestDue, formatWhen, zonedToUtc,
  planMilestones, deadlineReminder, parsePerson, birthdayInfo, checkinStatus,
  eventOccurrence, busyNow, isStarToday, todayKey, fitsIn, reviewDue,
  icsOccurrences, parseICS, filterOccurrences, cleanEventTitle,
} from '../app/shared.js';

const tz = 'Europe/Dublin';
const now = new Date('2026-11-18T18:57:00Z'); // Wed 18 Nov 2026, 18:57 in Dublin (winter, UTC+0)
const P = (text, o = {}) => parseQuick(text, { now, tz, ...o });
const iso = (d) => (d ? d.toISOString() : null);

test('plain text has no reminder', () => {
  const r = P('Buy milk');
  assert.equal(r.title, 'Buy milk');
  assert.equal(r.remindAt, null);
});

test('weekday + 12h time + tag', () => {
  const r = P('Submit lab report fri 5pm #college');
  assert.equal(r.title, 'Submit lab report');
  assert.equal(iso(r.remindAt), '2026-11-20T17:00:00.000Z');
  assert.deepEqual(r.tags, ['college']);
});

test('remind me to … tomorrow at 10', () => {
  const r = P('remind me to call the dentist tomorrow at 10');
  assert.equal(r.title, 'Call the dentist');
  assert.equal(iso(r.remindAt), '2026-11-19T10:00:00.000Z');
});

test('"at 3" means 3pm', () => {
  assert.equal(iso(P('Gym tomorrow at 3').remindAt), '2026-11-19T15:00:00.000Z');
});

test('time already passed today rolls to tomorrow', () => {
  assert.equal(iso(P('Take meds 9am').remindAt), '2026-11-19T09:00:00.000Z');
  assert.equal(iso(P('Take meds 21:15').remindAt), '2026-11-18T21:15:00.000Z');
});

test('relative minutes and hours', () => {
  assert.equal(iso(P('check oven in 20 min').remindAt), '2026-11-18T19:17:00.000Z');
  assert.equal(iso(P('Move car in an hour').remindAt), '2026-11-18T19:57:00.000Z');
  assert.equal(iso(P('stretch in half an hour').remindAt), '2026-11-18T19:27:00.000Z');
  assert.equal(P('check oven in 20 min').title, 'Check oven');
});

test('day without time uses 9am', () => {
  assert.equal(iso(P('Library books thursday').remindAt), '2026-11-19T09:00:00.000Z');
});

test('ambiguous short weekday words are left alone', () => {
  const r = P('buy sun cream');
  assert.equal(r.remindAt, null);
  assert.equal(r.title, 'Buy sun cream');
  const r2 = P('sat exam prep on fri');
  assert.equal(r2.title, 'Sat exam prep');
  assert.equal(P('Reply to group chat about Saturday').remindAt, null);
  assert.equal(iso(r2.remindAt), '2026-11-20T09:00:00.000Z');
});

test('same weekday later today vs next week', () => {
  assert.equal(iso(P('Call home wednesday 8pm').remindAt), '2026-11-18T20:00:00.000Z');
  assert.equal(iso(P('Call home wednesday 8am').remindAt), '2026-11-25T08:00:00.000Z');
  assert.equal(iso(P('Call home next wed 8pm').remindAt), '2026-11-25T20:00:00.000Z');
});

test('numeric day/month (Irish order) and month names', () => {
  assert.equal(iso(P('Pay rent 1/12').remindAt), '2026-12-01T09:00:00.000Z');
  assert.equal(iso(P('Essay 25th nov 5pm').remindAt), '2026-11-25T17:00:00.000Z');
  assert.equal(iso(P('Dentist on March 3 at 2:30pm').remindAt), '2027-03-03T14:30:00.000Z');
  assert.equal(P('Dentist on March 3 at 2:30pm').title, 'Dentist');
  // a date earlier in the year means next year
  assert.equal(iso(P('Renew passport 2/1').remindAt), '2027-01-02T09:00:00.000Z');
});

test('page ranges are not dates', () => {
  const r = P('Read pages 10-12');
  assert.equal(r.remindAt, null);
  assert.equal(r.title, 'Read pages 10-12');
});

test('tonight and evening words', () => {
  assert.equal(iso(P('Pack bag tonight').remindAt), '2026-11-18T20:00:00.000Z');
  assert.equal(iso(P('Email tutor tomorrow morning').remindAt), '2026-11-19T09:00:00.000Z');
  assert.equal(iso(P('Laundry fri evening').remindAt), '2026-11-20T18:00:00.000Z');
  // "tonight" after 8pm: an hour from now
  const late = new Date('2026-11-18T21:30:00Z');
  assert.equal(iso(parseQuick('Pack bag tonight', { now: late, tz }).remindAt), '2026-11-18T22:30:00.000Z');
});

test('repeats', () => {
  const bins = P('Bins out every tuesday 8pm');
  assert.equal(bins.repeat, 'weekly');
  assert.equal(bins.title, 'Bins out');
  assert.equal(iso(bins.remindAt), '2026-11-24T20:00:00.000Z');

  const meds = P('Vitamins every morning');
  assert.equal(meds.repeat, 'daily');
  assert.equal(iso(meds.remindAt), '2026-11-19T09:00:00.000Z');

  const daily = P('Duolingo daily 21:00');
  assert.equal(daily.repeat, 'daily');
  assert.equal(iso(daily.remindAt), '2026-11-18T21:00:00.000Z');

  const wk = P('Check timetable every weekday 7:30');
  assert.equal(wk.repeat, 'weekdays');
  assert.equal(iso(wk.remindAt), '2026-11-19T07:30:00.000Z');

  const rent = P('Pay rent monthly on 1/12');
  assert.equal(rent.repeat, 'monthly');
  assert.equal(iso(rent.remindAt), '2026-12-01T09:00:00.000Z');
});

test('next week and the weekend', () => {
  const r = P('Buy a present for Aoife next week');
  assert.equal(r.title, 'Buy a present for Aoife');
  assert.equal(iso(r.remindAt), '2026-11-23T09:00:00.000Z');
  assert.equal(iso(P('Clean room this weekend').remindAt), '2026-11-21T09:00:00.000Z');
});

test('priority flag', () => {
  const r = P('Register for exams ! tomorrow');
  assert.equal(r.priority, true);
  assert.equal(r.title, 'Register for exams');
  assert.equal(P('Pay rent!').priority, false); // punctuation, not a flag
});

test('daylight saving: 9am on the morning the clocks go forward', () => {
  const sat = new Date('2027-03-27T12:00:00Z');
  assert.equal(iso(parseQuick('Run tomorrow 9am', { now: sat, tz }).remindAt), '2027-03-28T08:00:00.000Z');
  assert.equal(iso(zonedToUtc(2027, 7, 1, 9, 0, tz)), '2027-07-01T08:00:00.000Z');
});

test('nextOccurrence', () => {
  assert.equal(iso(nextOccurrence('2026-11-20T09:00:00Z', 'weekdays', tz, new Date('2026-11-20T10:00:00Z'))), '2026-11-23T09:00:00.000Z');
  assert.equal(iso(nextOccurrence('2026-01-31T09:00:00Z', 'monthly', tz, new Date('2026-01-31T10:00:00Z'))), '2026-02-28T09:00:00.000Z');
  // weekly 8pm across the clock change keeps 8pm local
  assert.equal(iso(nextOccurrence('2027-03-23T20:00:00Z', 'weekly', tz, new Date('2027-03-24T00:00:00Z'))), '2027-03-30T19:00:00.000Z');
  // completed late: skips past occurrences
  assert.equal(iso(nextOccurrence('2026-11-10T09:00:00Z', 'daily', tz, now)), '2026-11-19T09:00:00.000Z');
});

test('completePatch: one-off closes, repeating rolls forward', () => {
  assert.equal(completePatch({ remind_at: '2026-11-18T10:00:00Z' }, now, tz).done_at, now.toISOString());
  const p = completePatch({ remind_at: '2026-11-18T10:00:00Z', repeat: 'daily' }, now, tz);
  assert.equal(p.done_at, null);
  assert.equal(p.remind_at, '2026-11-19T10:00:00.000Z');
});

test('shouldNag', () => {
  const s = { default_nag_minutes: 30 };
  const base = { kind: 'task', remind_at: '2026-11-18T18:00:00Z' };
  assert.equal(shouldNag(base, now, s), true);
  assert.equal(shouldNag({ ...base, last_nagged_at: '2026-11-18T18:40:00Z' }, now, s), false);
  assert.equal(shouldNag({ ...base, last_nagged_at: '2026-11-18T18:27:00Z' }, now, s), true);
  assert.equal(shouldNag({ ...base, last_nagged_at: '2026-11-18T18:00:00Z', nag_minutes: 0 }, now, s), false);
  assert.equal(shouldNag({ ...base, snoozed_until: '2026-11-18T19:30:00Z' }, now, s), false);
  assert.equal(shouldNag({ ...base, done_at: '2026-11-18T18:10:00Z' }, now, s), false);
  assert.equal(shouldNag({ ...base, remind_at: '2026-11-18T19:30:00Z' }, now, s), false);
  assert.equal(shouldNag({ ...base, kind: 'info' }, now, s), false);
});

test('quiet hours and digest', () => {
  const s = { tz, quiet_start: '23:00', quiet_end: '08:00', digest_time: '08:30' };
  assert.equal(inQuietHours(new Date('2026-11-18T23:30:00Z'), s), true);
  assert.equal(inQuietHours(new Date('2026-11-19T07:59:00Z'), s), true);
  assert.equal(inQuietHours(new Date('2026-11-19T08:00:00Z'), s), false);
  assert.equal(inQuietHours(now, s), false);
  assert.equal(digestDue(new Date('2026-11-19T08:29:00Z'), s, '2026-11-18'), false);
  assert.equal(digestDue(new Date('2026-11-19T08:31:00Z'), s, '2026-11-18'), '2026-11-19');
  assert.equal(digestDue(new Date('2026-11-19T09:00:00Z'), s, '2026-11-19'), false);
});

test('parseInfo', () => {
  assert.deepEqual(parseInfo('Locker code: 4821 #college'), { title: 'Locker code', body: '4821', tags: ['college'] });
  assert.deepEqual(parseInfo('Prof Murphy office hours: Tue 2-4, Rm 201'), { title: 'Prof Murphy office hours', body: 'Tue 2-4, Rm 201', tags: [] });
  assert.deepEqual(parseInfo('https://moodle.example.ie'), { title: 'https://moodle.example.ie', body: '', tags: [] });
  assert.deepEqual(parseInfo('Wifi\nname: Eduroam'), { title: 'Wifi', body: 'name: Eduroam', tags: [] });
});

test('formatWhen', () => {
  assert.equal(formatWhen(new Date('2026-11-18T20:00:00Z'), { now, tz }), 'today 20:00');
  assert.equal(formatWhen(new Date('2026-11-19T09:00:00Z'), { now, tz }), 'tomorrow 09:00');
  assert.equal(formatWhen(new Date('2026-11-20T17:00:00Z'), { now, tz }), 'Fri 17:00');
  assert.equal(formatWhen(new Date('2026-12-01T09:00:00Z'), { now, tz }), 'Tue 1 Dec 09:00');
  assert.equal(formatWhen(new Date('2027-03-03T14:30:00Z'), { now, tz }), 'Wed 3 Mar 2027 14:30');
});

test('deadlines: "due" keeps the deadline and reminds the morning before', () => {
  const r = P('Stats essay due 5/12 5pm #college');
  assert.equal(r.title, 'Stats essay');
  assert.equal(iso(r.dueAt), '2026-12-05T17:00:00.000Z');
  assert.equal(iso(r.remindAt), '2026-12-04T09:00:00.000Z');
  const soon = P('Lab report due tomorrow 9am');
  assert.equal(iso(soon.dueAt), '2026-11-19T09:00:00.000Z');
  assert.equal(iso(soon.remindAt), '2026-11-19T06:00:00.000Z', '3 hours before when the morning before has gone');
  const dateOnly = P('Essay due the 30th');
  assert.equal(iso(dateOnly.dueAt), '2026-11-30T23:59:00.000Z');
  assert.equal(iso(dateOnly.remindAt), '2026-11-29T09:00:00.000Z');
  assert.equal(iso(deadlineReminder(new Date('2026-11-18T20:00:00Z'), now, tz)), '2026-11-18T20:00:00.000Z');
});

test('time ranges make events', () => {
  const w = P('Work 5-10pm fri every week #work');
  assert.equal(w.isEvent, true);
  assert.equal(w.title, 'Work');
  assert.equal(w.repeat, 'weekly');
  assert.equal(iso(w.remindAt), '2026-11-20T17:00:00.000Z');
  assert.equal(iso(w.endAt), '2026-11-20T22:00:00.000Z');
  const l = P('Stats lecture 9:00-11:00 tomorrow');
  assert.equal(iso(l.remindAt), '2026-11-19T09:00:00.000Z');
  assert.equal(iso(l.endAt), '2026-11-19T11:00:00.000Z');
  assert.equal(iso(P('Lunch with Ciara 12-2pm sat').endAt), '2026-11-21T14:00:00.000Z');
  assert.equal(iso(P('Tutorial 11-1pm thursday').remindAt), '2026-11-19T11:00:00.000Z');
  assert.equal(iso(P('Night shift sat 10pm-6am').endAt), '2026-11-22T06:00:00.000Z');
  assert.equal(P('Read pages 10-12').isEvent, false);
});

test('effort: ~15m and ~1.5h', () => {
  const r = P('Reply to emails ~15m');
  assert.equal(r.effortMinutes, 15);
  assert.equal(r.title, 'Reply to emails');
  assert.equal(P('Clean room ~1.5h sat').effortMinutes, 90);
  assert.equal(P('Quick call ~10').effortMinutes, 10);
  assert.equal(fitsIn({ kind: 'task', effort_minutes: 15 }, 15), true);
  assert.equal(fitsIn({ kind: 'task', effort_minutes: 30 }, 15), false);
  assert.equal(fitsIn({ kind: 'task' }, 60), false);
});

test('planMilestones spreads check-ins before a deadline', () => {
  const steps = planMilestones(new Date('2026-12-02T17:00:00Z'), now, tz); // 14 days away
  assert.deepEqual(steps.map((x) => x.label), ['Start', 'First draft', 'Final check']);
  assert.deepEqual(steps.map((x) => iso(x.at)), ['2026-11-22T09:00:00.000Z', '2026-11-27T09:00:00.000Z', '2026-12-01T09:00:00.000Z']);
  assert.deepEqual(planMilestones(new Date('2026-11-23T17:00:00Z'), now, tz).map((x) => x.label), ['Start', 'First draft', 'Final check']);
  assert.deepEqual(planMilestones(new Date('2026-11-21T17:00:00Z'), now, tz).map((x) => x.label), ['Start', 'Final check']);
  assert.deepEqual(planMilestones(new Date('2026-11-19T17:00:00Z'), now, tz), []);
});

test('people: parse, birthdays, catch-ups', () => {
  assert.deepEqual(parsePerson('Aoife bday 14/3 every 2 weeks: exam Thursday #friends'),
    { title: 'Aoife', body: 'exam Thursday', tags: ['friends'], birthday: '03-14', checkinDays: 14 });
  assert.equal(parsePerson('Mam weekly').checkinDays, 7);
  assert.equal(parsePerson('call Dad every week').title, 'Dad');
  const g = parsePerson('Grandad birthday 2 June 1950');
  assert.equal(g.title, 'Grandad');
  assert.equal(g.birthday, '1950-06-02');
  assert.equal(birthdayInfo('03-14', now, tz).daysUntil, 116);
  assert.equal(birthdayInfo('11-18', now, tz).daysUntil, 0);
  assert.equal(birthdayInfo('11-21', now, tz).daysUntil, 3);
  assert.equal(birthdayInfo('1950-06-02', now, tz).turning, 77);
  assert.equal(birthdayInfo('02-29', now, tz).d, 28, 'leap-day birthdays land on the 28th in other years');
  assert.deepEqual(checkinStatus({ checkin_days: 7, last_contact: '2026-11-10T12:00:00Z' }, now), { due: true, daysSince: 8 });
  assert.deepEqual(checkinStatus({ checkin_days: 7, last_contact: '2026-11-15T12:00:00Z' }, now), { due: false, daysSince: 3 });
  assert.equal(checkinStatus({}, now), null);
});

test('events: occurrences and busy', () => {
  const shift = { kind: 'event', remind_at: '2026-11-13T17:00:00Z', ends_at: '2026-11-13T22:00:00Z', repeat: 'weekly' };
  assert.equal(iso(eventOccurrence(shift, now, tz).start), '2026-11-20T17:00:00.000Z');
  const lecture = { kind: 'event', remind_at: '2026-11-18T18:30:00Z', ends_at: '2026-11-18T19:30:00Z' };
  assert.equal(iso(eventOccurrence(lecture, now, tz).start), '2026-11-18T18:30:00.000Z');
  assert.equal(busyNow([lecture], now, tz), true);
  assert.equal(busyNow([{ ...lecture, busy: false }], now, tz), false);
  assert.equal(eventOccurrence({ kind: 'event', remind_at: '2026-11-10T10:00:00Z', ends_at: '2026-11-10T11:00:00Z' }, now, tz), null);
});

test('stars and weekly review timing', () => {
  assert.equal(todayKey(now, tz), '2026-11-18');
  assert.equal(isStarToday({ kind: 'task', star_date: '2026-11-18' }, now, tz), true);
  assert.equal(isStarToday({ kind: 'task', star_date: '2026-11-17' }, now, tz), false);
  const s = { tz, review_day: 0, review_time: '19:00', quiet_start: '23:00', quiet_end: '08:00' };
  assert.equal(reviewDue(new Date('2026-11-22T19:05:00Z'), s, null), '2026-11-22');
  assert.equal(reviewDue(new Date('2026-11-22T18:55:00Z'), s, null), false);
  assert.equal(reviewDue(new Date('2026-11-23T19:05:00Z'), s, null), false, 'Monday');
  assert.equal(reviewDue(new Date('2026-11-22T19:05:00Z'), s, '2026-11-22'), false, 'already done');
});

test('calendar files: timetable repeats, exceptions, moves, deadlines', () => {
  const text = readFileSync(new URL('./fixtures/college.ics', import.meta.url), 'utf8');
  const events = parseICS(text);
  assert.equal(events.length, 7);
  assert.ok(events[2].description.endsWith('folded onto a second line.'));
  assert.equal(events[0].location, 'Science Hub, Room 2.14');
  const occ = icsOccurrences(text, new Date(now - 86400000), new Date(now.getTime() + 120 * 86400000), tz);
  const lectures = occ.filter((o) => o.title.startsWith('STAT20010 Lecture'));
  assert.deepEqual(lectures.map((o) => iso(o.start)), [
    '2026-11-18T10:00:00.000Z', '2026-11-23T14:00:00.000Z', '2026-11-30T10:00:00.000Z',
    '2026-12-02T10:00:00.000Z', '2026-12-07T10:00:00.000Z', '2026-12-09T10:00:00.000Z',
  ]);
  assert.equal(lectures[1].title, 'STAT20010 Lecture (moved)');
  assert.ok(!occ.some((o) => o.title === 'Cancelled tutorial'));
  assert.equal(occ.find((o) => o.title === 'Reading week').allDay, true);
  const a = occ.find((o) => o.title === 'Assignment 2: Regression');
  assert.equal(iso(a.start), '2026-12-04T23:59:00.000Z');
  assert.equal(a.moduleTag, 'stat20010');
  assert.match(a.body, /moodle\.example/);
  assert.ok(!occ.some((o) => o.title === 'Old quiz'), 'past things outside the window are skipped');
  // keys stay stable between syncs
  const again = icsOccurrences(text, new Date(now - 86400000), new Date(now.getTime() + 120 * 86400000), tz);
  assert.deepEqual(again.map((o) => o.key), occ.map((o) => o.key));
});

test('Brightspace noise: one task per assignment, preferring Due', () => {
  const ev = (uid, summary, day, extra = '') => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:202612${day}T170000Z`, `SUMMARY:${summary}`, extra, 'END:VEVENT'].filter(Boolean).join('\r\n');
  const text = ['BEGIN:VCALENDAR',
    ev('a1', 'Lab Report 3 - Availability Starts', '01'),
    ev('a2', 'Lab Report 3 - Due', '05'),
    ev('a3', 'Lab Report 3 - Due', '05'),          // published twice
    ev('a4', 'Lab Report 3 - Availability Ends', '06'),
    ev('b1', 'Quiz 4 - Start Date', '02'),
    ev('b2', 'Quiz 4 - End Date', '09'),           // no Due entry: the end date is the deadline
    ev('c1', 'Weekly announcement', '03'),
    'END:VCALENDAR'].join('\r\n');
  const occ = icsOccurrences(text, new Date('2026-11-18'), new Date('2027-01-01'), tz);
  const kept = filterOccurrences(occ, 'deadlines', 'announcement');
  assert.deepEqual(kept.map((o) => `${o.title} ${o.start.toISOString().slice(5, 10)}`), ['Lab Report 3 12-05', 'Quiz 4 12-09']);
  assert.equal(cleanEventTitle('Essay 2 (Due)'), 'Essay 2');
  assert.equal(cleanEventTitle('Assignment 1 is due'), 'Assignment 1');
  // weekly items with the same name stay separate
  const weekly = ['BEGIN:VCALENDAR', ev('w1', 'Problem sheet - Due', '07'), ev('w2', 'Problem sheet - Due', '14'), 'END:VCALENDAR'].join('\r\n');
  assert.equal(filterOccurrences(icsOccurrences(weekly, new Date('2026-11-18'), new Date('2027-01-01'), tz), 'deadlines').length, 2);
  // timetables: exact repeats merge
  const tt = ['BEGIN:VCALENDAR', ev('t1', 'Lecture', '07'), ev('t2', 'Lecture', '07'), 'END:VCALENDAR'].join('\r\n');
  assert.equal(filterOccurrences(icsOccurrences(tt, new Date('2026-11-18'), new Date('2027-01-01'), tz), 'timetable').length, 1);
});

test('Brightspace content availability is not a deadline; tests get no check-ins', () => {
  const ev = (uid, summary, day, desc = '', url = '') => ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART:202612${day}T080000Z`, `SUMMARY:${summary}`,
    desc && `DESCRIPTION:${desc}`, url && `URL:${url}`, 'END:VEVENT'].filter(Boolean).join('\r\n');
  const text = ['BEGIN:VCALENDAR',
    ev('n1', 'Topic 8: TREATMENT OF TENDON INJURIES – Availability Ends', '19', 'Units:\\nTopic 8 - https://brightspace.ucd.ie/d2l/le/content/400123/viewContent/1/View'),
    ev('n2', 'Week/Topic 3: MUSCLE INJURIES – Availability Ends', '19', '<p>Topic 3 describes the <b>anatomy</b></p>', 'https://brightspace.ucd.ie/d2l/le/content/400123/viewContent/2/View'),
    ev('q1', 'Class Test 3 – Availability Ends', '30', 'Questions cover weeks 1 to 11', 'https://brightspace.ucd.ie/d2l/lms/quizzing/user/quiz_summary.d2l?qi=1'),
    ev('d1', 'Group Design Projects - Due', '29', '<p>1 document per group</p>', 'https://brightspace.ucd.ie/d2l/lms/dropbox/user/folder_submit_files.d2l?db=9'),
    'END:VCALENDAR'].join('\r\n');
  const kept = filterOccurrences(icsOccurrences(text, new Date('2026-11-18'), new Date('2027-01-01'), tz), 'deadlines');
  assert.deepEqual(kept.map((o) => [o.title, o.kind]), [['Group Design Projects', 'assignment'], ['Class Test 3', 'test']]);
  assert.equal(kept[0].body.split('\n')[0], '1 document per group', 'HTML stripped');
});
