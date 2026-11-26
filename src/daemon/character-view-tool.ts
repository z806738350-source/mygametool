import { defineTool } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import { characterViewToolParameters } from "../shared/character-views.js";
import type { ProjectState } from "../shared/contracts.js";
import type { AuthorizeAgentAttachment } from "./agent-attachments.js";
import type { RecoverableTool } from "./agent-auto-continue.js";
import { confirmCharacterViewFailure, toolPreflightError } from "./agent-tool-errors.js";
import type { CanvasStore } from "./canvas-workspace.js";
import { checkCharacterViewAuthoring, planCharacterViews } from "./character-view-plan.js";
import { describeCharacterViewPublishReceipt, publishCharacterViewSet } from "./character-view-publish.js";
import type { CharacterViewOperationIdentity, CharacterViewPublicationJournal, CharacterViewPublicationReceipt } from "./character-view-publication.js";
import { readCharacterViewSource } from "./character-views.js";
import type { ProjectSourceProfile } from "./isolated-project-files.js";
import type { ProjectManager } from "./projects.js";
import type { ToolRunner } from "./tools.js";

interface CharacterViewToolOptions {
  project: ProjectState;
  conversationId: string;
  projects: ProjectManager;
  canvas: CanvasStore;
  tools: ToolRunner;
  authorizeAttachment: AuthorizeAgentAttachment;
  gate: () => void;
  journal: () => Promise<CharacterViewPublicationJournal>;
  sourceProfile: () => Promise<ProjectSourceProfile | undefined>;
  mutateWorkspace: <T>(operation: () => Promise<T>) => Promise<T>;
}

const toolName = "prepare_character_views";

function identity(conversationId: string, callId: string, input: unknown): CharacterViewOperationIdentity {
  if (!Check(characterViewToolParameters, input) || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(input.setId) ||
      (input.action === "plan" ? !input.plan || !!input.publish : !input.publish || !!input.plan)) {
    throw toolPreflightError("Choose a lower-case setId and supply exactly the settings for the selected action.", "invalid_character_view_input");
  }
  const canonical = JSON.stringify(input, (key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return {
    operationId: JSON.stringify([conversationId, toolName, callId]),
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
    action: input.action,
    purpose: input.publish?.purpose ?? "prepare",
  };
}

function result(receipt: CharacterViewPublicationReceipt, original: CharacterViewOperationIdentity) {
  if (receipt.state === "unknown") throw new Error(receipt.reason);
  const response = { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: { characterViews: receipt } };
  return receipt.state === "failed"
    ? confirmCharacterViewFailure({ ...response, isError: true }, createHash("sha256").update(original.operationId).digest("hex"))
    : response;
}

export function createCharacterViewTool(options: CharacterViewToolOptions) {
  const describeRetained = (receipt: CharacterViewPublicationReceipt, action: "plan" | "publish", setId: string) =>
    action === "publish" ? describeCharacterViewPublishReceipt(receipt, { project: options.project, setId }) : receipt;
  const tool = defineTool({
    name: toolName,
    label: "Prepare character views",
    description: "Plan eight-direction character views or publish reviewed, aligned transparent PNGs. Use the authoring digest from the latest plan. Append views under the same designRevision, or promote a reviewed front under a new designRevision by passing its source as both baseline and the S view. Read the eight-direction-character guide for measurements and publication. Generate each approved missing direction separately with generate_canvas_media.",
    parameters: characterViewToolParameters,
    executionMode: "sequential",
    execute: async (callId, input, signal) => {
      signal?.throwIfAborted();
      const original = identity(options.conversationId, callId, input);
      const journal = await options.journal();
      const retained = await journal.recover(original);
      if (retained.state !== "missing") return result(await describeRetained(retained, input.action, input.setId), original);
      options.gate();
      const common = { project: options.project, setId: input.setId, identity: original, journal,
        sourceProfile: options.sourceProfile, mutateWorkspace: options.mutateWorkspace, signal };
      if (input.action === "plan") {
        return result(await planCharacterViews({ ...common, input: input.plan!, expectedAuthoringSha256: input.expectedAuthoringSha256,
          projects: options.projects, canvas: options.canvas, tools: options.tools, authorizeAttachment: options.authorizeAttachment }), original);
      }
      if (input.expectedAuthoringSha256 === null) {
        throw toolPreflightError("Prepare the character plan and use its returned authoring digest before publishing.", "invalid_character_view_input");
      }
      return result(await publishCharacterViewSet({ ...common, input: input.publish!, expectedAuthoringSha256: input.expectedAuthoringSha256,
        checkAuthoring: (bytes, request) => checkCharacterViewAuthoring(bytes, input.setId, request, options.project.id, options.canvas),
        readCandidate: async source => (await readCharacterViewSource(options.project.workspacePath, source, undefined, signal)).bytes }), original);
    },
  });
  return Object.assign(tool, {
    // A new call must reach the host and evaluate its own current CAS and permission checks.
    canReuseResult: () => false,
    recoverAfterHttp500: async (...[callId, input, signal]: Parameters<RecoverableTool["execute"]>) => {
      signal?.throwIfAborted();
      if (!Check(characterViewToolParameters, input)) throw new Error("The saved character tool input is invalid.");
      const original = identity(options.conversationId, callId, input);
      const receipt = await (await options.journal()).recover(original);
      if (receipt.state === "missing") throw new Error("The original local operation was not found. Recovery did not start another operation.");
      return result(await describeRetained(receipt, input.action, input.setId), original);
    },
  } satisfies Pick<RecoverableTool, "canReuseResult" | "recoverAfterHttp500">);
}
