import type { ThreadItemError } from "./contracts.js";

export const LOCAL_IMAGE_BUDGET_MESSAGE = "The model request exceeds the local image/history budget. Original images remain in the session. Reduce the current images or compact the text history before retrying.";

export function isLocalSessionImageBudgetError(error: Pick<ThreadItemError, "message" | "diagnostics"> | undefined) {
  if (!error?.message.includes(LOCAL_IMAGE_BUDGET_MESSAGE)) return false;
  const details = error.diagnostics;
  return details ? details.statusCode === 413 && details.errorCode === "request_size_exceeded"
    : error.message.includes("(413)") && error.message.includes('"code":"request_size_exceeded"');
}
