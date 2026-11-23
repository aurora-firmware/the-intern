---

name: carry-out-a-part
description: Work a part of a job to completion and write the final answer as the report. Use it when you were given a part of a job to carry out.
---

# Carry out a part

Use this when you were given one part of a job, by a job prompt or a handoff note.

## Steps

1. **Restate the part.** Write down in a sentence or two what the part asks for and how you will tell it is done. If
   the prompt leaves this open, choose the most reasonable reading and note it for the report.
2. **Gather what you need.** Read the files, output and context the part depends on. Look things up before you
   assume them.
3. **Do the work.** Make the changes or produce the result the part asks for. Keep to the part: don't widen the
   scope, and note anything outside it that you found instead of doing it.
4. **Check the result.** Run the checks that prove the part is done and read their output. If a check fails, fix the
   cause and run it again. Don't report a part as done without a check you ran.
5. **Write the final answer.** Your final answer is the report. The agent that invoked you receives it as a new
   input and can't see your conversation, so make it complete on its own.

## What the report contains

- What you did, in a few sentences.
- The result: where it is (paths, identifiers, values) and what it shows.
- The checks you ran and what they printed.
- Anything left undone, uncertain or outside the part that the invoking agent should know.

Finish your part and report. Don't close the job.
