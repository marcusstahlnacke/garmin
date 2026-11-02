export class AppError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  } });
}

export async function equalSecret(value: string, expected: string): Promise<boolean> {
  if (expected.length < 32) return false;
  const encode = new TextEncoder();
  const [a, b] = await Promise.all([value, expected].map(s => crypto.subtle.digest("SHA-256", encode.encode(s))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export async function readJSON(request: Request, max = 12_000): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new AppError(415, "json_required");
  const raw = await boundedText(request, max);
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new AppError(400, "invalid_json"); }
}

export async function boundedText(message: Request | Response, max: number): Promise<string> {
  const reader = message.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel(); throw new AppError(413, "payload_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function field(body: Record<string, unknown>, name: string, max = 1024): string {
  const value = body[name];
  if (typeof value !== "string" || !value.length || value.length > max) throw new AppError(400, "invalid_" + name);
  return value;
}

export type Sealed = { iv: string; ciphertext: string };
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
}
function unbase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}

export class Vault {
  private key: Promise<CryptoKey>;
  constructor(secret: string) {
    const bytes = unbase64(secret);
    if (bytes.length !== 32) throw new AppError(503, "invalid_session_encryption_key");
    this.key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async seal(value: unknown, purpose: string): Promise<Sealed> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
      additionalData: new TextEncoder().encode(purpose) }, await this.key, new TextEncoder().encode(JSON.stringify(value)));
    return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  }
  async open<T>(value: Sealed, purpose: string): Promise<T> {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(value.iv),
      additionalData: new TextEncoder().encode(purpose) }, await this.key, unbase64(value.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
}
