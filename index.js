// ZaZooom Cloud Functions — Section D
// =====================================
//
// Public callables + Firestore triggers that back the marketplace:
//   - Stripe Connect provisioning + escrow lifecycle
//   - Safety (SOS + share-location SMS via Twilio)
//
// Secrets are pulled at runtime via firebase-functions/params.defineSecret
// (Firebase Functions v2). Set them once per env with:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
//   firebase functions:secrets:set TWILIO_ACCOUNT_SID
//   firebase functions:secrets:set TWILIO_AUTH_TOKEN
//   firebase functions:secrets:set TWILIO_FROM_NUMBER
//
// Twilio is currently unconfigured. The SOS + ping functions ship with a
// TODO marker and a "noop" path so deploys succeed even without Twilio
// creds — they'll log + return without crashing until Twilio is wired.

const {
  onDocumentCreated,
} = require('firebase-functions/v2/firestore');
const {
  onCall,
  onRequest,
  HttpsError,
} = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const {
  getFirestore,
  FieldValue,
} = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');

// -----------------------------------------------------------------------------
// Secrets
// -----------------------------------------------------------------------------

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_FROM_NUMBER = defineSecret('TWILIO_FROM_NUMBER');

// Sandbox kill switch. Default is 'false' so sandbox / preview deploys
// never send real SMS even if Twilio credentials are set. Flip to 'true'
// only in the production environment:
//   firebase deploy --only functions  (with TWILIO_ENABLED=true in .env)
// or set per-env via .env.<channel> files (firebase-functions v2 picks
// up environment-specific values for defineString automatically).
const TWILIO_ENABLED = defineString('TWILIO_ENABLED', { default: 'false' });

// -----------------------------------------------------------------------------
// Constants — commission model from Section E.
//   application_fee_amount = 5% of item price + $1.75 flat (in cents).
// -----------------------------------------------------------------------------

const COMMISSION_PERCENT = 0.05;
const COMMISSION_FLAT_CENTS = 175;
const SAFETY_HOLD_DEFAULT_CENTS = 999; // $9.99

function commissionCents(amountUsd) {
  return Math.round(amountUsd * 100 * COMMISSION_PERCENT) + COMMISSION_FLAT_CENTS;
}

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

initializeApp();
const db = getFirestore();

// Default region for all functions. us-central1 keeps round-trip latency
// reasonable for a US-launch marketplace.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// Lazy-resolve helpers so cold starts only init clients when actually used.
let _stripe = null;
function stripeClient() {
  if (_stripe) return _stripe;
  const Stripe = require('stripe');
  _stripe = new Stripe(STRIPE_SECRET_KEY.value(), {
    apiVersion: '2024-12-18.acacia',
  });
  return _stripe;
}

let _twilio = null;
function twilioClient() {
  if (_twilio) return _twilio;
  // Explicit kill switch — sandbox stays SMS-silent even with real creds
  // in Secret Manager. Flip TWILIO_ENABLED to 'true' to actually send.
  if (TWILIO_ENABLED.value() !== 'true') return null;
  const sid = TWILIO_ACCOUNT_SID.value();
  const token = TWILIO_AUTH_TOKEN.value();
  // Secret Manager rejects empty payloads, so unconfigured envs use the
  // literal 'UNSET' sentinel. Real Twilio Account SIDs start with 'AC' —
  // anything else is treated as not yet wired.
  if (!sid || !token || !sid.startsWith('AC')) return null;
  const twilio = require('twilio');
  _twilio = twilio(sid, token);
  return _twilio;
}

function requireAuth(request) {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  return uid;
}

async function getUser(userId) {
  const snap = await db.collection('users').doc(userId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `users/${userId} does not exist.`);
  }
  return { id: snap.id, ...snap.data() };
}

async function getMeeting(meetingId) {
  const snap = await db.collection('meetings').doc(meetingId).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `meetings/${meetingId} does not exist.`);
  }
  return { id: snap.id, ...snap.data() };
}

// -----------------------------------------------------------------------------
// D-3. onUserCreate
//   Provisions a Stripe Customer + Connect Express account when a new
//   users/{uid} doc lands. Writes the IDs back.
// -----------------------------------------------------------------------------

