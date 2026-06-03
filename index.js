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
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
// Claude (Anthropic) vision — used by scanItems (Home Scan / room video).
// Set once with:  firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// Shared secret for the website's POST /api/listings — held server-side so the
// app never embeds it. Same value as the web's APP_LISTINGS_SECRET.
// Set once with:  firebase functions:secrets:set APP_LISTINGS_SECRET
const APP_LISTINGS_SECRET = defineSecret('APP_LISTINGS_SECRET');

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
//   Recomputes rating_avg + rating_count on users/{reviewed_user_id} from
//   all reviews of that user. v2 Firestore trigger, same shape as
//   onReportCreate.
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

// =============================================================================
// PHOTO → ADS + QR  (detectItemsFromPhoto + publishListingsFromDetection)
// =============================================================================
//
// One uploaded photo becomes one or many marketplace listings, each with a
// cropped photo and a scannable QR code. Two callables:
//
//   detectItemsFromPhoto(storagePath)
//     -> Gemini vision detects sellable items + bounding boxes. No writes.
//
//   publishListingsFromDetection(storagePath, mode, items[])
//     -> mode 'separate': one listing per item, photo cropped to its box.
//        mode 'bundle':   one listing, whole photo, combined price.
//     Each listing gets photo.jpg + qr.png in Storage and a `listings` doc.
//
// Runs in us-east1 (override of the us-central1 global default) to match the
// Firestore + Storage region. Heavy deps (vertexai/sharp/qrcode) are lazily
// required so the Stripe/Twilio functions above don't pay their cold-start.
//
// Listings schema note: the live hardened rules (firestore.rules) require
// `status: 'active'` (lowercase) and a `photos` LIST — there is no photo_url
// field in the client-writable schema. The Admin SDK bypasses rules, so we
// write a superset: `photos:[url]` + `status:'active'` (what the app reads)
// PLUS `photo_url`/`qr_url` (convenience, also returned to the caller).

const PHOTO_REGION = 'us-east1';
// gemini-2.5-flash is served from us-central1 on Vertex. The function itself
// runs in us-east1 (PHOTO_REGION); only the Vertex AI request targets
// us-central1. NOTE: location 'global' makes the deprecated @google-cloud/vertexai
// SDK hit a non-JSON endpoint -> "Unexpected token '<'" / vision_failed
// (verified 2026-05-31); a real region is required.
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const LISTING_URL_BASE =
  process.env.LISTING_URL_BASE || 'https://zazooomit.com/listing';
const GCP_PROJECT = process.env.GCLOUD_PROJECT || 'zazooom-app';

// ---- lazy deps --------------------------------------------------------------

let _sharp = null;
function sharpLib() {
  if (!_sharp) _sharp = require('sharp');
  return _sharp;
}
let _qrcode = null;
function qrcodeLib() {
  if (!_qrcode) _qrcode = require('qrcode');
  return _qrcode;
}
let _genModel = null;
function geminiModel() {
  if (_genModel) return _genModel;
  // Gemini Developer API (generativelanguage.googleapis.com) via API key —
  // intentionally NOT Vertex/aiplatform, which stayed SERVICE_DISABLED on this
  // project despite enablement. The generateContent request/response shape is
  // the same as the prior Vertex SDK, so the detect handler is unchanged.
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  _genModel = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  });
  return _genModel;
}
function defaultBucket() {
  const { getStorage } = require('firebase-admin/storage');
  return getStorage().bucket();
}

// ---- helpers ----------------------------------------------------------------

/** Reject empty / traversing / absolute storage paths; normalize gs:// URLs. */
function sanitizeStoragePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new HttpsError('invalid-argument', 'storagePath must be a non-empty string.');
  }
  let path = p;
  // FlutterFlow stores Firebase *download URLs* in capturedPhotoUrls, e.g.
  // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<ENCODED_PATH>?alt=media&token=...
  // Extract + URL-decode the /o/ segment back into the object path.
  const fbMatch = path.match(/\/o\/([^?]+)/);
  if (fbMatch) {
    path = decodeURIComponent(fbMatch[1]);
  } else if (path.startsWith('gs://')) {
    path = path.replace(/^gs:\/\/[^/]+\//, '');
  }
  path = path.replace(/^\/+/, '');
  if (path.includes('..')) {
    throw new HttpsError('invalid-argument', "storagePath may not contain '..'.");
  }
  if (path.length === 0) {
    throw new HttpsError('invalid-argument', 'storagePath resolved to empty.');
  }
  return path;
}

