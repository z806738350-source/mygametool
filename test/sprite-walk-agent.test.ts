import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CHARACTER_VIEW_DIRECTIONS } from "../src/shared/character-views.js";
import { createSpriteWalkRepairTool, createSpriteWalkFinishReview, createSpriteWalkTool, spriteWalkBoundary } from "../src/daemon/sprite-walk-agent.js";
import { createSpriteActionRepairTool, createSpriteActionReviewTool } from "../src/daemon/sprite-action-agent.js";
import type { inspectPublishedSpriteAction, SpriteActionRepairInput } from "../src/daemon/sprite-action-package.js";
import { projectPiToolNames } from "../src/daemon/agent-tools.js";
import { CHECKPOINT_ENTRY } from "../src/daemon/checkpoint-extension.js";

const project = { workspacePath: "/test/project", startupDirectory: "web" };
const setId = "robot", revision = "1".repeat(64), candidateDigest = "2".repeat(64);
const identity = { image: "clips/legs.png", directions: [...CHARACTER_VIEW_DIRECTIONS], biped: true, revision };
const result = { ...identity, standingReference: { file: "images/E-idle.png", width: 144, height: 160 }, status: "inconclusive" as const, direction: "E" as const, seams: [], topology: [], gait: { reasons: ["Supply a hand and boot."], status: "inconclusive" as const, contacts: [0, 3] as const, sides: {} } };
const pkg = "web/public/characters/robot/";
function history(text: string) {
  const log = SessionManager.inMemory(project.workspacePath);
  log.appendCustomEntry(CHECKPOINT_ENTRY, { version: 1, commit: "a".repeat(40) });
  log.appendMessage({ role: "user", content: text, timestamp: 1 });
  const tool = (name: string, details: object = {}, args?: object) => {
    if (args) log.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: name, name, arguments: args }], timestamp: 2 } as never);
    log.appendMessage({ role: "toolResult", toolCallId: name, toolName: name, isError: false, content: [{ type: "text", text: "receipt" }], details: JSON.parse(JSON.stringify(details)), timestamp: 3 });
  };
  return { log, tool };
}
it("requires actual saved atlas revisions, covers the whole requested set and permits an explicitly limited pilot", async () => {
  const deps = { identity: vi.fn(async () => identity), inspect: vi.fn(async () => result) };
  const { log, tool } = history("Repair this biped's walk. Deliver all eight playable directions.");
  tool("edit", {}, { path: "/test/project/" + pkg + "clips/legs.png" });
  tool("review_sprite_walk", { spriteWalkReview: { setId, revision: "old", direction: "S", status: "pass" } });
  tool("review_sprite_walk", { spriteWalkReview: { setId, revision, direction: "S", status: "fail" } });
  const boundary = () => spriteWalkBoundary(project, log.getBranch(), undefined, deps);
  const finish = createSpriteWalkFinishReview(boundary);
  expect(await finish()).toContain("S (fail)");
  await expect(finish()).rejects.toThrow("still unverified");
  tool("repair_sprite_walk", { spriteWalkRepair: { setId, revision, changed: [pkg+"clips/legs.png"],
    reviews: CHARACTER_VIEW_DIRECTIONS.map(direction => ({ direction, status: "pass" })) } });
  expect(await finish()).toContain("fresh game_use");
  tool("game_use", { playtest: {}, playtestReplay: {}, spriteWalkPlay: { setId, revision } });
  expect((await boundary())?.text).toContain("fresh game_use");
  tool("game_use", { playtest: {}, spriteWalkPlay: { setId, revision } });
  expect(await finish()).toBeUndefined();

  const pilot = history("只修 E/W 走路样片");
  pilot.tool("read_project_file", {}, { path: pkg+"walk.json" });
  for (const direction of ["E","W"]) pilot.tool("review_sprite_walk", { spriteWalkReview: { setId, revision, direction, status: "pass" } });
  expect(await spriteWalkBoundary(project, pilot.log.getBranch(), undefined, deps)).toBeUndefined();
});
it("activates an existing broken walk for repair, skips static changes, quadrupeds and read-only enquiries", async () => {
  const deps = { identity: vi.fn(async () => identity), inspect: vi.fn(async () => result) };
  for (const [prompt, name, details, args, active] of [
    ["请修好八向行走，不要改已通过的八张站姿。", "read", {}, { path: pkg+"walk.json" }, true],
    ["Fix the biped walk; do not change the approved idle frames.", "read_project_file", {}, { path: pkg+"walk.json" }, true],
    ["How can we fix the walk? Do not change any files.", "read_project_file", {}, { path: pkg+"walk.json" }, false],
    ["修复八向走路。", "read", {}, { path: pkg+"walk.json" }, true],
    ["修复步态。", "repair_sprite_walk", { spriteWalkAttempt: { setId } }, undefined, true],
    ["只检查双足角色是否需要修复，不要改。", "review_sprite_walk", { spriteWalkReview: { setId, revision, direction: "N", status:"fail" } }, undefined, false],
    ["Fix a biped idle.", "edit", {}, { path: pkg+"images/N-idle.png" }, false],
    ["Fix this biped.", "write", {}, { path: "/other/project/" + pkg+"walk.json" }, false],
  ] as const) {
    const {log, tool} = history(prompt);
    tool(name,details,args);
    expect(!!await spriteWalkBoundary(project, log.getBranch(), undefined, deps)).toBe(active);
  }
  const {log, tool} = history("Generate a playable walk for the four-legged dog.");
  tool("bash");
  const diff = vi.fn(async () => [{ path: pkg+"walk.json" }]);
  expect(await spriteWalkBoundary(project, log.getBranch(), undefined, { ...deps, identity: async () => ({ ...identity, biped:false }) }, diff)).toBeUndefined();
  expect(diff).toHaveBeenCalledWith("a".repeat(40));
});
it("prompts for the first walk only after a requested biped walk reads the standing manifest", async () => {
  const deps = { identity: vi.fn(async () => { throw new Error("walk.json does not exist"); }), inspect: vi.fn(async () => result) };
  for (const [prompt, active] of [
    ["为双足角色制作八向行走，不要改已通过的八张站姿。", true],
    ["Repair the humanoid walk. Do not change idle.", true],
    ["为双足角色制作八向站姿。", false],
    ["请制作双足角色站姿，不要做行走。", false],
    ["给四足动物制作八向行走。", false],
    ["只读：检查双足角色是否需要制作行走，不要修改。", false],
  ] as const) {
    const {log, tool} = history(prompt);
    tool("read_project_file", {}, {path: pkg+"manifest.json"});
    const notice = await spriteWalkBoundary(project, log.getBranch(), undefined, deps);
    if (active) expect(notice?.text).toContain("public/characters/robot/walk.json");
    else expect(notice).toBeUndefined();
  }
  expect(deps.identity).toHaveBeenCalledTimes(2);
});
it("keeps review read-only, sends pixels only to a visual connection, and requires an actual current-task repair preview", async () => {
  const names = ["review_sprite_walk","repair_sprite_walk"];
  expect(projectPiToolNames("planning",[],names)).toContain(names[0]);
  expect(projectPiToolNames("planning",[],names)).not.toContain(names[1]);
  expect(projectPiToolNames("normal",[],names)).toEqual(expect.arrayContaining(names));
  const data = Buffer.from("preview");
  const inspect = vi.fn(async () => ({ ...result, status: "pass" as const, preview:data }));
  for (const visual of [true,false]) {
    const result = await createSpriteWalkTool(project,visual,()=>{}, { identity: async () => identity, inspect }).execute("review", { setId, direction:"E" }, undefined, undefined, {} as never);
    expect(result.content.some(b => b.type === "image")).toBe(visual);
    expect(result.details.spriteWalkReview.status).toBe(visual ? "pass" : "inconclusive");
  }
  const {log,tool} = history("Repair E and W");
  const run = vi.fn(async () => ({ ...identity, reviews: [], previews: [{ direction:"E" as const, data }], status:"pass" as const, changed: [] as string[], candidateDigest }));
  const repair = createSpriteWalkRepairTool(true, () => log.getBranch(), run);
  const rect = { x:2, y:5, width:7, height:7 }, limb = { hand:rect, foot:rect };
  const args = { setId, expectedRevision:revision, directions:[{ direction:"E" as const, landmarks:{ left:limb,right:limb } }] };
  const apply = () => repair.execute("commit", { ...args, candidateDigest }, undefined, undefined, {} as never);
  await expect(apply()).rejects.toThrow("Preview this exact candidate");
  const preview = await repair.execute("prep",args,undefined,undefined,{} as never);
  expect(preview.content.filter(b=>b.type==="image")).toHaveLength(1);
  expect(JSON.stringify(preview.details)).not.toContain("Buffer");
  tool("repair_sprite_walk",preview.details);
  await apply();
  log.appendMessage({ role:"user", content:"New repair task", timestamp:4 });
  await expect(apply()).rejects.toThrow("current task");
  expect(run).toHaveBeenCalledTimes(2);
});

