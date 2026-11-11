import type { CustomModel3DSettings, Model3DOperation, Model3DOptions } from "./contracts.js";

export function requiresModelTurnaround(options: Model3DOptions | undefined, protocol: string | undefined, operation: Model3DOperation): boolean {
  return operation === "image" && (options?.referenceMode === "turnaround" || protocol === "tripo" && (options?.pose === "t-pose" || options?.pose === "a-pose"));
}

export const MODEL3D_OPERATIONS: readonly Model3DOperation[] = ["image", "text", "retexture", "remesh", "animate"];
/** Shared by capability discovery and option admission; local image guidance is never sent upstream. */
export function model3DOptionFields(protocol: string | undefined, operation: string, includeLocalImageGuidance = false): readonly string[] {
  const allowed = operation === "animate" && protocol === "tripo" ? ["rigModel", "rigType", "animateInPlace"]
    : operation === "retexture" && protocol === "tripo" ? ["textureModel", "textureQuality"]
    : operation === "retexture" && protocol === "meshy" ? ["textureModel"]
    : operation === "remesh" && protocol === "tripo" ? ["quad", "smartUv"]
    : (operation === "image" || operation === "text") && protocol === "tripo" ? ["quad", "geometryQuality", "textureModel", "textureQuality"]
    : (operation === "image" || operation === "text") && (protocol === "meshy" || protocol === "hyper3d") ? ["pose"] : [];
  return includeLocalImageGuidance && operation === "image"
    ? ["referenceMode", ...(protocol === "tripo" ? ["pose"] : []), ...allowed] : allowed;
}
export function protocolOperations(protocol: CustomModel3DSettings["protocol"]): Model3DOperation[] {
  return protocol === "hyper3d" ? ["image", "text", "retexture"] : [...MODEL3D_OPERATIONS];
}
export const MODEL3D_CONNECTION_ID = "connection";
/** Processing uses its own API limits, independently of the selected geometry version. */
export function remeshPolycount(protocol?: CustomModel3DSettings["protocol"]): CustomModel3DSettings["polycount"] {
  if (protocol === "tripo") return { min: 500, max: 20_000, default: 4_000, presets: [1_000, 4_000, 10_000, 20_000] };
  return { min: 100, max: protocol === "meshy" ? 300_000 : 1_500_000, default: 30_000, presets: [1_000, 4_000, 10_000, 30_000, 100_000, 300_000] };
}
/** Tripo has no animation-library endpoint; keep identifiers scoped to the rig version. */
export const TRIPO_ANIMATIONS_V1 = ["afraid", "agree", "angry_01", "angry_02", "angry_03", "basketball_shot", "bow", "box_01", "box_02", "box_03", "cast_a_spell", "cheer", "chop", "clap", "climb", "complain_01", "complain_02", "cross_body_crunch", "crossover_dribble", "cry", "dance_01", "dance_02", "dance_03", "dance_04", "dance_05", "dance_06", "defeat_02", "defeat_03", "depressed", "dig", "dive", "dribble", "fall", "fire", "flee_01", "flee_02", "flip", "fold_arms", "football_catch", "football_save", "football_pass", "freaky", "frightened", "front_kick_01", "front_kick_02", "frustrated_01", "frustrated_02", "golf", "greet_01", "greet_02", "greet_03", "greet_04", "heart_pose", "hit_to_body_01", "hit_to_body_02", "hit_to_head", "hit_to_side", "hit_to_stomach", "hug", "hurt", "idle", "jump_down", "jump", "jump_rope_01", "jump_rope_02", "laugh_01", "laugh_02", "lift_heavy", "look_around", "make_a_call_01", "make_a_call_02", "pitch_baseball", "play_mobile_game", "play_video_game", "press-up", "run_upstairs", "run", "scared_01", "scared_02", "scratch", "shoot", "shovel", "sing_01", "sing_02", "sing_03", "sing_04", "sit", "slash", "sob", "standing_relax", "surf", "swagger", "swim", "turn", "victory_celebration", "volleyball", "wait", "walk", "warm_up", "wave_goodbye_01", "wave_goodbye_02"] as const;
export function tripoActions(version = "v3.0-20260909", rigType = "biped") {
  // These rig types have no documented preset IDs in this integration; do not invent billable actions.
  if (rigType === "others" || rigType === "avian") return [];
  const names: readonly string[] = version === "v1.0-20240301" ? TRIPO_ANIMATIONS_V1
    : rigType === "biped" ? ["idle", "walk", "run", "dive", "climb", "jump", "slash", "shoot", "hurt", "fall", "turn"]
    : [rigType === "serpentine" || rigType === "aquatic" ? "march" : "walk"];
  const prefix = version === "v1.0-20240301" ? "biped:" : rigType === "biped" ? "" : `${rigType}:`;
  return names.map((name) => ({ id: `preset:${prefix}${name}`, name: name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), category: rigType, subCategory: version }));
}