/** Coerce anything to a finite, non-negative number, else fallback. */
function safeNum(v, fallback = 0) {
  const n = typeof v === 'number'
    ? v
    : parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Download an object's bytes + content type from the default bucket. */
async function downloadImage(storagePath) {
  const bucket = defaultBucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('not-found', `Object not found: ${storagePath}`);
  const [meta] = await file.getMetadata();
  const [buffer] = await file.download();
  return { buffer, contentType: meta.contentType || 'image/jpeg', bucket };
}

/**
 * Save a buffer to Storage and return a tokenized Firebase download URL.
 *
 * We deliberately do NOT use file.makePublic(): the bucket has Uniform
 * Bucket-Level Access (object ACLs disabled), so makePublic() throws; and the
 * live Storage rules deny read on `listings/**` anyway. Writing a
 * `firebaseStorageDownloadTokens` metadata value yields a
 * firebasestorage.googleapis.com URL that bypasses both rules and UBLA — the
 * same URL format the FlutterFlow client already produces on upload.
 */
async function savePublic(bucket, objectPath, buffer, contentType) {
  const { randomUUID } = require('crypto');
  const token = randomUUID();
  const file = bucket.file(objectPath);
  await file.save(buffer, {
    resumable: false,
    contentType,
    metadata: {
      cacheControl: 'public, max-age=31536000',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

/** Generate a QR PNG buffer encoding the public listing URL. */
function qrBuffer(listingId) {
  return qrcodeLib().toBuffer(`${LISTING_URL_BASE}/${listingId}`, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}

/**
 * Convert a 0-1000 normalized, top-left-origin box to integer pixel crop
 * geometry clamped to the image. Returns null if the box is degenerate.
 */
function boxToExtract(box, width, height) {
  if (!box || !width || !height) return null;
  const xmin = safeNum(box.xmin);
  const ymin = safeNum(box.ymin);
  const xmax = safeNum(box.xmax);
  const ymax = safeNum(box.ymax);

  let left = Math.round((xmin / 1000) * width);
  let top = Math.round((ymin / 1000) * height);
  let w = Math.round(((xmax - xmin) / 1000) * width);
  let h = Math.round(((ymax - ymin) / 1000) * height);

  left = Math.min(Math.max(left, 0), Math.max(width - 1, 0));
  top = Math.min(Math.max(top, 0), Math.max(height - 1, 0));
  w = Math.min(Math.max(w, 1), width - left);
  h = Math.min(Math.max(h, 1), height - top);

  if (w < 1 || h < 1) return null;
  return { left, top, width: w, height: h };
}

/** Build a `listings` doc payload conforming to the live hardened schema. */
function buildListingDoc(uid, f) {
  return {
    seller_id: uid,
    title: f.title,
    description: f.description || '',
    category: f.category || 'Other',
    condition: f.condition || 'Good',
    price: f.price,
    photos: [f.photo_url],      // list — what the app feed reads
    photo_url: f.photo_url,     // convenience mirror (Admin-written)
    qr_url: f.qr_url,
    status: 'active',           // lowercase — required by firestore.rules
    view_count: 0,
    created_at: FieldValue.serverTimestamp(),
  };
}

// ---- FUNCTION 1: detectItemsFromPhoto ---------------------------------------

const DETECT_PROMPT = `You are a marketplace listing assistant. Look at the image and identify each distinct sellable physical item.

Return ONLY valid JSON (no markdown, no code fences, no commentary) in EXACTLY this shape:
{
  "items": [
    {
      "label": "short noun label, e.g. 'sneaker'",
      "title": "catchy marketplace listing title",
      "description": "1-3 sentence selling description",
      "category": "one of: Electronics, Clothing, Shoes, Home, Toys, Sports, Books, Tools, Beauty, Other",
      "condition": "one of: New, Like New, Good, Fair, Poor",
      "priceEstimate": 0,
      "box": { "ymin": 0, "xmin": 0, "ymax": 1000, "xmax": 1000 }
    }
  ]
}

Rules:
- priceEstimate is a NUMBER in USD (no currency symbol).
- box coordinates are integers normalized 0-1000 with origin at the TOP-LEFT (Gemini convention): ymin/xmin = top-left corner, ymax/xmax = bottom-right corner.
- One entry per distinct item. If only one item, return one entry.
- If you see no sellable item, return {"items": []}.`;

exports.detectItemsFromPhoto = onCall(
  { region: PHOTO_REGION, memory: '1GiB', timeoutSeconds: 300, secrets: [GEMINI_API_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const storagePath = sanitizeStoragePath(request.data && request.data.storagePath);
    console.log('detectItemsFromPhoto', { uid, storagePath });

    const { buffer, contentType } = await downloadImage(storagePath);

    // Pixel dimensions so the caller can convert boxes -> px later.
    let width = 0;
    let height = 0;
    try {
      const meta = await sharpLib()(buffer).metadata();
      width = meta.width || 0;
      height = meta.height || 0;
    } catch (e) {
      console.warn('sharp metadata failed', String(e));
    }

    let raw = '';
    try {
      const resp = await geminiModel().generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: contentType, data: buffer.toString('base64') } },
            { text: DETECT_PROMPT },
          ],
        }],
      });
      const cand = resp.response
        && resp.response.candidates
        && resp.response.candidates[0];
      raw = ((cand && cand.content && cand.content.parts) || [])
        .map((p) => p.text || '')
        .join('');
    } catch (e) {
      console.error('Gemini generateContent failed', String(e));
      return { items: [], storagePath, width, height, error: 'vision_failed' };
    }

    // Strip code fences defensively, then parse.
    let cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn('JSON parse failed', cleaned.slice(0, 500));
      return { items: [], storagePath, width, height, error: 'parse_failed' };
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    console.log('detected items', items.length);
    return { items, storagePath, width, height };
  },
);

