# iPhone Shortcuts and automations

Your Focus server has a simple web address that Shortcuts can call, so you can add things by voice, ask what's due, look up a note, or tick something off without opening the app.

Every shortcut below uses the same action, **Get Contents of URL**, set up like this:

- **URL**: your function URL, `https://YOUR-PROJECT-REF.supabase.co/functions/v1/focus`
- Tap **Show More** (or the ⓘ arrow):
  - **Method**: `POST`
  - **Headers** → Add new header → Key `x-focus-key`, Text = *your key*
  - **Request Body**: `JSON`, then add the fields listed for each shortcut (all of type **Text**)

The server always replies with a `message` you can show or speak: "Added: Submit lab report — ⏰ Fri 17:00 — #college".

> Build the first one fully, then long-press it in the Shortcuts app → **Duplicate** and change the fields. That way you only type the URL and key once.

---

## 1. "Remember": add a task by voice

1. **Ask for Input**: Text, prompt *What do you need to remember?*
2. **Get Contents of URL** with body fields
   - `action` = `add`
   - `text` = **Provided Input** (tap the field, choose the blue variable)
3. **Get Dictionary Value**: Get **Value** for key `message` in **Contents of URL**
4. **Show Notification**: **Dictionary Value**

Say *"Hey Siri, Remember"*, then *"submit lab report Friday at 5 hashtag college"*. Everything you can type in the app works here: `tomorrow at 10`, `in 20 minutes`, `every Tuesday 8pm`, `next week`, `!` for priority.

Quick ways to run it without Siri:
- **Back Tap**: iPhone Settings → Accessibility → Touch → Back Tap → Double Tap → *Remember*
- **Action button** (iPhone 15 Pro and later): Settings → Action Button → Shortcut → *Remember*
- **Control Centre** or **Lock Screen** (iOS 18): add a control → Shortcuts → *Remember*

## 2. "Note this": save a bit of info

Same as above, with body fields `action` = `add`, `type` = `info`, `text` = **Provided Input**.
Say *"Hey Siri, Note this"*, then *"Locker code: 4821"*. The part before the colon becomes the title.

## 3. "What's due": hear today's list

1. **Get Contents of URL** with `action` = `due`
2. **Get Dictionary Value**: `message`
3. **Speak Text** (or **Show Result**)

Extra fields you can add: `scope` = `all` for everything open, `tag` = `college` for one tag only.

## 4. "Look up": find a note

1. **Ask for Input**: *What are you looking for?*
2. **Get Contents of URL** with `action` = `search`, `q` = **Provided Input**
3. **Get Dictionary Value**: `message` → **Show Result**

*"Hey Siri, Look up"* → *"locker"* → "Locker code: 4821".

## 5. "Done with": tick something off by name

1. **Ask for Input**: *What did you finish?*
2. **Get Contents of URL** with `action` = `complete`, `match` = **Provided Input**
3. **Get Dictionary Value**: `message` → **Show Notification**

A few words are enough: *"lab report"* finds "Submit lab report". Repeating tasks move on to their next time.

## 6. "My day": everything for today in one go

**Get Contents of URL** with `action` = `today` → **Get Dictionary Value** `message` → **Speak Text**.
You hear what's on (lectures, shifts), your 3, what else is due, and any birthdays.

## 7. "Got 15 minutes"

1. **Choose from Menu**: *15 min*, *30 min*, *An hour*. In each branch, a **Number** action with `15`, `30` or `60`.
2. **Get Contents of URL** with `action` = `free`, `minutes` = the menu's **Number** (Request Body field type **Number**)
3. **Get Dictionary Value** `message` → **Show Result**

Only tasks you've given a length to (`~15m` when typing, or "How long it takes" when editing) show up.

## 8. "Who should I call" and "Talked to"

- **Who should I call**: `action` = `catchup` → `message` → **Show Result**. Lists who you're due to catch up with and birthdays this week.
- **Talked to**: **Ask for Input** *Who?* → `action` = `contacted`, `match` = **Provided Input** → **Show Notification** with `message`. Say *"Hey Siri, Talked to"*, then *"Mam"*.

## 9. "Star it": add to today's 3

**Ask for Input** *Which task?* → `action` = `star`, `match` = **Provided Input** → **Show Notification** with `message`.

## 10. "Save to Focus" from the Share sheet

1. Create a shortcut, open its settings (ⓘ) and turn on **Show in Share Sheet**. Accept **URLs** and **Text**.
2. **Get Contents of URL** with `action` = `add`, `type` = `info`, `text` = **Shortcut Input**
3. **Show Notification**: *Saved to Focus*

Now any link or highlighted text can be shared straight into your Info list. Use `type` = `task` instead if you'd rather it became a task to deal with.

---

## Automations (they run by themselves)

Shortcuts app → **Automation** tab → **+**. For each one, choose **Run Immediately** so it doesn't ask first (iOS 17 and later).

| When | Do | Why |
|---|---|---|
| **Time of Day** 08:00, weekdays | "My day" with **Speak Text** | Hear your day while getting ready |
| **Alarm** → is stopped | "My day" | Same thing, tied to your wake-up alarm |
| **Time of Day** Sunday 11:00 | "Who should I call" | A gentle weekend nudge about family and friends |
| **Leave** → Home | `due`, then **Show Notification** with the message | "Before you go…" reminders |
| **Arrive** → your college | `due` with `tag` = `college` | Only the college things, as you walk in |
| **Focus** → Study → when turning on | `due` with `tag` = `college` | Shows the work list when you start studying |
| **NFC** → a sticker on your desk | "Remember" | Tap your phone on the desk to jot something down |

Focus also sends a morning summary, an evening people nudge and a Sunday review by itself, with no automation needed. Set their times (or turn them off) in the app's Settings.

---

## From Windows

**Open the app ready to type**: make a desktop shortcut to
`https://YOUR-GITHUB-NAME.github.io/focus/?add=` (or `?add=&kind=info`). The installed app also offers these when you right-click its taskbar icon.

**From PowerShell, a script or Task Scheduler**:

```powershell
$url = 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/focus'
$key = 'YOUR-FOCUS-KEY'
$body = @{ action = 'add'; text = 'Print notes for lab tomorrow 8am #college' } | ConvertTo-Json
(Invoke-RestMethod -Method Post -Uri $url -Headers @{ 'x-focus-key' = $key } -ContentType 'application/json' -Body $body).message
```

**Power Automate Desktop**: use the **Invoke web service** action with the same URL, method POST, header `x-focus-key`, and a JSON body.

The full list of actions and fields is in README.md → "Server API".

---

**Keep your key private.** Anyone with it can read and change your list. If it leaks: make a new one in the app's Settings, update the `FOCUS_KEY` secret in Supabase and the key in `cron.sql` (run it again), then reconnect each device and update your Shortcuts.