it("accepts generic visual evidence only for phases actually presented on this action revision and keeps measured failures", async () => {
  const input = { setId, actionId: "flap", direction: "E" as const };
  const { log, tool } = history("Animate the bird flapping");
  const sample: Awaited<ReturnType<typeof inspectPublishedSpriteAction>> = {
    revision, direction: "E", directions: ["E"], image: "wings.png", status: "inconclusive", damage: [], parts:[], markedParts:[],
    bodyPlan: "bird", motionName: "flap", hasVisibleMotion:true, frameCount: 4, previewFrames: [0, 3], preview: Buffer.from("actual preview"),
    motion: { status: "inconclusive", keyframes: [{phase:"upstroke", frame:0},{phase:"downstroke", frame:3}], checks: [], landmarks: {} },
  };
  const inspect = vi.fn(async () => sample);
  const review = createSpriteActionReviewTool(project, true, () => {}, () => log.getBranch(), inspect);
  const observations = [{part:"wingtip",phase:"upstroke",frame:0,observation:"Tips above the head."},
    {part:"wing",phase:"downstroke",frame:3,observation:"Visible wing is extended below the body."}];
  const call = (status: "pass" | "fail") => review.execute("annotate", { ...input, visualReview:{status,observations} }, undefined, undefined, {} as never);
  await expect(call("pass")).rejects.toThrow("Inspect these exact frames");
  const shown = await review.execute("show", input, undefined, undefined, {} as never);
  tool("review_sprite_action", shown.details);
  sample.hasVisibleMotion = false;
  await expect(call("pass")).rejects.toThrow("distinct visible poses");
  sample.hasVisibleMotion = true;
  const accepted = await call("pass");
  expect(accepted.details.spriteActionReview).toMatchObject({status:"pass",source:"visual",measuredStatus:"inconclusive"});
  const observedDefect = await call("fail");
  tool("review_sprite_action", observedDefect.details);
  expect((await review.execute("again", input, undefined, undefined, {} as never)).details.spriteActionReview.status).toBe("fail");
  sample.revision = "2".repeat(64);
  await expect(call("pass")).rejects.toThrow("Inspect these exact frames");
  sample.status = "fail";
  const broken = await review.execute("broken", input, undefined, undefined, {} as never);
  tool("review_sprite_action", broken.details);
  sample.status = "inconclusive";
  await expect(call("pass")).rejects.toThrow("measured defect");
  log.appendMessage({role:"user",content:"Review the same action again",timestamp:5});
  await expect(call("pass")).rejects.toThrow("Inspect these exact frames");
});
it("separates generic action previews and checks final-file review and playback for the correct action", async () => {
  const { log, tool } = history("修复并试玩狼的小跑动画");
  const target = {setId, actionId:"trot"};
  const input = {...target,expectedRevision:revision,directions:[{direction:"E" as const}]};
  const run = vi.fn(async () => ({revision, directions:["E" as const], image:"legs.png", changed:[] as string[], candidateDigest,
    status:"inconclusive" as const, reviews:[], previews:[{direction:"E" as const, data:Buffer.from("candidate")}] }));
  const repair = createSpriteActionRepairTool(true, () => log.getBranch(), run);
  const preview = await repair.execute("candidate",input,undefined,undefined,{} as never);
  tool("repair_sprite_action",preview.details);
  await expect(repair.execute("mismatched",{...input,actionId:"jump",candidateDigest},undefined,undefined,{} as never)).rejects.toThrow("exact candidate");
  await repair.execute("apply",{...input,candidateDigest},undefined,undefined,{} as never);
  const deps = {identity:async()=>identity,inspect:async()=>result};
  const boundary = () => spriteWalkBoundary(project,log.getBranch(),undefined,deps,undefined,
    async () => ({revision,directions:["E"],image:"legs.png"}));
  expect((await boundary())?.text).toContain("E (unchecked)");
  tool("review_sprite_action",{spriteActionReview:{...target,revision,direction:"E",status:"inconclusive"}});
  expect((await boundary())?.text).toContain("E (inconclusive)");
  tool("review_sprite_action",{spriteActionReview:{...target,revision,direction:"E",status:"pass"}});
  expect((await boundary())?.text).toContain("fresh game_use");
  tool("game_use",{playtest:{},spriteActionPlay:{...target,actionId:"leap",revision}});
  expect((await boundary())?.text).toContain("fresh game_use");
  tool("game_use",{playtest:{},spriteActionPlay:{...target,revision}});
  expect(await boundary()).toBeUndefined();
  const names = ["review_sprite_action","repair_sprite_action"];
  expect(projectPiToolNames("planning",[],names)).toContain(names[0]);
  expect(projectPiToolNames("planning",[],names)).not.toContain(names[1]);
  expect(projectPiToolNames("normal",[],names)).toEqual(expect.arrayContaining(names));
});

