import { createOAuth } from "./oauth";
import { handleMcp } from "./mcp";
import { DurableObject } from "cloudflare:workers";
import { AppError, equalSecret, field, json, readJSON, Sealed, Vault } from "./common";
import { completeMFA, GarminClient, login, Pending, Session } from "./garmin";
import { activitySection, listActivities, metrics, wellness, workout } from "./data";
import { page, pageResponse, script } from "./page";
import { schema } from "./schema";

export interface Env {
  GARMIN: DurableObjectNamespace<GarminAccount>;
  ACTION_API_KEY: string;
  OAUTH_KV?: KVNamespace;
  OAUTH_APPROVAL_KEY?: string;
  MCP_ALLOWED_ORIGINS?: string;
  ADMIN_API_KEY: string;
  SESSION_ENCRYPTION_KEY: string;
}

function failure(error: unknown): Response {
  return error instanceof AppError ? json({ error: error.code }, error.status) : json({ error: "internal_error" }, 503);
}

export class GarminAccount extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  async fetch(request: Request): Promise<Response> {
    if (this.waiting >= 8) return json({ error: "too_many_concurrent_requests" }, 429);
    this.waiting++;
    const operation = this.queue.then(() => this.handle(request)).catch(failure).finally(() => this.waiting--);
    this.queue = operation.then(() => undefined);
    return operation;
  }

  async oauthRateLimit(kind: 'page' | 'approval'): Promise<boolean> {
    if (this.waiting >= 8) return false;
    this.waiting++;
    const operation = this.queue.then(async () => {
      try { await this.count('oauth:' + kind, kind === 'page' ? 100 : 10, 600_000, 'oauth_rate_limited'); return true; }
      catch { return false; }
    }).finally(() => this.waiting--);
    this.queue = operation.then(() => undefined);
    return operation;
  }

  async alarm(): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.ctx.storage.delete(["pending", "mfaAttempts"]);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private vault(): Vault { return new Vault(this.env.SESSION_ENCRYPTION_KEY); }
  private async load<T>(key: string): Promise<T | undefined> {
    const value = await this.ctx.storage.get<Sealed>(key);
    return value ? this.vault().open<T>(value, key) : undefined;
  }
  private async save(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, await this.vault().seal(value, key));
  }
  private async count(key: string, maximum: number, window: number, code: string): Promise<void> {
    let state = await this.ctx.storage.get<{ count: number; until: number }>(key);
    if (!state || state.until <= Date.now()) state = { count: 0, until: Date.now() + window };
    if (state.count >= maximum) throw new AppError(429, code);
    await this.ctx.storage.put(key, { ...state, count: state.count + 1 });
  }
  private async verified(session: Session): Promise<Response> {
    const client = new GarminClient(session, async updated => { session = updated; });
    // Verification must succeed before replacing an existing connected account.
    const profile = await client.get("/userprofile-service/socialProfile");
    if (!profile || typeof profile.displayName !== "string") throw new AppError(502, "garmin_profile_missing");
    await this.save("session", { ...client.session, displayName: profile.displayName });
    await this.ctx.storage.delete(["pending", "mfaAttempts"]);
    await this.ctx.storage.deleteAlarm();
    return json({ status: "connected" });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    // Recheck the appropriate secret inside the object, not just the outer Worker.
    const admin = path.startsWith("/admin/");
    const expected = admin ? this.env.ADMIN_API_KEY : this.env.ACTION_API_KEY;
    if (!await equalSecret(request.headers.get("Authorization")?.replace(/^Bearer /, "") || "", expected || "")) throw new AppError(401, "unauthorized");
    if (admin) {
      if (request.headers.get("Origin") && request.headers.get("Origin") !== url.origin) throw new AppError(403, "origin_refused");
      if (path === "/admin/status" && request.method === "GET") return json({ connected: Boolean(await this.ctx.storage.get("session")), mfa_pending: Boolean(await this.ctx.storage.get("pending")) });
      if (request.method !== "POST") throw new AppError(405, "method_not_allowed");
      if (path === "/admin/disconnect") {
        await this.ctx.storage.delete(["session", "pending", "mfaAttempts"]);
        await this.ctx.storage.deleteAlarm();
        return json({ status: "disconnected" });
      }
      const body = await readJSON(request);
      if (path === "/admin/login") {
        await this.count("loginAttempts", 5, 3600_000, "login_rate_limited");
        await this.ctx.storage.delete(["pending", "mfaAttempts"]);
        const result = await login(field(body, "username", 320), field(body, "password"));
        if ("cookies" in result) {
          await this.save("pending", result);
          await this.ctx.storage.setAlarm(result.expires);
          return json({ status: "mfa_required" });
        }
        return this.verified(result);
      }
      if (path === "/admin/mfa") {
        const pending = await this.load<Pending>("pending");
        if (!pending || pending.expires <= Date.now()) {
          await this.ctx.storage.delete("pending");
          throw new AppError(409, "mfa_expired");
        }
        await this.count("mfaAttempts", 5, 10 * 60_000, "mfa_attempt_limit");
        const code = field(body, "code", 32);
        if (!/^[A-Za-z0-9 -]{4,32}$/.test(code)) throw new AppError(400, "invalid_code");
        let session: Session;
        try { session = await completeMFA(pending, code); }
        catch (error) { await this.save("pending", pending); throw error; }
        return this.verified(session);
      }
      if (path === "/admin/import") {
        await this.count("loginAttempts", 5, 3600_000, "login_rate_limited");
        return this.verified({ di_token: field(body, "di_token", 8000), di_refresh_token: field(body, "di_refresh_token", 8000),
          di_client_id: field(body, "di_client_id", 200), expires_at: Date.now() + 300_000 });
      }
      throw new AppError(404, "not_found");
    }
    if (request.method !== "GET") throw new AppError(405, "method_not_allowed");
    await this.count("dataRequests", 2000, 86400_000, "daily_app_limit");
    const session = await this.load<Session>("session");
    if (!session) throw new AppError(409, "garmin_not_connected");
    const client = new GarminClient(session, updated => this.save("session", updated));
    let result: unknown;
    if (path === "/activities") result = await listActivities(client, url);
    else {
      const activity = path.match(/^\/activities\/([1-9][0-9]{0,19})\/(analysis|metrics|sections\/([a-z_]+))$/);
      const health = path.match(/^\/wellness\/(\d{4}-\d{2}-\d{2})\/([a-z_]+)$/);
      if (activity) {
        const [, id, operation, section] = activity;
        result = operation === "analysis" ? await workout(client, id) : operation === "metrics" ? await metrics(client, id, url) : await activitySection(client, id, section);
      } else if (health) result = await wellness(client, health[1], health[2]);
      else throw new AppError(404, "not_found");
    }
    const encoded = JSON.stringify(result);
    if (new TextEncoder().encode(encoded).byteLength > 85_000) return json({ status: "omitted", reason: "response_budget_exceeded", instruction: "Reduce limit or max_points where supported. This section was not included; do not analyze as if present." });
    return json(result);
  }
}

