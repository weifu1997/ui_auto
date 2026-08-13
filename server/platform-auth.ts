import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

export function passwordHash(password: string) {
  if (password.length > 1024) throw new Error("PASSWORD_TOO_LONG");
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export function passwordMatches(password: string, encoded: string) {
  const [saltText, hashText] = encoded.split(":");
  if (!saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function setSessionCookie(response: ServerResponse, token: string, expiresAt: string) {
  // Secure 只在实际加密连接（HTTPS/反向代理 TLS）上设置；http 部署（内网/本机）不设置，
  // 否则浏览器会拒绝 cookie 导致登录后会话无法恢复（生产模式 + http 的真实案例 2026-08-13）。
  const secure = (response.req.socket as NodeJS.Socket & { encrypted?: boolean }).encrypted || process.env.AUTOFLOW_COOKIE_SECURE === "1" ? "; Secure" : "";
  response.setHeader("set-cookie", `autoflow_session=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}${secure}`);
}

export function clearSessionCookie(response: ServerResponse) {
  const secure = (response.req.socket as NodeJS.Socket & { encrypted?: boolean }).encrypted || process.env.AUTOFLOW_COOKIE_SECURE === "1" ? "; Secure" : "";
  response.setHeader("set-cookie", `autoflow_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}