exports.onUserCreate = onDocumentCreated(
  {
    document: 'users/{userId}',
    secrets: [STRIPE_SECRET_KEY],
  },
  async (event) => {
    const userId = event.params.userId;
    const data = event.data?.data() ?? {};

    // Bail if we've already provisioned (defensive — Firestore triggers
    // can fire twice on retry).
    if (data.stripe_customer_id && data.stripe_connect_id) {
      return;
    }

    const stripe = stripeClient();

    const customer = await stripe.customers.create({
      email: data.email,
      name: data.display_name,
      phone: data.phone,
      metadata: { firebase_uid: userId },
    });

    const connectAccount = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: data.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: { firebase_uid: userId },
    });

    await db.collection('users').doc(userId).update({
      stripe_customer_id: customer.id,
      stripe_connect_id: connectAccount.id,
      stripe_provisioned_at: FieldValue.serverTimestamp(),
    });
  },
);

// -----------------------------------------------------------------------------
// D-2. createStripeIdentitySession
//   Mints a Stripe Identity VerificationSession (document + selfie). The
//   client opens it via flutter_stripe's Stripe.instance.verifyIdentity.
//   On completion, identity.verification_session.verified fires the
//   webhook → user.id_verified = true.
// -----------------------------------------------------------------------------

exports.createStripeIdentitySession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const stripe = stripeClient();

    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { firebase_uid: uid },
      options: {
        document: {
          allowed_types: ['driving_license', 'passport', 'id_card'],
          require_id_number: false,
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
    });

    await db.collection('users').doc(uid).update({
      id_verification_session_id: session.id,
      id_verification_started_at: FieldValue.serverTimestamp(),
    });

    return {
      client_secret: session.client_secret,
      session_id: session.id,
      status: session.status,
      url: session.url,
    };
  },
);

// -----------------------------------------------------------------------------
// D-3b. createSetupIntent
//   Buyer-side: mint a Stripe SetupIntent so the client can present
//   PaymentSheet and save a card on the customer for off-session charges
//   (the safety hold uses `confirm: true` + `off_session: true`).
// -----------------------------------------------------------------------------

exports.createSetupIntent = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const buyer = await getUser(uid);
    if (!buyer.stripe_customer_id) {
      throw new HttpsError(
        'failed-precondition',
        'Stripe customer not provisioned yet — wait for onUserCreate.',
      );
    }

    const stripe = stripeClient();
    const setupIntent = await stripe.setupIntents.create({
      customer: buyer.stripe_customer_id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { firebase_uid: uid },
    });

    return {
      client_secret: setupIntent.client_secret,
      customer_id: buyer.stripe_customer_id,
    };
  },
);

// -----------------------------------------------------------------------------
// D-3c. createConnectOnboardingLink
//   Seller-side: mint a Stripe accountLinks URL so the seller can finish
//   bank + KYC + tax-form steps on Stripe's hosted Express dashboard.
//   The Connect account itself was created in onUserCreate.
// -----------------------------------------------------------------------------

exports.createConnectOnboardingLink = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const seller = await getUser(uid);
    if (!seller.stripe_connect_id) {
      throw new HttpsError(
        'failed-precondition',
        'Connect account not provisioned yet — wait for onUserCreate.',
      );
    }

    const stripe = stripeClient();
    const link = await stripe.accountLinks.create({
      account: seller.stripe_connect_id,
      // TODO: replace with real URLs once the marketing site is up.
      refresh_url: 'https://zazooom.com/payouts/refresh',
      return_url: 'https://zazooom.com/payouts/done',
      type: 'account_onboarding',
    });

    return {
      url: link.url,
      expires_at: link.expires_at,
    };
  },
);

// -----------------------------------------------------------------------------
// D-4. createSafetyHoldCharge
//   Buyer authorizes a non-refundable $9.99 hold (default; amount overridable).
//   Stores the charge_id on the meeting doc.
// -----------------------------------------------------------------------------

