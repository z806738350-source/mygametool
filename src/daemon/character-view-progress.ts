import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CHARACTER_VIEW_DIRECTIONS, type CharacterViewDirection, type CharacterViewRuntimeManifest } from "../shared/character-views.js";

// Reconcile only host receipts from this user request. A normally stopped partial response
// can then get one more decision per reached direction, without reopening a finished turn.
export function characterViewProgressReminder(messages: readonly AgentMessage[]) {
  const start = messages.findLastIndex(message => message.role === "user");
  if (start < 0) return;
  let setId: string | undefined, authoringPath: string | undefined;
  let needsPlaytest = false, released = false;
  const plannedNodes = new Map<string, CharacterViewDirection>();
  const candidates = new Set<CharacterViewDirection>();
  const playInputs = new Set<string>();
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (released && message.role === "assistant") {
      for (const call of message.content) {
        if (call.type !== "toolCall" || call.name !== "game_use") continue;
        const { operation, actions } = call.arguments;
        if ((operation === "open" || operation === "act") && Array.isArray(actions) &&
            actions.some(action => ["press", "click", "touch", "type"].includes(action?.type))) playInputs.add(call.id);
      }
    }
    if (message.role !== "toolResult") continue;
    // A question, refused operation or unresolved job can legitimately end a turn.
    if (message.toolName === "questionnaire" || (message.isError && i === messages.length - 2)) return;
    if (message.isError) continue;
    if (message.toolName === "prepare_character_views") {
      const receipt = (message.details as { characterViews?: { state: string; result?: {
        delivery?: string; setId?: string; authoringPath?: string; manifest?: CharacterViewRuntimeManifest;
        markerCurrent?: boolean | string; views?: Partial<Record<CharacterViewDirection, { nodeId?: string; accepted?: unknown }>>;
      } } } | undefined)?.characterViews;
      const result = receipt?.result;
      if (!result || receipt?.state !== "committed") continue;
      if (result.delivery && result.setId && result.authoringPath) {
        if (setId && setId !== result.setId) return;
        setId = result.setId;
        authoringPath = result.authoringPath;
        needsPlaytest = result.delivery === "complete-set-and-playtest";
      }
      if (!setId) continue;
      if (result.manifest?.setId === setId && result.manifest.complete &&
          (result.markerCurrent === undefined || result.markerCurrent === true)) released = true;
      if (result.authoringPath === authoringPath && result.views) {
        for (const direction of CHARACTER_VIEW_DIRECTIONS) {
          const view = result.views[direction];
          if (view?.nodeId) plannedNodes.set(view.nodeId, direction);
          if (view?.accepted) candidates.add(direction);
        }
      }
    } else if (message.toolName === "generate_canvas_media" || message.toolName === "recover_canvas_media") {
      const view = (message.details as { characterView?: { nodeId: string } } | undefined)?.characterView;
      const direction = view && plannedNodes.get(view.nodeId);
      if (direction) candidates.add(direction);
    } else if (message.toolName === "game_use" && playInputs.has(message.toolCallId)) {
      const receipt = message.details as { playtest?: unknown; playtestReplay?: unknown } | undefined;
      if (receipt?.playtest && !receipt.playtestReplay) return;
    }
  }
  if (!setId || (released && !needsPlaytest)) return;
  const missing = CHARACTER_VIEW_DIRECTIONS.filter(direction => !candidates.has(direction));
  const stage = released ? "The complete manifest is published. Exercise the requested controls in the playable preview and inspect the resulting movement and facing."
    : `The active task has no complete published manifest. Directions without a saved candidate: ${missing.join(", ") || "none; review alignment and publish the selected set"}.`;
  return { user: messages[start], setId, progress: candidates.size + Number(released),
    text: `Character set ${setId}: ${stage} Check the original user's request. Use the available tools now for the next authorized step. Respect requested checkpoints, spending limits and recovery restrictions. If the task is blocked or needs a user's decision, report the specific blocker and finish.` };
}
