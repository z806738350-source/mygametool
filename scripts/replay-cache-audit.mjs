// All comparisons stay in memory. The emitted evidence contains counts and source categories, never prompts or images.
import assert from "node:assert/strict";
import { wireImages } from "../src/daemon/session-images.ts";

/** Price the same layouts under an alternative hit pattern directly observed in the billing log. */
export function estimateCacheHitSensitivity({ audit, historicalRows, bills, userBoundaries, output, rate }) {
  const turn = step => userBoundaries.findLast(first => first <= step);
  const transitions = { bothFull: 0, onlyWireFull: 0, onlyBilledFull: 0, neitherFull: 0 };
  const partialHits = {};
  for (let i = 1; i < bills.length; i++) {
    // Every complete serialized item adds positive feature mass.
    const full = historicalRows[i].prefix.every((v, j) => v === historicalRows[i-1].features[j]);
    const hit = bills[i].read === bills[i-1].total - bills[i-1].plain;
    transitions[full ? (hit ? "bothFull" : "onlyWireFull") : (hit ? "onlyBilledFull" : "neitherFull")]++;
    if (!full && !hit && bills[i].read > 0 && !userBoundaries.includes(i+1))
      (partialHits[turn(i+1)] ??= []).push({ step: i+1, read: bills[i].read });
  }
  const result = { historicalTransitions: transitions, historicalPositivePartialHitsWithinTurn: partialHits };
  if (!rate || transitions.onlyWireFull || transitions.onlyBilledFull) return result;
  const limits = Object.fromEntries(Object.entries(partialHits).map(([k, list]) => [k, [...list].sort((a,b) => a.read-b.read)[Math.floor(list.length/2)].read]));
  const main = audit.rows.map((row, i) => ({
    step: row.step, inputTokens: row.modelInputTokens,
    prevIsExactPrefix: !!i && row.schemaUnchanged && row.prefixItems === audit.rows[i-1].inputItems,
  }));
  const layouts = { original: main, ...Object.fromEntries(Object.entries(audit.scenarios).map(([name, v]) => [name, v.steps])) };
  const models = {};
  for (const [name, rows] of Object.entries(layouts)) {
    assert.deepEqual(rows.map(r => r.step), main.map(r => r.step));
    const quote = creditPartial => {
      let read = 0, write = 0, plain = 0, preceding = 0;
      rows.forEach(({ step,inputTokens,prevIsExactPrefix }, i) => {
        const ordinary = bills[audit.rows[i].cacheWriteAnchorOriginalStep-1].plain;
        const available = inputTokens - ordinary;
        const allowance = userBoundaries.includes(step) ? bills[step-1].read : limits[turn(step)] ?? 0;
        const hit = Math.min(available, prevIsExactPrefix ? preceding : creditPartial ? allowance : 0);
        read += hit; write += available-hit; plain += ordinary; preceding=available;
      });
      return { cacheWrite: write, usd: +( (plain*rate[0]+read*rate[1]+write*rate[2]+output*rate[3])/1e6 ).toFixed(6) };
    };
    models[name] = { fullTransitions:rows.filter(row => row.prevIsExactPrefix).length,
      onlyFull:quote(false), observedPartial:quote(true) };
  }
  return { ...result, layouts:models,
    interpretation:"Sensitivity, not a vendor cache specification. Both comparisons reprice the original and the candidate. A complete previous request gets its preceding cacheable input; a partial prefix gets either zero or the observed within-turn median, with recorded user-boundary readings. No extra credit for extending a partial match." };
}

const plus = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const zeros = () => [0, 0, 0, 0, 0];
const addFeatures = (into, key, vector) => {
  const f = into[key] ??= zeros();
  for (let i = 0; i < f.length; i++) f[i] += vector[i];
};
function category(item, tools) {
  if (item.type === "reasoning") return "reasoning";
  if (item.type === "function_call") return "toolArguments";
  if (item.type === "function_call_output") {
    const name = tools.get(item.call_id);
    if (["tool_search", "read_workflow_guide", "list_media_capabilities"].includes(name)) return "guidesAndToolLookups";
    return "otherToolResults";
  }
  if (item.role === "developer" || item.role === "system") return "systemInstructions";
  if (item.role === "user") return "userMessage";
  if (item.role === "assistant") return "assistantMessage";
  return "other";
}

