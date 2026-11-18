# Setting up Focus

About an hour, once. Everything here is on free plans.

> **Already set up the first version?** You only need three things: run `supabase/schema.sql` again (it adds the new columns and keeps your data), paste the new `supabase/functions/focus/index.ts` into the function and deploy, and upload the new `app` files to GitHub. Then do steps 9 and 10 below.

You'll end up with:

- the app at a web address of your own (GitHub Pages), installed on your Windows PC and on your iPhone's Home Screen
- a small private server (Supabase) that keeps your tasks in sync and sends reminder notifications every few minutes until you tick things off

You need: a GitHub account, a Supabase account (sign in with GitHub), an iPhone on iOS 16.4 or later, and Edge or Chrome on your PC.

> **Try it first?** You can skip all of this for a few minutes: open `app/index.html` through any local web server and the app works on that one device, without sync or notifications (see "Trying it on your PC" in README.md).

---

## 1. Put the app online (GitHub Pages)

1. On github.com, click **New repository**. Name it `focus`, choose **Public**, and tick **Add a README** so the repo isn't empty. Create it.
   *Public is needed for free Pages. Nothing secret is in the code: your key is typed into the app on each device, never saved in the repo. If you have the GitHub Student Developer Pack you can make it private.*
2. In the new repo click **Add file → Upload files**. Open the `focus` folder from this download in File Explorer, select **everything inside it** (`app`, `supabase`, `tests`, `tools`, `.github`, the `.md` files, `package.json`, `.gitignore`) and drag it onto the page. Click **Commit changes**.
   *Check that the `.github` folder came across. If it didn't, use **Add file → Create new file**, type `.github/workflows/pages.yml` as the name, and paste in the contents of that file.*
3. Go to **Settings → Pages**. Under **Build and deployment → Source**, pick **GitHub Actions**.
4. Open the **Actions** tab. If the "Publish app" run hasn't started, choose it and click **Run workflow**. After a minute it turns green.
5. Your app is now at **`https://YOUR-GITHUB-NAME.github.io/focus/`**. Open it to check it loads.

*Later, to change the app, edit files on GitHub (or use GitHub Desktop) and it republishes on its own.*

## 2. Create the database (Supabase)

