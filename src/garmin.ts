// Protocol adapted from python-garminconnect 0.3.20 (MIT); see THIRD_PARTY_NOTICES.
// Only the documented-in-source mobile SSO → DI flow is implemented; no bot bypass.
import { AppError, boundedText } from "./common";

const SSO = "https://sso.garmin.com";
const API = "https://connectapi.garmin.com";
const TOKEN = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const SERVICE = "https://mobile.integration.garmin.com/gcm/ios";
const CLIENTS = ["GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2", "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4", "GARMIN_CONNECT_MOBILE_ANDROID_DI", "GARMIN_CONNECT_MOBILE_IOS_DI"];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const NATIVE = { "User-Agent": "GCM-Android-5.23", "X-Garmin-User-Agent": "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0", Accept: "application/json" };
type Data = Record<string, any>;
type Cookie = { name: string; value: string; path: string; expires?: number };
export type Session = { di_token: string; di_refresh_token: string; di_client_id: string; expires_at: number; displayName?: string };
export type Pending = { cookies: Cookie[]; method: string; expires: number };

function checked(response: Response): void {
  if (response.status === 429 || response.status === 427) throw new AppError(429, "garmin_rate_limited");
  if (response.status === 403) throw new AppError(502, "garmin_blocked");
  if (response.status === 401) throw new AppError(409, "garmin_reconnect_required");
  if (!response.ok) throw new AppError(502, "garmin_http_" + response.status);
}

async function request(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { ...options, redirect: "manual", signal: controller.signal });
    const body = await boundedText(response, 1_000_000);
    return new Response([101, 204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, "garmin_network_error");
  } finally { clearTimeout(timer); }
}

async function responseJSON(response: Response, max = 1_000_000): Promise<any> {
  checked(response);
  const raw = await boundedText(response, max);
  try { return JSON.parse(raw); } catch { throw new AppError(502, "garmin_non_json_response"); }
}

