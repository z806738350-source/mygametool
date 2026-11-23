import { useEffect, useRef, useState } from "react";
import type { ThreadItem } from "../shared/contracts.js";
import { validSourceConfirmation, type IsolatedSourceConfirmation } from "../shared/execution-storage.js";
import { isVolumeMigrationReview, validVolumeMigrationReview, validVolumeMigrationConfirmation, type VolumeMigrationConfirmation, type VolumeMigrationReview } from "../shared/volume-migration.js";
import type {
  ApprovalDecision,
  ApprovalRequestDetails,
  TripoModelReview,
} from "../shared/agent-runtimes.js";
import { ChevronRight, FileText, Image, InfoCircle, Terminal } from "./icons.js";
import { formatBytes } from "./format-bytes.js";
import { TurnaroundReviewViews } from "./turnaround-review-views.js";
import { ModelPreview } from "./model-preview.js";
import { getLibraryAsset } from "./api.js";
import { t } from "./i18n.js";
import "./approval-source-review.css";

interface ApprovalCardProps {
  request: Extract<ThreadItem, { type: "approvalRequest" }>;
  /** The coding agent's name, such as Claude Code. */
  agentName?: string;
  /** How many more requests wait behind this one. */
  waiting: number;
  onDecide: (decision: ApprovalDecision, sourceConfirmation?: IsolatedSourceConfirmation, volumeMigrationConfirmation?: VolumeMigrationConfirmation) => Promise<boolean>;
}

