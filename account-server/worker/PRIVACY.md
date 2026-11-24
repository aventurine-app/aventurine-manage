# Privacy requests: what you do by hand

The website's **Delete Me** page leads to `/auth/privacy`, where anyone can prove
they own an address, see what we hold, download it, and delete it. The worker
does everything it can reach (`src/privacy.js`). This page is the rest.

## Deadlines

| | |
|---|---|
| Our target for finishing | **30 days** from the request |
| GDPR limit | One month, extendable by two if the request is complex |
| CCPA limit | Confirm within 10 business days; answer within 45 days, extendable by 45 |

The checklist email states the date. If you need longer, tell the person why
inside those 30 days.

## When a checklist email arrives

Each confirmed deletion emails `PRIVACY_EMAIL` a checklist titled
`Privacy: finish deleting <address> by <date>`. It is sent before the address is
erased, and is the only place the address survives.

1. **Billing.** If it says `NOT FINISHED`, see below. Otherwise nothing to do.
2. **Support inbox.** Search for the address and delete the threads.
3. **`COMPLIMENTARY_EMAILS`**, if the email says so: remove the address with
   `npx wrangler secret put COMPLIMENTARY_EMAILS --config worker/wrangler.toml`.
4. **Delete the checklist email,** including from Sent and Trash.

Keep no list of whose requests you handled. The anonymous `privacy_requests`
table is the record California asks for.

## When billing says NOT FINISHED

The worker could not cancel the subscription, so it has deleted nothing, and it
repeats the email every day until it can. Cancel the subscription named in the
email from the Paddle dashboard. The webhook updates our copy, and the next daily
run (04:17 UTC) finishes the deletion and sends the person their receipt.

If the cause is a missing or expired `PADDLE_API_KEY`, set it again. Queued
deletions then finish by themselves. To see what is waiting:

```bash
npx wrangler d1 execute aventurine-prism --remote --config worker/wrangler.toml \
  --command "SELECT email, requested_at, notified_at FROM erasure_queue"
```

## Requests that arrive by email

Someone may email support instead of using the page, or be unable to use it.

- **Deletion, from the address in question:** reply with the link to the Delete
  Me page. If they cannot use it, have them confirm by reply, then delete their
  rows by hand. The statements are the ones in `eraseAccount` in `src/store.js`;
  cancel any subscription in the Paddle dashboard first.
- **From an agent:** ask for the person's written permission, then confirm it
  with the person directly at their address before doing anything.
- **Correction:** billing email and name live in Paddle, and the person changes
  them through Manage Billing. Paddle's `customer.updated` updates us.
- **Objection or restriction:** we do no marketing or profiling, so there is
  usually nothing to stop. If they want processing paused, deletion is the way to
  do that here.

## What the worker cannot delete

These are stated on the Delete Me page and in the privacy policy. Keep all three
in step if anything below changes.

| Place | What happens |
|---|---|
| Cloudflare D1 Time Travel | Always on and cannot be turned off. Deleted rows stay restorable for 30 days (7 on the free plan), then are gone |
| Resend logs | Kept 30 days. Resend removes a message sooner only if you ask its support |
| Cloudflare and web host request logs | Provider's schedule; not keyed by email |
| Paddle | Independent controller. No API deletes a customer. The person uses https://preferences.paddle.com/form/deletion; Paddle keeps transaction records for 5 years |
| Browsers | Cleared only in the browser that made the request, and only if it is signed in to that account. Others keep their copy until signed out or cleared |

**Do not restore D1 from Time Travel past a deletion.** It would bring the deleted
data back, and nothing records whose it was, so it could not be deleted again.
Before any restore, check `privacy_requests` for `delete` rows after the restore
point. If there are any, repair forward instead.

## What stays after a deletion

- A `privacy_requests` row: the kind and two dates. Nothing identifying. Kept 750
  days, since California's rules ask for at least 24 months.
- `erased_customers`: a SHA-256 of the Paddle customer id, for 30 days, so late
  webhooks cannot write the customer back. Paddle retries for about two days.