// ---- FUNCTION 2: publishListingsFromDetection -------------------------------

exports.publishListingsFromDetection = onCall(
  { region: PHOTO_REGION, memory: '1GiB', timeoutSeconds: 300 },
  async (request) => {
    const uid = requireAuth(request);
    const data = request.data || {};
    const storagePath = sanitizeStoragePath(data.storagePath);
    const mode = data.mode === 'bundle' ? 'bundle' : 'separate';
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      throw new HttpsError('invalid-argument', 'items[] must be non-empty.');
    }
    console.log('publishListingsFromDetection', { uid, mode, count: items.length });

    const { buffer, bucket } = await downloadImage(storagePath);
    const meta = await sharpLib()(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;

    // ----- BUNDLE: one listing, whole photo, one QR -----
    if (mode === 'bundle') {
      const ref = db.collection('listings').doc();
      const listingId = ref.id;

      const lines = items.map((it, i) => {
        const t = it.title || it.label || `Item ${i + 1}`;
        return `• ${t}${it.description ? ` — ${it.description}` : ''}`;
      });
      const sum = items.reduce((acc, it) => acc + safeNum(it.priceEstimate != null ? it.priceEstimate : it.price), 0);

      const title = (data.bundleTitle && String(data.bundleTitle).trim())
        || `Bundle: ${items.length} items`;
      const description = (data.bundleDescription && String(data.bundleDescription).trim())
        || lines.join('\n');
      const price = data.bundlePrice != null ? safeNum(data.bundlePrice) : sum;

      const photoBuf = await sharpLib()(buffer).jpeg({ quality: 85 }).toBuffer();
      const photo_url = await savePublic(
        bucket, `listings/${uid}/${listingId}/photo.jpg`, photoBuf, 'image/jpeg');
      const qr_url = await savePublic(
        bucket, `listings/${uid}/${listingId}/qr.png`, await qrBuffer(listingId), 'image/png');

      await ref.set(buildListingDoc(uid, {
        title,
        description,
        category: items[0] && items[0].category,
        condition: items[0] && items[0].condition,
        price,
        photo_url,
        qr_url,
      }));

      console.log('bundle listing created', listingId);
      return { mode, listings: [{ listingId, photo_url, qr_url }] };
    }

    // ----- SEPARATE: one listing per item, cropped to its box -----
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const ref = db.collection('listings').doc();
      const listingId = ref.id;

      const extract = boxToExtract(it.box, width, height);
      let photoBuf;
      try {
        const pipe = sharpLib()(buffer);
        photoBuf = await (extract ? pipe.extract(extract) : pipe)
          .jpeg({ quality: 85 })
          .toBuffer();
      } catch (e) {
        console.warn('crop failed, using full image', i, String(e));
        photoBuf = await sharpLib()(buffer).jpeg({ quality: 85 }).toBuffer();
      }

      const photo_url = await savePublic(
        bucket, `listings/${uid}/${listingId}/photo.jpg`, photoBuf, 'image/jpeg');
      const qr_url = await savePublic(
        bucket, `listings/${uid}/${listingId}/qr.png`, await qrBuffer(listingId), 'image/png');

      await ref.set(buildListingDoc(uid, {
        title: it.title || it.label || `Item ${i + 1}`,
        description: it.description || '',
        category: it.category,
        condition: it.condition,
        price: safeNum(it.priceEstimate != null ? it.priceEstimate : it.price),
        photo_url,
        qr_url,
      }));

      console.log('separate listing created', listingId, i);
      results.push({ listingId, photo_url, qr_url });
    }

    return { mode, listings: results };
  },
);