export function createCacheAudit() {
  const seenPixels = new Map(), seenBlocks = new Set(), seenText = new Set();
  let previousItems = [], ordinal = 0;
  return async function audit(payload, signature, previous, { step, freshIds, isInspection, toolNames, nextTools }, picturePatches) {
    const features = {}, suffixBytes = {}, repeatedBytes = {}, images = [], metadata = [];
    let matching = previous?.schemas === signature.schemas, firstDifference, prefixItems = 0;
    const exactSchemas = !!matching;
    if (!matching) {
      const n = Buffer.byteLength(signature.schemas);
      addFeatures(features, "toolSchemas", [0,n,0,0,0]); plus(suffixBytes, "toolSchemas", n);
      firstDifference = { cause: previous ? "schema-change" : "first-request" };
    }
    const fresh = new Set(freshIds);
    const prospectiveTexts = [];
    for (const [i,item] of payload.input.entries()) {
      const shots = wireImages([item]);
      const bytes = Buffer.byteLength(signature.items[i]) - shots.reduce((sum, shot) => sum + shot.data.length, 0);
      const source = category(item,toolNames);
      // IDs and metadata are part of the key. Unchanged excerpts inside edited items are conservatively not called repeats.
      const text = shots.length ? JSON.stringify(item, (k,v) => k === "image_url" && typeof v === "string" && v.startsWith("data:")
        ? v.slice(0,v.indexOf(",")+1) : v) : signature.items[i];
      assert.equal(Buffer.byteLength(text), bytes);
      const oldText = seenText.has(text);
      prospectiveTexts.push(text);
      const picMeta = { source, ...(item.call_id ? { tool: toolNames.get(item.call_id) ?? item.name } : {}), imageIds: shots.map(shot => shot.id) };
      metadata.push(picMeta);
      const samePosition = previous?.items[i] === signature.items[i];
      if (matching && !samePosition) {
        matching = false;
        const before = previousItems[i];
        const cause = !before ? "append" : before.imageIds.length || shots.length ? "changed-image-bearing-item" : "changed-text-or-reasoning-item";
        firstDifference = { cause, item: i, before, now: picMeta };
      }
      if (matching) prefixItems++;
      else {
        const bucket = source + (oldText ? ".seen" : ".newOrChanged");
        addFeatures(features, bucket, source === "reasoning" ? [0,0,bytes,0,0] : [bytes,0,0,0,0]);
        plus(suffixBytes, source, bytes); if (oldText) plus(repeatedBytes, source, bytes);
      }
      for (const shot of shots) {
        const prev = seenPixels.get(shot.data);
        if (prev) assert.equal(prev.mime,shot.mime);
        else seenPixels.set(shot.data,{ step,mime:shot.mime });
        const firstBlock = !seenBlocks.has(shot.id);
        seenBlocks.add(shot.id);
        const status = !prev ? "firstDistinct" : prev.step < step ? "seenEarlierRequest" : "sameRequestDuplicate";
        const patches = await picturePatches(shot.data);
        images.push({ id:shot.id, firstByteStep:prev?.step ?? step, firstBlock, freshReceipt:fresh.has(shot.id), status, adjacentPrefix:!!matching, patches, base64Bytes:shot.data.length });
        if (!matching) addFeatures(features,"pixels."+status,[0,0,0,1,patches]);
      }
    }
    if (!firstDifference && previousItems.length > payload.input.length)
      firstDifference = { cause:"shorter-input", item:payload.input.length };
    for (const text of prospectiveTexts) seenText.add(text);
    previousItems = metadata;
    return { request:++ordinal, step, nextTools, isInspection, freshBlocks:freshIds.length, images, schemaUnchanged:exactSchemas,
      prefixItems, inputItems:payload.input.length, firstDifference, suffixBytes, previouslyIdenticalSuffixTextBytes:repeatedBytes, suffixFeatures:features };
  };
}