exports.createSafetyHoldCharge = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const { meetingId, amount } = request.data || {};
    if (!meetingId) {
      throw new HttpsError('invalid-argument', 'meetingId required.');
    }

    const amountCents = Math.round((amount ?? 9.99) * 100) || SAFETY_HOLD_DEFAULT_CENTS;
    const meeting = await getMeeting(meetingId);
    if (meeting.buyer_id !== uid) {
      throw new HttpsError(
        'permission-denied',
        'Only the buyer can authorize the safety hold.',
      );
    }
    const buyer = await getUser(uid);
    if (!buyer.stripe_customer_id) {
      throw new HttpsError(
        'failed-precondition',
        'Buyer has no Stripe customer; wait for onUserCreate to finish.',
      );
    }

    const stripe = stripeClient();

    // The buyer needs a saved payment method on their customer. The client
    // gathers this via Stripe's SetupIntent flow on PaymentMethodsScreen
    // (Section B Group 5). Here we just pick the default.
    const customer = await stripe.customers.retrieve(buyer.stripe_customer_id);
    const paymentMethod = customer.invoice_settings?.default_payment_method;
    if (!paymentMethod) {
      throw new HttpsError(
        'failed-precondition',
        'No default payment method on file. Add a card first.',
      );
    }

    const charge = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: buyer.stripe_customer_id,
      payment_method: paymentMethod,
      off_session: true,
      confirm: true,
      description: `ZaZooom safety hold — meeting ${meetingId}`,
      metadata: { meetingId, type: 'safety_hold', buyer_id: uid },
    });

    await db.collection('meetings').doc(meetingId).update({
      safety_hold_amount: amountCents / 100,
      safety_hold_charge_id: charge.id,
    });

    return { charge_id: charge.id, amount: amountCents / 100 };
  },
);

// -----------------------------------------------------------------------------
// D-5. createEscrowPaymentIntent
//   Manual-capture PaymentIntent that targets the seller's Connect account.
//   Funds are AUTHORIZED here; capture happens after meeting completion.
// -----------------------------------------------------------------------------

exports.createEscrowPaymentIntent = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const { meetingId, amount } = request.data || {};
    if (!meetingId || typeof amount !== 'number') {
      throw new HttpsError(
        'invalid-argument',
        'meetingId + numeric amount required.',
      );
    }

    const meeting = await getMeeting(meetingId);
    if (meeting.buyer_id !== uid) {
      throw new HttpsError('permission-denied', 'Only the buyer can authorize escrow.');
    }
    const buyer = await getUser(meeting.buyer_id);
    const seller = await getUser(meeting.seller_id);
    if (!buyer.stripe_customer_id || !seller.stripe_connect_id) {
      throw new HttpsError(
        'failed-precondition',
        'Buyer customer or seller Connect account missing.',
      );
    }

    const amountCents = Math.round(amount * 100);
    const stripe = stripeClient();

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: buyer.stripe_customer_id,
      capture_method: 'manual',
      application_fee_amount: commissionCents(amount),
      transfer_data: { destination: seller.stripe_connect_id },
      description: `ZaZooom escrow — meeting ${meetingId}`,
      metadata: { meetingId, type: 'escrow', buyer_id: uid, seller_id: seller.id },
    });

    await db.collection('meetings').doc(meetingId).update({
      escrow_amount: amount,
      escrow_payment_intent_id: intent.id,
      status: 'confirmed',
      confirmed_time: FieldValue.serverTimestamp(),
    });

    return { payment_intent_id: intent.id, client_secret: intent.client_secret };
  },
);

// -----------------------------------------------------------------------------
// D-6. captureEscrow
//   Buyer-side confirm: capture the PaymentIntent → seller's Connect account
//   receives funds (minus application_fee_amount which lands in our main
//   balance). Updates the meeting to status=completed.
// -----------------------------------------------------------------------------

exports.captureEscrow = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const { meetingId } = request.data || {};
    if (!meetingId) {
      throw new HttpsError('invalid-argument', 'meetingId required.');
    }

    const meeting = await getMeeting(meetingId);
    if (meeting.buyer_id !== uid) {
      throw new HttpsError(
        'permission-denied',
        'Only the buyer can capture escrow.',
      );
    }
    if (!meeting.escrow_payment_intent_id) {
      throw new HttpsError(
        'failed-precondition',
        'No PaymentIntent on this meeting; createEscrowPaymentIntent first.',
      );
    }

    const stripe = stripeClient();
    const captured = await stripe.paymentIntents.capture(
      meeting.escrow_payment_intent_id,
    );

    await db.collection('meetings').doc(meetingId).update({
      status: 'completed',
      buyer_confirmed_at: FieldValue.serverTimestamp(),
      seller_confirmed_at: FieldValue.serverTimestamp(),
    });

    // Bump seller's sales_completed counter; buyer's purchases_completed.
    const userOps = db.batch();
    userOps.update(db.collection('users').doc(meeting.seller_id), {
      sales_completed: FieldValue.increment(1),
    });
    userOps.update(db.collection('users').doc(meeting.buyer_id), {
      purchases_completed: FieldValue.increment(1),
    });
    await userOps.commit();

    return {
      payment_intent_id: captured.id,
      amount: captured.amount,
      status: captured.status,
    };
  },
);