it("checks authored action manifests even without tool registration, keeps actions separate and leaves a read-only review alone", async () => {
  const deps = {identity:async()=>identity,inspect:async()=>result};
  const published = vi.fn(async (_p: {workspacePath:string}, _id: string, actionId: string) => ({
    revision, directions:["E" as const], image:actionId+".png", motionName:actionId === "leap" ? "jump" : actionId,
  }));
  const lookup = (h: ReturnType<typeof history>) => spriteWalkBoundary(project,h.log.getBranch(),undefined,deps,undefined,published);
  const readOnly = history("仅查看这只狼的小跑动画");
  readOnly.tool("read",{},{path:pkg+"trot.json"});
  readOnly.tool("review_sprite_action",{spriteActionReview:{setId,actionId:"trot",revision,direction:"E",status:"fail"}});
  expect(await lookup(readOnly)).toBeUndefined();
  const audit = history("请看看鸟扇翅的效果");
  audit.tool("review_sprite_action",{spriteActionReview:{setId,actionId:"flap",revision,direction:"E",status:"fail"}});
  expect(await lookup(audit)).toBeUndefined();
  for (const fileTool of ["read","write"]) {
    const h = history("制作狼的小跑和跳跃动作");
    h.tool("read",{},{path:pkg+"manifest.json"});
    h.tool(fileTool,{},{path:pkg+"leap.json"});
    h.tool(fileTool,{},{path:pkg+"trot.json"});
    expect((await lookup(h))?.text).toMatch(/robot\/(leap|trot)/);
    h.tool("review_sprite_action",{spriteActionReview:{setId,actionId:"trot",revision,direction:"E",status:"pass"}});
    expect((await lookup(h))?.text).toContain("robot/leap");
    h.tool("review_sprite_action",{spriteActionReview:{setId,actionId:"leap",revision:"old",direction:"E",status:"pass"}});
    expect((await lookup(h))?.text).toContain("robot/leap");
    h.tool("review_sprite_action",{spriteActionReview:{setId,actionId:"leap",revision,direction:"E",status:"pass"}});
    expect(await lookup(h)).toBeUndefined();
  }
});

