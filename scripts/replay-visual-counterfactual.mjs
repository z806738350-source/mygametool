// Offline layout experiments for recorded Responses requests. No model or project tools are invoked.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INLINE_IMAGE_HIGH_BYTES, INLINE_IMAGE_HIGH_COUNT, MODEL_REQUEST_HIGH_BYTES, wireImages } from "../src/daemon/session-images.ts";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inline = item => item.type === "input_image";
const text = value => ({ type: "input_text", text: value });
const plainText = output => typeof output === "string" ? output : output.filter(block => !inline(block)).map(block => {
  assert.equal(block.type, "input_text");
  return block.text;
}).join("\n");
const marker = id => `Session image: ${id}. Use recall_image with this imageId to inspect the original again.`;
const HEADER = "Retained visual evidence from earlier or sibling tool results, labeled by original call. These attachments belong to those results.";
const models = ["original", "keepFreshInSourceTool", "appendNewPicturesInPlace", "allPixelsInLabelledToolAttachment", "retainReviewedUntilTurnEnds"];

function samePictures(left, right) {
  assert.equal(left.length, right.length);
  left.forEach((image, i) => {
    assert.equal(image.id, right[i].id);
    assert.equal(image.mime, right[i].mime);
    assert(image.data === right[i].data, "Model-facing image bytes changed");
  });
}

function canonicalText(raw, id) {
  const label = marker(id);
  return raw.replaceAll(`[Image omitted from model context. ${label}]`,label)
    .replace(new RegExp(`(Session image: ${id}\\. Use recall_image with this imageId to inspect the original again\\.) Identical pixels are included under session image [a-zA-Z0-9_-]+:\\d+ in this request\\.`,"g"),"$1")
    .replaceAll(label + "\n" + label, label);
}

