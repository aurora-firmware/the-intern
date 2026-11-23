# test/AGENTS.md

How to write a test that passes or fails for the right reason on any machine. Read it with the "Tests" section of
`docs/development/coding_guidelines.md`, which covers fake models, restart tests and hermetic runs.

## Why these rules exist

The tests run on a fast machine that isn't isolated: another project can double its load within a minute. When the
tests that failed now and then were traced (2026-11-16), only two had simply run out of time. The others had one of
these causes:

- The test assumed an order it never set up, such as runs reaching the worker-thread queue in the order of the test's
  calls (B-039, B-043, B-047).
- The test compared two measured durations (B-042).
- The wait could end without proving the outcome (B-044).
- The product had a real race that load exposed: a page showed the data of the read that finished last, not the one
  that started last (B-035, B-038, B-041, B-045).

## Rules

1. **Set up the order a test needs; don't wait for it to happen.** If A must come before B, make A happen, observe it,
   then start B. For example, wait until a run shows in `status`'s `workerThreads.waiting` before starting the next
   run (B-043, B-047).
2. **Force an interleaving to test a race.** Hold the first answer back and release it after the second, instead of
   hoping load produces that order. `holdNextRead` in `test/support/hold_read.ts` does this for a page's reads
   (B-045, B-046).
3. **Wait for a state or an event, never for a length of time.** Poll a state the product exposes, or read the feed,
   until the expected value appears. Don't sleep and then assert.
4. **Prove that nothing happens with an event, not a sleep.** Wait for something that comes after the thing that must
   not happen, such as the run's end, then assert it didn't happen. A fixed sleep passes even when the product is
   wrong.
5. **Don't compare durations.** Two measurements on a shared machine aren't comparable. Turn a timing claim into an
   outcome: S-003 AC-011.3 proves a stalled reader doesn't delay a run by showing that the run finishes while the
   reader still has read nothing. If a spec criterion can only be checked with a stopwatch, raise it instead of
   measuring it.
6. **Make the wait's condition prove the outcome.** The condition must fail when the product does the wrong thing.
   Check the result itself, such as the job in `jobs.list`, not a reply the fake model sends whatever the tool result
   was. Pass Playwright a function predicate, never a string: a string is always truthy, so the wait ends at once
   (B-044).
7. **Read status words as the product defines them.** `running` means a conversation is busy, not that it holds a
   worker thread; `workerThreads.inUse` and `workerThreads.waiting` say that.
8. **Keep waits permissive.** Write every wait and timeout as `scaled(ms)` from `test/support/time_scale.ts`. A wait
   is a safety net for a hang, not a measure of speed. Never scale a value sent to the product beyond what it accepts:
   `submissions.wait` takes a `timeoutMs` of at most `MAX_SUBMISSION_WAIT_MS` (300 s), so scale only waits of 30 s
   or less there, and use `MAX_SUBMISSION_WAIT_MS` itself for a longer one.
9. **Treat a test that fails now and then as a finding.** File a bug, and reproduce it by forcing the interleaving,
   not by loading the machine. Several were real product races.
