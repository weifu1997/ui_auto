// The feedback bridge intentionally shares Ant Design's instance with imperative callers.
/* oxlint-disable react/only-export-components */
import { App as AntdApp } from "antd";

type Feedback = ReturnType<typeof AntdApp.useApp>;

let feedback: Feedback | undefined;

function currentFeedback() {
  if (!feedback) throw new Error("ANTD_FEEDBACK_UNAVAILABLE");
  return feedback;
}

export function AntdFeedbackBridge() {
  feedback = AntdApp.useApp();
  return null;
}

export const message = {
  success: (...args: Parameters<Feedback["message"]["success"]>) => currentFeedback().message.success(...args),
  error: (...args: Parameters<Feedback["message"]["error"]>) => currentFeedback().message.error(...args),
  info: (...args: Parameters<Feedback["message"]["info"]>) => currentFeedback().message.info(...args),
  warning: (...args: Parameters<Feedback["message"]["warning"]>) => currentFeedback().message.warning(...args),
};

export const modal = {
  confirm: (...args: Parameters<Feedback["modal"]["confirm"]>) => currentFeedback().modal.confirm(...args),
};