export function priceCacheAudit(audit, feature, prefix, weights, billed, fixed, anchorStep) {
  const all = Object.values(audit.suffixFeatures).reduce((acc,vector) => acc.map((v,i) => v+vector[i]),zeros());
  assert.deepEqual(all,feature.map((v,i) => v-prefix[i]),"Incomplete source accounting outside the common prefix");
  const estimatedSuffixTokens = Object.fromEntries(Object.entries(audit.suffixFeatures).map(([key,v]) => [
    key, v.reduce((a,n,i)=>a+n*weights[i],0)]));
  const gross = Object.values(estimatedSuffixTokens).reduce((a,n)=>a+n,0);
  const {suffixFeatures, ...evidence} = audit;
  return { ...evidence, estimatedCacheWrite:billed.write, fixedAnchorCacheWrite:fixed.write,
    cacheWriteAnchorOriginalStep:anchorStep, wireBytes:billed.wireBytes, inputFeatures:feature, adjacentPrefixFeatures:prefix, modelInputTokens:billed.total,
    estimatedModelUsd:billed.usd, estimatedSuffixTokens, modelOffsetFromGrossSuffix:billed.write-gross };
}

export function summarizeCacheAudit(rows) {
  const requestKinds = {}, firstChangedItem = {}, imageOccurrences = {}, suffixTokens = {}, suffixBytes = {}, repeatedTextBytes = {};
  let calibrationOffset = 0;
  for (const row of rows) {
    const kind = row.isInspection ? "formalVisualComparison" : row.images.some(i => i.status === "firstDistinct")
      ? "otherFirstDistinctImage" : row.freshBlocks ? "newImageEvidenceWithPreviouslySeenPixels"
      : row.images.length ? "onlyCarriedPixels" : "noImages";
    const group = requestKinds[kind] ??= { requests:0, estimatedCacheWrite:0, steps:[] };
    group.requests++; group.estimatedCacheWrite += row.estimatedCacheWrite; group.steps.push(row.step);
    const divergence = row.firstDifference?.cause ?? "identical-input";
    const change = firstChangedItem[divergence] ??= { requests:0, estimatedCacheWrite:0 };
    change.requests++; change.estimatedCacheWrite += row.estimatedCacheWrite;
    for (const image of row.images) {
      const occurrence = imageOccurrences[image.status] ??= { count:0, adjacentPrefix:0, afterPrefix:0 };
      occurrence.count++; occurrence[image.adjacentPrefix ? "adjacentPrefix" : "afterPrefix"]++;
    }
    for (const [k,n] of Object.entries(row.estimatedSuffixTokens)) plus(suffixTokens,k,n);
    for (const [k,n] of Object.entries(row.suffixBytes)) plus(suffixBytes,k,n);
    for (const [k,n] of Object.entries(row.previouslyIdenticalSuffixTextBytes)) plus(repeatedTextBytes,k,n);
    calibrationOffset += row.modelOffsetFromGrossSuffix;
  }
  const total = rows.reduce((n,row) => n + row.estimatedCacheWrite,0);
  assert(Math.abs(total - Object.values(suffixTokens).reduce((a,b) => a+b,calibrationOffset)) < 0.001);
  return { requestKinds, firstChangedItem, imageOccurrences, weightedAdjacentSuffixTokens:suffixTokens,
    nonPictureAdjacentSuffixBytes:suffixBytes, identicalTextBytesAfterPrefix:repeatedTextBytes,
    signedUnattributedCalibrationOffset:calibrationOffset,
    largestWrites:rows.toSorted((a,b) => b.estimatedCacheWrite-a.estimatedCacheWrite).slice(0,10)
      .map(({request,step,estimatedCacheWrite})=>({request,step,estimatedCacheWrite})) };
}

const RECENT_PREFIX_MS = 5 * 60 * 1000;
const roundUsd = (amount) => Number(amount.toFixed(6));
const tokenWeight = (features, weights) => features.reduce((sum, value, i) => sum + value * weights[i], 0);

