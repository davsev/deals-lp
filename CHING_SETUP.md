# Ching Checkout Setup

The payment flow uses Ching Hosted Checkout.

Run locally:

```bash
CHING_API_KEY_TEST=ck_test_your_api_key_here npm start
```

Open:

```text
http://127.0.0.1:4173
```

Required from Ching:

- `CHING_API_KEY_TEST`: server-side test API key from Ching Developers dashboard.
- `CHING_API_KEY`: optional production API key. Use `ck_live_...` only after the account is approved.
- `CHING_WEBHOOK_SECRET`: webhook signing secret returned when registering the Ching webhook endpoint.

Required for order confirmation emails:

- `RESEND_API_KEY`: Resend API key used to send order confirmation emails.
- `ORDER_EMAIL_FROM`: verified sender, for example `Al Deals <support@al-deals.com>`.
- `ORDER_NOTIFY_EMAIL`: merchant notification inbox, for example `support@al-deals.com`.

Webhook setup:

Register this HTTPS endpoint in Ching Developers / Webhooks:

```text
https://water-guns.al-deals.com/api/ching/webhook
```

Subscribe to:

```json
["charge.succeeded"]
```

Store the returned secret in Railway as:

```text
CHING_WEBHOOK_SECRET=whsec_...
```

Important:

- Do not put the Ching API key in HTML or frontend JavaScript.
- Ching requires creating a customer first, then creating `/checkout_sessions`.
- Cart amounts are sent as agorot (`amount_agorot`), not shekels.
- Fulfillment emails are sent from `/api/ching/webhook` after `charge.succeeded`.
- Ching receipts/invoices are still handled by Ching because `create_document: true` is sent on checkout session creation.
- Current order snapshots are kept in server memory between checkout creation and webhook delivery. For higher reliability, move this to a database before scaling traffic.
