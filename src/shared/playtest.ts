import type { ProjectType } from "./contracts.js";

export interface PlaytestViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export type GameRuntime = "web" | "godot" | "unity";
export type GameProjectType = ProjectType;
export type GameUseInputCapability = "pointer" | "keyboard" | "text" | "touch" | "resize";
export type GameUseObservationCapability = "screenshot" | "dom" | "canvas" | "console" | "network";
export type GameUseDeterminismCapability = "snapshot" | "reset" | "seed" | "step";

export interface GameUseCapabilities {
  runtime: GameRuntime;
  projectTypes: readonly GameProjectType[];
  input: readonly GameUseInputCapability[];
  observation: readonly GameUseObservationCapability[];
  deterministic: readonly GameUseDeterminismCapability[];
  watch: boolean;
}

export const WEB_GAME_USE_CAPABILITIES: GameUseCapabilities = {
  runtime: "web",
  projectTypes: ["web-game", "interactive-story", "general"],
  input: ["pointer", "keyboard", "text", "touch", "resize"],
  observation: ["screenshot", "dom", "canvas", "console", "network"],
  deterministic: [],
  watch: true,
};

export type GameUseOpenTarget =
  | { runtime: "web"; url: string }
  | { runtime: "godot" | "unity"; projectPath: string };

export type PlaytestTarget =
  | { selector: string }
  | { testId: string }
  | { text: string }
  | { role: string; name?: string }
  | { x: number; y: number };

export type PlaytestAction =
  | { type: "click"; target: PlaytestTarget }
  | { type: "type"; target: Exclude<PlaytestTarget, { x: number; y: number }>; text: string }
  | { type: "press"; key: string; duration?: number }
  | { type: "touch"; x: number; y: number }
  | { type: "wait"; milliseconds: number }
  | { type: "resize"; viewport: PlaytestViewport }
  | { type: "bridge"; method: "reset" }
  | { type: "bridge"; method: "setSeed" | "step"; value: number };

export interface PlaytestElement {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  disabled: boolean;
  box: { x: number; y: number; width: number; height: number };
}

export interface PlaytestCanvas {
  index: number;
  width: number;
  height: number;
  box: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface PlaytestLog {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  line?: number;
  timestamp: string;
}

export interface PlaytestFailedRequest {
  url: string;
  error: string;
  timestamp: string;
}

export interface PlaytestMedia {
  tag: "audio" | "video";
  source: string;
  readyState: number;
  currentTime: number;
  duration: number | null;
  paused: boolean;
  ended: boolean;
  errorCode: number | null;
  totalVideoFrames?: number;
  droppedVideoFrames?: number;
  videoWidth?: number;
  videoHeight?: number;
  networkState?: number;
  elementId?: string;
  buffered?: Array<{ start: number; end: number }>;
}

export interface GameUseSnapshot {
  sessionId: string;
  runtime: GameRuntime;
  capabilities: GameUseCapabilities;
  viewport: PlaytestViewport;
  gameState?: unknown;
  bridgeCapabilities?: string[];
}

export interface PlaytestSnapshot extends GameUseSnapshot {
  url: string;
  title: string;
  readyState: string;
  elements: PlaytestElement[];
  canvases: PlaytestCanvas[];
  media?: PlaytestMedia[];
  /** Visible text of the page and its frames, truncated. */
  text?: string;
  logs: PlaytestLog[];
  failedRequests: PlaytestFailedRequest[];
}

export interface PlaytestCapture {
  sessionId: string;
  mediaType: "image/jpeg";
  data: string;
  width: number;
  height: number;
  analysis: {
    sampledPixels: number;
    opaqueRatio: number;
    luminanceMean: number;
    luminanceVariance: number;
    likelyBlank: boolean;
  };
}

export interface PlaytestWatchState {
  visible: boolean;
  activeSessions: number;
}

export type PlaytestResourceStatus = "live" | "closing" | "closed" | "unknown";

export type PlaytestRequest =
  | { operation: "open"; target: GameUseOpenTarget; viewport: PlaytestViewport }
  | { operation: "inspect"; sessionId: string }
  | { operation: "act"; sessionId: string; actions: PlaytestAction[] }
  | { operation: "capture"; sessionId: string }
  | { operation: "close"; sessionId: string }
  | { operation: "sessionStatus"; sessionId: string }
  | { operation: "closeAll" };

export type PlaytestResult =
  | { operation: "open"; snapshot: GameUseSnapshot }
  | { operation: "inspect"; snapshot: GameUseSnapshot }
  | { operation: "act"; snapshot: GameUseSnapshot }
  | { operation: "capture"; capture: PlaytestCapture }
  | { operation: "close"; resourceStatus?: PlaytestResourceStatus }
  | { operation: "sessionStatus"; sessionId: string; resourceStatus: PlaytestResourceStatus }
  | { operation: "closeAll" };

export interface GameRuntimeAdapter {
  readonly available: boolean;
  readonly capabilities: GameUseCapabilities;
  request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult>;
  /** References owned by this adapter; they may have expired. Never lists another conversation's windows. */
  ownedSessionIds?(): readonly string[];
  /** A fresh observation for an authenticated receipt. Never runs page code. */
  sessionStatus?(sessionId: string, signal?: AbortSignal): Promise<PlaytestResourceStatus>;
  close(): void;
}

/** Host observation of a stopped action batch; never infer input delivery from error text. */
export interface PlaytestActionFailure {
  version: 1;
  sessionId: string;
  completedActions: number;
  failedAction: number;
  actionType: PlaytestAction["type"];
  phase: "target_lookup" | "session_unavailable" | "action";
  inputDispatched: false | "unknown";
}

const actionFailures = new WeakMap<object, Readonly<PlaytestActionFailure>>();
export function playtestActionError(message: string, failure: PlaytestActionFailure): Error {
  const error = new Error(message);
  actionFailures.set(error, Object.freeze({ version: failure.version, sessionId: failure.sessionId,
    completedActions: failure.completedActions, failedAction: failure.failedAction,
    actionType: failure.actionType, phase: failure.phase, inputDispatched: failure.inputDispatched }));
  return error;
}
export function getPlaytestActionFailure(cause: unknown): Readonly<PlaytestActionFailure> | undefined {
  return cause !== null && typeof cause === "object" ? actionFailures.get(cause) : undefined;
}

export interface PlaytestOpenFailure {
  version: 1;
  reason: "session_limit";
  limit: number;
  windowCreated: false;
}
const openFailures = new WeakMap<object, Readonly<PlaytestOpenFailure>>();
export function playtestOpenError(message: string, failure: PlaytestOpenFailure): Error {
  const error = new Error(message);
  if (failure.version !== 1 || failure.reason !== "session_limit" || !Number.isInteger(failure.limit)
    || failure.limit <= 0 || failure.limit > 100 || failure.windowCreated !== false) return error;
  openFailures.set(error, Object.freeze({ version: failure.version, reason: failure.reason, limit: failure.limit, windowCreated: false }));
  return error;
}
export function getPlaytestOpenFailure(cause: unknown): Readonly<PlaytestOpenFailure> | undefined {
  return cause !== null && typeof cause === "object" ? openFailures.get(cause) : undefined;
}

export type PlaytestIpcMessage =
  | { channel: "ohmygame:playtest-request"; id: string; request: PlaytestRequest }
  | { channel: "ohmygame:playtest-cancel"; id: string }
  | { channel: "ohmygame:playtest-response"; id: string; result?: PlaytestResult; error?: string; actionFailure?: PlaytestActionFailure; openFailure?: PlaytestOpenFailure };