// -----------------------------------------------------------------------------
// D-7. refundEscrow
//   Dispute / cancellation path. Refunds either a not-yet-captured
//   PaymentIntent (cancel) or a captured one (refund). Sets meeting status
//   to cancelled.
// -----------------------------------------------------------------------------

exports.refundEscrow = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const { meetingId, reason } = request.data || {};
    if (!meetingId) {
      throw new HttpsError('invalid-argument', 'meetingId required.');
    }

    const meeting = await getMeeting(meetingId);
    if (meeting.buyer_id !== uid && meeting.seller_id !== uid) {
      throw new HttpsError(
        'permission-denied',
        'Only meeting participants can refund.',
      );
    }
    if (!meeting.escrow_payment_intent_id) {
      throw new HttpsError(
        'failed-precondition',
        'No PaymentIntent on this meeting.',
      );
    }

    const stripe = stripeClient();
    const intent = await stripe.paymentIntents.retrieve(
      meeting.escrow_payment_intent_id,
    );

    let result;
    if (intent.status === 'requires_capture') {
      result = await stripe.paymentIntents.cancel(intent.id, {
        cancellation_reason: 'requested_by_customer',
      });
    } else if (intent.status === 'succeeded') {
      result = await stripe.refunds.create({
        payment_intent: intent.id,
        reason: 'requested_by_customer',
        metadata: { meetingId, requested_by: uid, reason: reason ?? '' },
      });
    } else {
      throw new HttpsError(
        'failed-precondition',
        `PaymentIntent is in ${intent.status}; cannot refund.`,
      );
    }

    await db.collection('meetings').doc(meetingId).update({
      status: 'cancelled',
      cancellation_reason: reason ?? null,
    });

    return { ok: true, id: result.id };
  },
);

// -----------------------------------------------------------------------------
// D-8. triggerSOS
//   Twilio SMS to the buyer's trusted contact + moderator alert doc.
//   No-ops gracefully when Twilio creds aren't configured yet.
// -----------------------------------------------------------------------------

exports.triggerSOS = onCall(
  {
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
  },
  async (request) => {
    const uid = requireAuth(request);
    const { meetingId, lat, lng } = request.data || {};
    if (!meetingId) {
      throw new HttpsError('invalid-argument', 'meetingId required.');
    }

    const meeting = await getMeeting(meetingId);

    // Mark the meeting + drop the moderator alert no matter what (these
    // don't depend on Twilio).
    await db.collection('meetings').doc(meetingId).update({
      status: 'sos_triggered',
      sos_triggered_at: FieldValue.serverTimestamp(),
      sos_triggered_by: uid,
      sos_last_known_lat: lat ?? null,
      sos_last_known_lng: lng ?? null,
    });

    await db.collection('admin_alerts').add({
      kind: 'sos',
      meeting_id: meetingId,
      triggered_by: uid,
      lat: lat ?? null,
      lng: lng ?? null,
      created_at: FieldValue.serverTimestamp(),
      acknowledged: false,
    });

    // TODO(twilio): Once TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
    // TWILIO_FROM_NUMBER are set as Firebase secrets, the path below
    // sends an SMS. Before that, this branch returns ok=true with
    // sms='skipped' so the client doesn't error.
    const client = twilioClient();
    if (!client) {
      return { ok: true, sms: 'skipped', reason: 'twilio_unconfigured' };
    }

    const trustedContact = await loadTrustedContact(uid);
    if (!trustedContact) {
      return { ok: true, sms: 'skipped', reason: 'no_trusted_contact' };
    }

    const mapUrl = lat != null && lng != null
      ? `https://maps.google.com/?q=${lat},${lng}`
      : 'unknown location';
    const buyer = await getUser(uid);
    const body =
      `EMERGENCY: ${buyer.display_name ?? 'A ZaZooom user'} triggered SOS ` +
      `at ${new Date().toISOString()}. Live location: ${mapUrl}. ` +
      `Meeting: ${meetingId}.`;

    try {
      const message = await client.messages.create({
        from: TWILIO_FROM_NUMBER.value(),
        to: trustedContact.phone,
        body,
      });
      return { ok: true, sms: 'sent', sid: message.sid };
    } catch (err) {
      // Don't fail the whole call if Twilio errors — the alert doc is
      // already written, moderators can hand-call from there.
      return { ok: true, sms: 'error', error: err.message };
    }
  },
);