export function createVisualCounterfactual() {
  const origins = new Map(), oldSequences = new Map(), exactSteps = Object.fromEntries(models.map(k => [k, []]));
  const tails = [], inspections = [], freshSteps = [];
  let group = "", anchor, freshAnchor, native, previousUser, lastImages;
  let previousIds = [], placement = new Map();
  let count = 0, occurrences = 0, addedTailImages = 0, firstOccurrences = 0;
  function observePrefix(name, payload, step) {
    const items = [digest(payload.tools), ...payload.input.map(digest)], prev = oldSequences.get(name);
    if (prev && prev.length <= items.length && prev.every((v, i) => items[i] === v)) exactSteps[name].push(step);
    oldSequences.set(name, items);
  }
  return {
    project(payload, {step, freshIds, isInspection}) {
      count++; occurrences += wireImages(payload).length; firstOccurrences += freshIds.length;
      const originals = wireImages(payload);
      const actualUser = payload.input.findLastIndex(item => item.role === "user");
      const calls = new Map(payload.input.filter(item => item.type === "function_call").map(call => [call.call_id, call]));
      const resultIndex = new Map(), images = [];
      payload.input.forEach((item, position) => {
        if (item.type !== "function_call_output") return;
        resultIndex.set(item.call_id, position);
        const blocks = Array.isArray(item.output) ? item.output.filter(inline) : [];
        const snapshots = wireImages([item]); assert.equal(blocks.length, snapshots.length);
        snapshots.forEach((photo, i) => {
          const call = calls.get(item.call_id); assert(call && photo.id);
          const source = { callId: item.call_id, name: call.name };
          assert(!origins.has(photo.id) || origins.get(photo.id).callId === source.callId);
          origins.set(photo.id, source); images.push({ ...photo, block: blocks[i], ...source });
        });
      });
      // Do not relocate user pictures or images from unknown/unassociated tools in this experiment.
      samePictures(originals, images);
      const ids = images.map(x => x.id), key = JSON.stringify(ids), fresh = new Set(freshIds);
      assert(freshIds.every(id => ids.includes(id)));
      if (freshIds.length) freshSteps.push(step);
      if (isInspection) inspections.push({step,pictures:ids.length});
      if (key !== group) {
        group = key;
        const last = payload.input.findLastIndex(item => item.type === "function_call_output");
        if (ids.length) assert(last > actualUser, "No existing tool result after user input");
        anchor = payload.input[last]?.call_id;
        native = fresh;
        freshAnchor = images.find(x => native.has(x.id))?.callId ?? anchor;
        if (!previousIds.every((id,i) => id === ids[i])) placement = new Map();
        for (const photo of images) if (!placement.has(photo.id))
          placement.set(photo.id, fresh.has(photo.id) ? photo.callId : freshAnchor);
        previousIds = ids;
      }
      function layout(keepFresh, incremental = false) {
        const dest = keepFresh ? freshAnchor : anchor;
        const retained = keepFresh ? images.filter(pic => !native.has(pic.id)) : images;
        const input = payload.input.map(item => {
          if (item.type !== "function_call_output") return item;
          const known = [...origins].filter(([,source]) => source.callId === item.call_id).map(([id]) => id);
          // A newly read image stays in its actual tool result in the first scenario.
          const keepHere = keepFresh && images.some(pic => pic.callId === item.call_id &&
            (incremental ? placement.get(pic.id) === item.call_id : native.has(pic.id)));
          let output = item.output;
          if (known.length && !keepHere) {
            let str = plainText(output);
            for (const id of known) str = canonicalText(str, id);
            output = str;
          }
          const attach = incremental ? images.filter(pic => placement.get(pic.id) === item.call_id && pic.callId !== item.call_id) : item.call_id === dest ? retained : [];
          if (attach.length) {
            const gallery = [text(HEADER)];
            for (const pic of attach) gallery.push(text(`Source tool ${pic.name}, call ${pic.callId}.\n${marker(pic.id)}`), pic.block);
            const actual = typeof output === "string" ? [text(output)] : output;
            // Earlier pictures precede new ones. Their original source marker stays beside the original result.
            output = [...gallery, text("End of retained attachments; this tool result follows."), ...actual];
          }
          return output === item.output ? item : { ...item, output };
        });
        const result = { ...payload, input };
        samePictures(originals, wireImages(result));
        assert.deepEqual(input.map(item => [item.type,item.role,item.call_id]), payload.input.map(item => [item.type,item.role,item.call_id]));
        for (const item of input) if (item.type === "function_call_output") {
          if (keepFresh) for (const pic of images.filter(p => fresh.has(p.id) && p.callId === item.call_id))
            assert(wireImages([item]).some(p => p.id === pic.id && p.data === pic.data), "New evidence moved to a different tool");
        }
        return result;
      }
      const first = layout(true), incremental = layout(true,true), second = layout(false);
      let deferred = payload;
      const user = actualUser < 0 ? undefined : digest(payload.input[actualUser]);
      if (user !== previousUser) lastImages = undefined;
      if (images.length) lastImages = {
        pictures: images,
        outputs: new Map([...new Set(images.map(p => p.callId))].map(id => [id, payload.input[resultIndex.get(id)].output])),
      };
      else if (lastImages && user === previousUser) {
        // Only extend a reviewed batch across the recorded text-only tail of this user turn.
        // Never change any request containing a new or ongoing visual comparison.
        assert(lastImages.pictures.every(p => resultIndex.get(p.callId) > actualUser));
        const input = payload.input.map(item => {
          if (item.type !== "function_call_output" || !lastImages.outputs.has(item.call_id)) return item;
          const output = lastImages.outputs.get(item.call_id);
          const canonical = raw => lastImages.pictures.filter(pic => pic.callId === item.call_id)
            .reduce((value,pic) => canonicalText(value,pic.id),plainText(raw));
          assert.equal(canonical(item.output),canonical(output),"Tail restored text unrelated to image placement");
          return { ...item, output };
        });
        deferred = { ...payload, input };
        samePictures(lastImages.pictures, wireImages(deferred));
        tails.push(step); addedTailImages += lastImages.pictures.length;
      }
      previousUser = user;
      const scenarios = { keepFreshInSourceTool:first, appendNewPicturesInPlace:incremental, allPixelsInLabelledToolAttachment:second, retainReviewedUntilTurnEnds:deferred };
      observePrefix("original",payload,step);
      for (const [name,scenario] of Object.entries(scenarios)) {
        const pics = wireImages(scenario);
        assert(pics.length <= INLINE_IMAGE_HIGH_COUNT && pics.reduce((total,pic) => total + pic.data.length,0) <= INLINE_IMAGE_HIGH_BYTES);
        assert(Buffer.byteLength(JSON.stringify(scenario)) + 4096 <= MODEL_REQUEST_HIGH_BYTES, "Request exceeds budget with transport envelope headroom");
        observePrefix(name,scenario,step);
      }
      return scenarios;
    },
    report() {
      return { requests: count, unchangedOrderedImageOccurrencesInGalleryLayouts: occurrences, freshOccurrences:firstOccurrences,
        freshSteps, inspections, retainedNonvisualTailSteps:tails, extraImageOccurrencesInNonvisualTail:addedTailImages,
        exactAdjacentInputPrefixSteps:exactSteps };
    },
  };
}
