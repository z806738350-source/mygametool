// Offline only. Test whether keeping previously shown pixels at their original
// tool result avoids breaking a whole-request cache hit during active visual work.
import assert from "node:assert/strict";
import { MODEL_REQUEST_HIGH_BYTES, wireImages } from "../src/daemon/session-images.ts";

export function createBoundedVisualHistory() {
  const limits = new Map([["keepPriorInSourceUnder4MiB", 4 * 1024 ** 2], ["keepPriorInSourceUnder8MiB", 8 * 1024 ** 2]]);
  const previous = new Map(), steps = Object.fromEntries([...limits.keys()].map(name => [name, []]));
  let previousUser, previousRelease;
  return {
    project(payload, { step, isInspection }) {
      const user = payload.input.findLastIndex(item => item.role === "user");
      const release = payload.input.findLast(item => item.type === "function_call" &&
        ["write", "edit", "recall_image"].includes(item.name) && JSON.parse(item.arguments).releaseReviewedImages === true)?.call_id;
      // Within this linear replay, adding a real user message changes its item index.
      const original = wireImages(payload);
      if (previousUser !== user || previousRelease !== release || !original.length || isInspection) previous.clear();
      previousUser = user;
      previousRelease = release;
      const scenarios = {};
      for (const [name, limit] of limits) {
        const oldItems = previous.get(name) ?? new Map();
        const input = payload.input.map(item => {
          if (item.type !== "function_call_output" || !oldItems.has(item.call_id)) return item;
          const old = oldItems.get(item.call_id);
          if (!old.ids.every(id => typeof item.output === "string" ? item.output.includes(id)
            : item.output.some(block => block.type === "input_text" && block.text.includes(id)))) return item;
          const currentIds = wireImages([item]).map(image => image.id);
          if (currentIds.length >= old.ids.length || currentIds.some(id => !old.ids.includes(id))) return item;
          // Restore only image blocks and their marker in the same tool result; never replace a
          // changed report or role. Substituting the omitted blocks back must reconstruct the original.
          const omitted = new Set(old.ids.filter(id => !currentIds.includes(id)));
          // The Responses adapter merges all tool text before its ordered images.
          const [label, ...blocks] = old.item.output;
          if (label?.type !== "input_text" || blocks.length !== old.ids.length) return item;
          const stripped = label.text.split("\n").map(line => {
            const match = /^Session image: ([\w-]+:\d+)\./.exec(line);
            return match && omitted.has(match[1]) ? `[Image omitted from model context. ${line}]` : line;
          }).join("\n");
          const remaining = blocks.filter((_, i) => !omitted.has(old.ids[i]));
          const equal = remaining.length === 0 ? stripped === item.output
            : JSON.stringify([{ ...label, text: stripped }, ...remaining]) === JSON.stringify(item.output);
          return equal ? old.item : item;
        });
        let projected = { ...payload, input };
        let images = wireImages(projected);
        if (images.length > original.length && (images.length > 32 ||
            images.reduce((n, image) => n + image.data.length, 0) > limit ||
            Buffer.byteLength(JSON.stringify(projected)) > MODEL_REQUEST_HIGH_BYTES)) {
          projected = payload; images = original;
        }
        const expectedIds = new Set(original.map(image => image.id));
        const kept = images.filter(image => expectedIds.has(image.id));
        assert.deepEqual(kept.map(v => v.id), original.map(v => v.id));
        assert(kept.every((image, i) => image.mime === original[i].mime && image.data === original[i].data));
        if (isInspection || !original.length) assert.equal(images.length, original.length);
        previous.set(name, new Map(projected.input.flatMap(item => {
          if (item.type !== "function_call_output" || !Array.isArray(item.output)) return [];
          const ids = wireImages([item]).map(image => image.id);
          return ids.length ? [[item.call_id, { item, ids }]] : [];
        })));
        if (images.length > original.length) steps[name].push({ step, addedPriorPictures: images.length - original.length });
        scenarios[name] = projected;
      }
      return scenarios;
    },
    report: () => ({ retainedAtOriginalToolResults: steps }),
  };
}
