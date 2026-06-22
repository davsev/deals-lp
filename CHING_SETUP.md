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

Important:

- Do not put the Ching API key in HTML or frontend JavaScript.
- Ching requires creating a customer first, then creating `/checkout_sessions`.
- Cart amounts are sent as agorot (`amount_agorot`), not shekels.
- Fulfillment should eventually be handled from a Ching webhook such as `charge.succeeded`, not only from `checkout-success.html`.
