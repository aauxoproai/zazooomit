# ZaZooom Cloud Functions — Deploy Checklist

Status: code written, **NOT deployed**. Review `index.js`, set the secrets, then deploy.

## 0. Prerequisites

```bash
# From zazooom-build/
npm install --prefix functions
firebase use zazooom-app          # confirms project link
firebase login                    # if not already
```

## 1. Stripe Connect (Section E)

In Stripe Dashboard → test mode:

1. **Enable Connect** — Connect → Get started → "Platform or marketplace" → Express accounts.
2. **Configure platform profile** — name (ZaZooom), branding (yellow #FFD400), support email, business URL.
3. **Webhook endpoint** — copy the URL after first deploy (we don't write webhook handlers in this push; add later for `payment_intent.succeeded`, `charge.refunded`, etc.).
4. **Save these test keys** — you'll paste them in step 3:
   - Publishable key (`pk_test_…`) — goes into the Flutter client app (Stripe SDK init).
   - Secret key (`sk_test_…`) — Firebase secret (below).

## 2. Twilio (optional for first deploy)

The SOS + ping functions ship with a graceful no-op path when Twilio creds are missing — deploys succeed; SMS just doesn't send. To enable:

1. Sign up at twilio.com → Console.
2. Buy a phone number (or use the trial one).
3. Grab Account SID + Auth Token + the From number.

## 3. Set Firebase secrets

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY      # paste sk_test_…
firebase functions:secrets:set TWILIO_ACCOUNT_SID     # paste ACxxxxxxxx (or skip)
firebase functions:secrets:set TWILIO_AUTH_TOKEN      # paste token (or skip)
firebase functions:secrets:set TWILIO_FROM_NUMBER     # paste +15555550100 (or skip)
```

Skipping any of the Twilio secrets is fine — the SMS callables return `{sms: 'skipped'}`.

## 4. Deploy

```bash
firebase deploy --only functions
```

First deploy creates 7 functions:
- `onUserCreate` (Firestore trigger)
- `createSafetyHoldCharge` (callable)
- `createEscrowPaymentIntent` (callable)
- `captureEscrow` (callable)
- `refundEscrow` (callable)
- `triggerSOS` (callable)
- `shareLocationPing` (callable)

## 5. Test (after deploy)

**Stripe Connect smoke test** (run in the Firebase console emulator or a Cloud Functions shell):

```javascript
// 1. Create a buyer user (this fires onUserCreate)
await admin.firestore().collection('users').doc('buyer1').set({
  email: 'buyer@example.com',
  display_name: 'Test Buyer',
  phone: '+15555550100',
});

// Wait ~2s — should see stripe_customer_id + stripe_connect_id appear.
```

In Stripe Dashboard → Customers + Connected Accounts you should see both new entries.

**Escrow happy path:**

1. Create seller user → same provisioning fires.
2. Have buyer add a payment method (via Stripe Elements / PaymentSheet — Section B Group 5 PaymentMethodsScreen).
3. Create a meeting doc with `buyer_id`, `seller_id`, `status='proposed'`.
4. Call `createSafetyHoldCharge` ({meetingId, amount: 9.99}) — confirms $9.99 charges to test card 4242 4242 4242 4242.
5. Call `createEscrowPaymentIntent` ({meetingId, amount: 220}) — meeting goes to `confirmed`.
6. Call `captureEscrow` ({meetingId}) — funds release to seller's Connect account; meeting goes to `completed`.

## 6. Commission verification

The application_fee_amount formula (in cents):

```
floor(amount_usd * 100 * 0.05) + 175
```

On a $220 item: `round(22000 * 0.05) + 175 = 1100 + 175 = 1275 cents = $12.75`.
Seller receives `$220.00 − $12.75 = $207.25`.

## 7. Known TODOs

- **Webhook handlers** — to react to `payment_intent.succeeded`, `account.updated`, etc. Land alongside Section D-10/11 (moderation triggers).
- **Stripe Connect onboarding link** — sellers need a `accountLinks.create()` URL to complete KYC. Wire from PaymentMethodsScreen with a "Set up payouts" CTA in Group 5.
- **Twilio gate** — set the three Twilio secrets to enable SMS. Until then SOS still writes the moderator alert + flips meeting status, but no SMS.
- **Phone auth** — the FlutterFlow DSL doesn't expose `FirebaseAuthProvider.phone` yet; SignUpScreen's "Send Code" is a placeholder. Wire phone auth via the FlutterFlow web editor or wait for SDK to expose it.
- **Idempotency on retries** — Firestore triggers can fire twice; `onUserCreate` already guards via the `if (stripe_customer_id …)` early-return. The callables don't have idempotency keys yet — fine for MVP, harden before launch.