// -----------------------------------------------------------------------------
// D-9. shareLocationPing
//   Client calls this every ~2 minutes while the share toggle is on.
//   Sends an SMS update to the trusted contact.
// -----------------------------------------------------------------------------

exports.shareLocationPing = onCall(
  {
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
  },
  async (request) => {
    const uid = requireAuth(request);
    const { meetingId, lat, lng } = request.data || {};
    if (!meetingId || lat == null || lng == null) {
      throw new HttpsError(
        'invalid-argument',
        'meetingId + lat + lng required.',
      );
    }

    // Stop pinging if the meeting has ended (any terminal status).
    const meeting = await getMeeting(meetingId);
    const terminal = ['completed', 'cancelled', 'sos_triggered'];
    if (terminal.includes(meeting.status)) {
      return { ok: true, sms: 'skipped', reason: 'meeting_ended' };
    }

    // TODO(twilio): same gate as triggerSOS.
    const client = twilioClient();
    if (!client) {
      return { ok: true, sms: 'skipped', reason: 'twilio_unconfigured' };
    }

    const trustedContact = await loadTrustedContact(uid);
    if (!trustedContact) {
      return { ok: true, sms: 'skipped', reason: 'no_trusted_contact' };
    }

    const buyer = await getUser(uid);
    const body =
      `ZaZooom: ${buyer.display_name ?? 'A friend'} is at a meetup. ` +
      `Current location: https://maps.google.com/?q=${lat},${lng}. ` +
      `Meeting: ${meetingId}.`;

    try {
      const message = await client.messages.create({
        from: TWILIO_FROM_NUMBER.value(),
        to: trustedContact.phone,
        body,
      });
      return { ok: true, sms: 'sent', sid: message.sid };
    } catch (err) {
      return { ok: true, sms: 'error', error: err.message };
    }
  },
);

// -----------------------------------------------------------------------------
// D-10. onMessageCreate
//   Re-applies the redaction rules server-side (don't trust the client's
//   `redacted_count`). If the message attempted 3+ off-platform contacts,
//   flag the chat for moderator review. Track per-user sliding-window
//   24h violations; cross thresholds → temporary suspension or
//   permanent ban.
// -----------------------------------------------------------------------------

const REDACTION_PHONE = /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/g;
const REDACTION_EMAIL = /[\w.\-]+@[\w.\-]+\.\w+/g;
const REDACTION_SERVICES = [
  'zelle', 'venmo', 'cashapp', 'cash app', 'paypal',
  'apple pay', 'google pay', 'western union', 'moneygram',
];
const SUSPEND_THRESHOLD_24H = 3;
const BAN_THRESHOLD_LIFETIME = 5;
const SUSPEND_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

function countRedactions(text) {
  if (!text) return 0;
  let n = 0;
  n += (text.match(REDACTION_PHONE) || []).length;
  n += (text.match(REDACTION_EMAIL) || []).length;
  for (const s of REDACTION_SERVICES) {
    n += (text.match(new RegExp(s, 'gi')) || []).length;
  }
  return n;
}

