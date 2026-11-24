# Aventurine account server

Aventurine Manage is a desktop app, and nothing of it is hosted. This one
Cloudflare Worker does only what the app and the billing need from a server:

- it records who has paid, from Paddle's webhooks;
- it signs Aventurine Manage in with an emailed 6-digit code, and hands it a
  signed license saying which tier the subscription buys;
- it hands out the beta spots offered on aventurine-app.com/pricing.html;
- it lets anyone see or delete what is held for their email address.

It lives in `account-server/` in the aventurine-manage repo (moved there from
the old aventurine-planner repo on 2026-11-24). Run every `npm` command below
from `account-server/`.

**No plans or finances ever reach it.** They live in the database file on the
user's computer. The worker knows an email address, its Paddle customer and
subscriptions, which computers are signed in, and who holds a beta spot.

## What it does

| Route | Who | Job |
|---|---|---|
| `POST /api/paddle/webhook` | Paddle (signature checked) | Copies customers and subscriptions into the database |
| `POST /api/device/code`, `/api/device/verify` | anyone (Aventurine Manage) | Emails a 6-digit code to an address with access; spending it registers the computer and returns a device token and a signed license |
| `POST /api/device/license`, `/api/device/signout` | a device token | A fresh signed license; forget the computer |
| `GET /api/beta`, `POST /api/beta/join` | the pricing page (CORS for `SITE_ORIGIN` only) | Spots left; reserve a spot for an email (see "Beta" below) |
| `/api/privacy/*` | an emailed link | See, download or delete what is held for an address (`PRIVACY.md`) |
| `/auth/privacy` and the `/static/` files it names | public | The page behind Delete Me on the website |
| everything else | | 404 |

`npm run build` writes only the privacy page and the files it names to `dist/`,
so nothing else can be served by mistake.