const readMcp = async (request: Request, env: Env): Promise<Response> => {
  const id = env.GARMIN.idFromName('personal-account-v1');
  return (await handleMcp(request, env, read => env.GARMIN.get(id).fetch(read)))!;
};
const oauth = createOAuth(readMcp);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      const oauthRoute = path === '/authorize' || path.startsWith('/oauth/') || path.startsWith('/.well-known/');
      if (oauthRoute || path === '/mcp') {
        if (path === '/mcp' && await equalSecret(request.headers.get('Authorization')?.replace(/^Bearer /, '') || '', env.ACTION_API_KEY || '')) return readMcp(request, env);
        if (!env.OAUTH_KV || !env.OAUTH_APPROVAL_KEY || env.OAUTH_APPROVAL_KEY.length < 32 || env.OAUTH_APPROVAL_KEY === env.ACTION_API_KEY || env.OAUTH_APPROVAL_KEY === env.ADMIN_API_KEY) return json({ error: 'configure_oauth' }, 503);
        return await oauth.fetch(request, env as Parameters<typeof oauth.fetch>[1], ctx);
      }
      if (request.method === "GET") {
        if (path === "/connect" || path === "/") return pageResponse(page, "text/html");
        if (path === "/connect.js") return pageResponse(script, "application/javascript");
        if (path === "/openapi.json") return json(schema(url.origin));
        if (path === "/health") return json({ status: "ok", garmin_connection: "not_checked" });
      }
      if (!env.ACTION_API_KEY || !env.ADMIN_API_KEY || env.ACTION_API_KEY === env.ADMIN_API_KEY) throw new AppError(503, "configure_separate_api_keys");
      if (path === "/mcp") {
        const id = env.GARMIN.idFromName("personal-account-v1");
        return (await handleMcp(request, env, read => env.GARMIN.get(id).fetch(read)))!;
      }
      const admin = path.startsWith("/admin/");
      if (!await equalSecret(request.headers.get("Authorization")?.replace(/^Bearer /, "") || "", (admin ? env.ADMIN_API_KEY : env.ACTION_API_KEY) || "")) throw new AppError(401, "unauthorized");
      const id = env.GARMIN.idFromName("personal-account-v1");
      return await env.GARMIN.get(id).fetch(request);
    } catch (error) { return failure(error); }
  },
} satisfies ExportedHandler<Env>;