exports.onMessageCreate = onDocumentCreated(
  { document: 'messages/{messageId}' },
  async (event) => {
    const msg = event.data?.data();
    if (!msg) return;
    const senderId = msg.sender_id;
    const chatId = msg.chat_id;
    // Run the same redaction patterns the client uses, server-side. If
    // the client tampered with redacted_count, this is the source of
    // truth.
    const violationsThisMessage = countRedactions(msg.text);
    if (violationsThisMessage === 0) return;

    // Single-message threshold: 3+ off-platform attempts in one message
    // flags the entire chat for moderator review.
    if (violationsThisMessage >= 3 && chatId) {
      await db.collection('chats').doc(chatId).update({
        status: 'reported',
        flagged_at: FieldValue.serverTimestamp(),
        flag_reason:
          `Auto-flag: ${violationsThisMessage} off-platform contact ` +
          'attempts in a single message.',
      });
      await db.collection('admin_alerts').add({
        kind: 'auto_flag_chat',
        chat_id: chatId,
        message_id: event.params.messageId,
        sender_id: senderId,
        violation_count: violationsThisMessage,
        created_at: FieldValue.serverTimestamp(),
        acknowledged: false,
      });
    }

    if (!senderId) return;
    const userRef = db.collection('users').doc(senderId);
    const now = Date.now();
    const cutoff = now - WINDOW_24H_MS;

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) return;
      const u = userSnap.data();
      // Sliding 24h window. We store epoch-ms numbers in an array;
      // typical user has <10 entries, well under Firestore's 1MB doc cap.
      const recent = (u.recent_violations || []).filter((ts) => ts > cutoff);
      for (let i = 0; i < violationsThisMessage; i++) recent.push(now);
      const lifetime = (u.violations_lifetime || 0) + violationsThisMessage;

      const updates = {
        recent_violations: recent,
        violations_lifetime: lifetime,
      };

      if (lifetime >= BAN_THRESHOLD_LIFETIME) {
        updates.is_banned = true;
        updates.ban_reason =
          `Auto-ban: ${lifetime} lifetime off-platform contact attempts.`;
      } else if (recent.length >= SUSPEND_THRESHOLD_24H && !u.is_banned) {
        updates.is_suspended = true;
        updates.suspended_until = new Date(now + SUSPEND_DURATION_MS);
        updates.ban_reason =
          `Auto-suspend (7d): ${recent.length} off-platform attempts in 24h.`;
      }
      tx.update(userRef, updates);
    });
  },
);

// -----------------------------------------------------------------------------
// D-11. onReportCreate
//   Writes an admin alert. If the reported user has 3+ open reports
//   against them, auto-suspends for 24h pending review.
// -----------------------------------------------------------------------------

exports.onReportCreate = onDocumentCreated(
  { document: 'reports/{reportId}' },
  async (event) => {
    const report = event.data?.data();
    if (!report) return;
    const reportedUserId = report.reported_user_id;
    if (!reportedUserId) return;

    await db.collection('admin_alerts').add({
      kind: 'user_reported',
      report_id: event.params.reportId,
      reported_user_id: reportedUserId,
      reporter_id: report.reporter_id,
      reason: report.reason,
      created_at: FieldValue.serverTimestamp(),
      acknowledged: false,
    });

    const openReports = await db
      .collection('reports')
      .where('reported_user_id', '==', reportedUserId)
      .where('status', '==', 'open')
      .get();

    if (openReports.size >= 3) {
      await db.collection('users').doc(reportedUserId).update({
        is_suspended: true,
        suspended_until: new Date(Date.now() + WINDOW_24H_MS),
        ban_reason:
          `Auto-suspend (24h) pending review: ${openReports.size} open reports.`,
      });
    }
  },
);

// -----------------------------------------------------------------------------
// D-12. onReviewCreate
//   RatingScreen writes a reviews/{reviewId} doc but nothing recomputed the
//   reviewed user's aggregate rating. This trigger recomputes rating_avg +
//   rating_count on users/{reviewed_user_id} from all of their reviews on
//   every new review. v2 Firestore trigger, same shape as onReportCreate.
//
//   STUB (Day 2 overnight): written + syntax-checked, NOT deployed. Founder to
//   review and `firebase deploy --only functions:onReviewCreate` on Day 3.
// -----------------------------------------------------------------------------

exports.onReviewCreate = onDocumentCreated(
  { document: 'reviews/{reviewId}' },
  async (event) => {
    const review = event.data?.data();
    if (!review) return;
    const reviewedUserId = review.reviewed_user_id;
    if (!reviewedUserId) return;

    const reviewsSnap = await db
      .collection('reviews')
      .where('reviewed_user_id', '==', reviewedUserId)
      .get();

    const ratings = reviewsSnap.docs
      .map((d) => d.data().rating)
      .filter((r) => typeof r === 'number');
    const avg = ratings.length
      ? ratings.reduce((a, b) => a + b, 0) / ratings.length
      : 0;
    const count = ratings.length;

    await db.collection('users').doc(reviewedUserId).update({
      rating_avg: avg,
      rating_count: count,
    });
  },
);