Code map: `src/index.js` (routes), `paddle.js` (signature, events), `access.js`
(who has access, and which tier), `devices.js` and `license.js` (Aventurine
Manage's sign-in and signed licenses), `beta.js` (the beta signup), `privacy.js` (seeing and deleting an
address's data), `store.js` (every SQL statement), `email.js`, `http.js`,
`config.js`, `crypto.js`. Schema: `migrations/`.

## Access rule

A subscription grants access while Paddle says `active`, `trialing` or
`past_due` (a failed renewal that Paddle is still retrying: cutting someone off
for an expired card would be unkind). `paused` and `canceled` do not. A
cancellation the customer asks for stays `active` until the paid period ends,
then Paddle sends `canceled` and access stops at the app's next check.

What it grants is its tier, from the Paddle price it is on (`src/access.js`):

- **Pro**: the prices in `PRO_PRICE_IDS` (wrangler.toml), the Pro monthly and
  annual prices. Aventurine Manage, Planner, and every later Pro feature.
- **Basic**: any other price. Aventurine Manage only.

Someone with several subscriptions gets the best of them. Addresses in
`COMPLIMENTARY_EMAILS` always have Pro. The signed license carries the tier
(`tier` in `src/license.js`), and the app opens only with Basic or Pro.
**Add every new Pro price to `PRO_PRICE_IDS`**, or its buyers get Basic.

## Beta

The first `BETA_LIMIT` people (wrangler.toml, 50) to join on the pricing page
get a free Pro license with no end date. Joining reserves a spot and emails a
download link; the spot counts as access when that address signs in to
Aventurine Manage (it shows as "complimentary" in the app), and the first
sign-in claims it. A spot not claimed within 14 days (`BETA_HOLD_MS`,
`store.js`) is freed by the daily job. A claimed spot lasts until its row is
deleted:

```sh
npx wrangler d1 execute aventurine-prism --remote --config worker/wrangler.toml \
  --command "SELECT email, joined_at, claimed_at FROM beta_members"
npx wrangler d1 execute aventurine-prism --remote --config worker/wrangler.toml \
  --command "DELETE FROM beta_members WHERE email = 'someone@example.com'"
```

`BETA_LIMIT = "0"` closes signups; lowering the limit takes no spot away.

## Licenses

Aventurine Manage keeps the last license it was given and trusts it until
`validUntil`: 30 days after its last good check, so it works offline. The
signature (Ed25519) stops it being edited to unlock more or last longer. The
worker signs with `LICENSE_SIGNING_KEY`, the private half; the app has the
public half built in (`LICENSE_PUBLIC_KEY` in Manage's
`electron/licensePolicy.js`). Without the secret, sign-ins fail with a server
error and nothing else changes.

The `/api/device/*` routes answer on any hostname the worker serves, so a move
to a custom domain does not sign installed copies out. The worker's name in
`wrangler.toml` is part of the address those copies call: renaming it signs
every install out.

## Run it locally

```bash
cp worker/.dev.vars.example worker/.dev.vars    # then edit
npm run build
npx wrangler d1 migrations apply aventurine-prism --local --config worker/wrangler.toml
npm run dev                              # http://127.0.0.1:8787
```

With no `RESEND_API_KEY`, sign-in codes and privacy links are printed in the
wrangler console. Point a dev run of Manage at it with
`AVENTURINE_ACCOUNT_URL=http://127.0.0.1:8787` and
`AVENTURINE_LICENSE_PUBLIC_KEY` set to the public half of your dev key.

`npm run smoke` runs the whole flow against Cloudflare's real local
runtime with a throwaway database and key. `npm test` covers the same rules
without it.

## Set it up for real

Do all of it against Paddle's **sandbox** first; going live is the last section.

### 1. Cloudflare

```bash
npx wrangler login
npx wrangler d1 create aventurine-prism
```

Put the printed `database_id` in `wrangler.toml`, then create the tables:

```bash
npx wrangler d1 migrations apply aventurine-prism --remote --config worker/wrangler.toml
```

### 2. Email (Resend)

1. Create a [Resend](https://resend.com) account and add your sending domain. It
   gives you DNS records (SPF, DKIM) to add at your registrar.
2. Create an API key limited to sending, then `npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml`.
3. Set `EMAIL_FROM` in `wrangler.toml` to an address on that domain.

### 3. Paddle (sandbox)

In the sandbox dashboard:

1. **Catalog → Products**: the Basic and Pro prices. Note the `pri_…` ids: the
   website's pricing buttons need all of them, and `PRO_PRICE_IDS` needs the
   Pro ones.
2. **Developer tools → Authentication → Client-side token**: for Paddle.js on
   the website's pricing page (not a secret).
   **Developer tools → Authentication → API keys**: create one with only
   `customer.read`, `subscription.read` and `subscription.write`, then
   `npx wrangler secret put PADDLE_API_KEY --config worker/wrangler.toml`.
   The worker uses it to cancel a subscription when its owner deletes their
   data, so without it those deletions wait for you (`PRIVACY.md`). A sandbox key
   also needs `PADDLE_API_URL` set to `https://sandbox-api.paddle.com`.
3. **Events → Notifications → New destination** (not under Developer tools):
   - URL: `<APP_ORIGIN>/api/paddle/webhook`
   - Events: `customer.created`, `customer.updated`, and every `subscription.*`
     event (`created`, `activated`, `updated`, `trialing`, `past_due`, `paused`,
     `resumed`, `canceled`).
   - Copy its secret (`pdl_ntfset_…`; later, Events → Notifications → the destination's menu → Edit destination → the copy icon):
     `npx wrangler secret put PADDLE_WEBHOOK_SECRET --config worker/wrangler.toml`
4. **Checkout → Checkout settings**: set the default payment link to the
   website's pricing page (`https://aventurine-app.com/#pricing`) and approve
   the website's domain for checkout.

Optionally `npx wrangler secret put COMPLIMENTARY_EMAILS` (comma separated) for
yourself and testers.

### 4. License key

```bash
node scripts/make-license-key.mjs ~/license-signing-key.txt
npx wrangler secret put LICENSE_SIGNING_KEY --config worker/wrangler.toml < ~/license-signing-key.txt
```

Put the printed public key in `LICENSE_PUBLIC_KEY` in Manage's
`electron/licensePolicy.js`. Keep the private key file somewhere safe and off
any shared drive: anyone holding it can make licenses.

### 5. Deploy and test

```bash
npm run deploy
```

Then buy with a Paddle sandbox test card on the website and sign in from
Aventurine Manage with the purchase email. Paddle's **Developer tools →
Simulations** can replay cancellations and failed payments. To see what the
worker stored:

```bash
npx wrangler d1 execute aventurine-prism --remote --config worker/wrangler.toml \
  --command "SELECT c.email, s.status, s.price_id, s.period_end FROM subscriptions s JOIN customers c ON c.id = s.customer_id"
```

### 6. Going live

Paddle's live account is separate: repeat step 3 there (live catalog, live
notification destination), re-set `PADDLE_WEBHOOK_SECRET`, put the live Pro
price ids in `PRO_PRICE_IDS`, use the live client token and price ids on the
website, and deploy again. Buy once with a real card and refund it.

## Things worth knowing

- **Customers who get no code.** The sign-in form only emails addresses whose
  subscription grants access (or that are in `COMPLIMENTARY_EMAILS`), so
  someone who left checkout before paying gets nothing. If someone says no
  email arrives: run the query above first (no row means Paddle's
  `customer.created` or `subscription.created` was never delivered: see
  Paddle's notification log; a `canceled` or `paused` status means it is
  working as intended), then Resend's log, then spam.
- **The code reply costs the same for everyone.** Whether or not the address
  is a customer, the request does the same reads and replies; making the code
  and emailing it happen after the reply (`ctx.waitUntil`), so timing cannot
  tell a customer from a stranger.
- **Out-of-order events.** Paddle may deliver webhooks in any order or twice.
  Each write only applies if it is newer than what is stored (`store.js`).
- **Migrations before code.** A deploy that needs a new table needs its
  migration applied first; one that drops a table (0006) is applied after the
  deploy that stops using it.
  `npx wrangler d1 migrations apply aventurine-prism --remote --config worker/wrangler.toml`.
- **Rotating a secret.** Paddle lets two webhook secrets overlap; the worker
  accepts a request if any signature matches. Roll the secret in Paddle, then
  `wrangler secret put PADDLE_WEBHOOK_SECRET`.
- **Rate limits.** Sign-in codes: 10 per minute per IP (the `RATE_LIMIT`
  binding), 3 codes per email per 10 minutes, and 5 wrong guesses per code.
  Privacy requests: 10 per minute per IP, and at most 3 links per email per day.