function cookiesFrom(response: Response, cookies: Cookie[], path: string): Cookie[] {
  const jar = [...cookies];
  for (const header of response.headers.getAll("Set-Cookie")) {
    const [pair, ...attrs] = header.split(";");
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const entry: Cookie = { name: pair.slice(0, index).trim(), value: pair.slice(index + 1), path: path.slice(0, path.lastIndexOf("/") + 1) || "/" };
    let maxAge: number | undefined;
    let valid = true;
    for (const attr of attrs) {
      const [key, ...parts] = attr.trim().split("=");
      const val = parts.join("=");
      if (key.toLowerCase() === "path" && val.startsWith("/")) entry.path = val;
      if (key.toLowerCase() === "domain" && !["garmin.com", "sso.garmin.com"].includes(val.toLowerCase().replace(/^\./, ""))) valid = false;
      if (key.toLowerCase() === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
      if (key.toLowerCase() === "expires" && Number.isFinite(Date.parse(val))) entry.expires = Date.parse(val);
    }
    if (!valid) continue;
    if (maxAge !== undefined) entry.expires = Date.now() + maxAge * 1000;
    const old = jar.findIndex(c => c.name === entry.name && c.path === entry.path);
    if (old >= 0) jar.splice(old, 1);
    if (!entry.expires || entry.expires > Date.now()) jar.push(entry);
    if (jar.length > 64) throw new AppError(502, "garmin_cookie_limit");
  }
  return jar;
}

class SSOClient {
  constructor(public cookies: Cookie[] = []) {}
  async send(path: string, body?: unknown): Promise<Response> {
    let url = new URL(path, SSO);
    if (url.origin !== SSO) throw new AppError(502, "garmin_redirect_refused");
    for (let redirects = 0; redirects < 5; redirects++) {
      const cookie = this.cookies.filter(c => (!c.expires || c.expires > Date.now()) &&
        (url.pathname === c.path || url.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")))
        .sort((a, b) => b.path.length - a.path.length).map(c => c.name + "=" + c.value).join("; ");
      const response = await request(url.href, {
        method: body === undefined ? "GET" : "POST",
        headers: { "User-Agent": UA, Accept: body === undefined ? "text/html" : "application/json", "Accept-Language": "en-US,en;q=0.9",
          Origin: SSO, Referer: `${SSO}/mobile/sso/en_US/sign-in?${new URLSearchParams({ clientId: "GCM_IOS_DARK", service: SERVICE })}`,
          ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      this.cookies = cookiesFrom(response, this.cookies, url.pathname);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (body !== undefined || !location) throw new AppError(502, "garmin_redirect_refused");
        url = new URL(location, url);
        if (url.origin !== SSO) throw new AppError(502, "garmin_redirect_refused");
      } else return response;
    }
    throw new AppError(502, "garmin_redirect_limit");
  }
}

function loginPath(suffix: string): string {
  return `/mobile/api/${suffix}?${new URLSearchParams({ clientId: "GCM_IOS_DARK", locale: "en-US", service: SERVICE })}`;
}

function loginResult(data: Data, client: SSOClient): Pending | string {
  const type = data?.responseStatus?.type;
  if (type === "SUCCESSFUL" && typeof data.serviceTicketId === "string") return data.serviceTicketId;
  if (type === "MFA_REQUIRED") return { cookies: client.cookies, method: data.customerMfaInfo?.mfaLastMethodUsed || "email", expires: Date.now() + 10 * 60_000 };
  if (type === "CAPTCHA_REQUIRED") throw new AppError(502, "garmin_captcha_required");
  if (type === "INVALID_USERNAME_PASSWORD") throw new AppError(401, "garmin_invalid_credentials");
  throw new AppError(401, "garmin_login_or_mfa_failed");
}

export async function login(username: string, password: string): Promise<Pending | Session> {
  const client = new SSOClient();
  const page = await client.send(`/mobile/sso/en_US/sign-in?${new URLSearchParams({ clientId: "GCM_IOS_DARK", service: SERVICE })}`);
  checked(page);
  await page.body?.cancel();
  // Normal mobile web-view sequence; no retries or fingerprint impersonation.
  await new Promise(resolve => setTimeout(resolve, 2000));
  const data = await responseJSON(await client.send(loginPath("login"), { username, password, rememberMe: true, captchaToken: "" }));
  const result = loginResult(data, client);
  return typeof result === "string" ? exchangeTicket(result) : result;
}

export async function completeMFA(pending: Pending, code: string): Promise<Session> {
  if (pending.expires < Date.now()) throw new AppError(409, "mfa_expired");
  const client = new SSOClient(pending.cookies);
  const response = await client.send(loginPath("mfa/verifyCode"), {
    mfaMethod: pending.method, mfaVerificationCode: code, rememberMyBrowser: true, reconsentList: [], mfaSetup: false,
  });
  pending.cookies = client.cookies;
  const data = await responseJSON(response);
  const result = loginResult(data, client);
  if (typeof result !== "string") throw new AppError(401, "garmin_login_or_mfa_failed");
  return exchangeTicket(result);
}

function tokenData(data: Data, clientID: string, oldRefresh?: string): Session {
  if (typeof data?.access_token !== "string" || !(data.refresh_token || oldRefresh)) throw new AppError(502, "garmin_invalid_token_response");
  const seconds = Number(data.expires_in);
  // Only a selector for subsequent Garmin refresh calls, never authentication
  // or user identity. The API still verifies the actual token on every call.
  try {
    const part = data.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (typeof payload.client_id === "string" && payload.client_id.length <= 200) clientID = payload.client_id;
  } catch { /* Opaque tokens are valid too. */ }
  return { di_token: data.access_token, di_refresh_token: data.refresh_token || oldRefresh,
    di_client_id: clientID, expires_at: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000 };
}

async function tokenPost(clientID: string, data: Record<string, string>): Promise<Response> {
  return request(TOKEN, { method: "POST", headers: { ...NATIVE, Authorization: "Basic " + btoa(clientID + ":"), "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ ...data, client_id: clientID }).toString() });
}

async function exchangeTicket(ticket: string): Promise<Session> {
  for (const clientID of CLIENTS) {
    const response = await tokenPost(clientID, { grant_type: `${API}/di-oauth2-service/oauth/grant/service_ticket`, service_ticket: ticket, service_url: SERVICE });
    if (response.status === 400 || response.status === 401) { await response.body?.cancel(); continue; }
    return tokenData(await responseJSON(response), clientID);
  }
  throw new AppError(502, "garmin_ticket_exchange_failed");
}

export class GarminClient {
  constructor(public session: Session, private persist: (session: Session) => Promise<void>) {}
  async refresh(): Promise<void> {
    const response = await tokenPost(this.session.di_client_id, { grant_type: "refresh_token", refresh_token: this.session.di_refresh_token });
    if ([400, 401].includes(response.status)) throw new AppError(409, "garmin_reconnect_required");
    const data = await responseJSON(response);
    const next = { ...tokenData(data, this.session.di_client_id, this.session.di_refresh_token), displayName: this.session.displayName };
    // Persist rotated tokens BEFORE any subsequent API call or successful response.
    await this.persist(next);
    this.session = next;
  }
  async get(path: string): Promise<any> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || new URL(path, API).origin !== API) throw new AppError(400, "invalid_garmin_path");
    let refreshed = false;
    if (this.session.expires_at < Date.now() + 60_000) { await this.refresh(); refreshed = true; }
    let response = await request(API + path, { headers: { ...NATIVE, Authorization: "Bearer " + this.session.di_token } });
    if (response.status === 401 && !refreshed) {
      await response.body?.cancel();
      await this.refresh();
      response = await request(API + path, { headers: { ...NATIVE, Authorization: "Bearer " + this.session.di_token } });
    }
    return responseJSON(response);
  }
}
