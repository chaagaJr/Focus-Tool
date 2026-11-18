# Focus

A personal app for not forgetting things, and for fitting college, work and people into the same week. Type a line and it becomes a task that keeps reminding you until it's done, a deadline with check-ins planned before it, a lecture or shift on your schedule, a person to keep in touch with, or a bit of info you can find again later. It runs on your iPhone (from the Home Screen) and your Windows PC (as an installed app), stays in sync, pulls in your timetable and Moodle deadlines, and works with Siri, Shortcuts and automations.

- **Setting it up:** [SETUP.md](SETUP.md) (about an hour, once)
- **Shortcuts, Siri and automations:** [SHORTCUTS.md](SHORTCUTS.md)

## What's in it

| | |
|---|---|
| **Tasks** | Nag you every 30 minutes (your choice) once they're due, until you tick them off. Grouped into Needs you, Later today, Coming up and Anytime. |
| **Today's 3** | Star up to three tasks a day. They sit at the top and lead the morning summary. |
| **Deadlines** | `essay due 5/12 5pm` keeps the deadline and reminds you the morning before. **Plan check-ins** adds Start, First draft and Final check, spread out so it doesn't all land the night before. |
| **Schedule** | Lectures, labs and shifts, typed in (`work 5-10pm fri every week`) or pulled from your timetable and rota. You get a heads-up before each one, and other reminders hold off while they're on. |
| **People** | Birthdays (a nudge 3 days before, the day before, and on the day) and "catch up every 2 weeks" reminders that stop as soon as you tap **Talked today**. |
| **Got 15 min** | Give tasks a length (`~15m`) and Focus shows what fits the gap you have. |
| **Weekly review** | On Sunday evening (you can change this), a notification takes you through five minutes of setting up the week: what slipped, what has no date, deadlines to plan, people, and what's on. |
| **Info** | Locker codes, room numbers, office hours, links to module pages and notes. Copy or open them with one tap. |
| **Calendars** | Pulls in your college timetable, Moodle/Brightspace/Canvas/Blackboard deadlines, work rota and Google/Outlook calendars. Also gives you a link so Focus shows up in Apple Calendar or Outlook. |

## Typing it in

Type in the box at the top and press Enter. Choose **Task**, **Person** or **Info** above it. Below the box you see how your line was understood before you press Enter.

| You type | You get |
|---|---|
| `Submit lab report fri 5pm #college` | Task, reminder Friday 17:00, tagged college |
| `remind me to call the dentist tomorrow at 10` | "Call the dentist", tomorrow 10:00 |
| `check the oven in 20 min` · `pack bag tonight` · `email tutor tomorrow morning` | In 20 minutes · 20:00 · 09:00 tomorrow |
| `renew passport 2/1` · `buy present next week` · `clean room this weekend` | Dates are day/month · next Monday · Saturday |
| `stats essay due 5/12 5pm ~2h` | Deadline Fri 5 Dec 17:00, reminder the morning before, takes about 2 hours |
| `work 5-10pm fri every week #work` · `gym 7-8pm tomorrow` | A time range puts it on your schedule |
| `bins out every tuesday 8pm` · `vitamins every morning` · `rent monthly on 1/12` | Repeating tasks |
| `reply to emails ~15m` | Shows up under **Got 15 min** |
| `register for exams ! tomorrow` | Priority: nags every 10 minutes |
| *(Person)* `Aoife bday 14/3 every 2 weeks: exam Thursday` | Birthday 14 March, catch-up nudge every 2 weeks, a note |
| *(Person)* `Mam weekly` · `Grandad birthday 2 June 1950` | |
| *(Info)* `Locker code: 4821 #college` | Title "Locker code", note "4821" |

Tap anything to change it: times, notes, repeat, how often it nags, how long it takes, birthdays and so on.

## How reminders behave

- When a task's time comes, every device with notifications on gets one. It repeats at your "keep reminding" interval until you tick it off or snooze it.
- Nothing arrives during quiet hours (23:00 to 08:00 by default). While a lecture or shift is on, nags wait and come through when it ends.
- **Morning summary** (08:30): what's on, your 3, what's due, birthdays.
- **People nudge** (18:00): who's due a catch-up, birthdays coming up.
- **Weekly review** (Sunday 19:00).
- **Heads-ups** before lectures and shifts (15 minutes for imported ones, 30 for your own; change in Settings).

All of these times are in Settings, and you can leave any of them empty to turn it off.

On Windows, notifications have **Done** and **Snooze** buttons. On iPhone, tapping one opens the right thing.

## How it fits together

```
 iPhone (Home Screen app)       Windows (installed app)       iPhone Shortcuts / scripts
          │                               │                              │
          └────────────── HTTPS + your key ┴─────────────────────────────┘
                                          │
                       Supabase Edge Function "focus"  ◄── cron, once a minute ("tick")
                         │            │            │
              Postgres (your items)   │     Web Push ──► notifications
                                      │
         your calendar links (timetable, Moodle, rota) ──► pulled in every 6 hours
         Apple Calendar / Outlook ◄── your Focus calendar link (read-only)
```

- **`app/`**: the web app. Plain HTML, CSS and JavaScript with no build step. Hosted on GitHub Pages. Works offline: changes queue up and send when you're back online.
- **`supabase/functions/focus/index.ts`**: the whole backend in one file: saving, syncing, calendars, the Shortcuts API, and sending reminders.
- **`supabase/schema.sql`**: the tables. **`supabase/cron.sql`**: the once-a-minute clock.
- **`app/shared.js`**: what both sides need: the "fri 5pm" parser, repeats, deadlines and check-ins, birthdays, the calendar-file reader, and the rules for when to nag. A copy of it lives inside the function file.
- **`tests/`**: 48 automated tests, for the parser and calendar reading and for the server (run with a fake database and push service), plus a sample college calendar.

