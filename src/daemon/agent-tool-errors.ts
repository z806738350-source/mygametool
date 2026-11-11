/** Host-owned evidence that a tool rejected input before reaching an effect. */
const dispositions = {
  edit_text_not_unique: "correctable",
  text_too_large: "correctable",
  invalid_canvas_document: "correctable",
  runtime_media_budget: "correctable",
  media_recovery_unavailable: "correctable",
  playtest_inspection_required: "correctable",
  playtest_session_limit: "correctable",
  audio_input_invalid: "correctable",
  invalid_animation_action: "correctable",
  invalid_model_reference: "correctable",
  invalid_media_options: "correctable",
  unsafe_path: "blocked",
  protected_content: "blocked",
  authorization_denied: "blocked",
  approval_required: "blocked",
  source_review_required: "blocked",
} as const;

export type ToolPreflightReason = keyof typeof dispositions;
export interface ToolPreflightFailure {
  readonly effect: "none";
  readonly reason: ToolPreflightReason;
  readonly disposition: "correctable" | "blocked";
}

// Error messages, prototypes and JSON properties are not execution evidence.
const trusted = new WeakMap<object, ToolPreflightFailure>();

export function toolPreflightError(message: string, reason: ToolPreflightReason): Error {
  if (!Object.hasOwn(dispositions, reason)) throw new TypeError("Unknown tool preflight reason");
  const error = new Error(message);
  trusted.set(error, Object.freeze({ effect: "none", reason, disposition: dispositions[reason] }));
  return error;
}

export function getToolPreflightFailure(value: unknown): ToolPreflightFailure | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? trusted.get(value as object) : undefined;
}

/** Transfer only existing host evidence; an untrusted descriptor cannot brand a result. */
export function inheritToolPreflightFailure<T extends object>(target: T, original: unknown): T {
  const failure = getToolPreflightFailure(original);
  if (failure) trusted.set(target, failure);
  return target;
}

/** Schema validation for host-owned journal entries, never authorization by itself. */
export function parseToolPreflightFailure(value: unknown): ToolPreflightFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (input.effect !== "none" || typeof input.reason !== "string" || !Object.hasOwn(dispositions, input.reason)) return;
  const reason = input.reason as ToolPreflightReason;
  if (input.disposition !== dispositions[reason]) return;
  return Object.freeze({ effect: "none", reason, disposition: dispositions[reason] });
}
