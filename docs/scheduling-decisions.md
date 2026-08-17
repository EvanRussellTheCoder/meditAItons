# Meditation scheduling: implementation decisions

This log records every material decision behind the conversation-aware Cal.com scheduling feature.
It complements the routing and localhost-chat decision logs.

1. **Scheduling is a first-class route.** The classifier emits
   `SCHEDULE/MEDITATION_SCHEDULING` when the user wants a calendar action. It is not folded into
   `IN_SCOPE`, because an external side effect needs a different trust and consent boundary.

2. **Safety keeps higher priority than scheduling.** A scheduling phrase combined with imminent
   self-harm, violence, abuse, or another safety concern receives `SAFETY`. Calendar convenience
   must never bypass the established crisis route.

3. **Only `IN_SCOPE` retrieves.** `SCHEDULE` never creates an embedding, queries Pinecone, or asks
   the grounded-answer model to improvise calendar behavior. `MeditationsChatService` calls only the
   scheduling proposal gateway on that branch.

4. **Ongoing conversation context is supported in two bounded stages.** The route classifier sees
   recent user turns to recognize a follow-up such as “Tuesday at 7.” The scheduling extractor sees
   up to eight recent user/Marcus messages to recover date and time constraints. Both serialized
   inputs are labeled untrusted data and OpenAI requests set `store: false`.

5. **Extraction uses Structured Outputs.** `gpt-5.6-luna` with reasoning effort `none` returns one
   of `ready` or `needs_clarification`, optional ISO local date/time fields, an ambiguity category,
   and an optional clarification question. Application code validates the schema again and rejects
   past dates or inconsistent combinations. A small classification/extraction model keeps latency
   and cost proportional to the task.

6. **Missing information is editable; contradictory information is clarified.** A missing date
   defaults visibly to the next weekday and a missing time to 09:00. The user can edit both before
   confirmation. “Tuesday or Wednesday” and “at 7” when AM/PM cannot be inferred produce a chat
   clarification instead of a guessed card.

7. **The browser supplies an IANA timezone.** Calendar language such as “Tuesday at 7” is local to
   the user. The server validates the timezone before extraction and again before booking; it does
   not infer location from IP address.

8. **Local wall time is converted without a date library.** The converter tests possible offsets
   with `Intl.DateTimeFormat`. It rejects spring-forward times that do not exist and fall-back
   times that occur twice rather than silently shifting or choosing one occurrence. A production
   multi-zone system could instead adopt the Temporal API or a maintained timezone library.

9. **Proposal and booking are separate HTTP actions.** `POST /api/chat` can create a server-held
   proposal ID and return an editable card. Only `POST /api/schedule`, after the user presses
   **Confirm meditation time**, can call Cal.com. This is the central human-confirmation guardrail.

10. **Proposals are one-time and short-lived.** IDs are cryptographically random by default, live
    in server memory for 30 minutes, and transition through pending, in-flight, booked, or uncertain
    states. This is sufficient for the loopback development app. A production multi-instance
    service would use an authenticated durable store with atomic idempotency records.

11. **The card collects name and email only at confirmation time.** These fields are required by
    the configured Cal.com event type and are not sent to the routing or extraction models. The UI
    does not persist them in `localStorage`.

12. **The event type is preflighted at startup.** The server verifies that the configured event ID
    exists, reads its duration, and refuses unsupported required booking fields. This catches a
    mismatched key or event configuration before the user reaches the final action.

13. **The Cal.com request follows the current v2 contract.** Booking uses
    `POST https://api.cal.com/v2/bookings`, bearer authentication, API version `2026-02-25`, a UTC
    `start`, `eventTypeId`, attendee name/email/timeZone/language, and
    `bookingFieldsResponses.title`. The implementation follows the
    [Cal.com Create a Booking documentation](https://cal.com/docs/api-reference/v2/bookings/create-a-booking).

14. **Provider safeguards are not overridden.** The payload does not set `allowConflicts`,
    `allowBookingOutOfBounds`, or `skipBookingLimits`. Availability, bounds, and booking limits
    remain controlled by the Cal.com event type.

15. **Booking POST is never automatically retried.** A timeout, lost response, HTTP 5xx, or
    malformed success response can mean the event was created even though the client did not
    receive a usable confirmation. The proposal becomes `uncertain`, the confirm button changes to
    “Check Cal.com,” and a duplicate POST is blocked. Definite availability or validation failures
    leave the proposal retryable after editing.

16. **The UI blocks conflicting local actions during submission.** Confirm, cancel, composing a new
    chat message, and clearing the conversation are disabled while the booking is in flight. This
    prevents an external result from being hidden or submitted twice.

17. **Provider errors are bounded for the browser.** The API maps authentication, permission,
    validation, availability, rate-limit, service, invalid-response, and network failures to short
    messages. It does not return credentials, raw provider bodies, or stack traces.

18. **No database is required for localhost.** `DATABASE_URL` is not read by this feature. The
    tradeoff is that a server restart invalidates pending proposal IDs. Durable, authenticated
    scheduling would require a database and user identity before production deployment.

19. **Testing stops short of an unapproved real booking.** Unit tests use a mocked Cal endpoint to
    verify the exact request, consent boundary, no automatic retry, duplicate prevention, time-zone
    conversion, DST behavior, and Angular confirmation flow. A read-only live preflight verifies
    the configured key, event ID, duration, booking fields, and location. Creating a real event is
    reserved for an actual user-supplied name, email, future time, and explicit confirmation.

20. **Terminal logs expose the scheduler's decisions without attendee identity.** The correlated
    scheduling summary shows extraction status, ambiguity, selected date/time, whether each value
    came from conversation or a visible default, proposal/card versus clarification, confirmation,
    and definite versus uncertain Cal.com outcomes. It never prints the attendee name or email.

## Alternatives considered

- **Direct booking from the first chat message:** faster, but dates can be misread and it lacks
  informed confirmation. Rejected.
- **Tool calling inside the answer model:** convenient, but couples prose generation to an external
  write and weakens deterministic routing. Rejected in favor of a typed action branch.
- **Cal.com embed or hosted booking link:** delegates availability and identity UI well, but does
  not provide the requested in-chat confirmation experience. It remains a useful production option.
- **Rules-only date parsing:** deterministic for a few English patterns, but brittle across
  conversational follow-ups and phrasing. Structured extraction plus strict validation was chosen.
- **A database-backed job/outbox:** best for production idempotency and auditability, but unnecessary
  for this loopback prototype. The one-time in-memory proposal registry makes that limitation clear.
- **Automatic POST retry:** common for reads, unsafe for a booking without a provider-supported
  idempotency key guaranteed by this API contract. Rejected.