Your data lives only in your own Supabase project. The tables are locked so the public keys can't read them: only your function can, and it only answers requests that carry your Focus key. Your calendar feed uses a separate read-only token.

## Changing things

The code is commented and meant to be read. Some starting points:

| To change… | Look in |
|---|---|
| Colours, spacing, fonts | `app/styles.css` (the variables at the top, with a dark set below) |
| What the lists show, or the buttons | `app/app.js`: `taskRow`, `eventRow`, `personRow`, `renderTasks`, `renderPeople`, `renderInfo` |
| The weekly review | `app/app.js`: `renderReview` |
| What phrases are understood | `app/shared.js`: `parseQuick`, `parsePerson` (add a test in `tests/shared.test.mjs`) |
| How check-ins are spaced out | `app/shared.js`: `planMilestones` |
| When and what gets sent | `supabase/functions/focus/index.ts`: `tick` |
| New things Shortcuts can do | the `ACTIONS` list in the same file |

After changing the app:
1. Bump `VERSION` at the top of `app/sw.js` (e.g. `focus-v3`) so your phone and PC fetch the new files. They switch over the next time you open the app.
2. Commit to GitHub. It republishes by itself.

After changing **`app/shared.js`** or the function: copy `shared.js` into the function file and redeploy it in Supabase (Edge Functions → focus → Code → paste → Deploy). If you have Node.js installed (`winget install OpenJS.NodeJS.LTS`), `npm run build:function` does the copying for you, and `npm test` runs the tests.

### Trying it on your PC

With Node.js installed, run these in the `focus` folder in two terminals:

```
node tests/dev-server.mjs
npx serve app -l 8080
```

Open http://localhost:8080, then Settings → URL `http://localhost:8787/functions/v1/focus`, key `dev-key`. This is a fake server that keeps everything in memory and prints notifications in the terminal instead of sending them, so nothing touches your real data.

### Ideas for later

- A Home Screen widget, via a Shortcut that runs `today` and shows the result
- Subtasks for any task, not just deadline check-ins
- Exam countdowns and study-session planning around your timetable
- A "this week" view laid out like a timetable
- Location reminders ("when I get to college"), using a Shortcuts automation that calls `due` with a tag

## Server API

`POST` to your function URL with header `x-focus-key: <your key>` and a JSON body. Every reply has `ok`, and most have a human-readable `message` for Siri to read out.

| `action` | Fields | Returns |
|---|---|---|
| `add` | `text` (understood like the app), or fields (`title`, `body`, `remind_at`, `due_at`, `ends_at`, `tags`, `repeat`, `effort_minutes`, `priority`, `birthday`…); `type`: `task` (default), `info` or `person`; `when`: e.g. `"tomorrow 3pm"` | `item`, `message` |
| `today` | | schedule, today's 3, what's due, birthdays as one `message` |
| `due` | `scope`: `today` (default) or `all`; `tag` | `tasks`, `count`, `message` |
| `free` | `minutes` (default 15) | the best 3 tasks that fit |
| `catchup` | | people due a catch-up, birthdays this week |
| `contacted` | `id`, or `match` (part of a name) | marks that you were in touch |
| `star` | `id` or `match`; `on`: `false` to unstar | today's 3 (max three) |
| `plan` | `id` of a task with a deadline | adds check-ins before it |
| `search` | `q` | `items`, `message` |
| `complete` | `id`, or `match` (part of the title) | `item`, `message` |
| `snooze` | `id`, `minutes` (default 60) or `until` | `item`, `message` |
| `update` | `id`, `patch` | `item` |
| `uncomplete`, `delete` | `id` | |
| `list` | `all`: include tasks finished over 30 days ago | `items` |
| `feeds`, `feed_save`, `feed_sync`, `feed_delete` | `feed`: `{ name, url, type: timetable or deadlines, tag, lead_minutes, busy, auto_plan }`, or `id` | your calendar links |
| `calendar` | | the token for your read-only calendar feed: `GET ?action=ics&token=…` |
| `settings` | `patch`: any of `default_nag_minutes`, `quiet_start`, `quiet_end`, `digest_time`, `people_time`, `review_day` (0 = Sunday), `review_time`, `heads_up_minutes`, `hold_during_busy`, `default_hour`, `tz` | `settings` |
| `test` | | sends a test notification to every device |
| `export` / `import` | `items` for import | full backup |
| `ping` | | settings and the push key |
| `tick` | | used by the cron job |

## Limits worth knowing

- iPhone notifications need iOS 16.4+ and only work when Focus is opened from the Home Screen.
- On iPhone, notifications can't have Done/Snooze buttons (Apple doesn't allow them for web apps). Tap to open, or use the "Done with" shortcut.
- Calendar links are fetched every 6 hours. Use **Sync now** in Settings after a change. Calendar apps refresh your Focus feed on their own schedule, usually every hour or few hours.
- Lecture notes themselves can't be pulled out of Moodle without a login. Save links to the module pages in Info and they're one tap away.
- The free Supabase plan has no automatic backups: use **Settings → Download backup** now and then. Free projects pause after a week with no activity; the reminder clock and your normal use should prevent that, and a paused project can be resumed from the dashboard with nothing lost.
- Reminders can be a minute or two late: the server checks every minute and phones sometimes batch notifications.