// =============================================================================
// HOME SCAN  (scanItems)
// =============================================================================
//
//   scanItems(videoPath)
//     -> Downloads a short room-scan video from Storage, extracts ~1 frame/sec
//        (server-side ffmpeg), sends the frames to Claude vision, and returns a
//        deduped array of sellable items with a price range. No writes — the
//        app reviews the items, then reuses publishListingsFromDetection's
//        sibling flow (ListingPreview -> Where-to-Post -> publish) to list them.
//
//     Returns: { items:[{title,category,condition,priceLow,priceHigh}], total,
//                frameCount, videoPath, error? }
//
// Claude (not Gemini) per product spec; the key lives in Secret Manager
// (ANTHROPIC_API_KEY), never in client code. Runs in us-east1 to match Storage.

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const SCAN_MAX_FRAMES = parseInt(process.env.SCAN_MAX_FRAMES || '20', 10);

let _anthropic = null;
function anthropicClient() {
  if (_anthropic) return _anthropic;
  const Anthropic = require('@anthropic-ai/sdk');
  _anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  return _anthropic;
}
let _ffmpegPath = null;
function ffmpegBin() {
  if (!_ffmpegPath) _ffmpegPath = require('ffmpeg-static');
  return _ffmpegPath;
}

/**
 * Extract up to `maxFrames` JPEG frames at ~1 fps from a video buffer using the
 * bundled static ffmpeg binary. Frames are scaled to <=768px wide to keep the
 * vision payload small. Returns an array of JPEG Buffers (chronological).
 */
async function extractFrames(videoBuffer, maxFrames) {
  const os = require('os');
  const path = require('path');
  const fsp = require('fs/promises');
  const { spawn } = require('child_process');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scan-'));
  const inPath = path.join(tmpDir, 'input.mp4');
  const pattern = path.join(tmpDir, 'frame-%03d.jpg');
  try {
    await fsp.writeFile(inPath, videoBuffer);
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegBin(), [
        '-i', inPath,
        '-vf', "fps=1,scale='min(768,iw)':-2",
        '-frames:v', String(maxFrames),
        '-q:v', '4',
        pattern,
      ], { stdio: 'ignore' });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}`))));
    });

    const names = (await fsp.readdir(tmpDir))
      .filter((f) => f.startsWith('frame-') && f.endsWith('.jpg'))
      .sort();
    const frames = [];
    for (const n of names.slice(0, maxFrames)) {
      frames.push(await fsp.readFile(path.join(tmpDir, n)));
    }
    return frames;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const SCAN_PROMPT = `You are a marketplace listing assistant. The images are frames from a short video panning around a room. Identify every DISTINCT sellable physical item visible across ALL the frames combined.

The SAME real-world object usually appears in several consecutive frames — count it ONCE. Deduplicate aggressively across frames.

Return ONLY valid JSON (no markdown, no code fences, no commentary) in EXACTLY this shape:
{
  "items": [
    {
      "title": "catchy marketplace listing title",
      "category": "one of: Electronics, Clothing, Shoes, Home, Toys, Sports, Books, Tools, Beauty, Other",
      "condition": "one of: New, Like New, Good, Fair, Poor",
      "priceLow": 0,
      "priceHigh": 0
    }
  ]
}