/** A coding agent asks before it does something OhMyGame does not allow on its own. */
export function ApprovalCard({
  request,
  agentName,
  waiting,
  onDecide,
}: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [filesReviewed, setFilesReviewed] = useState(false);
  const [codeReviewed, setCodeReviewed] = useState(false);
  const [decisionFailed, setDecisionFailed] = useState(false);
  const [readyReviewId, setReadyReviewId] = useState<string>();
  const [migrationConsent, setMigrationConsent] = useState({ key: "", capacityReviewed: false, oldVolumeRetained: false });
  // A second click can arrive before the disabled buttons render; one answer is sent per request.
  const answering = useRef(false);
  useEffect(() => {
    answering.current = false;
    setSubmitting(false);
    setFilesReviewed(false);
    setCodeReviewed(false);
    setDecisionFailed(false);
    setMigrationConsent({ key: "", capacityReviewed: false, oldVolumeRetained: false });
  }, [request.requestId, request.turnId, request.request.isolatedSourceReview?.reviewId, request.request.volumeMigration?.planId, request.request.turnaroundReview?.reviewId, request.request.tripoModelReview?.reviewId]);
  const details = request.request;
  const turnaround = details.kind === "turnaroundReview";
  const views = details.turnaroundReview;
  const tripo = details.kind === "tripoModelReview";
  const model = details.tripoModelReview;
  const visualReview = turnaround || tripo;
  const visualReviewId = (turnaround ? views : model)?.reviewId;
  const migrationRequested = details.kind === "volumeMigration" || details.volumeMigration !== undefined;
  const migration = migrationRequested && isVolumeMigrationReview(details.volumeMigration) ? details.volumeMigration : undefined;
  const creatingVolume = migration?.source.profileId === "unallocated";
  const migrationKey = migration ? JSON.stringify([request.requestId, request.turnId, migration.planId, migration.generation, migration.source.imageSha256, migration.target.profileId]) : "";
  const migrationConfirmation = migration ? { planId: migration.planId, generation: migration.generation, sourceImageSha256: migration.source.imageSha256,
    targetProfileId: migration.target.profileId, capacityReviewed: migrationConsent.key === migrationKey && migrationConsent.capacityReviewed,
    oldVolumeRetained: migrationConsent.key === migrationKey && migrationConsent.oldVolumeRetained } : undefined;
  const source = migrationRequested ? undefined : details.isolatedSourceReview;
  const confirmation = source ? { reviewId: source.reviewId, filesReviewed, codeReviewed } : undefined;
  const canApprove = visualReview ? Boolean(visualReviewId && visualReviewId === readyReviewId && !details.canAllowSession)
    : migrationRequested ? details.kind === "volumeMigration" && !details.canAllowSession && !details.isolatedSourceReview && validVolumeMigrationConfirmation(migration, migrationConfirmation)
    : !source || validSourceConfirmation(source, confirmation);
  const agent = agentName ?? t("approval.theAgent");
  const title =
    turnaround ? t("approval.turnaroundTitle") : tripo ? t("approval.tripoModelTitle") : migrationRequested ? t(creatingVolume ? "approval.migrationCreateTitle" : "approval.migrationTitle") : source ? t("approval.sourceReviewScope", { generation: source.generation, count: source.files.length }) : details.kind === "command"
      ? t("approval.commandTitle", { agent })
      : details.kind === "file"
        ? t("approval.fileTitle", { agent })
        : details.kind === "tool"
          ? t("approval.toolTitle", {
              agent,
              tool: details.title ?? details.tool,
            })
          : t("approval.otherTitle", { agent });
  async function decide(decision: ApprovalDecision) {
    if (answering.current) return;
    if (decision !== "deny" && !canApprove) return;
    if (migrationRequested && decision !== "deny" && (decision !== "allow" || !validVolumeMigrationConfirmation(migration, migrationConfirmation))) return;
    answering.current = true;
    setDecisionFailed(false);
    setSubmitting(true);
    let answered = false;
    try {
      answered = migrationRequested && decision === "allow" ? await onDecide(decision, undefined, migrationConfirmation)
        : source && decision === "allow" ? await onDecide(decision, confirmation) : await onDecide(decision);
    } catch {
      /* A failed decision leaves this request open for another attempt. */
    }
    if (!answered) {
      answering.current = false;
      setSubmitting(false);
      setDecisionFailed(true);
    }
  }
  return (
    <section
      className={`questionnaire-card approval-card${source || migrationRequested ? " approval-card-source" : ""}${migrationRequested ? " approval-card-migration" : ""}${visualReview ? " approval-card-turnaround" : ""}`}
      aria-label={t("approval.label")}
      aria-busy={submitting}
    >
      <header>
        {visualReview ? <Image size={15} aria-hidden="true" /> : source || migrationRequested ? <FileText size={15} aria-hidden="true" /> : <Terminal size={14} aria-hidden="true" />}
        <strong>{title}</strong>
        {waiting > 0 ? (
          <small>{t("approval.waiting", { count: waiting })}</small>
        ) : null}
      </header>
      {turnaround && views ? <TurnaroundReviewViews key={views.reviewId} review={views} onReady={setReadyReviewId} /> : null}
      {tripo && model ? <TripoModelReviewPreview key={model.reviewId} review={model} onReady={setReadyReviewId} /> : null}
      {details.command !== undefined ? (
        <pre className="approval-card-detail">
          <code>{details.command}</code>
        </pre>
      ) : null}
      {details.path ? (
        <p className="approval-card-path">
          <code>{details.path}</code>
        </p>
      ) : null}
      {details.reason ? (
        <p className="approval-card-reason">{details.reason}</p>
      ) : null}
      {migrationRequested ? migration ? <section className="approval-source-review approval-migration-review">
        <VolumeMigrationDetails review={migration} />
        {!validVolumeMigrationReview(migration) ? <div className="approval-source-blockers" role="alert">
          <strong>{t("approval.migrationBlocked")}</strong>
          {migration.blockers.map((reason, index) => <p key={index}>{reason}</p>)}
        </div> : null}
        <fieldset className="approval-source-confirmations" disabled={submitting || !validVolumeMigrationReview(migration)}>
          <legend>{t("approval.migrationConfirmations")}</legend>
          <label><input type="checkbox" checked={migrationConfirmation?.capacityReviewed === true} onChange={event => setMigrationConsent(previous => ({ key: migrationKey, capacityReviewed: event.target.checked, oldVolumeRetained: previous.key === migrationKey && previous.oldVolumeRetained }))} /><span>{t("approval.migrationCapacityReviewed")}</span></label>
          <label><input type="checkbox" checked={migrationConfirmation?.oldVolumeRetained === true} onChange={event => setMigrationConsent(previous => ({ key: migrationKey, oldVolumeRetained: event.target.checked, capacityReviewed: previous.key === migrationKey && previous.capacityReviewed }))} /><span>{t(creatingVolume ? "approval.migrationCreateRetentionReviewed" : "approval.migrationRetentionReviewed")}</span></label>
        </fieldset>
      </section> : <p className="approval-source-blockers" role="alert">{t("approval.migrationBlocked")}</p> : null}
      {source ? (
        <section className="approval-source-review">
          <p className="approval-source-intro">{t(source.publicationUnchanged ? "approval.sourceReviewUnchanged" : "approval.sourceReviewSummary")}</p>
          <div className="approval-source-files" role="region" aria-label={t("approval.sourceFileList")} tabIndex={0}>
            {source.files.map(file => <details className="approval-source-file" key={file.path}>
              <summary>
                <ChevronRight className="approval-source-chevron" size={13} aria-hidden="true" />
                <code className="approval-source-file-path">{file.path}</code>
                <span className="approval-source-file-size">{formatBytes(file.bytes)}</span>
                <span className="approval-source-file-meta">
                  <span className={file.kind === "code" ? "approval-source-code-kind" : undefined}>{t(`approval.sourceKind.${file.kind}`)}</span>
                  <span>{t(source.publicationUnchanged ? "approval.sourceTargetMatched" : `approval.sourceChange.${file.change}`)}</span>
                </span>
              </summary>
              <div className="approval-source-file-content">
                <dl>
                  <dt>{t("approval.sourceSize")}</dt>
                  <dd>{file.beforeBytes === undefined ? file.bytes : `${file.beforeBytes} → ${file.bytes}`} B</dd>
                  {file.beforeSha256 ? <><dt>{t("approval.sourceOriginalHash")}</dt><dd><code>{file.beforeSha256}</code></dd></> : null}
                  <dt>{t("approval.sourceReturnedHash")}</dt><dd><code>{file.afterSha256}</code></dd>
                  {file.optimization ? <>
                    <dt>{t("approval.sourceRetainedImage")}</dt>
                    <dd>{file.optimization.originalBytes} B{file.optimization.originalWidth && file.optimization.originalHeight ? ` · ${file.optimization.originalWidth} × ${file.optimization.originalHeight}` : ""} · {t(file.optimization.originalRetained ? "approval.sourceRetained" : "approval.sourceNotRetained")}</dd>
                    <dt>{t("approval.sourceRetainedHash")}</dt><dd><code>{file.optimization.originalSha256}</code></dd>
                    <dt>{t("approval.sourceWorkingImage")}</dt>
                    <dd>{file.optimization.width && file.optimization.height ? `${file.optimization.width} × ${file.optimization.height}` : t("approval.sourceNotPrepared")}</dd>
                    <dt>{t("approval.sourceImagePolicy")}</dt>
                    <dd>{file.optimization.maxEdge === undefined ? t("approval.sourcePreserveDimensions") : t("approval.sourceExplicitMaxEdge", { maxEdge: file.optimization.maxEdge })}</dd>
                    <dt>{t("approval.sourceImageAlpha")}</dt>
                    <dd>{t(file.optimization.hasAlpha === true && file.optimization.width && file.optimization.height && !file.optimization.needsMaxEdge ? "approval.sourceAlphaPreserved" : file.optimization.hasAlpha === false ? "approval.sourceAlphaAbsent" : "approval.sourceAlphaUnchecked")}</dd>
                  </> : null}
                  {file.kind === "image" ? <>
                    {file.imageCost?.performanceStatus === "estimate-only" ? <>
                      <dt>{t("approval.sourceImageEncoded")}</dt>
                      <dd>{file.imageCost.encodedBytes} B · {formatBytes(file.imageCost.encodedBytes)}</dd>
                      <dt>{t("approval.sourceImagePixels")}</dt>
                      <dd>{file.imageCost.pixelCount}</dd>
                      <dt>{t("approval.sourceImageDecoded")}</dt>
                      <dd>{formatBytes(file.imageCost.decodedRgbaBytes)}</dd>
                      <dt>{t("approval.sourceImageTexture")}</dt>
                      <dd>{formatBytes(file.imageCost.estimatedTextureBytes)}</dd>
                      <dt>{t("approval.sourceImageMipmaps")}</dt>
                      <dd>{formatBytes(file.imageCost.estimatedMipmapBytes)}</dd>
                      <dt>{t("approval.sourceImageDecodeLimit")}</dt>
                      <dd>{t("approval.sourceImageDecodeLimitValue", { count: file.imageCost.decodeLimitPixels })}</dd>
                    </> : <><dt>{t("approval.sourceImageResources")}</dt><dd>{t("approval.sourceImageCostUnavailable")}</dd></>}
                    <dt>{t("approval.sourceImagePerformance")}</dt>
                    <dd>{t("approval.sourceImageEstimateOnly")}</dd>
                  </> : null}
                </dl>
                {file.preview !== undefined ? <pre className="approval-card-detail" aria-label={t("approval.sourceContent")}><code>{file.preview}</code></pre> : null}
              </div>
            </details>)}
          </div>
          <div className="approval-source-risk">
            <InfoCircle size={14} aria-hidden="true" />
            <p>{t("approval.sourceReviewRisk")}</p>
          </div>
          {source.blockers.length ? <div className="approval-source-blockers" role="alert">
            <strong>{t("approval.sourceBlocked")}</strong>
            {source.blockers.map((blocker, index) => <p key={index}><code>{blocker.path}</code>: {blocker.reason}</p>)}
          </div> : null}
          <fieldset className="approval-source-confirmations" disabled={submitting}>
            <legend>{t("approval.sourceConfirmations")}</legend>
            <label><input type="checkbox" checked={filesReviewed} onChange={event => setFilesReviewed(event.target.checked)} /><span>{t(source.publicationUnchanged ? "approval.sourceFilesVerified" : "approval.sourceFilesReviewed")}</span></label>
            {source.files.some(file => file.kind === "code") ? <label><input type="checkbox" checked={codeReviewed} onChange={event => setCodeReviewed(event.target.checked)} /><span>{t(source.publicationUnchanged ? "approval.sourceCodeVerified" : "approval.sourceCodeReviewed")}</span></label> : null}
          </fieldset>
        </section>
      ) : null}
      {!source && details.paths?.length ? (
        <ul>
          {details.paths.map((entry, index) => (
            <li key={`${entry.path}:${index}`}>
              <span>
                {t(
                  entry.access === "read"
                    ? "approval.readAccess"
                    : "approval.writeAccess",
                )}
              </span>{" "}
              <code>{entry.path}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {details.network ? <p>{t("approval.networkAccess")}</p> : null}
      {visualReview && decisionFailed ? <p className="approval-source-status approval-source-error" role="alert">{t("approval.sourceDecisionFailed")}</p> : null}
      <footer>
        {migrationRequested ? <p className={`approval-source-status${decisionFailed ? " approval-source-error" : ""}`} role={decisionFailed ? "alert" : "status"}>
          {t(decisionFailed ? "approval.sourceDecisionFailed" : submitting ? "approval.sourceSubmitting" : !validVolumeMigrationReview(migration) ? "approval.migrationBlocked" : canApprove ? "approval.sourceReady" : "approval.migrationNeedsConfirmation")}
        </p> : null}
        {source ? <p className={`approval-source-status${decisionFailed ? " approval-source-error" : ""}`} role={decisionFailed ? "alert" : "status"}>
          {t(decisionFailed ? "approval.sourceDecisionFailed" : submitting ? "approval.sourceSubmitting" : source.blockers.length ? "approval.sourceBlocked" : canApprove ? "approval.sourceReady" : "approval.sourceNeedsConfirmation")}
        </p> : null}
        <button
          type="button"
          className="settings-secondary-button"
          disabled={submitting}
          onClick={() => void decide("deny")}
        >
          {t(visualReview ? "approval.turnaroundRevise" : "approval.deny")}
        </button>
        {details.canAllowSession && !source && !migrationRequested && !visualReview ? (
          <button
            type="button"
            className="settings-secondary-button"
            disabled={submitting}
            onClick={() => void decide("allow-session")}
            title={sessionScopeTitle(details.sessionScope)}
          >
            {sessionLabel(details.sessionScope)}
          </button>
        ) : null}
        <button
          type="button"
          className="settings-primary-button"
          disabled={submitting || !canApprove}
          onClick={() => void decide("allow")}
        >
          {t(turnaround ? "approval.turnaroundApprove" : tripo ? "approval.tripoModelApprove" : migrationRequested ? creatingVolume ? "approval.migrationCreateApprove" : "approval.migrationApprove" : "approval.allow")}
        </button>
      </footer>
    </section>
  );
}

function TripoModelReviewPreview({ review, onReady }: { review: TripoModelReview; onReady(id: string | undefined): void }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    onReady(undefined);
    void getLibraryAsset(review.assetId, review.fbx, controller.signal, review.previewSha256).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [review, attempt, onReady]);
  return <div className="turnaround-review">
    <p>{t("approval.tripoModelSummary")}</p>
    {failed ? <div className="turnaround-review-error">
      <span role="alert">{t("approval.tripoModelLoadFailed")}</span>
      <button type="button" className="settings-secondary-button" onClick={() => setAttempt(value => value + 1)}>{t("common.retry")}</button>
    </div> : url ? <ModelPreview source={url} label={review.name} minHeight={240} animate={false} clipPicker={false}
      onLoad={() => onReady(review.reviewId)} onError={() => { onReady(undefined); setFailed(true); }} />
      : <span role="status">{t("common.loading")}</span>}
  </div>;
}

function VolumeMigrationDetails({ review }: { review: VolumeMigrationReview }) {
  const creating = review.source.profileId === "unallocated";
  const bytes = (value: number | null | undefined) => value == null ? t("approval.migrationUnknown") : formatBytes(value);
  const shortfall = (required: number | null, available: number | null) => required !== null && available !== null && required > available
    ? ` · ${t("approval.migrationBytesShortfall", { bytes: required - available, required, available })}` : "";
  const pair = (required: number | null, available: number | null) => `${bytes(required)} / ${bytes(available)}${shortfall(required, available)}`;
  const r = review.resources;
  return <>
    <p className="approval-source-intro">{t(creating ? "approval.migrationCreateSummary" : "approval.migrationSummary")}</p>
    <div className="approval-source-file-content approval-migration-summary"><dl>
      <dt>{t("approval.migrationCurrent")}</dt><dd>{creating ? t("approval.migrationUnallocated") : <><code>{review.source.profileId}</code> · {bytes(review.source.volumeBytes)}</>}</dd>
      <dt>{t("approval.migrationTarget")}</dt><dd>{t("approval.migrationTargetValue", { media: review.target.mediaBytes / 1024 ** 2, volume: review.target.volumeBytes / 1024 ** 2, recovery: review.target.recoveryBytes / 1024 ** 2 })}</dd>
      {review.target.profileId === "capacity-128-media64-v3" ? <><dt>{t("approval.migrationFileLimits")}</dt><dd>{t("approval.migrationMedia64Limits")}</dd></> : null}
      <dt>{t("approval.migrationGeneration")}</dt><dd>{review.generation}</dd>
      <dt>{t("approval.migrationGlobalPeak")}</dt><dd>{bytes(r.globalBeforeBytes)} → {bytes(r.globalDuringBytes)}{shortfall(r.globalDuringBytes, 4 * 1024 ** 3)}</dd>
      <dt>{t("approval.migrationGuestSpace")}</dt><dd>{pair(r.guestRequiredBytes, r.guestAvailableBytes)}</dd>
      <dt>{t("approval.migrationHostSpace")}</dt><dd>{pair(r.hostRequiredBytes, r.hostAvailableBytes)}</dd>
      <dt>{t("approval.migrationInodes")}</dt><dd>{r.requiredInodes ?? t("approval.migrationUnknown")} / {r.availableInodes ?? t("approval.migrationUnknown")}</dd>
      <dt>{t("approval.migrationCurrentRecovery")}</dt><dd>{bytes(review.source.recoveryBytes)}</dd>
      <dt>{t("approval.migrationRecoveryPeak")}</dt><dd>{bytes(r.recoveryUsedBytes)} + {bytes(r.recoveryRequiredBytes)} / {bytes(review.target.recoveryBytes)}{shortfall(r.recoveryUsedBytes === null || r.recoveryRequiredBytes === null ? null : r.recoveryUsedBytes + r.recoveryRequiredBytes, review.target.recoveryBytes)}</dd>
    </dl></div>
    <details className="approval-source-file approval-migration-identity"><summary><ChevronRight className="approval-source-chevron" size={13} aria-hidden="true" /><span className="approval-source-file-path">{t("approval.migrationIdentity")}</span></summary>
      <div className="approval-source-file-content"><dl>
        <dt>{t("approval.migrationPlan")}</dt><dd><code>{review.planId}</code></dd>
        <dt>{t("approval.migrationImage")}</dt><dd><code>{review.source.imageId ?? t("approval.migrationNoOldImage")}</code></dd>
        <dt>{t("approval.migrationImageHash")}</dt><dd><code>{review.source.imageSha256 ?? t("approval.migrationNoOldImage")}</code></dd>
        <dt>{t("approval.migrationTargetProfile")}</dt><dd><code>{review.target.profileId}</code></dd>
        <dt>{t("approval.migrationExpires")}</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd>
      </dl></div>
    </details>
    <div className="approval-source-risk"><InfoCircle size={14} aria-hidden="true" /><p>{t(creating ? "approval.migrationCreateRetention" : "approval.migrationRetention")}</p></div>
    <div className="approval-source-risk"><InfoCircle size={14} aria-hidden="true" /><p>{t(creating ? "approval.migrationCreateUnsupported" : "approval.migrationUnsupported")}</p></div>
  </>;
}

/** One line in the conversation for a request that was answered or let go. */
export function approvalOutcomeLabel(
  item: Extract<ThreadItem, { type: "approvalRequest" }>,
): string {
  if (item.request.kind === "turnaroundReview") {
    if (item.status !== "completed") return t("approval.turnaroundUnanswered");
    return t(item.decision === "allow" ? "approval.turnaroundApproved" : "approval.turnaroundChangesRequested");
  }
  if (item.request.kind === "tripoModelReview") {
    if (item.status !== "completed") return t("approval.tripoModelUnanswered");
    return t(item.decision === "allow" ? "approval.tripoModelApproved" : "approval.tripoModelChangesRequested");
  }
  const subject =
    (item.request.kind === "volumeMigration" ? t(item.request.volumeMigration?.source?.profileId === "unallocated" ? "approval.migrationCreateTitle" : "approval.migrationTitle") : undefined) ??
    item.request.command ??
    item.request.path ??
    (item.request.paths?.length
      ? item.request.paths.map((entry) => entry.path).join(", ")
      : undefined) ??
    (item.request.network ? t("approval.networkAccess") : undefined) ??
    item.request.title ??
    item.request.tool;
  if (item.status === "completed" && item.decision === "allow")
    return t("approval.allowed", { subject });
  if (item.status === "completed" && item.decision === "allow-session")
    return t("approval.allowedSession", { subject });
  if (item.status === "completed") return t("approval.denied", { subject });
  return t("approval.notAnswered", { subject });
}

type SessionScope = NonNullable<ApprovalRequestDetails["sessionScope"]>;

/** Names what allowing for the conversation covers when it is more than this request. */
function sessionLabel(scope: SessionScope | undefined): string {
  if (scope?.commands?.length && !scope.readFolders?.length)
    return t("approval.allowSessionCommands", {
      commands: scope.commands.join(", "),
    });
  if (scope?.readFolders?.length && !scope.commands?.length)
    return t("approval.allowSessionFolders", {
      folders: scope.readFolders.map(folderName).join(", "),
    });
  return t("approval.allowSession");
}

function sessionScopeTitle(
  scope: SessionScope | undefined,
): string | undefined {
  const folders = scope?.readFolders ?? [];
  return folders.length ? folders.join("\n") : undefined;
}

function folderName(folder: string): string {
  return `${folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder}/`;
}
