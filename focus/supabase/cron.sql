-- Focus — the reminder clock.
-- Runs your edge function once a minute so it can send any reminders that are due.
--
-- BEFORE RUNNING: replace the two placeholders below
--   YOUR-PROJECT-REF  → the part before .supabase.co in your Project URL
--   YOUR-FOCUS-KEY    → the same key you saved as the FOCUS_KEY secret
-- Then paste into Supabase → SQL Editor → Run.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Remove an older copy of the job if you're re-running this file.
select cron.unschedule(jobid) from cron.job where jobname = 'focus-tick';

select cron.schedule(
  'focus-tick',
  '* * * * *',   -- every minute
  $$
  select net.http_post(
    url     := 'https://hyqxytmodzuharzrbpfh.supabase.co/functions/v1/focus',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-focus-key',  'YOUR-FOCUS-KEY'
               ),
    body    := jsonb_build_object('action', 'tick')
  );
  $$
);

-- Handy checks (run separately):
--   select * from cron.job;                                                   -- is the job there?
--   select status, return_message, start_time from cron.job_run_details
--     order by start_time desc limit 10;                                      -- did it run?
--   select status_code, content, created from net._http_response
--     order by created desc limit 10;                                         -- what did the function say?
--
-- To stop all reminders:  select cron.unschedule('focus-tick');
