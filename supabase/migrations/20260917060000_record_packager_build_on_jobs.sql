-- Which build of the packager produced a job.
--
-- The packager is deployed separately from the web app, on its own machine and
-- release cadence, so "which version is running" cannot be answered by looking
-- at the server. Recording it with the claim also means a finished package
-- still names the build behind it after that packager has been upgraded - the
-- question is usually asked once something looks wrong.
--
-- Free text rather than a structured pair: it holds a version, a commit and
-- where that commit was read from, and it is only ever read by a human.
ALTER TABLE packaging_jobs
  ADD COLUMN IF NOT EXISTS packager_build TEXT;

COMMENT ON COLUMN packaging_jobs.packager_build IS
  'Packager build identity reported at claim time, e.g. "1.4.0+abc1234 (git)".';
