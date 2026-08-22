/**
 * 元素定位器校验的登录态错误码。
 *
 * 校验器会注入发起者最近一次录制会话的登录态快照（进程内存，重启即失）。
 * 若目标页仍被重定向到登录墙，说明元素位于登录后才能访问的位置，
 * 后端会返回下面两个稳定错误码而不是静默「未匹配」。
 */

export const ELEMENT_VALIDATION_LOGIN_REQUIRED = "ELEMENT_VALIDATION_LOGIN_REQUIRED";
export const ELEMENT_VALIDATION_LOGIN_INVALID = "ELEMENT_VALIDATION_LOGIN_INVALID";

export function elementValidationLoginMessage(error?: string): string | null {
  if (error === ELEMENT_VALIDATION_LOGIN_REQUIRED) {
    return "该元素位于登录后才能访问的页面：当前没有可用的登录态。请先在录制浏览器中完成登录（重新发起录制），再校验该元素。";
  }
  if (error === ELEMENT_VALIDATION_LOGIN_INVALID) {
    return "该元素位于登录后才能访问的页面：已注入的登录态快照已失效。请重新发起一次录制并在其中完成登录，再校验该元素。";
  }
  return null;
}