// -----------------------------------------------------------------------------
// stripeWebhook
//   HTTPS endpoint for Stripe events. Verifies signature against
//   STRIPE_WEBHOOK_SECRET. Configure the endpoint URL in Stripe Dashboard
//   → Webhooks after first deploy:
//     https://us-central1-zazooom-app.cloudfunctions.net/stripeWebhook
//   Select events:
//     payment_intent.succeeded, payment_intent.payment_failed,
//     charge.refunded, account.updated,
//     identity.verification_session.verified,
//     identity.verification_session.requires_input
// -----------------------------------------------------------------------------

exports.stripeWebhook = onRequest(
  {
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
    cors: false,
  },
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      res.status(400).send('Missing stripe-signature header');
      return;
    }

    const webhookSecret = STRIPE_WEBHOOK_SECRET.value();
    if (!webhookSecret || webhookSecret === 'UNSET') {
      // Endpoint deployed but signing secret not yet configured. Reject
      // so we never process unverified events.
      res.status(503).send('Webhook endpoint not configured yet');
      return;
    }

    const stripe = stripeClient();
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      res.status(400).send(`Webhook signature failed: ${err.message}`);
      return;
    }

    console.log(`stripe event: ${event.type} ${event.id}`);

    try {
      switch (event.type) {
        case 'payment_intent.succeeded': {
          const pi = event.data.object;
          const meetingId = pi.metadata?.meetingId;
          if (meetingId) {
            await db.collection('meetings').doc(meetingId).update({
              payment_succeeded_at: FieldValue.serverTimestamp(),
              payment_intent_status: pi.status,
            });
          }
          break;
        }
        case 'payment_intent.payment_failed': {
          const pi = event.data.object;
          const meetingId = pi.metadata?.meetingId;
          if (meetingId) {
            await db.collection('meetings').doc(meetingId).update({
              payment_failed_at: FieldValue.serverTimestamp(),
              payment_failure_reason:
                pi.last_payment_error?.message ?? 'unknown',
            });
          }
          break;
        }
        case 'charge.refunded': {
          const charge = event.data.object;
          const meetingId = charge.metadata?.meetingId;
          if (meetingId) {
            await db.collection('meetings').doc(meetingId).update({
              refunded_at: FieldValue.serverTimestamp(),
              refunded_amount: (charge.amount_refunded ?? 0) / 100,
            });
          }
          break;
        }
        case 'account.updated': {
          const account = event.data.object;
          const uid = account.metadata?.firebase_uid;
          if (uid) {
            await db.collection('users').doc(uid).update({
              stripe_connect_payouts_enabled: account.payouts_enabled === true,
              stripe_connect_charges_enabled: account.charges_enabled === true,
              stripe_connect_details_submitted:
                account.details_submitted === true,
              stripe_connect_updated_at: FieldValue.serverTimestamp(),
            });
          }
          break;
        }
        case 'identity.verification_session.verified': {
          const session = event.data.object;
          const uid = session.metadata?.firebase_uid;
          if (uid) {
            await db.collection('users').doc(uid).update({
              id_verified: true,
              id_verified_at: FieldValue.serverTimestamp(),
              id_verification_session_id: session.id,
            });
          }
          break;
        }
        case 'identity.verification_session.requires_input': {
          const session = event.data.object;
          const uid = session.metadata?.firebase_uid;
          if (uid) {
            await db.collection('users').doc(uid).update({
              id_verification_requires_input: true,
              id_verification_session_id: session.id,
            });
          }
          break;
        }
        default:
          // Unhandled event type — log and ack so Stripe doesn't retry.
          console.log(`Unhandled stripe event: ${event.type}`);
      }
    } catch (err) {
      console.error('Webhook handler error:', err);
      res.status(500).send(`Handler error: ${err.message}`);
      return;
    }

    res.status(200).json({ received: true });
  },
);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function loadTrustedContact(userId) {
  // Spec stores trusted_contact_id on the user doc; the actual contact
  // lives in trusted_contacts/{id}.
  const user = await getUser(userId);
  if (!user.trusted_contact_id) return null;
  const snap = await db
    .collection('trusted_contacts')
    .doc(user.trusted_contact_id)
    .get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}
