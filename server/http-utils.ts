import type { IncomingMessage, ServerResponse } from "node:http";

const jsonContentType = { "content-type": "application/json; charset=utf-8" };

export function json(value: unknown) {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { ...jsonContentType });
  response.end(json(body));
}

export function sendError(response: ServerResponse, status: number, error: string) {
  sendJson(response, status, { error });
}

export class PlatformError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function readBody(request: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new PlatformError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T>(request: IncomingMessage, maxBytes = 1_000_000) {
  const body = await readBody(request, maxBytes);
  if (body.length === 0) return {} as T;
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new PlatformError(400, "INVALID_JSON");
  }
}

export type ErrorResponseOptions = {
  /** 对普通 Error 暴露 message 作为错误码（legacy Worker 契约）。默认关闭。 */
  exposeMessage?: boolean;
  /** 非 PlatformError 时的通用内部错误码。默认 "INTERNAL_ERROR"。 */
  internalCode?: string;
};

/** Map an arbitrary thrown value to an HTTP status + error code. */
export function errorResponse(error: unknown, options: ErrorResponseOptions = {}): { status: number; code: string } {
  if (error instanceof PlatformError) return { status: error.status, code: error.code };
  if (options.exposeMessage && error instanceof Error) {
    const message = error.message;
    if (message.includes("NOT_FOUND")) return { status: 404, code: message };
    if (message === "PAYLOAD_TOO_LARGE") return { status: 413, code: message };
    if (message === "RUN_SECRETS_REQUIRED") return { status: 409, code: message };
    return { status: 400, code: message };
  }
  return { status: 500, code: options.internalCode ?? "INTERNAL_ERROR" };
}

/**
 * Wrap an async route handler with a unified try/catch that serializes any
 * error into a JSON error response. Optional per-route rate limiting keyed by
 * a request attribute (e.g. an id from the URL).
 */
export function routeHandler(
  handler: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean | void> | boolean | void,
  options: {
    rateLimit?: { windowMs: number; max: number; key: (request: IncomingMessage, url: URL) => string | undefined };
    errorResponse?: ErrorResponseOptions;
  } = {},
) {
  const windows = new Map<string, number[]>();
  const { rateLimit } = options;
  return async (request: IncomingMessage, response: ServerResponse, externalUrl?: URL): Promise<boolean | void> => {
    const url = externalUrl ?? new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (rateLimit) {
      const key = rateLimit.key(request, url);
      if (key) {
        const cutoff = Date.now() - rateLimit.windowMs;
        const hits = (windows.get(key) ?? []).filter((time) => time > cutoff);
        if (hits.length >= rateLimit.max) {
          sendError(response, 429, "RATE_LIMITED");
          return true;
        }
        hits.push(Date.now());
        windows.set(key, hits);
      }
    }
    try {
      return await handler(request, response, url);
    } catch (error) {
      const { status, code } = errorResponse(error, options.errorResponse);
      sendError(response, status, code);
      return true;
    }
  };
}

/** Apply CORS headers for an allowlisted origin; returns false when forbidden. */
export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: string[],
  allowLoopback = false,
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const allowed = allowedOrigins.includes(origin)
    || (allowLoopback && allowedOrigins.length === 0 && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin));
  if (!allowed) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("vary", "origin");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
  return true;
}