/** Nonnegative fit over text, schema, reasoning, image count and pixel-patch features. */
export function fitReplayTokenWeights(features, targets) {
  assert(features.length && features.length === targets.length && features.every(v => v.length === 5));
  const scale = zeros().map((_, j) => Math.sqrt(features.reduce((n, row) => n + row[j] ** 2, 0) / features.length) || 1);
  const input = features.map(row => row.map((n, j) => n / scale[j]));
  const weights = zeros(), residual = targets.slice();
  const denominators = weights.map((_, j) => input.reduce((n, row) => n + row[j] ** 2, 0));
  for (let pass = 0; pass < 1000; pass++) for (let j = 0; j < weights.length; j++) {
    if (!denominators[j]) continue;
    const change = Math.max(-weights[j], input.reduce((n, row, i) => n + row[j] * residual[i], 0) / denominators[j]);
    weights[j] += change;
    input.forEach((row, i) => { residual[i] -= change * row[j]; });
  }
  return weights.map((n, j) => n / scale[j]);
}

/** Compare serialized inputs exactly. Intern items so growing transcripts need only one copy of each distinct item. */
export function createReplayPrefixHistory() {
  const interned = new Map(), bySchema = new Map();
  let previous;
  return {
    observe({ step, time, schemas, items, itemFeatures }) {
      assert(items.length === itemFeatures.length && itemFeatures.every(v => v.length === 5));
      assert(Number.isSafeInteger(step) && Number.isFinite(time) && (!previous || step > previous.step && time >= previous.time));
      const seen = bySchema.get(schemas) ?? [];
      const ids = items.map(item => {
        if (!interned.has(item)) interned.set(item, interned.size);
        return interned.get(item);
      });
      const schemaFeatures = [0, Buffer.byteLength(schemas), 0, 0, 0];
      const cumulative = [schemaFeatures];
      for (const feature of itemFeatures)
        cumulative.push(cumulative.at(-1).map((n, j) => n + feature[j]));
      let adjacent = null, recent = null, history = null;
      const longer = (candidate, current) => !current || candidate.items > current.items ||
        candidate.items === current.items && candidate.completePrior && !current.completePrior;
      for (let i = seen.length - 1; i >= 0; i--) {
        const prior = seen[i];
        let count = 0;
        while (count < ids.length && ids[count] === prior.ids[count]) count++;
        const match = { step: prior.step, gapMs: time - prior.time, items: count,
          completePrior: count === prior.ids.length, features: cumulative[count] };
        if (prior === previous) adjacent = match;
        if (longer(match, history)) history = match;
        if (match.gapMs <= RECENT_PREFIX_MS && longer(match, recent)) recent = match;
      }
      previous = { step, time, ids };
      seen.push(previous);
      bySchema.set(schemas, seen);
      return { adjacent, recent, history };
    },
  };
}