it("reuses marked anatomy only on the actual atlas and verifies each region's keyframes using its picture number", async () => {
  const target = { setId, actionId: "flap", direction: "E" as const };
  const h = history("Animate the bird's wings and tail");
  const marks = [{ name:"wing tip", region:{x:6,y:2,width:4,height:4} },
    { name:"tail", region:{x:19,y:20,width:4,height:4}, anchor:{x:16,y:20,width:3,height:3} }];
  let active = revision;
  const inspect: typeof inspectPublishedSpriteAction = async (_project, input) => {
    const selected = !input.partsRevision || active === input.partsRevision ? input.parts ?? [] : [];
    const mapped = selected.map((p,i) => ({...p, status:"tracked" as const, reason:"tracked pixels",
      keyframes:[{phase:"extension",frame:i+1}]}));
    return {revision:active,directions:["E"],direction:"E",image:"wing.png",frameCount:4,hasVisibleMotion:true,
      status:"inconclusive",bodyPlan:"bird",motionName:"flap",parts:mapped,markedParts:mapped,damage:[],
      motion:{status:"inconclusive",keyframes:mapped.flatMap(p=>p.keyframes),checks:[],landmarks:{}},
      preview:Buffer.from("frame strip"),previewFrames:[...input.frames ?? [0,1,2,3]]};
  };
  const tool = createSpriteActionReviewTool(project,true,()=>{},()=>h.log.getBranch(),inspect);
  const call = (args: Parameters<typeof tool.execute>[1]) => tool.execute("review",args,undefined,undefined,{} as never);
  const show = await call({...target,parts:marks,frames:[0,1]});
  h.tool("review_sprite_action",show.details);
  const observations = [{part:"primary feathers",partIndex:1,phase:"opening",frame:1,observation:"Distal feathers swing upward."},
    {part:"rectrices",partIndex:2,phase:"extended",frame:2,observation:"Rectrices extend at the apex."}];
  const accept = () => call({...target,visualReview:{status:"pass",observations}});
  await expect(accept()).rejects.toThrow("Inspect these exact frames");
  const next = await call({...target,frames:[2]});
  expect(next.details.spriteActionReview.partSelection).toEqual(marks);
  h.tool("review_sprite_action",next.details);
  observations[1].partIndex = 1;
  await expect(accept()).rejects.toThrow("marked part 2");
  observations[1].partIndex = 2;
  expect((await accept()).details.spriteActionReview.status).toBe("pass");
  active = "9".repeat(64);
  expect((await call(target)).details.spriteActionReview.partSelection).toBeUndefined();
  await expect(accept()).rejects.toThrow("Inspect these exact frames");
});

