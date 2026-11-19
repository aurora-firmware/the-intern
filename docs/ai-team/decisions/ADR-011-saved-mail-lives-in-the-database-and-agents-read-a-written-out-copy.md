---
id: ADR-011
title: Saved mail lives in the database, and agents read a written-out copy
status: accepted
created: '2026-11-19'
---

# ADR-011: Saved mail lives in the database, and agents read a written-out copy

## Context

The daemon saves every email it takes in, the message exactly as received and each attachment byte for byte, and a
job's agents read them as files (S-009 REQ-007). The export stays one file that opens as a database, carries every
saved message and attachment, and `bob import` restores them with their jobs (S-009 REQ-024; S-004 REQ-016, AC-016.1,
REQ-017). Saved mail lives as long as its job.

## Decision

Each saved email's raw bytes are a row of the job store, and the files agents read are a copy the daemon writes out
from it.

1. **The source.** The job store's `intern_mail_messages` table holds each saved email's raw bytes in one `BLOB`
   column, beside what the daemon needs to route and show it: the account, the IMAP UIDVALIDITY and UID, the
   `Message-ID`, `In-Reply-To`, `References`, sender, subject, date and the list of attachments. The text and the
   attachments aren't stored apart: they're decoded from the raw bytes. The row is written in a transaction of its own,
   never with a job write.
2. **The copy.** The daemon writes each saved email out to `<state dir>/mail/<saved id>/`: `message.eml` (the raw
   bytes), `message.txt` (its text, or the text of its HTML part) and `attachments/<n>-<name>`, where `n` keeps two
   attachments of one name apart and `name` loses path separators and control characters. Folders are `0700` and files
   `0600`. It writes the copy at intake, before the email becomes a job or an input, and at startup step 7, before
   `host.resume()`, for each saved email whose folder is missing. It never reads the copy back.
3. **The paths.** A job's request, and the input a reply becomes, name the copy's paths as they were at intake.
   `jobs.get` and the job tools compute the paths from the state directory at each read.
4. **Export and import.** The online backup carries the rows with the rest of the database, so the export stays one
   SQLite file and the import places it unchanged (ADR-001 decision 1). The first start after an import writes the copy.

## Consequences

- The database is the only source of saved mail. A copy that is deleted or edited is written again from it at the next
  start, and an edit to it never reaches the job record.
- The export and the database grow with every email kept, attachments included, and nothing deletes a saved email
  (S-009 Exclusions).
- A large email is one long write on the one connection and delays the commits queued behind it once (ADR-001,
  Consequences).
- After an import into a state directory at another path, transcripts written before it still name the old paths;
  `jobs.get` and the job tools give the new ones.
- An upgrade of the MIME parser could decode an old message differently. The raw bytes stay exact.

## Alternatives Considered

- **Files beside the database, with an archive as the export:** rejected because the export would stop being one file
  that opens as a database, and the files couldn't be copied consistently with the online backup.
- **Each attachment in its own row as well:** rejected because it keeps every attachment twice, once encoded in the
  message.
- **Agents read saved mail only through a tool:** rejected because S-009 REQ-007 asks for files, which any role reads
  with `read`, whether or not its tool set names `mail`.
- **The copy in the data directory:** rejected because that folder holds what team members edit; the copy derives from
  the database and sits beside it.
