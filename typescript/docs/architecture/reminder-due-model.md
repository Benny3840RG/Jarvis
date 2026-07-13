# Reminder due model

Status: accepted

Jarvis stores reminder timing in three fields:

- `dueRaw`: the exact user-supplied due text after outer whitespace is removed.
- `dueAt`: an optional Unix timestamp in milliseconds.
- `dueTimezone`: an optional timezone descriptor explaining how the timestamp was interpreted.

`dueAt` and `dueTimezone` must either both exist or both be absent. A normalized value must also retain `dueRaw`. Unrecognised or ambiguous text remains useful as `dueRaw` and is not forced into a guessed timestamp.

The CLI parser is deliberately conservative. It accepts explicit ISO instants, local ISO or Australian calendar dates, `today` or `tomorrow` with a time, and named weekdays with a time. Local wall-clock input uses `JARVIS_TIMEZONE` or the machine IANA timezone. Invalid calendar dates, non-existent daylight-saving wall times, and repeated daylight-saving wall times are left unnormalized.

For local wall-clock input, `dueTimezone` is an IANA timezone such as `Australia/Melbourne`. For an ISO instant containing an explicit offset, it is a fixed-offset descriptor such as `UTC+10:00`. Both forms are validated before storage or restore.

JSON document version 2 and backup version 2 use these fields. Version 1 JSON documents, version 1 backup archives, and existing Convex rows with the legacy `due` field are read compatibly and mapped to `dueRaw` without fabricating a timestamp.