/** Reprice the same recorded decisions, including conservative alternatives for unknown cache reuse. */
export function priceRecordedReplay({ comparison, calibrationRows = comparison, weights, rate }) {
  assert(comparison.length && weights.length === 5 && weights.every(n => Number.isFinite(n) && n >= 0));
  assert(rate.length === 4 && rate.every(n => Number.isFinite(n) && n >= 0));
  const byStep = new Map(calibrationRows.map(row => [row.step, row]));
  const previousByStep = new Map(calibrationRows.slice(1).map((row, i) => [row.step, calibrationRows[i]]));
  const tokens = (match) => match ? tokenWeight(match.features, weights) : 0;
  const billUsd = ({ plain, read, write, output }) =>
    (plain * rate[0] + read * rate[1] + write * rate[2] + output * rate[3]) / 1e6;
  const estimatedTotal = ({ bill, historical, candidate }) => !candidate ? 0 :
    Math.max(bill.plain, Math.round(bill.total + tokenWeight(
      candidate.features.map((n, j) => n - historical.features[j]), weights)));
  const available = row => estimatedTotal(row) - row.bill.plain;
  const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
  const summarize = rows => ({
    calls: rows.filter(row => row.total > 0).length,
    ...Object.fromEntries(["total", "plain", "read", "write", "output"].map(field => [field, sum(rows, field)])),
    usd: roundUsd(sum(rows, "usd")),
  });
  const calibrate = (rows, fit = weights) => ({
    requests: rows.length,
    firstStep: rows[0].step,
    lastStep: rows.at(-1).step,
    startTime: rows[0].time,
    endTime: rows.at(-1).time,
    meanAbsoluteInputErrorTokens: Math.round(rows.reduce((total, { historical, bill }) =>
      total + Math.abs(tokenWeight(historical.features, fit) - bill.total), 0) / rows.length),
    meanAbsoluteRelativeInputError: +(rows.reduce((total, { historical, bill }) =>
      total + Math.abs(tokenWeight(historical.features, fit) - bill.total) / Math.max(1, bill.total), 0) / rows.length).toFixed(4),
    meanAbsolutePrefixErrorTokens: Object.fromEntries(["adjacent", "recent", "history"].map(key => [key, Math.round(rows.reduce((total, { historical, bill }) =>
      total + Math.abs(tokenWeight(historical.matches[key]?.features ?? zeros(), fit) - bill.read), 0) / rows.length)])),
  });
  const calibration = {
    inSample: calibrate(calibrationRows),
    chronologicalQuarters: [0, 1, 2, 3].flatMap(i => {
      const quarter = calibrationRows.slice(Math.floor(calibrationRows.length * i / 4), Math.floor(calibrationRows.length * (i + 1) / 4));
      return quarter.length ? [calibrate(quarter)] : [];
    }),
    forwardHoldouts: calibrationRows.length < 12 ? [] : [2, 3].map(i => {
      const start = Math.floor(calibrationRows.length * i / 4), end = Math.floor(calibrationRows.length * (i + 1) / 4);
      const train = calibrationRows.slice(0, start);
      const fit = fitReplayTokenWeights(train.map(row => row.historical.features), train.map(row => row.bill.total));
      return { trainThroughStep: train.at(-1).step, trainingRequests: train.length,
        ...calibrate(calibrationRows.slice(start, end), fit) };
    }),
    ratesPerMillionOrdinaryReadWriteOutput: rate,
    actualMinusRateUsd: roundUsd(calibrationRows.reduce((total, { bill }) => total + bill.charge - billUsd(bill), 0)),
    maxAbsoluteBillingResidualUsd: roundUsd(Math.max(...calibrationRows.map(({ bill }) => Math.abs(bill.charge - billUsd(bill))))),
  };
  const transitionCounts = {
    fullAdjacentOnWire: 0, fullAdjacentAsBilled: 0, both: 0,
    recentCompleteWithSourceBill: 0, recentCompleteAndCompatibleWithBilledRead: 0,
    nonAdjacentRecentCompleteAndCompatibleWithBilledRead: 0,
    nonAdjacentOlderCompleteAndCompatibleWithBilledRead: 0,
  };
  const partialReadPlateaus = new Map();
  for (const { step, bill, historical } of comparison) {
    const { adjacent, recent, history } = historical.matches;
    const prior = previousByStep.get(step);
    const priorBill = prior?.bill;
    const billedFull = Boolean(priorBill && bill.read === priorBill.total - priorBill.plain);
    if (adjacent?.completePrior) transitionCounts.fullAdjacentOnWire++;
    if (billedFull) transitionCounts.fullAdjacentAsBilled++;
    if (billedFull && adjacent?.completePrior) transitionCounts.both++;
    if (!billedFull && bill.read > 0)
      partialReadPlateaus.set(bill.read, (partialReadPlateaus.get(bill.read) ?? 0) + 1);
    const recentSource = recent?.completePrior ? byStep.get(recent.step)?.bill : undefined;
    if (recentSource) {
      transitionCounts.recentCompleteWithSourceBill++;
      if (bill.read === recentSource.total - recentSource.plain) transitionCounts.recentCompleteAndCompatibleWithBilledRead++;
    }
    for (const [match, key] of [[recent, "nonAdjacentRecentCompleteAndCompatibleWithBilledRead"], [history, "nonAdjacentOlderCompleteAndCompatibleWithBilledRead"]]) {
      if (!match?.completePrior || match.step === prior?.step || key.includes("Older") && match.gapMs <= RECENT_PREFIX_MS) continue;
      const source = byStep.get(match.step)?.bill;
      if (source && bill.read === source.total - source.plain) transitionCounts[key]++;
    }
  }
  const rows = comparison.map(row => {
    const { step, time, bill, historical, candidate, answeredLocally = false } = row;
    assert.equal(bill.total, bill.plain + bill.read + bill.write, "The CSV input counts do not reconcile");
    if (answeredLocally) assert.equal(candidate, null, "A local answer cannot also have a candidate provider request");
    const total = estimatedTotal(row), plain = candidate ? bill.plain : 0, cacheable = total - plain;
    const bounded = amount => Math.max(0, Math.min(cacheable, Math.round(amount)));
    const delta = key => tokens(candidate?.matches[key]) - tokens(historical.matches[key]);
    const recordedReuseOnly = bounded(bill.read + Math.min(0, delta("recent")));
    let recentExactPrefix = recordedReuseOnly;
    const recent = candidate?.matches.recent;
    if (recent?.completePrior && !historical.matches.recent?.completePrior) {
      const source = byStep.get(recent.step);
      recentExactPrefix = Math.max(recordedReuseOnly, bounded(source?.candidate ? available(source) : tokens(recent)));
    }
    const candidates = {
      recordedReuseOnly, recentExactPrefix,
      recentPrefixDelta: bounded(bill.read + delta("recent")),
      allHistoryPrefixDelta: bounded(bill.read + delta("history")),
    };
    const scenarios = Object.fromEntries(Object.entries(candidates).map(([name, read]) => {
      const estimate = { total, plain, read, write: cacheable - read, output: answeredLocally ? 0 : bill.output };
      // Apply price deltas to the exact CSV charge instead of treating the approximate rate fit as a receipt.
      return [name, { ...estimate, usd: answeredLocally ? 0 : Math.max(0, bill.charge + billUsd(estimate) - billUsd(bill)) }];
    }));
    return { step, time, actual: { ...bill, usd: bill.charge }, candidateRemoved: !candidate,
      ...(answeredLocally ? { answeredLocally: true } : {}),
      historicalMatches: historical.matches, candidateMatches: candidate?.matches ?? null, scenarios };
  });
  const actual = summarize(rows.map(row => row.actual));
  const scenarios = Object.fromEntries(Object.keys(rows[0].scenarios).map(name => {
    const scenario = summarize(rows.map(row => row.scenarios[name]));
    return [name, { ...scenario, estimatedSavedUsd: roundUsd(actual.usd - scenario.usd) }];
  }));
  return { actual, calibration, transitionCounts, scenarios, rows,
    commonPartialReadCounts: [...partialReadPlateaus.entries()].filter(([, requests]) => requests > 1)
      .sort((a, b) => b[1] - a[1]).map(([tokens, requests]) => ({ tokens, requests })),
    assumptions: {
      recentMaxAgeMs: RECENT_PREFIX_MS,
      originalCharge: "Exact CSV charges. Rate-based candidate deltas use the same recorded output count, including folded calls." +
        (rows.some(row => row.answeredLocally) ? " Calls answered locally have no provider input or output." : ""),
      input: "Baseline total plus the rounded weighted difference in reconstructed input. Forward holdouts fit only on earlier requests. Absolute input/prefix calibration does not measure the actual effect of a candidate change.",
      recordedReuseOnly: "No additional hits credited. Recorded reads are capped at candidate capacity and reduced for estimated loss of a recent exact prefix.",
      recentExactPrefix: "Same floor, with possible credit for a complete newly matched prior request within five minutes.",
      recentPrefixDelta: "Recorded reads adjusted for estimated differences in the longest same-schema exact prefix within five minutes.",
      allHistoryPrefixDelta: "The same sensitivity across all earlier reconstructed requests. No assumption of indefinite retention in the primary estimate.",
      scope: "Window lengths and prefix reuse rules are counterfactual pricing assumptions. The gateway's tokenizer, eviction policy, actual matching boundaries and candidate charges are unknown.",
    },
  };
}
