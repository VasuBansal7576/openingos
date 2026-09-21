/** Signed AgentMail callback helpers.
 *
 * AgentMail's component performs this verification on the HTTP route. C1
 * keeps the same Svix-compatible verifier here for direct boundary tests and
 * for any future route adapter; downstream mutations never accept a raw
 * provider event as trusted merely because it has an event-shaped payload.
 */

export interface SignedWebhookHeaders {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
}

export type WebhookVerification =
  | { readonly ok: true; readonly body: string; readonly headers: SignedWebhookHeaders }
  | { readonly ok: false; readonly reason: string };

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function parseHeaders(headers: Headers | Record<string, string | null | undefined>): SignedWebhookHeaders | null {
  const read = (key: string): string => {
    if (headers instanceof Headers) return headers.get(key) ?? "";
    return headers[key] ?? "";
  };
  const id = read("svix-id");
  const timestamp = read("svix-timestamp");
  const signature = read("svix-signature");
  if (id.length === 0 || timestamp.length === 0 || signature.length === 0) return null;
  return { id, timestamp, signature };
}

/**
 * Verify a Svix v1 signature with bounded timestamp skew. Secrets may be
 * supplied as the AgentMail `whsec_` form or as raw base64 after that prefix.
 */
export async function verifySignedWebhook(
  secret: string,
  body: string,
  headers: Headers | Record<string, string | null | undefined>,
  nowMs = Date.now(),
  toleranceMs = 5 * 60 * 1_000,
): Promise<WebhookVerification> {
  const parsed = parseHeaders(headers);
  if (secret.trim().length === 0) return { ok: false, reason: "webhook secret is missing" };
  if (parsed === null) return { ok: false, reason: "required Svix headers are missing" };
  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: "webhook timestamp is invalid" };
  if (Math.abs(nowMs - timestampSeconds * 1_000) > toleranceMs) return { ok: false, reason: "webhook timestamp is outside tolerance" };
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const secretBytes = base64ToBytes(encodedSecret);
  if (secretBytes === null || secretBytes.length === 0) return { ok: false, reason: "webhook secret is not valid base64" };
  const signingInput = `${parsed.id}.${parsed.timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    copyToArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  const accepted = parsed.signature
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("v1,"))
    .some((entry) => {
      const supplied = base64ToBytes(entry.slice(3));
      return supplied !== null && constantTimeEqual(digest, supplied);
    });
  return accepted
    ? { ok: true, body, headers: parsed }
    : { ok: false, reason: "webhook signature is invalid" };
}
