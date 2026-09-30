'use strict';

// Server-side credit gate for app publishing (publishListingsFromDetection).
//
// WHY: the app published FIRST and charged AFTER, treating a failed charge as
// non-fatal (call_publish_listings.dart / publish_listing.dart). Its only guard
// was a UI balance check on ONE home-screen button; My Listings → camera, the
// home Scan button, "post another" from the preview and multi-item scan results
// all reach publish without it. Any listing whose charge then failed (0 credits
// → insufficient_credits, or the database unreachable) stayed live for free.
// On 2026-09-29 two new accounts with 1 signup credit each posted 2 and 3.
//
// The server now charges BEFORE each listing is written, as the caller, through
// the same spend_credit RPC the web uses. The idempotency key is the Firestore
// listing id — the exact key installed apps send for their post-publish spend —
// so an old app's follow-up charge is a no-op replay, never a double charge.
// Fails CLOSED: if credits can't be verified, nothing is published.

/**
 * Balance for a Firebase uid via the service-role key (RLS-bypassing read).
 * Returns null when it cannot be determined.
 */
async function creditBalance({ fetchImpl = fetch, supabaseUrl, serviceKey, uid }) {
  if (!serviceKey) return null;
  try {
    const r = await fetchImpl(
      `${supabaseUrl}/rest/v1/firebase_credit_balances?firebase_uid=eq.${encodeURIComponent(uid)}&select=balance`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? Number(rows[0].balance) || 0 : 0;
  } catch {
    return null;
  }
}

/**
 * Throws (via makeError(code, message)) unless the caller can pay for `count` listings.
 */
async function requireCredits({ fetchImpl = fetch, supabaseUrl, serviceKey, uid, count, makeError }) {
  const bal = await creditBalance({ fetchImpl, supabaseUrl, serviceKey, uid });
  if (bal === null) throw makeError('unavailable', 'credits_unverified: Could not check your credits. Please try again.');
  if (bal < count) {
    throw makeError('resource-exhausted',
      `out_of_credits: You have ${bal} credit${bal === 1 ? '' : 's'}; this post needs ${count}. Each listing uses 1 credit.`);
  }
  return bal;
}

/**
 * Charge 1 credit for listingId AS THE CALLER (their Firebase ID token), so
 * spend_credit's own balance gate and idempotency apply. Throws on any failure.
 */
async function chargeListing({ fetchImpl = fetch, supabaseUrl, serviceKey, authorization, listingId, makeError }) {
  if (!authorization || !/^Bearer\s+\S+/i.test(authorization) || !serviceKey) {
    throw makeError('unavailable', 'credits_unverified: Could not verify your credits. Please try again.');
  }
  let r;
  try {
    r = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/spend_credit`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_amount: 1, p_idempotency_key: listingId, p_reason: 'listing' }),
    });
  } catch {
    throw makeError('unavailable', 'credits_unverified: Could not verify your credits. Please try again.');
  }
  if (r.ok) return;
  const body = await r.text().catch(() => '');
  if (/insufficient_credits/.test(body)) {
    throw makeError('resource-exhausted', "out_of_credits: You're out of credits. Each listing uses 1 credit.");
  }
  console.error('spend_credit failed', r.status, body.slice(0, 300));
  throw makeError('unavailable', 'credits_unverified: Could not verify your credits. Please try again.');
}

module.exports = { creditBalance, requireCredits, chargeListing };