it("passes the last marked anatomy for the exact source revision and facing into the repair preview and publication", async () => {
  const h = history("Repair the bird's flight");
  const target = {setId,actionId:"flap"}, E = {direction:"E" as const}, W = {direction:"W" as const}, S = {direction:"S" as const};
  const wing = [{name:"wingtip",region:{x:6,y:2,width:4,height:4},anchor:{x:10,y:8,width:3,height:3}}];
  const tail = [{name:"tail",region:{x:20,y:8,width:3,height:4}}];
  const mark = (direction:string, actionId:string, source:string, partSelection:typeof tail) => h.tool("review_sprite_action",{
    spriteActionReview:{setId,actionId,direction,revision:source,partSelection,previewFrames:[0,1]},
  });
  mark("E","flap",revision,tail); mark("E","flap",revision,wing); mark("W","flap","old",wing);
  mark("S","turn",revision,wing); mark("E","flap","other",tail);
  const run = vi.fn(async (_: SpriteActionRepairInput) =>
    ({revision,directions:["E" as const],image:"flight.png",changed:[] as string[],candidateDigest,status:"inconclusive" as const,reviews:[],previews:[{direction:"E" as const,data:Buffer.from("candidate")}] }));
  const repair = createSpriteActionRepairTool(true,()=>h.log.getBranch(),run);
  const call = (args:Parameters<typeof repair.execute>[1])=>repair.execute("repair",args,undefined,undefined,{} as never);
  const input = {...target,expectedRevision:revision,directions:[E,W,S]};
  const preview = await call(input);
  const expected = [{...E,parts:wing},W,S];
  expect(run.mock.calls.at(-1)?.[0].directions).toEqual(expected);
  h.tool("repair_sprite_action",preview.details);
  await call({...input,candidateDigest});
  expect(run.mock.calls.at(-1)?.[0].directions).toEqual(expected);
  await call({...input,directions:[{...E,parts:tail}]});
  expect(run.mock.calls.at(-1)?.[0].directions).toEqual([{...E,parts:tail}]);
  h.log.appendMessage({role:"user",content:"Repair the bird again",timestamp:5});
  await call(input);
  expect(run.mock.calls.at(-1)?.[0].directions).toEqual([E,W,S]);
});