1. On supabase.com, click **New project**. Pick any name (e.g. `focus`), make up a database password (save it in your password manager, though you won't need it day to day), and choose the region **West EU (Ireland)**. Create it and wait a minute or two.
2. In the left sidebar open **SQL Editor → New query**. Paste in the whole of `supabase/schema.sql` and click **Run**. It should say "Success. No rows returned".

## 3. Make your key

The key is a long password that lets your devices and Shortcuts talk to your server.

1. Open your app (`https://YOUR-GITHUB-NAME.github.io/focus/`) on your PC, open **Settings** (the sliders icon, top right) and click **Make a new key**. It's shown in a box and copied to your clipboard.
2. In Supabase, open **Edge Functions → Secrets** (sometimes labelled "Manage secrets"). Add a secret:
   - Name `FOCUS_KEY`, value: the key you just made.
3. Add a second secret: name `PUSH_CONTACT`, value `mailto:` followed by your real email address (e.g. `mailto:aoife.murphy@gmail.com`). Push services, Apple's included, expect a real contact address and may refuse to deliver without one.
4. Keep the key somewhere safe, like your password manager. You'll paste it into your phone and into Shortcuts.

## 4. Deploy the server code

1. In Supabase, open **Edge Functions** and choose **Deploy a new function → Via Editor**.
2. Name it exactly **`focus`**.
3. Delete the sample code in the editor, then paste in the whole of `supabase/functions/focus/index.ts`. Click **Deploy function**.
4. Open the function's details or settings and **turn off "Verify JWT"** (it may say "Enforce JWT verification" or "Verify JWT with legacy secret"). Save.
   *This matters: the function checks your Focus key itself. With the switch on, every request is turned away with a 401 before your code runs.*
5. Copy the function's URL. It looks like `https://abcdefghijkl.supabase.co/functions/v1/focus`. The `abcdefghijkl` part is your **project ref**.

## 5. Start the reminder clock

1. Open `supabase/cron.sql` in Notepad. Replace `YOUR-PROJECT-REF` with your project ref and `YOUR-FOCUS-KEY` with your key.
2. Paste the edited file into **SQL Editor → New query** and **Run**.

From now on the server checks for due tasks once a minute. To check it's working, run this a couple of minutes later:

```sql
select status_code, content, created from net._http_response order by created desc limit 5;
```

You want `200` and something like `{"ok":true,"nagged":0,...}`. A `401` means the key in `cron.sql` doesn't match `FOCUS_KEY`.

## 6. Set up your PC (Windows)

1. Open your app in **Edge** or **Chrome**. Settings → paste the **Function URL** and your **key** → **Connect**. If you already added things, leave "Upload what's already on this device" ticked.
2. **Install it as an app**: in Edge, the "App available" icon in the address bar (or **⋯ → Apps → Install this site as an app**). In Chrome, the install icon in the address bar. Pin it to the taskbar if you like. Right-clicking the taskbar icon gives you **Add a task** and **Add info** shortcuts.
3. In the installed app: Settings → **Turn on notifications** → Allow. Then **Send a test**.
4. So reminders arrive when the app is closed, let the browser keep running in the background:
   - Edge: Settings → **System and performance** → turn on **Continue running background extensions and apps when Microsoft Edge is closed**.
   - Chrome: Settings → **System** → turn on **Continue running background apps when Google Chrome is closed**.
5. Check that Windows isn't hiding them: **Settings → System → Notifications** → make sure Edge/Chrome is allowed, and that **Do not disturb** isn't on.

## 7. Set up your iPhone

1. Open your app's address in **Safari**.
2. Tap **Share → Add to Home Screen → Add**. From now on, always open Focus from the Home Screen icon (notifications only work there, not in a Safari tab).
3. Open it from the Home Screen → Settings → paste the **Function URL** and **key** → **Connect**.
   *To get the key onto your phone, copy it from your password manager, or email it to yourself and delete the email afterwards.*
4. Tap **Turn on notifications** → **Allow**, then **Send a test**.
5. Optional: iPhone **Settings → Notifications → Focus** → set **Banner Style** to **Persistent**, so a reminder stays on screen until you deal with it.

## 8. Check it end to end

Type `test in 2 min` in the app and press Enter. Lock your phone. Within about three minutes you should get a notification on both devices, and another one after your "keep reminding" interval (30 minutes by default) until you tick it off.

## 9. Add your timetable, Moodle and work rota

In the app: **Settings → Calendars, timetable and college**. For each calendar:

1. Get its link (the **Where do I find the link?** list in Settings has the steps for Moodle, Brightspace, Canvas, Blackboard, Google, Outlook and rota apps). It ends in `.ics` or starts with `webcal://`. Moodle's has a long token in it: that token is what lets Focus read it without your password, so treat it like a password.
2. Give it a name and choose what's in it:
   - **Classes, shifts or plans**: each one goes on your schedule, gives you a heads-up beforehand, and holds other reminders while it's on.
   - **Assignments and deadlines**: each one becomes a task with the deadline, a reminder the morning before, and (for anything more than a week away) check-ins planned before it.
3. Add a tag (e.g. `college` or `work`) and click **Add calendar**. It syncs straight away, then every 6 hours.

Things you finish stay finished, even when the calendar syncs again. If an assignment's deadline moves in Moodle, it moves in Focus too.

## 10. See Focus in your calendar (optional)

Settings → **Show Focus in your calendar** → **Get my calendar link**.
- **iPhone**: tap **Open in Calendar** and confirm, or go to Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → **Add Subscribed Calendar** and paste the link.
- **Outlook**: Add calendar → **Subscribe from web** → paste the link.

Your timed tasks, deadlines, your own events and birthdays then show up next to everything else. It's read-only, so make changes in Focus. Calendars imported in step 9 aren't repeated in it.

Now set up your Shortcuts: see **SHORTCUTS.md**.

---

## If something's not working

| What you see | What to do |
|---|---|
| "Couldn't reach that URL" when connecting | Check the URL ends in `/functions/v1/focus`, the function is deployed, and **Verify JWT is off**. |
| "The server rejected that key" | The key in the app must match the `FOCUS_KEY` secret exactly (no spaces). |
| "The FOCUS_KEY secret is not set" | Add the secret (step 3), then try again. No redeploy needed. |
| No notifications on iPhone | Open Focus from the Home Screen, not Safari. Settings → Notifications → Focus must be allowed. iOS 16.4+ needed. |
| No notifications on PC | Turn on background running (step 6.4) and check Windows notification settings and Do not disturb. |
| Notifications stop at night | That's quiet hours (11pm to 8am by default). Change them in the app's Settings. |
| Reminders a few minutes late | The server checks once a minute, and phones sometimes hold notifications for a little while to save battery. |
| Email saying your project will be paused | Free projects with no activity for a week get paused. The once-a-minute check plus your own use should keep it awake, but if it is paused, open Supabase and click **Resume project**. Nothing is lost. |
| A calendar says "Problem: …" in Settings | Open the link in a browser. If it asks you to log in, it's not a shareable calendar link: look for Export, Subscribe or iCal instead. Moodle export links stop working if you reset your Moodle security key, so make a new one. |
| Lectures show at the wrong time | Check Settings → How reminders behave shows your time zone. Calendars that give no time zone are read in yours. |
| See the server's error messages | Supabase → Edge Functions → focus → **Logs**. |