Rules:
- priceLow and priceHigh are NUMBERS in USD (no currency symbol), priceLow <= priceHigh, based on typical US used-resale values.
- One entry per distinct real-world item. Do NOT emit the same item multiple times because it appears in multiple frames.
- Only movable, sellable goods. Skip fixtures and built-ins (walls, floors, doors, windows, outlets, ceiling fixtures, built-in cabinets).
- If you see nothing sellable, return {"items": []}.`;

/** Normalize one model item to the strict {title,category,condition,priceLow,priceHigh} shape. */
function normalizeScanItem(it) {
  const CATEGORIES = ['Electronics', 'Clothing', 'Shoes', 'Home', 'Toys', 'Sports', 'Books', 'Tools', 'Beauty', 'Other'];
  const CONDITIONS = ['New', 'Like New', 'Good', 'Fair', 'Poor'];
  const title = (it && it.title ? String(it.title) : '').trim() || 'Untitled item';
  const category = CATEGORIES.includes(it && it.category) ? it.category : 'Other';
  const condition = CONDITIONS.includes(it && it.condition) ? it.condition : 'Good';
  let low = safeNum(it && it.priceLow);
  let high = safeNum(it && it.priceHigh, low);
  if (high < low) { const t = low; low = high; high = t; }
  return { title, category, condition, priceLow: low, priceHigh: high };
}

/** Safety-net dedupe by case-folded title (the model is also told to dedupe). */
function dedupeByTitle(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

exports.scanItems = onCall(
  { region: PHOTO_REGION, memory: '2GiB', timeoutSeconds: 300, secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    const uid = requireAuth(request);
    const videoPath = sanitizeStoragePath(request.data && request.data.videoPath);
    console.log('scanItems', { uid, videoPath });

    // downloadImage is a generic byte-download (name aside) — reuse it for video.
    const { buffer } = await downloadImage(videoPath);

    let frames;
    try {
      frames = await extractFrames(buffer, SCAN_MAX_FRAMES);
    } catch (e) {
      console.error('frame extraction failed', String(e));
      return { items: [], total: 0, frameCount: 0, videoPath, error: 'frame_extraction_failed' };
    }
    if (frames.length === 0) {
      return { items: [], total: 0, frameCount: 0, videoPath, error: 'no_frames' };
    }
    console.log('extracted frames', frames.length);

    let raw = '';
    try {
      const content = frames.map((buf) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
      }));
      content.push({ type: 'text', text: SCAN_PROMPT });

      const msg = await anthropicClient().messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content }],
      });
      raw = (msg.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (e) {
      console.error('Claude vision failed', String(e));
      return { items: [], total: 0, frameCount: frames.length, videoPath, error: 'vision_failed' };
    }

    let cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.warn('scan JSON parse failed', cleaned.slice(0, 500));
      return { items: [], total: 0, frameCount: frames.length, videoPath, error: 'parse_failed' };
    }

    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items = dedupeByTitle(rawItems.map(normalizeScanItem));
    // "≈ $total" on the results screen = sum of each item's midpoint price.
    const total = Math.round(
      items.reduce((acc, it) => acc + (it.priceLow + it.priceHigh) / 2, 0),
    );
    console.log('scan items', { detected: rawItems.length, deduped: items.length, total });

    return { items, total, frameCount: frames.length, videoPath };
  },
);

// =============================================================================
// POST LISTING TO WEB  (postListing)
// =============================================================================
//
//   postListing(draft)
//     -> Authenticated Firebase callable. Forwards the listing draft to the
//        website's POST /api/listings (the canonical Supabase store), attaching
//        the APP_LISTINGS shared secret SERVER-SIDE (never in the app binary).
//        sellerId is taken from the verified Firebase auth uid — the client
//        cannot spoof it. Returns the web API's { id, url }.
//
// This replaces the app embedding APP_LISTINGS_SECRET: the app calls this
// callable (signed in), and only this function knows the secret.

const WEB_API_URL = process.env.WEB_API_URL || 'https://zazooomit.com/api/listings';

exports.postListing = onCall(
  { region: PHOTO_REGION, timeoutSeconds: 60, secrets: [APP_LISTINGS_SECRET] },
  async (request) => {
    const uid = requireAuth(request);
    const d = request.data || {};
    const payload = {
      title: d.title,
      description: d.description,
      price: d.price,
      category: d.category,
      condition: d.condition,
      photos: Array.isArray(d.photos) ? d.photos : [],
      sellerId: uid, // verified Firebase uid — not client-supplied
      locationCity: d.locationCity,
      lat: d.lat,
      lng: d.lng,
      source: 'app',
    };

    let res;
    let json;
    try {
      res = await fetch(WEB_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-app-secret': APP_LISTINGS_SECRET.value(),
        },
        body: JSON.stringify(payload),
      });
      json = await res.json().catch(() => ({}));
    } catch (e) {
      console.error('postListing fetch failed', String(e));
      throw new HttpsError('unavailable', 'Could not reach the marketplace.');
    }
    if (!res.ok) {
      console.warn('postListing web API error', res.status, json && json.error);
      throw new HttpsError(
        res.status === 422 ? 'invalid-argument' : 'internal',
        (json && json.error) || `web API ${res.status}`,
      );
    }
    return json; // { id, url }
  },
);
