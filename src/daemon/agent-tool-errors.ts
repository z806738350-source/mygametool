/** Host-owned evidence that a tool rejected input before reaching an effect. */
const dispositions = {
  edit_text_not_unique: "correctable",
  invalid_text_file: "correctable",
  text_too_large: "correctable",
  invalid_canvas_document: "correctable",
  runtime_media_budget: "correctable",
  media_recovery_unavailable: "correctable",
  new_media_requires_authorization: "correctable",
  playtest_inspection_required: "correctable",
  playtest_session_limit: "correctable",
  playtest_project_busy: "correctable",
  project_execution_busy: "correctable",
  playtest_precondition: "correctable",
  audio_input_invalid: "correctable",
  invalid_animation_action: "correctable",
  invalid_model_reference: "correctable",
  model_review_required: "correctable",
  invalid_media_options: "correctable",
  invalid_blender_input: "correctable",
  invalid_character_view_input: "correctable",
  invalid_sprite_walk_input: "correctable",
  invalid_sprite_action_input: "correctable",
  unsafe_path: "blocked",
  protected_content: "blocked",
  authorization_denied: "blocked",
  approval_required: "blocked",
  source_review_required: "blocked",
  invalid_recovery_input: "correctable",
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

export type ToolConfirmedFailure = {
  readonly reason: "blender_run_failed";
  readonly runId: string;
} | {
  readonly reason: "isolated_command_failed";
  readonly operationId: string;
  readonly exitCode: number;
} | {
  readonly reason: "character_view_publication_failed";
  readonly operationId: string;
};

const confirmed = new WeakMap<object, ToolConfirmedFailure>();

/** Only the host's retained, terminated Blender job may confirm this failure. */
export function confirmBlenderRunFailure<T extends object>(target: T, runId: string): T {
  const failure = parseToolConfirmedFailure({ reason: "blender_run_failed", runId });
  if (!failure) throw new TypeError("Invalid retained Blender run ID");
  confirmed.set(target, failure);
  return target;
}

/** Only after a matching terminal status, unchanged source capture, ACK and release. */
export function confirmIsolatedCommandFailure<T extends object>(target: T, operationId: string, exitCode: number): T {
  const failure = parseToolConfirmedFailure({ reason: "isolated_command_failed", operationId, exitCode });
  if (!failure) throw new TypeError("Invalid confirmed isolated command failure");
  confirmed.set(target, failure);
  return target;
}

/** Only attach this to a verified terminal receipt from the character publication journal. */
export function confirmCharacterViewFailure<T extends object>(target: T, operationId: string): T {
  const failure = parseToolConfirmedFailure({ reason: "character_view_publication_failed", operationId });
  if (!failure) throw new TypeError("Invalid retained character publication ID");
  confirmed.set(target, failure);
  return target;
}

export function getToolConfirmedFailure(value: unknown): ToolConfirmedFailure | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? confirmed.get(value as object) : undefined;
}

export function inheritToolConfirmedFailure<T extends object>(target: T, original: unknown): T {
  const failure = getToolConfirmedFailure(original);
  if (failure) confirmed.set(target, failure);
  return target;
}

/** Validate host journal metadata; plain tool output is never execution evidence. */
export function parseToolConfirmedFailure(value: unknown): ToolConfirmedFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (input.reason === "character_view_publication_failed" && typeof input.operationId === "string" && /^[a-f0-9]{64}$/.test(input.operationId))
    return Object.freeze({ reason: "character_view_publication_failed", operationId: input.operationId });
  if (input.reason === "isolated_command_failed" && typeof input.operationId === "string" &&
    /^[a-f\d]{32}$/.test(input.operationId) && Number.isSafeInteger(input.exitCode) &&
    Number(input.exitCode) > 0 && Number(input.exitCode) <= 255)
    return Object.freeze({ reason: "isolated_command_failed", operationId: input.operationId, exitCode: Number(input.exitCode) });
  if (input.reason !== "blender_run_failed" || typeof input.runId !== "string" ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.runId)) return;
  return Object.freeze({ reason: "blender_run_failed", runId: input.runId });
}
