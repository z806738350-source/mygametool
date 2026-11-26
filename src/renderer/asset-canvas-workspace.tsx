import { isMeshyModelReference } from "../shared/disabled-media-providers.js";
import { workspaceVersion } from "./workspace-version.js";
import type { CanvasCharacterViewStatus } from "../shared/canvas-workspace.js";
import { validVideoReferencePreparation, VIDEO_REFERENCE_BUDGET_ERROR } from "../shared/video-reference-preparation.js";
import { CanvasTableNode, type CanvasTables, type TableNodeRuntime } from "./canvas-table-node.js";
import {
  ArrowUp,
  Box,
  Check,
  ChevronRight,
  Clipboard,
  Copy,
  Download,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  LoaderCircle,
  Maximize,
  Music2,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  Upload,
  Undo2,
  WandSparkles,
  Redo2,
  Volume2,
  VolumeX,
  X,
  type IconComponent,
} from "./icons.js";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent, type ClipboardEvent, type ReactNode } from "react";
import { releaseImage, releaseMedia } from "./release-media.js";
import { createPortal, flushSync } from "react-dom";
import {
  Handle,
  Position,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import { CANVAS_GRID_SIZE, snapCanvasPosition } from "./canvas-alignment.js";
import { RESIZABLE_CANVAS_NODE_SIZES, canvasNodeLayout, isResizableCanvasNodeType } from "../shared/canvas-node-layout.js";
import { CanvasNodeResizer, CanvasNodeSizeActions, type CanvasNodeResizeRuntime } from "./canvas-node-resizer.js";
import { MAX_ASSET_CANVAS_NODES, MAX_TEXT_NODE_REFERENCES } from "../shared/asset-canvas-schema.js";
import { createCanvasClipboard, duplicateAssetCanvasNode, duplicateCanvasSelection, lastCanvasClipboard, parseCanvasClipboard, rememberCanvasClipboard, type CanvasClipboard } from "./asset-canvas-clipboard.js";
import { clipboardFiles, hasTransferredFiles, pasteNativeFiles, transferredFiles, type TransferredFile } from "./file-transfer.js";
import { CanvasContextMenu, EditorCanvas, isTextEntry, undoShortcut, useCanvasCenter, type CanvasContextMenuState } from "./editor-canvas.js";
import {
  IMAGE_MAX_REFERENCE_IMAGES,
  type AssetCanvasDocument,
  type AssetCanvasEditorLayout,
  type AssetCanvasNode,
  type AssetCanvasNodeType,
  type AssetCanvasReference,
  type AssetCanvasTextReference,
  type ImageAspectRatio,
  type AgentModel,
  type AgentModelRef,
  type AgentReasoningLevel,
  type CreateLibraryImageRequest,
  type ImageModel,
  type ImageGenerationSettings,
  type MediaProviderStatus,
  type ImageModelRef,
  type ImageDownloadNetworkStatus,
  type ModelRef,
  type ImageResolution,
  type LibraryUploadMediaType,
  type Model3DGenerationConfig,
  type Model3DOptions,
  type Model3DActionId,
  type Model3DOperation,
  type Model3DModel,
  type Model3DAnimationAction,
  type ProjectState,
  type ToolJob,
  type VideoAspectRatio,
  type VideoModel,
  type VideoModelRef,
  type VideoGenerationReference,
  type VideoResolution,
} from "../shared/contracts.js";
import { combineAssetCanvasPrompt, createAssetGenerationNode, isTextGenerationReferenceNode, preferredImageOption, validateAssetCanvasDocument } from "../shared/asset-canvas.js";
import { availableAudioOperations, type AudioModel, type AudioOperation, type AudioProviderCatalogStatus } from "../shared/audio.js";
import { createLibraryImage, getLibraryAsset, getWorkspaceAsset, getProjectCover, getProjectCoverState, listAudioModelCatalog, listImageModelCatalog, listModel3DAnimations, listModel3DOperations, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setProjectCover, uploadLibraryAsset, importCanvasFile, createCanvasImportFolder } from "./api.js";
import { canvasAssetDownloadName, downloadAssetBlob, loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { SendToProjectDialog } from "./send-to-project-dialog.js";
import { useAgentModels, type AgentModelCatalogStatus } from "./model-selector.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import {
  GPT_IMAGE_26_DEFAULTS, GPT_IMAGE_SVG_MODELS, GPT_IMAGE_SVG_EFFORTS,
  gptImage26FrameSize, gptImage26Options, isGptImage26, validateGptImage26Settings, type GptImage26Options,
} from "../shared/gpt-image-26.js";
import { CanvasChipSelect, type CanvasChipNote } from "./canvas-chip-select.js";
import { settingsHash } from "./routes.js";
import { useCanvasAssetSources, useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { canvasNodeTitle } from "../shared/canvas-assets.js";
import type { CanvasAssetCatalogEntry } from "../shared/canvas-assets.js";
import { prepareVideoReferenceFile, readMediaFileDuration } from "./video-reference-files.js";
import { findAssetCanvasCoverSource, type AssetCanvasCoverSource } from "../shared/asset-canvas-cover.js";
import { ModelPreview, useModelPlayback } from "./model-preview.js";
import { LibraryAssetPicker } from "./node-workbench.js";
import { AssetDialogShell, AssetMedia, useNearViewport, type AssetMediaType } from "./asset-gallery.js";
import { ANIMATION_ACTIONS_PER_REQUEST, DEFAULT_IMAGE_NODE_CONFIG, DEFAULT_MODEL_3D_CONFIG, DEFAULT_ANIMATION_ACTION_IDS, DEFAULT_CHARACTER_HEIGHT_METERS, DEFAULT_VIDEO_NODE_CONFIG, MAX_ANIMATION_ACTIONS, MODEL_3D_MAX_REFERENCE_IMAGES, mediaGenerationNeedsConfirmation, normalizeModel3DConfig, resolveModel3D, resolveModel3DConnection } from "../shared/generation-config.js";
import { MODEL3D_CONNECTION_ID, remeshPolycount, requiresModelTurnaround } from "../shared/model3d-operations.js";
import { FbxAssetActions } from "./fbx-asset-actions.js";
import { mergeCanvasDocument } from "../shared/canvas-workspace.js";
import { CanvasDocumentNode, ExpandedCanvasDocument, type CanvasDocuments, type DocumentNodeRuntime } from "./canvas-document-node.js";
import { CanvasNodeLabel, type CanvasNodeDetails } from "./canvas-node-label.js";
import { exportCanvasAsset, generateCanvasText, inspectImageDownloadNetwork } from "./canvas-api.js";
import { saveTrimmedVideo, VideoTrimmer } from "./video-trimmer.js";
import type { VideoTrim } from "./video-trim.js";
import type { CanvasBoardStorage } from "./canvas-board-storage.js";
import { CanvasNotice } from "./canvas-notice.js";
import { useDesktopClosing } from "./desktop-close-guard.js";
import { isDesktopClosing } from "./desktop-save.js";
import { CanvasTextarea, CanvasTextComposer } from "./canvas-text-composer.js";
import { VideoReferencePrompt } from "./video-reference-prompt.js";
import { resolveVideoMentions, sameVideoReference, videoReferenceAliases, videoReferenceAspectRatios, videoReferenceLimit, videoReferenceMode } from "../shared/video-references.js";
import { CanvasNodeReferenceStrip, CanvasReferenceThumbnail, type CanvasNodeReferencesRuntime } from "./canvas-node-references.js";
import { t, tNodes } from "./i18n.js";
import { canvasImportKind, droppedFolders, isIgnoredImportPath, type DroppedFolder } from "./canvas-file-import.js";
import { formatBytes } from "./format-bytes.js";
import { fileExtension } from "../shared/media-files.js";
import { AUDIO_REFERENCE_MAX_BYTES, inspectAudioReference } from "../shared/audio-reference.js";
import { kunpoModelOption, type KunpoModelSelections } from "../shared/kunpo-models.js";
import { importCanvasCsv } from "../shared/canvas-table.js";

const ASSET_EDGE_PREFIX = "asset:";
const OUTPUT_HANDLE = "out";
const MEDIA_NODE_MAX_WIDTH = 440;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_FOLDER_IMPORT_FILES = 5_000;
const MAX_FOLDER_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_NODE_MIN_WIDTH = 300;
const MEDIA_NODE_MAX_HEIGHT = 360;
const MEDIA_NODE_MIN_HEIGHT = 200;
type CanvasNodeCreationAction = { kind: "node"; type: Exclude<AssetCanvasNodeType, "asset">; documentId?: string; tableId?: string };
interface CanvasNodeCreationLeaf {
  label: string;
  description: string;
  icon: IconComponent;
  action: CanvasNodeCreationAction;
}
interface CanvasNodeCreationBranch {
  label: string;
  description: string;
  icon: IconComponent;
  children: CanvasNodeCreationLeaf[];
}
interface OpenCanvasNodeCreationBranch {
  branch: CanvasNodeCreationBranch;
  top: number;
}
type CanvasNodeCreationItem = CanvasNodeCreationLeaf | CanvasNodeCreationBranch;
interface CanvasNodeCreationGroup {
  label: string;
  items: CanvasNodeCreationItem[];
}

const BASE_CANVAS_NODE_CREATION_GROUPS: CanvasNodeCreationGroup[] = [
  {
    label: t("assetCanvas.group.assets"),
    items: [
      { label: t("assetCanvas.node.text"), description: t("assetCanvas.node.textHint"), icon: FileText, action: { kind: "node", type: "text" } },
      { label: t("assetCanvas.node.image"), description: t("assetCanvas.node.imageHint"), icon: ImageIcon, action: { kind: "node", type: "image" } },
      { label: t("assetCanvas.node.video"), description: t("assetCanvas.node.videoHint"), icon: Film, action: { kind: "node", type: "video" } },
      { label: t("assetCanvas.node.voice"), description: t("assetCanvas.node.voiceHint"), icon: Volume2, action: { kind: "node", type: "voice" } },
      { label: t("assetCanvas.node.speech"), description: t("assetCanvas.node.speechHint"), icon: Music2, action: { kind: "node", type: "speech" } },
      { label: t("assetCanvas.node.soundEffect"), description: t("assetCanvas.node.soundEffectHint"), icon: Volume2, action: { kind: "node", type: "sound-effect" } },
      { label: t("assetCanvas.node.music"), description: t("assetCanvas.node.musicHint"), icon: Music2, action: { kind: "node", type: "music" } },
      { label: t("assetCanvas.node.model3d"), description: t("assetCanvas.node.model3dHint"), icon: Box, action: { kind: "node", type: "model-3d" } },
      { label: t("assetCanvas.node.animate3d"), description: t("assetCanvas.node.animate3dHint"), icon: WandSparkles, action: { kind: "node", type: "animate-3d" } },
    ],
  },
];

function isCanvasNodeCreationLeaf(item: CanvasNodeCreationItem): item is CanvasNodeCreationLeaf {
  return "action" in item;
}

function canvasCreationGroups(documents: CanvasDocuments, tables: CanvasTables, audioOperations: ReadonlySet<AudioOperation>): CanvasNodeCreationGroup[] {
  const items: CanvasNodeCreationItem[] = [{ label: t("assetCanvas.node.document"), description: t("assetCanvas.node.markdown"), icon: FileText, action: { kind: "node", type: "document" } }];
  if (documents.documents.length) items.push({ label: t("assetCanvas.node.existingDocument"), description: t("assetCanvas.node.existingDocumentHint"), icon: FileText, children: documents.documents.map((document) => ({ label: document.title || t("canvasDocs.untitled"), description: t("assetCanvas.node.markdown"), icon: FileText, action: { kind: "node", type: "document", documentId: document.id } })) });
  items.push({ label: t("assetCanvas.node.table"), description: t("assetCanvas.node.tableHint"), icon: FileText, action: { kind: "node", type: "table" } });
  const existingTables = [...tables.storage.sessions.values()].filter((session) => !session.issue);
  if (existingTables.length) items.push({ label: t("assetCanvas.node.existingTable"), description: t("assetCanvas.node.existingTableHint"), icon: FileText, children: existingTables.map(({ local: table }) => ({ label: table.title || t("canvasTable.untitled"), description: t("assetCanvas.node.sharedTable"), icon: FileText, action: { kind: "node", type: "table", tableId: table.id } })) });
  const assetGroups = BASE_CANVAS_NODE_CREATION_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!isCanvasNodeCreationLeaf(item)) return true;
      return canvasNodeTypeAvailable(item.action.type, audioOperations);
    }),
  }));
  return [{ label: t("assetCanvas.group.documents"), items }, ...assetGroups];
}

type CanvasImageSettings = Omit<ImageGenerationSettings, "mask" | "markup"> & { mask?: AssetCanvasReference; markup?: AssetCanvasReference };
type AssetCanvasFlowData = CanvasImageSettings & {
  resizeRuntime?: CanvasNodeResizeRuntime;
  nodeDetails?: CanvasNodeDetails;
  panelOpen?: boolean;
  tableId?: string;
  tableRuntime?: TableNodeRuntime;
  /** Project-relative path of a file node. */
  path?: string;
  directory?: true;
  fileRuntime?: { onReveal?: () => void };
  documentId?: string;
  documentRuntime?: DocumentNodeRuntime;
  prompt?: string;
  promptSource?: AssetCanvasTextReference;
  text?: string;
  instruction?: string;
  textModel?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  model?: ImageModelRef;
  audioModel?: ModelRef;
  language?: string;
  style?: string;
  output?: import("../shared/audio.js").AudioOutputSettings;
  voiceId?: string;
  referenceAssetId?: string;
  referenceSha256?: string;
  voiceSourceNodeId?: string;
  voiceDescription?: string;
  sampleText?: string;
  selectedAssetId?: string;
  selectedSha256?: string;
  speed?: number;
  durationSeconds?: number;
  loop?: boolean;
  negativePrompt?: string;
  instrumental?: boolean;
  lyrics?: string;
  resolution?: ImageResolution;
  aspectRatio?: ImageAspectRatio;
  videoModel?: VideoModelRef;
  videoResolution?: VideoResolution;
  videoAspectRatio?: VideoAspectRatio;
  duration?: number;
  images?: AssetCanvasReference[];
  references?: AssetCanvasReference[];
  referenceMode?: "frame" | "reference";
  referenceMentions?: Record<string, AssetCanvasReference>;
  assetId?: string;
  mediaType?: "image" | "video" | "audio" | "model";
  model3DConfig?: Model3DGenerationConfig;
  heightMeters?: number;
  actionIds?: Model3DActionId[];
  animationModel?: ModelRef;
  model3DOperation?: Exclude<Model3DOperation, "animate">;
  model3DSource?: AssetCanvasReference;
  model3DOptions?: Model3DOptions;
  contentType?: string;
  assetDuration?: number;
  /** Width / height of the output media, known before it loads. */
  assetAspectRatio?: number;
  name?: string;
  assetOrigin?: "Project" | "Library";
  assetError?: string;
  imageRuntime?: ImageNodeRuntime;
  videoRuntime?: VideoNodeRuntime;
  audioRuntime?: AudioNodeRuntime;
  model3DRuntime?: Model3DNodeRuntime;
  animateRuntime?: Animate3DNodeRuntime;
  textRuntime?: TextNodeRuntime;
};
type AssetCanvasFlowNode = Node<AssetCanvasFlowData, AssetCanvasNodeType> & { title?: string; description?: string };

interface MediaNodeRuntime {
  generating: boolean;
  recovering?: boolean;
  generationStatus?: ToolJob["status"];
  busy: boolean;
  error?: string;
  notice?: string;
  onChange: (data: AssetCanvasFlowData, removedHandle?: string | string[]) => void;
  onGenerate: () => void;
  onCancel?: () => void;
  onRecover?: () => void;
  linkedPrompt?: string;
  onDisconnectPrompt?: () => void;
}

interface TextNodeRuntime extends CanvasNodeReferencesRuntime {
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  defaultModel?: AgentModelRef;
  defaultReasoningLevel?: AgentReasoningLevel;
  generating: boolean;
  busy: boolean;
  error?: string;
  onChange: (data: AssetCanvasFlowData) => void;
  onGenerate: (model: AgentModelRef, reasoningLevel: AgentReasoningLevel) => void;
}

interface ReferenceMediaNodeRuntime extends MediaNodeRuntime {
  references: MediaReferenceView[];
  maxReferences: number;
  uploading: boolean;
  accept: string;
  addLabel: string;
  /** Names each reference position (e.g. 3D views); the strip then shows every position as a labelled slot. */
  slotLabels?: readonly string[];
  showEmptySlots?: boolean;
  orderedViews?: boolean;
  onRemoveReference: (index: number) => void;
  /** Absent when references can only be connected, not uploaded. */
  onUploadReferences?: (files: File[], replaceAt?: number) => void;
  /** The Library images the + button offers next to Upload. */
  libraryImages?: LibraryAsset[];
  onReloadLibrary?: () => Promise<void>;
  onAddLibraryReference?: (asset: LibraryAsset, replaceAt?: number) => void;
}

type ReferenceStripRuntime = Omit<ReferenceMediaNodeRuntime, "generating" | "error" | "onChange" | "onGenerate" | "onCancel">;

interface ImageNodeRuntime extends ReferenceMediaNodeRuntime {
  models: ImageModel[];
  providers: MediaProviderStatus[];
  managed?: CanvasCharacterViewStatus;
  onViewOriginal?: () => void;
  onPrepareRevision?: () => void;
}

interface VideoNodeRuntime extends ReferenceMediaNodeRuntime {
  models: VideoModel[];
  providers: MediaProviderStatus[];
}

interface AudioNodeRuntime extends MediaNodeRuntime {
  models: AudioModel[];
  providers: AudioProviderCatalogStatus[];
  voiceReference?: ReferenceStripRuntime;
  referenceReady?: boolean;
  onSelectSample?: () => void;
  onUpdateVoice?: () => void;
}

interface Model3DNodeRuntime extends ReferenceMediaNodeRuntime {
  viewIssue?: string;
  sourceRuntime?: ReferenceStripRuntime;
  models: Model3DModel[];
  providers: MediaProviderStatus[];
  modelSelections?: KunpoModelSelections;
}

interface Animate3DNodeRuntime extends ReferenceMediaNodeRuntime {
  models: Model3DModel[];
}

interface MediaReferenceView {
  assetId?: string;
  contentType?: string;
  key: string;
  name: string;
  label: string;
  type: VideoGenerationReference["type"] | "model";
  duration?: number;
}

const STORY_NODE_TYPES: NodeTypes = {
  table: CanvasTableNode,
  document: CanvasDocumentNode,
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  speech: SpeechNode,
  voice: VoiceNode,
  "sound-effect": SoundEffectNode,
  music: MusicNode,
  "model-3d": Model3DNode,
  "animate-3d": Animate3DNode,
  asset: AssetNode,
  file: FileNode,
};

export function CanvasBoardEditor({ project, initialNodeId, onInitialNodeHandled, hidden = false, storage, documents, tables, assets: localAssets, conflicted = false, overlay, onSaveReady, onSyncReady, onResolveReady, onStatusChange, onSelectionChange, expandedDocument, onAskAgent }: {
  project: ProjectState;
  initialNodeId?: string;
  onInitialNodeHandled?: () => void;
  hidden?: boolean;
  storage: CanvasBoardStorage;
  documents: CanvasDocuments;
  tables: CanvasTables;
  assets: CanvasAssetCatalogEntry[];
  conflicted?: boolean;
  overlay?: ReactNode;
  onSaveReady?: (save: (() => Promise<void>) | undefined) => void;
  onSyncReady?: (sync: (() => Promise<void>) | undefined) => void;
  onResolveReady?: (resolve: ((version: "local" | "remote") => Promise<void>) | undefined) => void;
  onStatusChange?: (status: "loading" | "saved" | "saving" | "error" | "sync-error" | "load-error") => void;
  onSelectionChange?: (nodes: AssetCanvasNode[]) => void;
  onAskAgent?: (text: string) => void;
  expandedDocument?: { id: string; nodeId?: string; busy?: boolean; onClose(): void };
}) {
  const projectId = project.id;
  const [writeVersion] = useState(() => workspaceVersion(projectId));
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<{ kind: "save" | "action"; message: string }>();
  const [loadError, setLoadError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const closing = useDesktopClosing();
  const syncFailed = useRef(false);
  const saveFailed = useRef(false);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [transferError, setTransferError] = useState<string>();
  // The canvas file format still requires a viewport; nothing in Asset Canvas uses it, so it is only carried through saves.
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [nodes, setNodes] = useState<AssetCanvasFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [editorLayout, setEditorLayout] = useState<AssetCanvasEditorLayout>({
    version: 1,
    nodes: {},
    viewport: { x: 64, y: 32, zoom: 1 },
    view: "canvas",
  });
  const finishInitialFit = useCallback((viewport: AssetCanvasEditorLayout["viewport"]) => {
    setEditorLayout(({ fitView: _fitView, ...current }) => ({ ...current, viewport }));
  }, []);
  const [selectedAssetEdgeId, setSelectedAssetEdgeId] = useState<string>();
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenuState>();
  const [expandedTextId, setExpandedTextId] = useState<string>();
  // A marquee arranges nodes; explicitly activating a node opens its panel.
  const [marqueeActive, setMarqueeActive] = useState(false);
  const [marqueeSelectedIds, setMarqueeSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [copiedSelection, setCopiedSelection] = useState(lastCanvasClipboard);
  const canvasElement = useRef<HTMLDivElement>(null);
  const flowInstance = useRef<ReactFlowInstance<AssetCanvasFlowNode, Edge>>(null);
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const pasteSequence = useRef({ text: "", count: 0 });
  const dragDepth = useRef(0);
  const [fileDropActive, setFileDropActive] = useState(false);
  const pendingImport = useRef<Promise<void> | undefined>(undefined);
  const [globalAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const reloadLibraryAssets = async () => {
    const assets = await loadLibraryAssets();
    if (mounted.current) setLibraryAssets(assets);
  };
  const libraryAssets = useMemo<LibraryAsset[]>(() => {
    const assets = new Map(globalAssets.map((asset) => [asset.id, asset]));
    for (const asset of localAssets) assets.set(asset.id, { ...assets.get(asset.libraryAssetId ?? asset.id), ...asset, assetId: asset.id });
    return [...assets.values()];
  }, [globalAssets, localAssets]);
  const assetPaths = useCanvasAssetSources();
  const [nodeDetails, setNodeDetails] = useState<{ id: string; title: string; description: string; job?: ToolJob }>();
  const libraryImages = useMemo(() => libraryAssets.filter((asset) => asset.mediaType === "image"), [libraryAssets]);
  const staticImageReferences = useMemo(() => libraryImages.filter(asset => ["image/png", "image/jpeg", "image/webp"].includes(asset.contentType)), [libraryImages]);

  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [globalDefaultImageModel, setDefaultImageModel] = useState<ImageModelRef>();
  const [videoModels, setVideoModels] = useState<VideoModel[]>([]);
  const [imageProviders, setImageProviders] = useState<MediaProviderStatus[]>([]);
  const [videoProviders, setVideoProviders] = useState<MediaProviderStatus[]>([]);
  const [audioModels, setAudioModels] = useState<AudioModel[]>([]);
  const audioOperations = useMemo(() => availableAudioOperations(audioModels), [audioModels]);
  const [audioProviders, setAudioProviders] = useState<AudioProviderCatalogStatus[]>([]);
  const [globalDefaultVideoModel, setDefaultVideoModel] = useState<ModelRef>();
  const [model3DModels, setModel3DModels] = useState<Model3DModel[]>([]);
  const [model3DProviders, setModel3DProviders] = useState<MediaProviderStatus[]>([]);
  const [globalDefaultModel3D, setDefaultModel3D] = useState<ModelRef>();
  const defaultImageModel = project.modelSelections?.image ?? project.mediaModelDefaults?.image ?? globalDefaultImageModel;
  const defaultVideoModel = project.modelSelections?.video ?? project.mediaModelDefaults?.video ?? globalDefaultVideoModel;
  const defaultModel3D = project.modelSelections?.["3d-generation"] ?? project.mediaModelDefaults?.["3d"] ?? globalDefaultModel3D;
  const [operationModels3D, setOperationModels3D] = useState<Model3DModel[]>([]);
  const textModelCatalog = useAgentModels();
  const defaultTextModel = project.modelSelections?.agent ?? textModelCatalog.defaultModel ?? textModelCatalog.models[0];
  const [canvasJobs, setCanvasJobs] = useState<Record<string, ToolJob>>({});
  const [characterViews, setCharacterViews] = useState<Record<string, CanvasCharacterViewStatus>>({});
  const [revealNodeIds, setRevealNodeIds] = useState<string[]>([]);
  const canvasJobsRef = useRef(canvasJobs); canvasJobsRef.current = canvasJobs;
  const [mediaConfirmation, setMediaConfirmation] = useState<{ nodeId: string; jobId: string }>();
  const mediaConfirmationRef = useRef<typeof mediaConfirmation>(undefined);
  // The last settings picked per node type, so a new node starts where the user left off.
  const rememberedSettings = useRef<RememberedSettings>({});
  const [viewedAsset, setViewedAsset] = useState<ViewableCanvasAsset>();
  const [sentAsset, setSentAsset] = useState<{ assetId: string; name: string }>();
  const [startingCanvasNodes, setStartingCanvasNodes] = useState<Set<string>>(() => new Set());
  const startingCanvasNodesRef = useRef(new Set<string>());
  const hydratedJobRuns = useRef(new Set<string>());
  const [generatingTextNodeId, setGeneratingTextNodeId] = useState<string>();
  const [uploadingNodeId, setUploadingNodeId] = useState<string>();
  const speechReferenceUpload = useRef(false);
  const [importingAssets, setImportingAssets] = useState(false);
  const [folderPrompt, setFolderPrompt] = useState<{ folders: DroppedFolder[]; answer: (choice: "folder" | "files" | undefined) => void }>();
  const [generationError, setGenerationError] = useState<{ nodeId: string; message: string }>();
  const latestCanvas = useRef<AssetCanvasDocument | undefined>(undefined);
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const queuedCanvas = useRef<string | undefined>(undefined);
  // Apply each result before the next operation reads the live canvas.
  const operationChain = useRef(Promise.resolve());
  // A failed background read must not turn an already successful save into a failure.
  const lastSave = useRef(Promise.resolve());
  const initialNodeRequest = useRef({ nodeId: initialNodeId, onHandled: onInitialNodeHandled });
  const editorUndoHistory = useRef<AssetCanvasDocument[]>([]);
  const editorRedoHistory = useRef<AssetCanvasDocument[]>([]);
  const historyObserved = useRef<AssetCanvasDocument | undefined>(undefined);
  const historyObservedJson = useRef<string | undefined>(undefined);
  const historyPendingBase = useRef<AssetCanvasDocument | undefined>(undefined);
  const historyTimer = useRef<number | undefined>(undefined);
  const historyGestureBase = useRef<AssetCanvasDocument | undefined>(undefined);
  const altDragCopies = useRef<ReadonlyMap<string, string> | undefined>(undefined);
  const [, setHistoryRevision] = useState(0);
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedNodeIdsJson = JSON.stringify(selectedNodes.map((node) => node.id));
  const selection = JSON.stringify(selectedNodes.map((node) => toAssetCanvasNode(node, model3DModels)));
  useEffect(() => { onSelectionChange?.(JSON.parse(selection) as AssetCanvasNode[]); }, [selection, onSelectionChange]);

  useEffect(() => {
    let disposed = false;
    setPhase("loading");
    setLoadError(undefined);
    onStatusChange?.("loading");
    resetHistory();
    setCanvasContextMenu(undefined);
    mediaConfirmationRef.current = undefined; setMediaConfirmation(undefined);
    const emptyCatalog = { models: [], providers: [], defaultModel: undefined };
    void Promise.all([storage.load(), loadLibraryAssets().catch(() => []), listImageModelCatalog().catch(() => emptyCatalog), listVideoModelCatalog().catch(() => emptyCatalog), listModel3DCatalog().catch(() => emptyCatalog), listModel3DOperations().catch(() => [])]).then(([story, assets, imageCatalog, videoCatalog, model3DCatalog, operationModels]) => {
      const models = imageCatalog.models;
      const loadedVideoModels = videoCatalog.models;
      if (disposed) return;
      setViewport(story.viewport);
      const loadedNodes = story.nodes.map((node) => toFlowNode(node, models, loadedVideoModels));
      const request = initialNodeRequest.current;
      initialNodeRequest.current = { nodeId: undefined, onHandled: undefined };
      const initialNode = request.nodeId ? loadedNodes.find((node) => node.id === request.nodeId) : undefined;
      setNodes(loadedNodes.map((node) => ({ ...node, selected: node.id === initialNode?.id })));
      if (request.nodeId) {
        request.onHandled?.();
      }
      setEditorLayout(story.editorLayout);
      setEdges(story.edges);
      queuedCanvas.current = undefined;
      lastSave.current = Promise.resolve();
      syncFailed.current = false;
      saveFailed.current = false;
      setLibraryAssets(assets);
      setImageModels(models);
      setDefaultImageModel(imageCatalog.defaultModel);
      setVideoModels(loadedVideoModels);
      setImageProviders(imageCatalog.providers);
      setVideoProviders(videoCatalog.providers);
      setDefaultVideoModel(videoCatalog.defaultModel);
      setModel3DModels(model3DCatalog.models);
      setOperationModels3D(operationModels);
      setModel3DProviders(model3DCatalog.providers);
      setDefaultModel3D(model3DCatalog.defaultModel);
      // Audio models are not needed for the first render, so fetching them must not delay the board.
      void listAudioModelCatalog().then((audioCatalog) => {
        if (disposed) return;
        setAudioModels(audioCatalog.models);
        setAudioProviders(audioCatalog.providers);
      }).catch(() => undefined);
      setNotice(undefined);
      setPhase("ready");
      onStatusChange?.("saved");
    }).catch((error) => {
      if (disposed) return;
      setLoadError(errorMessage(error));
      setPhase("error");
      onStatusChange?.("load-error");
    });
    return () => { disposed = true; };
  }, [projectId, storage, loadAttempt]);

  useEffect(() => {
    if (closing) return;
    let active = true;
    let revision = 0;
    let model3DRevision = 0;
    const refresh3D = () => {
      const current = ++model3DRevision;
      void listModel3DCatalog().then((catalog) => {
        if (!active || current !== model3DRevision) return;
        setModel3DModels(catalog.models.filter((model) => !model.provider.startsWith("cloud-"))); setModel3DProviders(catalog.providers.filter((provider) => !provider.cloud && !provider.provider.startsWith("cloud-"))); setDefaultModel3D(catalog.defaultModel);
      }).catch(() => undefined);
    };
    const refresh = () => {
      const current = ++revision;
      void listImageModelCatalog().then((catalog) => {
        if (!active || current !== revision) return;
        setImageModels(catalog.models);
        setDefaultImageModel(catalog.defaultModel);
        setImageProviders(catalog.providers);
      }).catch(() => undefined);
      void listVideoModelCatalog().then((catalog) => {
        if (!active || current !== revision) return;
        setVideoModels(catalog.models); setVideoProviders(catalog.providers); setDefaultVideoModel(catalog.defaultModel);
      }).catch(() => undefined);
      void listAudioModelCatalog().then((catalog) => {
        if (!active || current !== revision) return;
        setAudioModels(catalog.models); setAudioProviders(catalog.providers);
      }).catch(() => undefined);
      void listModel3DOperations().then((models) => {
        if (active && current === revision) setOperationModels3D(models);
      }).catch(() => undefined);
      refresh3D();
    };
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    return () => { active = false; window.removeEventListener(MODELS_CHANGED_EVENT, refresh); };
  }, [projectId, closing]);

  useEffect(() => {
    if (phase !== "ready" || closing) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const storage = storageRef.current;
        const snapshot = project.type === "web-game" && storage.boardJobs ? await storage.boardJobs() : undefined;
        const jobs = snapshot?.jobs ?? await storage.jobs();
        if (stopped) return;
        if (snapshot) setCharacterViews(Object.fromEntries(snapshot.characterViews.map(view => [view.nodeId, view])));
        const latestJobs = new Map<string, ToolJob>();
        for (const job of jobs) {
          const nodeId = job.context?.nodeId;
          if (nodeId && !latestJobs.has(nodeId)) latestJobs.set(nodeId, job);
        }
        setCanvasJobs(Object.fromEntries(latestJobs));
        const completedAssetIds: string[] = [];
        let completedCover: AssetCanvasCoverSource | undefined;
        // Jobs arrive newest first; the daemon persists outputs to the current board.
        for (const job of latestJobs.values()) {
          const nodeId = job.context?.nodeId;
          const file = job.run?.files[0];
          if (job.status !== "succeeded" || !nodeId || !file?.assetId || hydratedJobRuns.current.has(job.id)) continue;
          hydratedJobRuns.current.add(job.id);
          completedAssetIds.push(file.assetId);
          if (!completedCover) {
            const mediaType = file.mediaType.startsWith("image/") ? "image" : file.mediaType.startsWith("video/") ? "video" : undefined;
            if (mediaType) completedCover = { assetId: file.assetId, mediaType };
          }
        }
        if (completedAssetIds.length) {
          const assets = await loadLibraryAssets();
          if (completedCover && !stopped && project.type === "asset-canvas") {
            try {
              if ((await getProjectCoverState(projectId)).mode === "auto") {
                const cover = await projectCoverBlob(completedCover, assets);
                if (!stopped && cover) await setProjectCover(projectId, cover, "auto");
              }
            } catch { /* Cover generation is best-effort. */ }
          }
          if (!stopped) setLibraryAssets(assets);
        }
      } catch { /* Job polling is best-effort; the node keeps its last state. */ }
      if (!stopped) timer = window.setTimeout(poll, 1_500);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [phase, projectId, project.type, closing]);

  const document = useMemo(
    () => assetCanvasDocument(viewport, nodes, edges, {
      ...editorLayout,
      nodes: {
        ...Object.fromEntries(nodes.map((node) => [node.id, canvasNodeLayout(node)])),
      },
      view: "canvas",
    }, model3DModels),
    [edges, editorLayout, nodes, viewport, model3DModels],
  );
  latestCanvas.current = document;

  useEffect(() => {
    if (project.type !== "asset-canvas" || phase !== "ready" || !document || libraryAssets.length === 0) return;
    let disposed = false;
    void (async () => {
      const source = findAssetCanvasCoverSource(document);
      if (!source || await getProjectCover(projectId)) return;
      const cover = await projectCoverBlob(source, libraryAssets, assetBlob);
      if (!disposed && cover && !(await getProjectCover(projectId))) await setProjectCover(projectId, cover, "auto");
    })().catch(() => {});
    return () => { disposed = true; };
  }, [document, libraryAssets, phase, projectId, project.type]);

  function updateHistoryControls(): void {
    setHistoryRevision((revision) => revision + 1);
  }

  // Whole-board snapshots must not restore a version from before an external edit.
  function resetHistory(): void {
    window.clearTimeout(historyTimer.current);
    editorUndoHistory.current = [];
    editorRedoHistory.current = [];
    historyObserved.current = undefined;
    historyObservedJson.current = undefined;
    historyPendingBase.current = undefined;
    historyGestureBase.current = undefined;
  }

  function pushUndoSnapshot(snapshot: AssetCanvasDocument): void {
    editorUndoHistory.current.push(structuredClone(snapshot));
    if (editorUndoHistory.current.length > 50) editorUndoHistory.current.shift();
  }

  function commitPendingHistory(): void {
    window.clearTimeout(historyTimer.current);
    historyTimer.current = undefined;
    const pending = historyPendingBase.current;
    if (!pending) return;
    pushUndoSnapshot(pending);
    historyPendingBase.current = undefined;
    updateHistoryControls();
  }

  function observeHistoryDocument(next: AssetCanvasDocument): void {
    historyObserved.current = structuredClone(next);
    historyObservedJson.current = canvasHistoryKey(next);
  }

  function undoEditorChange(): boolean {
    if (!document) return false;
    window.clearTimeout(historyTimer.current);
    historyTimer.current = undefined;
    const pending = historyPendingBase.current;
    const next = pending ?? editorUndoHistory.current.pop();
    if (!next) return false;
    historyPendingBase.current = undefined;
    editorRedoHistory.current.push(structuredClone(document));
    observeHistoryDocument(next);
    applyEditorCanvas(next);
    updateHistoryControls();
    return true;
  }

  function redoEditorChange(): boolean {
    if (!document || historyPendingBase.current) return false;
    const next = editorRedoHistory.current.pop();
    if (!next) return false;
    pushUndoSnapshot(document);
    observeHistoryDocument(next);
    applyEditorCanvas(next);
    updateHistoryControls();
    return true;
  }

  function beginHistoryGesture(): void {
    if (!document) return;
    commitPendingHistory();
    historyGestureBase.current = structuredClone(document);
  }

  function finishHistoryGesture(): void {
    window.setTimeout(() => {
      const base = historyGestureBase.current;
      const current = latestCanvas.current;
      historyGestureBase.current = undefined;
      if (!base || !current || canvasHistoryKey(base) === canvasHistoryKey(current)) return;
      pushUndoSnapshot(base);
      editorRedoHistory.current = [];
      observeHistoryDocument(current);
      updateHistoryControls();
    }, 0);
  }

  useEffect(() => {
    if (phase !== "ready" || !document) return;
    const serialized = canvasHistoryKey(document);
    if (!historyObserved.current || historyObservedJson.current === undefined) {
      observeHistoryDocument(document);
      updateHistoryControls();
      return;
    }
    if (serialized === historyObservedJson.current) return;
    if (historyGestureBase.current) {
      observeHistoryDocument(document);
      return;
    }
    if (!historyPendingBase.current) historyPendingBase.current = structuredClone(historyObserved.current);
    editorRedoHistory.current = [];
    observeHistoryDocument(document);
    window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(commitPendingHistory, 450);
    updateHistoryControls();
  }, [document, phase]);

  useEffect(() => () => window.clearTimeout(historyTimer.current), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || isTextEntry(event.target) || eventWithin(event, ".nokey") || !canvasElement.current?.contains(event.target as globalThis.Node)) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const selected = nodes.filter((node) => node.selected).map((node) => toAssetCanvasNode(node, model3DModels));
        if (selected.length) pasteSelection(createCanvasClipboard(projectId, selected, document.edges), { x: Math.min(...selected.map((node) => node.position.x)) + 40, y: Math.min(...selected.map((node) => node.position.y)) + 40 });
        return;
      }
      const step = undoShortcut(event);
      if (!step) return;
      event.preventDefault();
      if (historyGestureBase.current) return;
      if (step === "redo") redoEditorChange();
      else undoEditorChange();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [document, model3DModels]);
  const assetEdges = useMemo(() => nodes.flatMap((node): Edge[] => {
    const derived: Edge[] = [];
    if (node.type === "speech" && node.data.voiceSourceNodeId) derived.push({ id: assetEdgeId("reference", node.id, node.data.voiceSourceNodeId), source: node.data.voiceSourceNodeId, target: node.id, sourceHandle: OUTPUT_HANDLE, selected: selectedAssetEdgeId === assetEdgeId("reference", node.id, node.data.voiceSourceNodeId), data: { relation: "voice-reference", referenceId: node.data.voiceSourceNodeId } });
    if (node.type === "image" || node.type === "model-3d" || node.type === "animate-3d") derived.push(...(node.data.images ?? []).flatMap((image) => image.type === "node" ? [{
      id: assetEdgeId("image", node.id, image.nodeId),
      source: image.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      selected: selectedAssetEdgeId === assetEdgeId("image", node.id, image.nodeId),
      data: { relation: "media-image", referenceId: image.nodeId },
    }] : []));
    if (node.type === "model-3d" && node.data.model3DSource?.type === "node") derived.push({
      id: assetEdgeId("model", node.id, node.data.model3DSource.nodeId), source: node.data.model3DSource.nodeId, target: node.id,
      sourceHandle: OUTPUT_HANDLE, selected: selectedAssetEdgeId === assetEdgeId("model", node.id, node.data.model3DSource.nodeId),
      data: { relation: "media-model", referenceId: node.data.model3DSource.nodeId },
    });
    if (node.type === "video" || node.type === "text" || node.type === "document") derived.push(...(node.data.references ?? []).flatMap((reference) => reference.type === "node" ? [{
      id: assetEdgeId("reference", node.id, reference.nodeId),
      source: reference.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      ...((node.type === "text" || node.type === "document") ? { targetHandle: "references" } : {}),
      selected: selectedAssetEdgeId === assetEdgeId("reference", node.id, reference.nodeId),
      data: { relation: node.type === "video" ? "video-reference" : "text-reference", referenceId: reference.nodeId },
    }] : []));
    if ((node.type === "image" || node.type === "video" || node.type === "model-3d" || node.type === "speech" || node.type === "voice" || node.type === "sound-effect" || node.type === "music") && node.data.promptSource) derived.push({
      id: assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      source: node.data.promptSource.nodeId,
      target: node.id,
      sourceHandle: OUTPUT_HANDLE,
      selected: selectedAssetEdgeId === assetEdgeId("prompt", node.id, node.data.promptSource.nodeId),
      data: { relation: "media-prompt", referenceId: node.data.promptSource.nodeId },
    });
    return derived;
  }), [nodes, selectedAssetEdgeId]);

  const save = useCallback((story: AssetCanvasDocument): Promise<void> => {
    if (resolvingRef.current) return operationChain.current;
    const serialized = JSON.stringify(story);
    if (serialized === queuedCanvas.current) return lastSave.current;
    queuedCanvas.current = serialized;
    onStatusChange?.("saving");
    const operation = operationChain.current
      .catch(() => undefined)
      .then(async () => {
        const submitted = latestCanvas.current ?? story;
        const saved = await storage.save(submitted);
        if (mounted.current) reconcileCanvas(submitted, saved);
      });
    operationChain.current = operation;
    lastSave.current = operation;
    void operation.then(
      () => { if (mounted.current) { saveFailed.current = false; setNotice((current) => current?.kind === "save" ? undefined : current); onStatusChange?.(syncFailed.current ? "sync-error" : "saved"); } },
      (error) => {
        if (!mounted.current) return;
        saveFailed.current = true;
        if (queuedCanvas.current === serialized) queuedCanvas.current = undefined;
        setNotice({ kind: "save", message: t("assetCanvas.saveFailedDetail", { error: errorMessage(error) }) });
        onStatusChange?.("error");
      },
    );
    return operation;
  }, [storage, onStatusChange]);

  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  useEffect(() => {
    const selected = new Set<string>(JSON.parse(selectedNodeIdsJson));
    setMarqueeSelectedIds((current) => {
      if (!current.size) return current;
      const next = new Set([...current].filter((id) => selected.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [selectedNodeIdsJson]);
  const imageModelsRef = useRef(imageModels); imageModelsRef.current = imageModels;
  const videoModelsRef = useRef(videoModels); videoModelsRef.current = videoModels;
  function reconcileCanvas(submitted: AssetCanvasDocument, saved: AssetCanvasDocument) {
    const current = latestCanvas.current ?? submitted;
    const merged = storage.reconcile(submitted, current, saved);
    if (JSON.stringify(current) === JSON.stringify(merged)) return;
    if (canvasHistoryKey(current) !== canvasHistoryKey(merged)) resetHistory();
    if (historyGestureBase.current) historyGestureBase.current = mergeCanvasDocument(submitted, historyGestureBase.current, saved);
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    const addedMedia = merged.nodes.filter(node => !previous.has(node.id) && ["image", "video", "model-3d", "animate-3d", "voice", "speech", "sound-effect", "music", "asset"].includes(node.type));
    if (addedMedia.length) setRevealNodeIds(addedMedia.map(node => node.id));
    latestCanvas.current = merged;
    observeHistoryDocument(merged);
    setNodes(merged.nodes.map((node) => ({ ...toFlowNode(node, imageModelsRef.current, videoModelsRef.current, previous.get(node.id)), selected: previous.get(node.id)?.selected === true })));
    setEdges(merged.edges); setViewport(merged.viewport); setEditorLayout(merged.editorLayout);
    updateHistoryControls();
  }
  const flush = useCallback(async () => {
    await pendingImport.current;
    await operationChain.current.catch(() => {});
    // A close can precede React Flow's delayed onMoveEnd callback.
    const current = latestCanvas.current;
    const viewport = flowInstance.current?.getViewport();
    if (current && viewport && phase === "ready") {
      const editorLayout = { ...current.editorLayout, viewport };
      latestCanvas.current = { ...current, editorLayout };
      setEditorLayout(editorLayout);
    }
    while (latestCanvas.current && phase === "ready") {
      const submitted = latestCanvas.current;
      await save(submitted);
      if (JSON.stringify(latestCanvas.current) === JSON.stringify(submitted)) break;
    }
  }, [save, phase]);
  useEffect(() => { onSaveReady?.(flush); return () => onSaveReady?.(undefined); }, [onSaveReady, flush]);
  const resolveConflict = useCallback(async (version: "local" | "remote") => {
    resolvingRef.current = true;
    setResolving(true);
    try {
      await operationChain.current.catch(() => {});
      const submitted = latestCanvas.current;
      if (!submitted) return;
      const operation = storage.resolveConflict(version, submitted);
      operationChain.current = operation.then(() => {}, () => {});
      const selected = await operation;
      if (version === "local") reconcileCanvas(submitted, selected);
      else {
        resetHistory();
        latestCanvas.current = selected; observeHistoryDocument(selected); applyEditorCanvas(selected); updateHistoryControls();
      }
      queuedCanvas.current = JSON.stringify(selected);
      lastSave.current = Promise.resolve();
      saveFailed.current = false;
      syncFailed.current = false;
      setNotice(undefined);
      onStatusChange?.("saved");
    } finally { resolvingRef.current = false; setResolving(false); }
  }, [storage, onStatusChange]);
  useEffect(() => { onResolveReady?.(phase === "ready" ? resolveConflict : undefined); return () => onResolveReady?.(undefined); }, [onResolveReady, resolveConflict, phase]);
  const sync = useCallback(() => {
    if (resolvingRef.current || isDesktopClosing()) return Promise.resolve();
    const operation = operationChain.current.catch(() => {}).then(async () => {
      if (!mounted.current || !latestCanvas.current || isDesktopClosing()) return;
      const submitted = latestCanvas.current;
      const wasSaved = queuedCanvas.current === JSON.stringify(submitted);
      const refreshed = await storage.refresh(submitted);
      if (!mounted.current) return;
      if (refreshed) {
        queuedCanvas.current = wasSaved ? JSON.stringify(refreshed) : undefined;
        reconcileCanvas(submitted, refreshed);
      }
      syncFailed.current = false;
      if (saveFailed.current) onStatusChange?.("error");
      else if (queuedCanvas.current === JSON.stringify(latestCanvas.current)) onStatusChange?.("saved");
    });
    operationChain.current = operation;
    void operation.catch(() => {
      if (!mounted.current || isDesktopClosing()) return;
      syncFailed.current = true;
      if (!saveFailed.current) onStatusChange?.("sync-error");
    });
    return operation;
  }, [storage, onStatusChange]);
  useEffect(() => { onSyncReady?.(sync); return () => onSyncReady?.(undefined); }, [onSyncReady, sync]);
  useEffect(() => {
    if (phase !== "ready" || conflicted || resolving || closing) return;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void sync().catch(() => {}).finally(() => { pending = false; });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [sync, phase, conflicted, resolving, closing]);

  useEffect(() => {
    if (phase !== "ready" || !document || resolving || closing) return;
    const timeout = window.setTimeout(() => { if (!isDesktopClosing()) void save(document).catch(() => {}); }, 350);
    return () => window.clearTimeout(timeout);
  }, [document, phase, save, resolving, closing]);

  useEffect(() => () => {
    const story = latestCanvas.current;
    if (story && phase === "ready") void save(story).catch(() => {});
  }, [save, phase]);

  const onNodesChange = useCallback((changes: NodeChange<AssetCanvasFlowNode>[]) => {
    const copies = altDragCopies.current;
    const moves = copies ? changes.flatMap<NodeChange<AssetCanvasFlowNode>>((change) => {
      if (change.type !== "position") return [change];
      const id = copies.get(change.id);
      return id ? [{ ...change, id }] : [];
    }) : changes;
    const removed = new Set(moves.filter((change) => change.type === "remove").map((change) => change.id));
    setNodes((current) => applyNodeChanges(moves, current).map((node) => node.type === "video" && (node.data.references ?? []).some((reference) => reference.type === "node" && removed.has(reference.nodeId))
      ? { ...node, data: compatibleVideoDraft({ ...node.data, references: node.data.references!.filter((reference) => reference.type !== "node" || !removed.has(reference.nodeId)) }, videoModels) } : node));
  }, [videoModels]);
  function onEdgesChange(changes: EdgeChange[]): void {
    const assetEdgeIds = new Set(assetEdges.map((edge) => edge.id));
    for (const change of changes) {
      if (change.type === "add") continue;
      if (!assetEdgeIds.has(change.id)) continue;
      if (change.type === "select") setSelectedAssetEdgeId(change.selected ? change.id : undefined);
      if (change.type === "remove") {
        const edge = assetEdges.find((candidate) => candidate.id === change.id);
        const relation = edge?.data?.relation;
        const referenceId = edge?.data?.referenceId;
        if (edge && typeof referenceId === "string") setNodes((current) => current.map((node) => {
          if (relation === "media-image" && node.id === edge.target && (node.type === "image" || node.type === "model-3d" || node.type === "animate-3d")) {
            return { ...node, data: { ...node.data, images: (node.data.images ?? []).filter((image) => image.type !== "node" || image.nodeId !== referenceId) } };
          }
          if (node.id === edge.target && ((relation === "video-reference" && node.type === "video") || (relation === "text-reference" && (node.type === "text" || node.type === "document")))) {
            const data = { ...node.data, references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || reference.nodeId !== referenceId) };
            return { ...node, data: node.type === "video" ? compatibleVideoDraft(data, videoModels) : data };
          }
          if (relation === "voice-reference" && node.id === edge.target && node.type === "speech") return { ...node, data: { ...node.data, voiceSourceNodeId: undefined } };
          if (relation === "media-model" && node.id === edge.target && node.type === "model-3d") return { ...node, data: { ...node.data, model3DSource: undefined } };
          if (relation === "media-prompt" && node.id === edge.target && (node.type === "image" || node.type === "video" || node.type === "model-3d" || node.type === "speech" || node.type === "voice" || node.type === "sound-effect" || node.type === "music")) {
            return { ...node, data: { ...node.data, promptSource: undefined } };
          }
          return node;
        }));
        setSelectedAssetEdgeId(undefined);
      }
    }
    const storyChanges = changes.filter((change) => change.type === "add" || (!assetEdgeIds.has(change.id) && !change.id.startsWith("reference:")));
    if (storyChanges.length) setEdges((current) => applyEdgeChanges(storyChanges, current));
  }

  async function onConnect(connection: Connection): Promise<void> {
    if (!connection.source || !connection.target) return;
    const target = nodes.find((node) => node.id === connection.target);
    const source = nodes.find((node) => node.id === connection.source);
    if (!source || !target) return;
    const relation = connectionRelation(source, target, connection.sourceHandle, nodes, libraryAssets, imageModels, model3DModels);
    if (relation === "voice-reference" && target.type === "speech" && source.type === "asset") {
      const asset = libraryAssets.find((item) => item.id === source.data.assetId);
      if (asset) await selectSpeechReference(target, asset, source.id);
      return;
    }
    if (relation === "voice-reference" && target.type === "speech" && source.type === "voice") {
      await selectVoiceSample(source, target);
      return;
    }
    if (relation === "image-reference" && (target.type === "image" || target.type === "model-3d")) {
      setNodes((current) => current.map((node) => node.id === target.id && (node.type === "image" || node.type === "model-3d")
        ? { ...node, data: { ...node.data, images: [...(node.data.images ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (relation === "model-reference" && target.type === "model-3d") {
      setNodes((current) => current.map((node) => node.id === target.id ? { ...node, data: { ...node.data, model3DSource: { type: "node", nodeId: source.id } } } : node));
      return;
    }
    if (relation === "model-reference" && target.type === "animate-3d") {
      // An Animate node rigs one model, so a new connection replaces the previous one.
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, assetId: undefined, images: [{ type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if ((relation === "video-reference" && target.type === "video") || (relation === "text-reference" && (target.type === "text" || target.type === "document"))) {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: node.type === "video" ? compatibleVideoDraft({ ...node.data, references: [...(node.data.references ?? []), { type: "node", nodeId: source.id }] }, videoModels) : { ...node.data, references: [...(node.data.references ?? []), { type: "node", nodeId: source.id }] } }
        : node));
      return;
    }
    if (relation === "prompt" && (target.type === "image" || target.type === "video" || target.type === "model-3d" || target.type === "speech" || target.type === "sound-effect" || target.type === "music")) {
      setNodes((current) => current.map((node) => node.id === target.id
        ? { ...node, data: { ...node.data, promptSource: { type: "node", nodeId: source.id } } }
        : node));
      return;
    }
  }

  const contextMenuNode = canvasContextMenu?.kind === "node" ? nodes.find((node) => node.id === canvasContextMenu.nodeId) : undefined;
  const contextMenuNodeMissing = canvasContextMenu?.kind === "node" && !contextMenuNode;
  const canInsertCopiedNode = Boolean(copiedSelection);
  const canUndo = Boolean(historyPendingBase.current || editorUndoHistory.current.length);
  const canRedo = !historyPendingBase.current && editorRedoHistory.current.length > 0;

  function addNode(type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, existingResourceId?: string): void {
    if (type === "document" || type === "table") {
      void (existingResourceId ? Promise.resolve(existingResourceId) : type === "document" ? documents.add() : tables.add()).then((id) => {
        if (!id || !mounted.current) return;
        setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), { id: crypto.randomUUID(), type, position, selected: true, data: type === "document" ? { documentId: id } : { tableId: id } }]);
      }).catch((cause) => setNotice({ kind: "action", message: errorMessage(cause) }));
      return;
    }
    const created = createFlowNode(type, position, imageModels, videoModels, defaultTextModel);
    const node = { ...applyRememberedSettings(created, rememberedSettings.current[type], { imageModels, defaultImageModel, videoModels, defaultVideoModel, audioModels, model3DModels, defaultModel3D, textModels: textModelCatalog.models, modelSelections: project.modelSelections }), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
  }

  function addAssetNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration">, position: { x: number; y: number }): void {
    if (asset.mediaType !== "image" && asset.mediaType !== "video" && asset.mediaType !== "audio" && asset.mediaType !== "model") return;
    const node = assetFlowNode(asset, position);
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), node]);
  }

  function assetFlowNode(asset: Pick<LibraryAsset, "id" | "name" | "mediaType" | "contentType" | "duration">, position: { x: number; y: number }): AssetCanvasFlowNode {
    return {
      id: crypto.randomUUID(),
      type: "asset",
      position,
      selected: true,
      deletable: true,
      data: { assetId: asset.id, mediaType: asset.mediaType, contentType: asset.contentType, assetDuration: asset.duration, name: asset.name },
    };
  }

  async function uploadAssetFile(file: File, mediaType: LibraryUploadMediaType): Promise<LibraryAsset> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("assetCanvas.uploadSize"));
    const kind = mediaType.startsWith("video/") ? "video" : mediaType.startsWith("audio/") ? "audio" : undefined;
    const duration = kind ? await readMediaFileDuration(file, kind) : undefined;
    const uploaded = await uploadLibraryAsset(file, mediaType, duration, undefined, undefined, projectId);
    const asset: LibraryAsset = { ...uploaded, assetId: uploaded.id, path: uploaded.name };
    setLibraryAssets((current) => [asset, ...current]);
    return asset;
  }

  /** Copies a file that is not a document, table or media asset into the project; returns its project path. */
  async function importProjectFile(file: File, directory?: string): Promise<string> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("assetCanvas.uploadSize"));
    return (await importCanvasFile(projectId, file, directory)).path;
  }

  async function importAssetFiles(files: File[], position: { x: number; y: number }): Promise<void> {
    await importCanvasFiles(files.map((file) => ({ file })), position);
  }

  async function importTableFile(file: File, delimiter: "," | "\t"): Promise<string> {
    if (file.size > 4 * 1024 * 1024) throw new Error(t("tableNode.tooLarge"));
    const text = await file.text();
    const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200);
    // Parse before creating, so a malformed file leaves no empty table behind.
    const draft = importCanvasCsv({ version: 1, id: "import", title, columns: [], rows: [] }, text, delimiter);
    const id = await tables.add();
    if (!id || !tables.storage.sessions.has(id)) throw new Error(t("assetCanvas.tableCreateFailed"));
    tables.storage.update({ ...draft, id }, false);
    return id;
  }

  function importCanvasFiles(source: TransferredFile[] | Promise<TransferredFile[]>, position: { x: number; y: number }): Promise<void> {
    if (pendingImport.current) {
      void Promise.resolve(source).catch(() => {});
      setTransferError(t("assetCanvas.importRunning")); return Promise.resolve();
    }
    const operation = performFileImport(source, position).finally(() => { pendingImport.current = undefined; });
    pendingImport.current = operation;
    return operation;
  }

  async function performFileImport(source: TransferredFile[] | Promise<TransferredFile[]>, position: { x: number; y: number }): Promise<void> {
    setImportingAssets(true);
    setTransferError(undefined);
    const failures: string[] = [];
    const imported: AssetCanvasFlowNode[] = [];
    try {
      const accepted = (await source).filter(({ file, relativePath }) => !isIgnoredImportPath(relativePath ?? file.name));
      let { folders, files: chosen } = droppedFolders(accepted);
      if (folders.length) {
        // A folder is easy to drop by mistake and can hold many files, so ask first.
        setImportingAssets(false);
        const choice = await new Promise<"folder" | "files" | undefined>((answer) => setFolderPrompt({ folders, answer }));
        setFolderPrompt(undefined);
        if (!choice || !mounted.current) return;
        setImportingAssets(true);
        if (choice === "files") { chosen = accepted; folders = []; }
      }
      if (folders.reduce((count, folder) => count + folder.files.length, 0) > MAX_FOLDER_IMPORT_FILES) throw new Error(t("assetCanvas.folderFileLimit"));
      if (folders.reduce((bytes, folder) => bytes + folder.bytes, 0) > MAX_FOLDER_IMPORT_BYTES) throw new Error(t("assetCanvas.folderSizeLimit"));
      const files = chosen.map(({ file }) => ({ file, kind: canvasImportKind(file.name) }));
      if (files.length > 1_000) throw new Error(t("assetCanvas.importLimit"));
      if (nodesRef.current.length + files.length + folders.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.nodeLimit"));
      let placed = 0;
      const nextPosition = () => { const index = placed++; return snapCanvasPosition({ x: position.x + (index % 3) * 480, y: position.y + Math.floor(index / 3) * 560 }); };
      for (const folder of folders) {
        try {
          const root = (await createCanvasImportFolder(projectId, folder.name)).path;
          const queue = [...folder.files];
          await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
            for (let item = queue.shift(); item; item = queue.shift()) {
              const { file, directory } = item;
              try { await importProjectFile(file, directory ? `${root}/${directory}` : root); } catch (cause) { failures.push(`${[folder.name, directory, file.name].filter(Boolean).join("/")}: ${errorMessage(cause)}`); }
            }
          }));
          imported.push({ id: crypto.randomUUID(), type: "file", position: nextPosition(), selected: true, data: { path: root, directory: true } });
        } catch (cause) { failures.push(`${folder.name}: ${errorMessage(cause)}`); }
      }
      for (const { file, kind } of files) {
        const at = nextPosition();
        try {
          if (kind.kind === "table") {
            imported.push({ id: crypto.randomUUID(), type: "table", position: at, selected: true, data: { tableId: await importTableFile(file, kind.delimiter) } });
          } else if (kind.kind === "document") {
            if (file.size > 1_000_000) throw new Error(t("assetCanvas.textTooLarge"));
            const text = await file.text();
            const id = await documents.add();
            if (!id) throw new Error(t("assetCanvas.documentCreateFailed"));
            documents.update(id, { title: file.name.replace(/\.[^.]+$/, "").slice(0, 200), markdown: text });
            imported.push({ id: crypto.randomUUID(), type: "document", position: at, selected: true, data: { documentId: id } });
          } else if (kind.kind === "media") imported.push(assetFlowNode(await uploadAssetFile(file, kind.mediaType), at));
          else imported.push({ id: crypto.randomUUID(), type: "file", position: at, selected: true, data: { path: await importProjectFile(file) } });
        } catch (cause) { failures.push(`${file.name}: ${errorMessage(cause)}`); }
      }
      if (nodesRef.current.length + imported.length > MAX_ASSET_CANVAS_NODES) throw new Error(t("assetCanvas.canvasFull"));
      // Tables and documents start at their default size; other nodes leave room for their selected controls.
      const footprint = (node: AssetCanvasFlowNode) => isResizableCanvasNodeType(node.type) ? { width: node.width ?? RESIZABLE_CANVAS_NODE_SIZES[node.type].width, height: node.height ?? RESIZABLE_CANVAS_NODE_SIZES[node.type].height } : { width: 440, height: 520 };
      const occupied = nodesRef.current.map((node) => ({ ...node.position, width: node.measured?.width ?? footprint(node).width, height: node.measured?.height ?? footprint(node).height }));
      for (const node of imported) {
        // Keep imported files near the drop point while leaving space for selected node controls.
        const { width, height } = footprint(node);
        let overlaps;
        do {
          overlaps = occupied.filter((rect) => node.position.x < rect.x + rect.width + 20 && node.position.x + width + 20 > rect.x && node.position.y < rect.y + rect.height + 20 && node.position.y + height + 20 > rect.y);
          if (overlaps.length) node.position.y = snapCanvasPosition({ x: node.position.x, y: Math.max(...overlaps.map((rect) => rect.y + rect.height)) + 40 }).y;
        } while (overlaps.length);
        occupied.push({ ...node.position, width, height });
      }
      // Publish before a waiting board switch flushes the canvas.
      if (imported.length) flushSync(() => setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...imported]));
    } catch (cause) { failures.push(errorMessage(cause)); }
    finally {
      setImportingAssets(false);
      if (failures.length) setTransferError(failures.join("\n"));
    }
  }

  function transferPosition(): { x: number; y: number } {
    const bounds = canvasElement.current?.getBoundingClientRect();
    const screen = pointer.current ?? (bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : { x: 0, y: 0 });
    return flowInstance.current?.screenToFlowPosition(screen) ?? { x: 96, y: 96 };
  }

  function pasteSelection(value: CanvasClipboard, position: { x: number; y: number }): void {
    if (nodesRef.current.length + value.nodes.length > MAX_ASSET_CANVAS_NODES) {
      setTransferError(t("assetCanvas.nodeLimit")); return;
    }
    if (value.nodes.some((node) => (node.type === "document" || node.type === "table" || node.type === "file")) && value.projectId !== projectId) {
      setTransferError(t("assetCanvas.pasteProject")); return;
    }
    commitPendingHistory();
    setTransferError(undefined);
    const copied = duplicateCanvasSelection(value.nodes, value.edges, position);
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...copied.nodes.map((node) => ({ ...toFlowNode(node, imageModels, videoModels), selected: true }))]);
    setEdges((current) => [...current, ...copied.edges]);
    setSelectedAssetEdgeId(undefined);
  }

  function startAltDragDuplicate(dragged: readonly AssetCanvasFlowNode[]): void {
    // A rejected copy gesture must not fall back to moving the originals.
    altDragCopies.current = new Map();
    if (nodesRef.current.length + dragged.length > MAX_ASSET_CANVAS_NODES) { setTransferError(t("assetCanvas.nodeLimit")); return; }
    setTransferError(undefined);
    const copies = dragged.map((node) => {
      const source = toAssetCanvasNode(node, model3DModels);
      return { ...toFlowNode(duplicateAssetCanvasNode(source, source.position), imageModels, videoModels), selected: true };
    });
    altDragCopies.current = new Map(dragged.map((node, index) => [node.id, copies[index]!.id]));
    clearSelection();
    setNodes((current) => [...current, ...copies]);
    setMarqueeSelectedIds(new Set(altDragCopies.current.values()));
  }

  function finishAltDragDuplicate(dragged: readonly AssetCanvasFlowNode[]): void {
    const copies = altDragCopies.current;
    altDragCopies.current = undefined;
    if (!copies?.size) return;
    const start = new Map(nodesRef.current.map((node) => [node.id, node.position]));
    if (dragged.some((node) => node.position.x !== start.get(node.id)?.x || node.position.y !== start.get(node.id)?.y)) return;
    const copyIds = new Set(copies.values());
    setNodes((current) => current.flatMap((node) => copyIds.has(node.id) ? [] : [copies.has(node.id) ? { ...node, selected: true } : node]));
    setMarqueeSelectedIds(new Set(copies.keys()));
  }

  function copySelection(event: ClipboardEvent<HTMLDivElement>, cut = false): void {
    if (isTextEntry(event.target) || eventWithin(event, ".nokey")) return;
    const selected = nodes.filter((node) => node.selected).map((node) => toAssetCanvasNode(node, model3DModels));
    if (!selected.length) return;
    const value = createCanvasClipboard(projectId, selected, document.edges);
    event.preventDefault(); event.clipboardData.setData("text/plain", JSON.stringify(value));
    rememberCanvasClipboard(value); setCopiedSelection(value); pasteSequence.current = { text: "", count: 0 };
    if (cut) removeCanvasNodes(new Set(selected.map((node) => node.id)));
  }

  function pasteFromClipboard(event: ClipboardEvent<HTMLDivElement>): void {
    if (isTextEntry(event.target) || eventWithin(event, ".nokey") || phase !== "ready") return;
    const files = clipboardFiles(event.clipboardData);
    if (files.length) { event.preventDefault(); void importCanvasFiles(files.map((file) => ({ file })), transferPosition()); return; }
    const text = event.clipboardData.getData("text/plain"), value = parseCanvasClipboard(text);
    if (!value) return;
    event.preventDefault();
    const count = pasteSequence.current.text === text ? pasteSequence.current.count + 1 : 0;
    pasteSequence.current = { text, count };
    const at = transferPosition();
    pasteSelection(value, { x: at.x + count * 40, y: at.y + count * 40 });
  }

  function addCanvasNode(item: CanvasNodeCreationLeaf, position: { x: number; y: number }): void {
    addNode(item.action.type, position, item.action.documentId ?? item.action.tableId);
  }

  function insertNodeCopy(source: AssetCanvasNode, position: { x: number; y: number }): void {
    const duplicate = { ...toFlowNode(duplicateAssetCanvasNode(source, position), imageModels, videoModels), selected: true };
    setNodes((current) => [...current.map((candidate) => candidate.selected ? { ...candidate, selected: false } : candidate), duplicate]);
    setSelectedAssetEdgeId(undefined);
  }

  function copyCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const value = createCanvasClipboard(projectId, [toAssetCanvasNode(source, model3DModels)], []);
    rememberCanvasClipboard(value); setCopiedSelection(value);
    void navigator.clipboard?.writeText(JSON.stringify(value)).catch(() => {});
  }

  function duplicateCanvasNode(nodeId: string): void {
    const source = nodes.find((node) => node.id === nodeId);
    if (!source) return;
    const canonical = toAssetCanvasNode(source, model3DModels);
    insertNodeCopy(canonical, { x: source.position.x + CANVAS_GRID_SIZE * 2, y: source.position.y + CANVAS_GRID_SIZE * 2 });
  }

  function canRemoveCanvasItems(removedIds: ReadonlySet<string>, removedEdges: readonly Edge[] = []): boolean {
    for (const node of nodes) {
      if (removedIds.has(node.id) || node.type !== "model-3d" || !requiresModelTurnaround(node.data.model3DOptions, nodeModel3D(node, model3DModels)?.protocol, node.data.model3DOperation ?? "image")) continue;
      let removedView = false;
      for (const view of node.data.images ?? []) {
        if (view.type === "node" && (removedIds.has(view.nodeId) || removedEdges.some((edge) => edge.id === assetEdgeId("image", node.id, view.nodeId)))) removedView = true;
        else if (removedView) {
          setNotice({ kind: "action", message: t("assetCanvas.removeLaterViewsFirst") });
          return false;
        }
      }
    }
    return true;
  }

  function removeCanvasNodes(requestedIds: ReadonlySet<string>): void {
    const removedIds = new Set(nodes.filter((node) => requestedIds.has(node.id)).map((node) => node.id));
    if (!removedIds.size || !canRemoveCanvasItems(removedIds)) return;
    commitPendingHistory();
    setNodes((current) => removeNodesAndReferences(current, removedIds));
    setEdges((current) => current.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)));
    canvasElement.current?.focus({ preventScroll: true });
  }

  function openViewer(node: AssetCanvasFlowNode): void {
    const asset = viewableCanvasAsset(node);
    if (asset) setViewedAsset(asset);
  }

  /**
   * Saves the kept part of a viewed video as a new Library video, placed as
   * an asset node beside the node it was trimmed from.
   */
  async function saveTrimmedVideoNode(viewed: ViewableCanvasAsset, name: string, video: Blob, trim: VideoTrim): Promise<void> {
    // A canvas copy of a Library video records the Library original.
    const libraryAssetId = localAssets.find((asset) => asset.id === viewed.assetId)?.libraryAssetId ?? viewed.assetId;
    const saved = await saveTrimmedVideo(video, trim, { name, ...(globalAssets.some((asset) => asset.id === libraryAssetId) ? { libraryAssetId } : {}), projectId });
    setLibraryAssets((current) => [{ ...saved, assetId: saved.id, path: saved.name }, ...current]);
    const source = nodesRef.current.find((node) => node.id === viewed.nodeId);
    const position = { x: (source?.position.x ?? 0) + (source?.measured?.width ?? 440) + 60, y: source?.position.y ?? 0 };
    const occupied = nodesRef.current.map((node) => ({ ...node.position, width: node.measured?.width ?? 440, height: node.measured?.height ?? 520 }));
    let overlaps;
    do {
      overlaps = occupied.filter((rect) => position.x < rect.x + rect.width + 20 && position.x + 460 > rect.x && position.y < rect.y + rect.height + 20 && position.y + 540 > rect.y);
      if (overlaps.length) position.y = snapCanvasPosition({ x: position.x, y: Math.max(...overlaps.map((rect) => rect.y + rect.height)) + 40 }).y;
    } while (overlaps.length);
    addAssetNode(saved, snapCanvasPosition(position));
    setViewedAsset(undefined);
  }

  // An open viewer can still refer to an earlier output after the node regenerates.
  function assetDownloadName(assetId: string, nodeId: string): string {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    return canvasAssetDownloadName(node?.title, asset?.name || node?.data.name || titleCase(node?.type ?? "asset"), asset?.contentType);
  }

  function downloadAsset(assetId: string, name: string): void {
    void assetBlob(assetId).then((blob) => downloadAssetBlob(blob, name)).catch((cause) => setNotice({ kind: "action", message: t("assetCanvas.downloadFailed", { error: errorMessage(cause) }) }));
  }

  function assetBlob(assetId: string, signal?: AbortSignal, contentSha256?: string): Promise<Blob> {
    const local = assetPaths.get(assetId);
    return local ? contentSha256 ? getWorkspaceAsset(local.projectId, local.path, signal, contentSha256) : signal ? getWorkspaceAsset(local.projectId, local.path, signal) : getWorkspaceAsset(local.projectId, local.path)
      : contentSha256 ? getLibraryAsset(assetId, false, signal, contentSha256) : signal ? getLibraryAsset(assetId, false, signal) : getLibraryAsset(assetId);
  }

  function sendAssetToProject(assetId: string, fallbackName: string): void {
    setViewedAsset(undefined);
    const name = libraryAssets.find((candidate) => candidate.id === assetId)?.name ?? fallbackName;
    void (assetPaths.has(assetId) ? exportCanvasAsset(projectId, assetId) : Promise.resolve({ assetId }))
      .then((asset) => setSentAsset({ assetId: asset.assetId, name }))
      .catch((cause) => setNotice({ kind: "action", message: t("assetCanvas.sendFailed", { error: errorMessage(cause) }) }));
  }

  function clearSelection(): void {
    setSelectedAssetEdgeId(undefined);
    setNodes((current) => current.map((node) => node.selected ? { ...node, selected: false } : node));
    setEdges((current) => current.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
  }

  function activateNode(nodeId: string): void {
    setCanvasContextMenu(undefined);
    setSelectedAssetEdgeId(undefined);
    setMarqueeSelectedIds((current) => {
      if (!current.has(nodeId)) return current;
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
  }

  async function generateTextNode(node: AssetCanvasFlowNode, model: AgentModelRef, reasoningLevel: AgentReasoningLevel): Promise<void> {
    if (node.type !== "text" || generatingTextNodeId) return;
    const instruction = node.data.instruction?.trim();
    if (!instruction) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.instructionRequired") });
      return;
    }
    setGeneratingTextNodeId(node.id);
    setGenerationError(undefined);
    try {
      const referenceSource = { boardId: storage.boardId, nodeId: node.id };
      await documents.flush();
      const result = await generateCanvasText(projectId, instruction, model, reasoningLevel, referenceSource, writeVersion);
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, text: result.text, textModel: result.model, reasoningLevel } }
        : candidate));
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setGeneratingTextNodeId(undefined);
    }
  }

  function attachImageReferences(node: AssetCanvasFlowNode, assets: readonly { id: string }[], replaceAt?: number): void {
    const added = assets.map((asset): AssetCanvasReference => ({ type: "library", assetId: asset.id }));
    setNodes((current) => current.map((candidate) => {
      if (candidate.id !== node.id || candidate.type !== node.type) return candidate;
      const images = [...(candidate.data.images ?? [])];
      if (replaceAt === undefined) images.push(...added);
      else {
        // A board refresh can change the selected slot while its replacement uploads.
        const original = node.data.images?.[replaceAt], slot = images[replaceAt];
        if (!original || !slot || !sameVideoReference(original, slot)) return candidate;
        images.splice(replaceAt, 1, ...added);
      }
      return { ...candidate, data: { ...candidate.data, images } };
    }));
  }

  async function uploadReferenceImages(node: AssetCanvasFlowNode, files: File[], replaceAt?: number): Promise<void> {
    if ((node.type !== "image" && node.type !== "model-3d") || files.length === 0 || uploadingNodeId) return;
    const available = replaceAt !== undefined ? 1 : (node.type === "image" ? imageReferenceLimit(node, imageModels) : modelReferenceLimit(node, nodeModel3D(node, model3DModels))) - (node.data.images?.length ?? 0);
    if (available <= 0) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.noMoreReferences") });
      return;
    }
    if (files.length > available) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.addUpTo", { count: available }) });
      return;
    }
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const images = await Promise.all(files.map(readUploadImage));
      const assets = await Promise.all(images.map(({ name, image }) => createLibraryImage({ name, image, purpose: "reference" }, projectId)));
      attachImageReferences(node, assets, replaceAt);
      setLibraryAssets(await loadLibraryAssets());
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setUploadingNodeId(undefined);
    }
  }

  function addLibraryReference(node: AssetCanvasFlowNode, asset: LibraryAsset, replaceAt?: number): void {
    setGenerationError(undefined);
    if (node.type === "image" || node.type === "model-3d") {
      attachImageReferences(node, [asset], replaceAt);
      return;
    }
    const reference: AssetCanvasReference = { type: "library", assetId: asset.id };
    setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "video"
      ? { ...candidate, data: compatibleVideoDraft({ ...candidate.data, references: [...(candidate.data.references ?? []), reference] }, videoModels) }
      : candidate));
  }

  async function uploadVideoReferences(node: AssetCanvasFlowNode, files: File[]): Promise<void> {
    if (node.type !== "video" || files.length === 0 || uploadingNodeId) return;
    const remaining = videoReferenceLimit(selectedVideoModel(node, videoModels), node.data.referenceMode) - (node.data.references?.length ?? 0);
    if (files.length > remaining) {
      setGenerationError({ nodeId: node.id, message: t("assetCanvas.modeAccepts", { count: Math.max(0, remaining) }) });
      return;
    }
    setUploadingNodeId(node.id);
    setGenerationError(undefined);
    try {
      const uploads = await Promise.all(files.map(prepareVideoReferenceFile));
      for (const upload of uploads) {
        const asset = await uploadLibraryAsset(upload.file, upload.mediaType, undefined, "reference", undefined, projectId);
        setLibraryAssets((current) => [{ ...asset, assetId: asset.id, path: asset.name }, ...current.filter((candidate) => candidate.id !== asset.id)]);
        setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "video"
          ? { ...candidate, data: compatibleVideoDraft({ ...candidate.data, references: [...(candidate.data.references ?? []), { type: "library", assetId: asset.id }] }, videoModels) }
          : candidate));
      }
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      setUploadingNodeId(undefined);
    }
  }

  async function selectSpeechReference(node: AssetCanvasFlowNode, source: LibraryAsset | File, sourceNodeId?: string): Promise<void> {
    if (node.type !== "speech" || uploadingNodeId || speechReferenceUpload.current) return;
    speechReferenceUpload.current = true;
    setUploadingNodeId(node.id); setGenerationError(undefined);
    try {
      const mediaType = source instanceof File ? /\.wav$/i.test(source.name) ? "audio/wav" : /\.mp3$/i.test(source.name) ? "audio/mpeg" : "" : source.contentType;
      if (source.size > AUDIO_REFERENCE_MAX_BYTES || !["audio/mpeg", "audio/wav"].includes(mediaType)) throw new Error();
      const blob = source instanceof File ? source : await assetBlob(source.id);
      if (!blob.size || blob.size > AUDIO_REFERENCE_MAX_BYTES) throw new Error();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const inspected = await inspectAudioReference(bytes, source instanceof File ? undefined : mediaType);
      const digest = await audioReferenceDigest(bytes);
      const asset = source instanceof File ? await uploadLibraryAsset(new File([source], source.name.replace(/\.(mp3|wav)$/i, inspected.mediaType === "audio/wav" ? ".wav" : ".mp3"), { type: inspected.mediaType, lastModified: source.lastModified }), inspected.mediaType, inspected.duration, "reference", undefined, projectId) : source;
      setLibraryAssets((current) => [{ ...asset, assetId: asset.id, path: asset.name }, ...current.filter((candidate) => candidate.id !== asset.id)]);
      setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "speech"
        ? { ...candidate, data: { ...candidate.data, referenceAssetId: asset.id, referenceSha256: digest, voiceSourceNodeId: sourceNodeId, voiceId: undefined } } : candidate));
    } catch { setGenerationError({ nodeId: node.id, message: t("assetCanvas.audioReferenceInvalid") }); }
    finally { speechReferenceUpload.current = false; setUploadingNodeId(undefined); }
  }

  async function selectVoiceSample(node: AssetCanvasFlowNode, target?: AssetCanvasFlowNode): Promise<void> {
    if (node.type !== "voice" || target && target.type !== "speech" || uploadingNodeId || speechReferenceUpload.current) return;
    const selected = target ? node.data.selectedAssetId ?? node.data.assetId : node.data.assetId;
    if (!selected) return;
    speechReferenceUpload.current = true;
    setUploadingNodeId(node.id); setGenerationError(undefined);
    let contentChanged = false;
    try {
      const asset = libraryAssets.find((item) => item.id === selected);
      if (!asset || asset.size > AUDIO_REFERENCE_MAX_BYTES || !["audio/mpeg", "audio/wav"].includes(asset.contentType)) throw new Error();
      const blob = await assetBlob(selected);
      if (!blob.size || blob.size > AUDIO_REFERENCE_MAX_BYTES) throw new Error();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await inspectAudioReference(bytes, asset.contentType);
      const digest = await audioReferenceDigest(bytes);
      if (target && node.data.selectedAssetId && node.data.selectedSha256 !== digest) { contentChanged = true; throw new Error(); }
      const sourceMatches = (candidate?: AssetCanvasFlowNode) => candidate?.type === "voice" && (target ? candidate.data.selectedAssetId ?? candidate.data.assetId : candidate.data.assetId) === selected && (!target || candidate.data.selectedSha256 === node.data.selectedSha256);
      const targetMatches = (candidate?: AssetCanvasFlowNode) => !target || candidate?.type === "speech" && candidate.data.referenceAssetId === target.data.referenceAssetId && candidate.data.referenceSha256 === target.data.referenceSha256 && candidate.data.voiceSourceNodeId === target.data.voiceSourceNodeId && candidate.data.voiceId === target.data.voiceId;
      if (!sourceMatches(nodesRef.current.find((candidate) => candidate.id === node.id)) || target && !targetMatches(nodesRef.current.find((candidate) => candidate.id === target.id))) return;
      setNodes((current) => {
        if (!sourceMatches(current.find((candidate) => candidate.id === node.id)) || target && !targetMatches(current.find((candidate) => candidate.id === target.id))) return current;
        return current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, selectedAssetId: selected, selectedSha256: digest } }
          : target && candidate.id === target.id ? { ...candidate, data: { ...candidate.data, referenceAssetId: selected, referenceSha256: digest, voiceSourceNodeId: node.id, voiceId: undefined } } : candidate);
      });
    } catch { setGenerationError({ nodeId: node.id, message: t(contentChanged ? "assetCanvas.audioReferenceChanged" : "assetCanvas.audioReferenceInvalid") }); }
    finally { speechReferenceUpload.current = false; setUploadingNodeId(undefined); }
  }

  async function generateMedia(node: AssetCanvasFlowNode, recoverJobId?: string, confirmedJobId?: string): Promise<void> {
    const previous = canvasJobsRef.current[node.id];
    const managed = characterViews[node.id];
    if (managed && managed.state !== "ready" && managed.state !== "not-submitted") return;
    if (unavailableModel3DSelection(node, [...model3DModels, ...operationModels3D]) || recoverJobId && isMeshyModelReference(previous?.model)) {
      setGenerationError({ nodeId: node.id, message: t("modelUsage.meshyUnavailable") });
      return;
    }
    if (previous?.status === "running" || startingCanvasNodesRef.current.has(node.id)) return;
    if (confirmedJobId && previous?.id !== confirmedJobId) return;
    if (!managed && !recoverJobId && mediaGenerationNeedsConfirmation(previous) && confirmedJobId !== previous.id) {
      if (mediaConfirmationRef.current) return;
      mediaConfirmationRef.current = { nodeId: node.id, jobId: previous.id };
      setMediaConfirmation(mediaConfirmationRef.current);
      return;
    }
    startingCanvasNodesRef.current.add(node.id);
    setStartingCanvasNodes((current) => new Set(current).add(node.id));
    setGenerationError(undefined);
    try {
      await flush();
      const job = recoverJobId ? node.type === "video" && storageRef.current.resumeVideo
        ? await storageRef.current.resumeVideo(recoverJobId) : await storageRef.current.recoverImage(recoverJobId)
        : confirmedJobId ? await storageRef.current.generate(node.id, confirmedJobId) : await storageRef.current.generate(node.id);
      setCanvasJobs((current) => ({ ...current, [node.id]: job }));
    } catch (error) {
      setGenerationError({ nodeId: node.id, message: errorMessage(error) });
    } finally {
      startingCanvasNodesRef.current.delete(node.id);
      setStartingCanvasNodes((current) => {
        const next = new Set(current);
        next.delete(node.id);
        return next;
      });
    }
  }

  async function useOriginalCharacterView(view: CanvasCharacterViewStatus): Promise<void> {
    if (!view.jobId || startingCanvasNodesRef.current.has(view.nodeId)) return;
    startingCanvasNodesRef.current.add(view.nodeId);
    setStartingCanvasNodes((current) => new Set(current).add(view.nodeId));
    setGenerationError(undefined);
    try {
      const job = await storageRef.current.recoverImage(view.jobId);
      setCanvasJobs((current) => ({ ...current, [view.nodeId]: job }));
      const assetId = job.status === "succeeded" ? job.run?.files[0]?.assetId : undefined;
      if (assetId) setViewedAsset({ nodeId: view.nodeId, assetId, mediaType: "image" });
    } catch (error) {
      setGenerationError({ nodeId: view.nodeId, message: errorMessage(error) });
    } finally {
      startingCanvasNodesRef.current.delete(view.nodeId);
      setStartingCanvasNodes((current) => new Set([...current].filter(id => id !== view.nodeId)));
    }
  }

  async function cancelCanvasJob(nodeId: string): Promise<void> {
    const job = canvasJobs[nodeId];
    if (!job) return;
    try {
      setCanvasJobs((current) => ({ ...current, [nodeId]: { ...job, status: "cancelled" } }));
      const next = await storageRef.current.cancel(job.id);
      setCanvasJobs((current) => ({ ...current, [nodeId]: next }));
    } catch (error) {
      setGenerationError({ nodeId, message: errorMessage(error) });
    }
  }

  function recoveryLabel(job?: ToolJob) {
    if (job?.canRecoverVideo && storageRef.current.resumeVideo) return "assetCanvas.recoverVideo";
    if (job?.canRecoverImage) return "assetCanvas.recoverImage";
    if (job?.canRecoverModel3D) return "kunpoModels.recoverModel";
    return undefined;
  }

  function answerMediaConfirmation(answer: "cancel" | "recover" | "new"): void {
    const pending = mediaConfirmationRef.current;
    mediaConfirmationRef.current = undefined; setMediaConfirmation(undefined);
    if (!pending || answer === "cancel") return;
    const node = nodesRef.current.find((candidate) => candidate.id === pending.nodeId);
    const job = canvasJobsRef.current[pending.nodeId];
    if (!node || job?.id !== pending.jobId) return;
    if (answer === "recover") {
      if (recoveryLabel(job)) void generateMedia(node, job.id);
    } else void generateMedia(node, undefined, job.id);
  }

  function rememberSettings(node: AssetCanvasFlowNode, data: AssetCanvasFlowData): void {
    const next = nodeGenerationSettings({ type: node.type, data });
    if (!next || JSON.stringify(next) === JSON.stringify(nodeGenerationSettings(node))) return;
    rememberedSettings.current[node.type] = next;
  }

  function nodeReferencesRuntime(node: AssetCanvasFlowNode): CanvasNodeReferencesRuntime {
    return {
      references: (node.data.references ?? []).flatMap((reference) => {
        if (reference.type !== "node") return [];
        const source = nodes.find((candidate) => candidate.id === reference.nodeId);
        const doc = source?.type === "document" ? documents.documents.find((document) => document.id === source.data.documentId) : undefined;
        return [{
          nodeId: reference.nodeId,
          name: source ? canvasNodeTitle(toAssetCanvasNode(source), documents.documents, libraryAssets) : t("assetCanvas.missingNode"),
          type: source?.type === "text" ? "text" as const : source?.type === "document" ? "document" as const : "image" as const,
          text: source?.type === "text" ? source.data.text : doc?.markdown,
          assetId: source?.data.assetId,
        }];
      }),
      onRemoveReference: (index) => setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? { ...candidate, data: { ...candidate.data, references: (candidate.data.references ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
        : candidate)),
    };
  }

  const expanded = documents.documents.find((doc) => doc.id === expandedDocument?.id);
  const expandedNode = nodes.find((node) => node.id === expandedDocument?.nodeId && node.type === "document");

  const tableContents = [...tables.storage.sessions.values()].map((session) => session.local);
  const renderedNodes = nodes.map((original) => {
    const size = isResizableCanvasNodeType(original.type) ? RESIZABLE_CANVAS_NODE_SIZES[original.type] : undefined;
    // A render can arrive before React Flow publishes its first dimensions.
    // An empty measurement keeps it from clearing freshly measured handle bounds.
    const node = { ...original, measured: original.measured ?? {}, ...(size ? { style: { ...original.style, width: original.width ?? size.width, height: original.height ?? size.height } } : {}), data: { ...original.data,
      ...(size ? { resizeRuntime: {
        start: beginHistoryGesture, end: finishHistoryGesture,
        reset: () => { beginHistoryGesture(); setNodes((current) => current.map((node) => { if (node.id !== original.id) return node; const { width: _width, height: _height, ...rest } = node; return rest; })); finishHistoryGesture(); },
        ...(original.type === "text" ? { open: () => setExpandedTextId(original.id) } : {}),
      } } : {}), assetAspectRatio: mediaAspectRatio(libraryAssets.find((asset) => asset.id === original.data.assetId)), panelOpen: original.selected === true && !marqueeActive && !marqueeSelectedIds.has(original.id), nodeDetails: {
      title: original.title?.trim(), label: canvasNodeTitle(toAssetCanvasNode(original, model3DModels), documents.documents, libraryAssets, tableContents), description: original.description,
      edit: () => setNodeDetails({ id: original.id, title: original.title ?? "", description: original.description ?? "", job: canvasJobsRef.current[original.id] }),
    } } };
    if (node.type === "table") {
      const session = tables.storage.sessions.get(node.data.tableId ?? "");
      return { ...node, data: { ...node.data, tableRuntime: { tables, table: session?.local, issue: session?.issue ?? tables.issues?.find((issue) => issue.id === node.data.tableId)?.message, models: textModelCatalog.models, modelStatus: textModelCatalog.status, defaultModel: defaultTextModel, defaultReasoningLevel: textModelCatalog.defaultReasoningLevel } } };
    }
    if (node.type === "file") {
      const reveal = window.ohMyGameDesktop?.openProjectFile;
      return { ...node, data: { ...node.data, fileRuntime: { onReveal: reveal && node.data.path ? () => { void reveal(projectId, node.data.path!, "reveal").catch((cause) => setNotice({ kind: "action", message: errorMessage(cause) })); } : undefined } } };
    }
    if (node.type === "document") return { ...node, data: { ...node.data, documentRuntime: { ...nodeReferencesRuntime(node), referenceSource: { boardId: storage.boardId, nodeId: node.id }, design: documents, document: documents.documents.find((doc) => doc.id === node.data.documentId), models: textModelCatalog.models, modelStatus: textModelCatalog.status, defaultModel: defaultTextModel, defaultReasoningLevel: textModelCatalog.defaultReasoningLevel } } };
    if (node.type === "asset") return {
      ...node,
      data: (() => {
        const asset = libraryAssets.find((candidate) => candidate.id === node.data.assetId);
        const local = assetPaths.get(node.data.assetId ?? "");
        return {
          ...node.data,
          name: asset?.name ?? local?.name ?? t("assetCanvas.missingAsset"),
          assetError: local?.error,
          assetOrigin: local ? "Project" as const : "Library" as const,
          contentType: asset?.contentType,
          assetDuration: asset?.duration,
        };
      })(),
    };
    if (node.type === "text") return {
      ...node,
      data: {
          ...node.data,
        textRuntime: {
          ...nodeReferencesRuntime(node),
          models: textModelCatalog.models,
          modelStatus: textModelCatalog.status,
          ...(defaultTextModel ? { defaultModel: defaultTextModel } : {}),
          defaultReasoningLevel: textModelCatalog.defaultReasoningLevel,
          generating: generatingTextNodeId === node.id,
          busy: Boolean(generatingTextNodeId),
          ...(generationError?.nodeId === node.id ? { error: generationError.message } : {}),
          onChange: (data: AssetCanvasFlowData) => {
            rememberSettings(node, data);
            setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
            setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
          },
          onGenerate: (model: AgentModelRef, reasoningLevel: AgentReasoningLevel) => void generateTextNode(node, model, reasoningLevel),
        },
      },
    };
    if (node.type === "model-3d") {
      const nodeJob = canvasJobs[node.id];
      const operation = node.data.model3DOperation ?? "image";
      const availableModels = (operation === "image" || operation === "text" ? model3DModels : operationModels3D).filter((model) => (model.operations ?? ["image"]).includes(operation));
      const model = nodeModel3D(node, availableModels);
      const turnaround = requiresModelTurnaround(node.data.model3DOptions, model?.protocol, operation);
      const slotLabels = operation === "image" ? model3DViewLabels(model, turnaround) : undefined;
      const references = imageReferenceViews(node, nodes, libraryAssets, slotLabels);
      const viewIssue = turnaround ? turnaroundViewIssue(references, slotLabels!, model, libraryImages, assetPaths) : undefined;
      const lastError = nodeJob?.status === "failed" || nodeJob?.status === "cancelled" ? nodeJob.error : undefined;
      return {
        ...node,
        data: {
          ...node.data,
          model3DRuntime: {
            generating: nodeJob?.status === "running",
            generationStatus: nodeJob?.status,
            busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id) || Boolean(uploadingNodeId),
            error: generationError?.nodeId === node.id ? generationError.message : operation === "image" && lastError === "Use text generation for a prompt" ? undefined : lastError,
            onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
            onChange: (data: AssetCanvasFlowData) => {
              rememberSettings(node, data);
              setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
              setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
            },
            onGenerate: () => void generateMedia(node),
            onRecover: nodeJob?.canRecoverModel3D && !isMeshyModelReference(nodeJob.model) && (nodeJob.status === "failed" || nodeJob.status === "cancelled") ? () => void generateMedia(node, nodeJob.id) : undefined,
            recovering: nodeJob?.status === "running" && nodeJob.model3DRecoveryOnly === true,
            references, slotLabels, viewIssue,
            maxReferences: modelReferenceLimit(node, model),
            showEmptySlots: operation === "image" && (turnaround || Boolean(model?.referenceImageLabels)),
            orderedViews: turnaround,
            uploading: uploadingNodeId === node.id,
            accept: "image/png,image/jpeg,image/webp",
            addLabel: t("assetCanvas.addReferences"),
            onRemoveReference: (index: number) => setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "model-3d"
              ? { ...candidate, data: { ...candidate.data, images: (candidate.data.images ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
              : candidate)),
            onUploadReferences: (files: File[], replaceAt?: number) => void uploadReferenceImages(node, files, replaceAt),
            libraryImages,
            onReloadLibrary: reloadLibraryAssets,
            onAddLibraryReference: (asset: LibraryAsset, replaceAt?: number) => addLibraryReference(node, asset, replaceAt),
            models: availableModels,
            modelSelections: project.modelSelections,
            linkedPrompt: operation === "text" || operation === "retexture" ? resolveLinkedPrompt(node, nodes, documents) : undefined,
            onDisconnectPrompt: () => setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, promptSource: undefined } } : candidate)),
            sourceRuntime: {
              busy: nodeJob?.status === "running",
              references: modelReferenceViews(node, nodes, libraryAssets), maxReferences: 1, slotLabels: [t("assetCanvas.sourceModel")], uploading: false, accept: "", addLabel: t("assetCanvas.connectGlb"),
              onRemoveReference: () => setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, model3DSource: undefined } } : candidate)),
            },
            providers: model3DProviders,
          },
        },
      };
    }
    if (node.type === "animate-3d") {
      const nodeJob = canvasJobs[node.id];
      return {
        ...node,
        data: {
          ...node.data,
          animateRuntime: {
            generating: nodeJob?.status === "running",
            generationStatus: nodeJob?.status,
            busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id),
            ...(nodeJob?.status === "failed" || nodeJob?.status === "cancelled" ? { error: nodeJob.error } : generationError?.nodeId === node.id ? { error: generationError.message } : {}),
            onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
            onChange: (data: AssetCanvasFlowData) => {
              setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
              setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
            },
            onGenerate: () => void generateMedia(node),
            onRecover: nodeJob?.canRecoverModel3D && !isMeshyModelReference(nodeJob.model) && (nodeJob.status === "failed" || nodeJob.status === "cancelled") ? () => void generateMedia(node, nodeJob.id) : undefined,
            recovering: nodeJob?.status === "running" && nodeJob.model3DRecoveryOnly === true,
            references: modelReferenceViews(node, nodes, libraryAssets),
            maxReferences: 1,
            slotLabels: [t("assetCanvas.model")],
            uploading: false,
            accept: "",
            addLabel: t("assetCanvas.connect3d"),
            onRemoveReference: () => setNodes((current) => current.map((candidate) => candidate.id === node.id
              ? { ...candidate, data: { ...candidate.data, images: [] } }
              : candidate)),
            models: operationModels3D.filter((model) => model.operations?.includes("animate")),
          } satisfies Animate3DNodeRuntime,
        },
      };
    }
    if (node.type === "speech" || node.type === "voice" || node.type === "sound-effect" || node.type === "music") {
      const nodeJob = canvasJobs[node.id];
      const linkedPrompt = resolveLinkedPrompt(node, nodes, documents);
      const operation = audioOperationForNode(node.type)!;
      const reference = node.type === "speech" ? libraryAssets.find((asset) => asset.id === node.data.referenceAssetId) : undefined;
      const voiceSource = nodes.find((candidate) => candidate.id === node.data.voiceSourceNodeId && candidate.type === "voice");
      const referenceReady = Boolean(reference && ["audio/mpeg", "audio/wav"].includes(reference.contentType) && reference.size <= AUDIO_REFERENCE_MAX_BYTES && (!reference.duration || reference.duration <= 30));
      return {
        ...node,
        data: {
          ...node.data,
          audioRuntime: {
            generating: nodeJob?.status === "running",
            generationStatus: nodeJob?.status,
            busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id) || Boolean(uploadingNodeId),
            ...(generationError?.nodeId === node.id ? { error: generationError.message } : nodeJob?.status === "failed" || nodeJob?.status === "cancelled" ? { error: nodeJob.error } : {}),
            onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
            onChange: (data) => {
              rememberSettings(node, data);
              setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
              setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
            },
            onGenerate: () => void generateMedia(node),
            ...(linkedPrompt !== undefined ? { linkedPrompt } : {}),
            onDisconnectPrompt: () => {
              setSelectedAssetEdgeId(undefined);
              setNodes((current) => current.map((candidate) => candidate.id === node.id
                ? { ...candidate, data: { ...candidate.data, promptSource: undefined } }
              : candidate));
            },
            models: audioModels.filter((model) => model.capabilities.operations.includes(operation) && (node.type !== "voice" || model.capabilities.supportsVoiceDesign)),
            ...(node.type === "voice" ? { onSelectSample: () => selectVoiceSample(node) } : {}),
            ...(node.type === "speech" && voiceSource?.data.selectedAssetId && voiceSource.data.selectedSha256 && (voiceSource.data.selectedAssetId !== node.data.referenceAssetId || voiceSource.data.selectedSha256 !== node.data.referenceSha256) ? { onUpdateVoice: () => setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, referenceAssetId: voiceSource.data.selectedAssetId, referenceSha256: voiceSource.data.selectedSha256, voiceId: undefined } } : candidate)) } : {}),
            providers: audioProviders,
            ...(node.type === "speech" ? { referenceReady, voiceReference: {
              busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id) || Boolean(uploadingNodeId),
              references: node.data.referenceAssetId ? [{ key: node.data.referenceAssetId, assetId: node.data.referenceAssetId, name: reference?.name ?? t("assetCanvas.missingAsset"), label: t("assetCanvas.audioReference"), type: "audio" as const }] : [],
              maxReferences: 1, uploading: uploadingNodeId === node.id, accept: ".mp3,.wav,audio/mpeg,audio/wav", addLabel: t("assetCanvas.audioReference"),
              libraryImages: libraryAssets.filter((asset) => asset.mediaType === "audio" && ["audio/mpeg", "audio/wav"].includes(asset.contentType)),
              onReloadLibrary: reloadLibraryAssets,
              onUploadReferences: (files: File[]) => { if (files.length === 1) void selectSpeechReference(node, files[0]!); else setGenerationError({ nodeId: node.id, message: t("assetCanvas.audioReferenceInvalid") }); },
              onAddLibraryReference: (asset: LibraryAsset) => selectSpeechReference(node, asset),
              onRemoveReference: () => setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data: { ...candidate.data, referenceAssetId: undefined, referenceSha256: undefined, voiceSourceNodeId: undefined, voiceId: undefined } } : candidate)),
            } } : {}),
          } satisfies AudioNodeRuntime,
        },
      };
    }
    if (!isMediaNodeType(node.type)) return node;
    const linkedPrompt = resolveLinkedPrompt(node, nodes, documents);
    const managed = node.type === "image" ? characterViews[node.id] : undefined;
    const latest = canvasJobs[node.id];
    const nodeJob = !managed || managed.jobId === latest?.id ? latest : undefined;
    const runtime: MediaNodeRuntime = {
      generating: nodeJob?.status === "running",
      generationStatus: nodeJob?.status,
      recovering: nodeJob?.status === "running" && (nodeJob.imageRecoveryOnly || nodeJob.videoRecoveryOnly),
      busy: nodeJob?.status === "running" || startingCanvasNodes.has(node.id) || Boolean(uploadingNodeId),
      ...(node.type === "video" && nodeJob?.videoReferencePreparation ? { notice: videoReferencePreparationNotice(nodeJob.videoReferencePreparation) } : {}),
      ...(generationError?.nodeId === node.id ? { error: generationError.message } : (!managed || nodeJob?.imageRecoveryOnly) && (nodeJob?.status === "failed" || nodeJob?.status === "cancelled") ? { error: nodeJob.error } : {}),
      onCancel: nodeJob?.status === "running" ? () => void cancelCanvasJob(node.id) : undefined,
      onRecover: nodeJob && (node.type === "image" && nodeJob.canRecoverImage || node.type === "video" && nodeJob.canRecoverVideo && storageRef.current.resumeVideo) && (nodeJob.status === "failed" || nodeJob.status === "cancelled") ? () => void generateMedia(node, nodeJob.id) : undefined,
      onChange: (data) => {
        if (node.type === "video") data = compatibleVideoDraft(data, videoModels);
        rememberSettings(node, data);
        setGenerationError((error) => error?.nodeId === node.id ? undefined : error);
        setNodes((current) => current.map((candidate) => candidate.id === node.id ? { ...candidate, data } : candidate));
      },
      onGenerate: () => void generateMedia(node),
      ...(linkedPrompt !== undefined ? { linkedPrompt } : {}),
      onDisconnectPrompt: () => {
        setSelectedAssetEdgeId(undefined);
        setNodes((current) => current.map((candidate) => candidate.id === node.id
          ? { ...candidate, data: { ...candidate.data, promptSource: undefined } }
        : candidate));
      },
    };
    const referenceRuntime: ReferenceMediaNodeRuntime = {
      ...runtime,
      references: node.type === "image" ? imageReferenceViews(node, nodes, libraryAssets) : videoReferenceViews(node, nodes, libraryAssets),
      maxReferences: node.type === "image" ? imageReferenceLimit(node, imageModels) : videoReferenceLimit(selectedVideoModel(node, videoModels), node.data.referenceMode),
      uploading: uploadingNodeId === node.id,
      accept: "image/png,image/jpeg,image/webp",
      addLabel: t("assetCanvas.addReferences"),
      onRemoveReference: (index) => {
        setSelectedAssetEdgeId(undefined);
        setNodes((current) => current.map((candidate) => candidate.id === node.id && candidate.type === "image"
          ? { ...candidate, data: { ...candidate.data, images: (candidate.data.images ?? []).filter((_, candidateIndex) => candidateIndex !== index) } }
          : candidate.id === node.id && candidate.type === "video"
            ? { ...candidate, data: compatibleVideoDraft({ ...candidate.data, references: (candidate.data.references ?? []).filter((_, candidateIndex) => candidateIndex !== index) }, videoModels) }
          : candidate));
      },
      onUploadReferences: (files) => node.type === "image" ? void uploadReferenceImages(node, files) : void uploadVideoReferences(node, files),
      libraryImages: node.type === "image" ? staticImageReferences : libraryImages,
      onReloadLibrary: reloadLibraryAssets,
      onAddLibraryReference: (asset) => addLibraryReference(node, asset),
    };
    return {
      ...node,
      data: node.type === "image"
        ? { ...node.data, imageRuntime: {
          ...referenceRuntime, models: imageModels, providers: imageProviders,
          ...(managed ? {
            managed,
            onViewOriginal: () => void useOriginalCharacterView(managed),
            ...(onAskAgent ? { onPrepareRevision: () => onAskAgent(
              `Prepare a new ${managed.direction} standing-view revision for character set ${managed.setId}, within design revision ${managed.designRevision}. Keep the prior view revision ${managed.viewRevision} and its original request and result. Use prepare_character_views in plan mode for this direction only. Stop after preparing the new Canvas node and show me its prompt and references for review before generating or publishing anything.`,
            ) } : {}),
          } : {}),
        } satisfies ImageNodeRuntime }
        : { ...node.data, videoRuntime: { ...referenceRuntime, models: videoModels, providers: videoProviders } satisfies VideoNodeRuntime },
    };
  });

  function applyEditorCanvas(next: AssetCanvasDocument): void {
    next = { ...next, editorLayout: { ...next.editorLayout, viewport: latestCanvas.current?.editorLayout.viewport ?? next.editorLayout.viewport } };
    validateAssetCanvasDocument(next);
    observeHistoryDocument(next);
    setViewport(next.viewport);
    const previous = new Map(nodesRef.current.map((node) => [node.id, node]));
    setNodes(next.nodes.map((node) => toFlowNode(node, imageModels, videoModels, previous.get(node.id))));
    setEdges(next.edges);
    setEditorLayout(next.editorLayout);
  }

  const confirmationJob = mediaConfirmation && canvasJobs[mediaConfirmation.nodeId];
  const confirmationType = confirmationJob?.toolId === "generate-video" ? "newVideo" : confirmationJob?.toolId === "generate-image" || confirmationJob?.toolId === "image-to-3d" || confirmationJob?.toolId === "animate-3d" ? "newMedia" : "newAudio";
  const confirmationRecovery = recoveryLabel(confirmationJob);
  const confirmationNode = mediaConfirmation && nodes.find(node => node.id === mediaConfirmation.nodeId);
  const imageConfirmation = confirmationNode?.type === "image" && isGptImage26(confirmationNode.data.model?.id) ? confirmationNode.data : undefined;

  return (
    <section className="viewer-pane interactive-story-workspace" hidden={hidden} aria-label={t("canvas.assetCanvasWorkspace")}>
      {expandedTextId && nodes.find((node) => node.id === expandedTextId)?.type === "text" ? <div className="design-expanded-document" role="dialog" aria-modal="true" aria-label={t("assetCanvas.expandedText")}>
        <header className="design-expanded-toolbar"><FileText size={16} /><strong>{t("assetCanvas.node.text")}</strong></header>
        <div className="design-expanded-body"><CanvasTextarea autoFocus aria-label={t("assetCanvas.expandedText")} value={nodes.find((node) => node.id === expandedTextId)?.data.text ?? ""} onChange={(text) => setNodes((current) => current.map((node) => node.id === expandedTextId ? { ...node, data: { ...node.data, text } } : node))} /></div>
        <button type="button" className="design-expanded-close" title={t("canvas.backToCanvas")} aria-label={t("canvas.backToCanvas")} onClick={() => setExpandedTextId(undefined)}><X size={16} /></button>
      </div> : null}
      <div className="interactive-story-body">
        <div ref={canvasElement} tabIndex={0} inert={resolving || undefined} aria-busy={resolving || undefined} className={`interactive-story-canvas${selectedNodes.length === 1 ? " has-single-selection" : ""}${fileDropActive ? " is-file-drop-active" : ""}`} onPointerMoveCapture={(event) => { pointer.current = { x: event.clientX, y: event.clientY }; }}
          onPointerDownCapture={(event) => { if (!isTextEntry(event.target) && !eventWithin(event, "button, a, .nokey")) event.currentTarget.focus({ preventScroll: true }); }}
          onCopy={copySelection} onCut={(event) => copySelection(event, true)} onPaste={pasteFromClipboard}
          onKeyDown={(event) => {
            if (phase !== "ready" || isTextEntry(event.target) || eventWithin(event, ".nokey")) return;
            // React Flow's keyboard activation does not emit onNodeClick.
            if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLElement && event.target.matches(".react-flow__node")) {
              const nodeId = event.target.dataset.id;
              if (nodeId) activateNode(nodeId);
            }
            pasteNativeFiles(event, (files) => { void importCanvasFiles(files, transferPosition()); }, (cause) => setTransferError(errorMessage(cause)));
          }}
          onDragEnter={(event) => { if (!hasTransferredFiles(event.dataTransfer)) return; event.preventDefault(); dragDepth.current++; setFileDropActive(true); }}
          onDragOver={(event) => { if (!hasTransferredFiles(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
          onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setFileDropActive(false); }}
          onDrop={(event) => {
            if (!hasTransferredFiles(event.dataTransfer)) return;
            event.preventDefault(); dragDepth.current = 0; setFileDropActive(false);
            if (phase !== "ready") return;
            const at = flowInstance.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 96, y: 96 };
            void importCanvasFiles(transferredFiles(event.dataTransfer), at);
          }}>
          {overlay}
          {fileDropActive ? <div className="canvas-file-drop-overlay"><Upload size={18} /><span>{t("assetCanvas.dropFiles")}</span></div> : importingAssets ? <div className="canvas-file-import-status" role="status"><LoaderCircle size={13} className="spin" /><span>{t("assetCanvas.importing")}</span></div> : null}
          {phase === "loading" ? <div className="story-canvas-state">{t("assetCanvas.loading")}</div> : null}
          {phase === "error" ? <div className="story-canvas-state story-canvas-state-error" role="alert"><span>{t("assetCanvas.loadFailed", { error: loadError })}</span><button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>{t("assetCanvas.reload")}</button></div> : null}
          {phase === "ready" ? (
            <EditorCanvas<AssetCanvasFlowNode>
              nodes={renderedNodes}
              edges={[...edges, ...assetEdges]}
              nodeTypes={STORY_NODE_TYPES}
              onInit={(instance) => { flowInstance.current = instance; }}
              addControl={<AssetCanvasAddControl
                project={project}
                documents={documents} tables={tables}
                audioOperations={audioOperations}
                libraryAssets={libraryAssets.filter((asset) => asset.mediaType === "image" || asset.mediaType === "video" || asset.mediaType === "audio" || asset.mediaType === "model")}
                onReloadLibrary={reloadLibraryAssets}
                importing={importingAssets}
                onAdd={addNode}
                onAddAsset={addAssetNode}
                onUpload={(files, position) => void importAssetFiles(files, position)}
              />}
              onOpenMenu={setCanvasContextMenu}
              addOnDoubleClick
              deleteKeyCode={["Backspace", "Delete"]}
              onNodesChange={onNodesChange}
              onNodeDragStart={(event, _node, dragged) => {
                setCanvasContextMenu(undefined); beginHistoryGesture();
                altDragCopies.current = undefined;
                if (event.altKey) startAltDragDuplicate(dragged);
              }}
              onNodeDragStop={(_event, _node, dragged) => { finishAltDragDuplicate(dragged); finishHistoryGesture(); }}
              onMoveStart={() => setCanvasContextMenu(undefined)}
              onEdgesChange={onEdgesChange}
              onBeforeDelete={async ({ nodes, edges }) => canRemoveCanvasItems(new Set(nodes.map((node) => node.id)), edges)}
              onConnect={onConnect}
              onMoveEnd={(_event, viewport) => setEditorLayout((current) => ({ ...current, viewport }))}
              onEdgeClick={(_event, edge) => setSelectedAssetEdgeId(edge.id.startsWith(ASSET_EDGE_PREFIX) ? edge.id : undefined)}
              onSelectionStart={() => setMarqueeActive(true)}
              onSelectionEnd={() => {
                setMarqueeActive(false);
                setMarqueeSelectedIds(new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id)));
              }}
              onNodeClick={(event, node) => {
                activateNode(node.id);
                // XYFlow skips click selection on nodrag regions when drag-start selection is enabled.
                if (!event.shiftKey && !event.metaKey && !event.ctrlKey) setNodes((current) => current.map((candidate) => candidate.selected === (candidate.id === node.id) ? candidate : { ...candidate, selected: candidate.id === node.id }));
                if (eventWithin(event, ".story-media-view-button")) openViewer(node);
              }}
              // Only the preview opens the viewer; the prompt, chips, and video controls below keep their own double-click.
              onNodeDoubleClick={(event, node) => { if (eventWithin(event, ".story-media-stage")) openViewer(node); }}
              onPaneClick={() => { setCanvasContextMenu(undefined); clearSelection(); }}
              onNodeContextMenu={(_event, node) => {
                activateNode(node.id);
                setNodes((current) => current.map((candidate) => ({ ...candidate, selected: candidate.id === node.id })));
              }}
              onNodesDelete={(deleted) => {
                removeCanvasNodes(new Set(deleted.map((node) => node.id)));
                finishHistoryGesture();
              }}
              isValidConnection={(connection) => {
                const target = nodes.find((node) => node.id === connection.target);
                const source = nodes.find((node) => node.id === connection.source);
                return Boolean(source && target && connectionRelation(source, target, connection.sourceHandle, nodes, libraryAssets, imageModels, model3DModels));
              }}
              defaultViewport={editorLayout.viewport}
              fitViewOnLoad={editorLayout.fitView === true}
              revealNodeIds={revealNodeIds}
              onInitialFit={finishInitialFit}
            />
          ) : null}
          {canvasContextMenu ? <AssetCanvasContextMenu
            documents={documents} tables={tables}
            audioOperations={audioOperations}
            onUseInDocument={contextMenuNode?.type === "text" && contextMenuNode.data.text ? () => documents.appendText(contextMenuNode.data.text!) : contextMenuNode?.data.assetId && (contextMenuNode.type === "image" || contextMenuNode.data.mediaType === "image") ? () => documents.appendImage(contextMenuNode.data.assetId!) : undefined}
            menu={canvasContextMenu}
            canUndo={canUndo}
            canRedo={canRedo}
            canPaste={canInsertCopiedNode}
            canDuplicate={Boolean(contextMenuNode)}
            canView={Boolean(contextMenuNode && viewableCanvasAsset(contextMenuNode))}
            canDownload={Boolean(contextMenuNode?.data.assetId)}
            canSendToProject={Boolean(contextMenuNode?.data.assetId)}
            nodeActionsDisabled={Boolean(contextMenuNodeMissing)}
            importing={importingAssets}
            onClose={() => setCanvasContextMenu(undefined)}
            onDetails={contextMenuNode ? () => setNodeDetails({ id: contextMenuNode.id, title: contextMenuNode.title ?? "", description: contextMenuNode.description ?? "" }) : undefined}
            onUndo={undoEditorChange}
            onRedo={redoEditorChange}
            onPaste={() => { const value = lastCanvasClipboard(); if (value) pasteSelection(value, canvasContextMenu.flowPosition); }}
            onAdd={(item) => addCanvasNode(item, canvasContextMenu.flowPosition)}
            onUpload={(files) => void importAssetFiles(files, canvasContextMenu.flowPosition)}
            onView={() => { if (contextMenuNode) openViewer(contextMenuNode); }}
            onDownload={() => { if (contextMenuNode?.data.assetId) downloadAsset(contextMenuNode.data.assetId, assetDownloadName(contextMenuNode.data.assetId, contextMenuNode.id)); }}
            onSendToProject={() => { if (contextMenuNode?.data.assetId) sendAssetToProject(contextMenuNode.data.assetId, contextMenuNode.data.name || titleCase(contextMenuNode.type ?? "asset")); }}
            onCopy={() => { if (canvasContextMenu.nodeId) copyCanvasNode(canvasContextMenu.nodeId); }}
            onDuplicate={() => { if (canvasContextMenu.nodeId) duplicateCanvasNode(canvasContextMenu.nodeId); }}
            onDelete={() => { if (canvasContextMenu.nodeId) removeCanvasNodes(new Set([canvasContextMenu.nodeId])); }}
          /> : null}
          {notice && phase === "ready" && !conflicted ? <CanvasNotice className="story-save-notice" tone={notice.kind === "save" ? "error" : "neutral"} message={notice.kind === "save" ? t("assetCanvas.saveFailed") : t("canvas.actionFailed")} detail={notice.message} actionLabel={t("canvas.retrySave")} onAction={notice.kind === "save" ? flush : undefined} onDismiss={() => setNotice(undefined)} /> : null}
          {!notice && transferError && phase === "ready" ? <CanvasNotice className="story-save-notice canvas-transfer-error" message={t("assetCanvas.transferFailed")} detail={transferError} onDismiss={() => setTransferError(undefined)} /> : null}
        </div>
      </div>
      {expanded && expandedDocument ? <div className="design-expanded-document" role="dialog" aria-modal="true" aria-label={expanded.title}>
        <ExpandedCanvasDocument design={documents} document={expanded}
          references={expandedNode ? nodeReferencesRuntime(expandedNode) : undefined}
          referenceSource={expandedNode ? { boardId: storage.boardId, nodeId: expandedNode.id } : undefined} />
        <button className="design-expanded-close" type="button" title={t("canvas.backToCanvas")} aria-label={t("canvas.backToCanvas")} disabled={expandedDocument.busy} onClick={expandedDocument.onClose}><X size={16} /></button>
      </div> : null}
      {viewedAsset ? <CanvasAssetViewer
        asset={viewedAsset}
        name={assetDownloadName(viewedAsset.assetId, viewedAsset.nodeId)}
        onDownload={(name) => downloadAsset(viewedAsset.assetId, name)}
        onSendToProject={(name) => sendAssetToProject(viewedAsset.assetId, name)}
        onClose={() => setViewedAsset(undefined)}
        {...(viewedAsset.mediaType === "video" ? { trimmer: {
          loadSource: (signal?: AbortSignal, contentSha256?: string) => assetBlob(viewedAsset.assetId, signal, contentSha256),
          onSave: (video: Blob, trim: VideoTrim) => saveTrimmedVideoNode(viewedAsset, libraryAssets.find((candidate) => candidate.id === viewedAsset.assetId)?.name ?? "video", video, trim),
        } } : {})}
      /> : null}
      {sentAsset ? <SendToProjectDialog assetId={sentAsset.assetId} name={sentAsset.name} onClose={() => setSentAsset(undefined)} /> : null}
      {folderPrompt ? createPortal(<FolderImportDialog folders={folderPrompt.folders} onAnswer={folderPrompt.answer} />, window.document.body) : null}
      {nodeDetails ? createPortal(<div className="design-modal-backdrop nokey" onPointerDown={(event) => { if (event.target === event.currentTarget) setNodeDetails(undefined); }}><section className="design-modal" role="dialog" aria-modal="true" aria-label={t("assetCanvas.nodeDetails")} onKeyDown={(event) => { if (event.key === "Escape") setNodeDetails(undefined); }}>
        <header><h2>{t("assetCanvas.nodeDetails")}</h2><button type="button" title={t("common.close")} aria-label={t("common.close")} onClick={() => setNodeDetails(undefined)}><X size={16} /></button></header>
        <form onSubmit={(event) => { event.preventDefault(); setNodes((current) => current.map((node) => node.id === nodeDetails.id ? { ...node, title: nodeDetails.title.trim() || undefined, description: nodeDetails.description.trim() || undefined } : node)); setNodeDetails(undefined); }}>
          <label>{t("common.name")}<input autoFocus maxLength={200} value={nodeDetails.title} placeholder={t("assetCanvas.automaticName")} onChange={(event) => setNodeDetails({ ...nodeDetails, title: event.target.value })} /></label>
          <label>{t("publish.description")}<textarea rows={3} maxLength={2000} value={nodeDetails.description} onChange={(event) => setNodeDetails({ ...nodeDetails, description: event.target.value })} /></label>
          {nodeDetails.job?.model ? <p><strong>{t("assetCanvas.generationModel")}</strong><br />{nodeDetails.job.model.provider}/{nodeDetails.job.model.id}</p> : null}
          {nodeDetails.job?.sources ? <div><strong>{t("assetCanvas.generationSources")}</strong>{nodeDetails.job.sources.length ? <ul>{nodeDetails.job.sources.map(source => <li key={source.assetId} title={source.assetId}>{source.name}</li>)}</ul> : <p>{t("assetCanvas.generationFromText")}</p>}</div> : null}
          <code className="canvas-node-id">{nodeDetails.id}</code>
          <footer><button type="button" onClick={() => setNodeDetails(undefined)}>{t("common.cancel")}</button><button type="submit">{t("common.save")}</button></footer>
        </form>
      </section></div>, window.document.body) : null}
      {mediaConfirmation ? <CanvasConfirmationDialog title={t(`assetCanvas.${confirmationType}Title`)} onClose={() => answerMediaConfirmation("cancel")} actions={<>
        <button type="button" data-autofocus onClick={() => answerMediaConfirmation("cancel")}>{t("common.cancel")}</button>
        {confirmationRecovery ? <button type="button" onClick={() => answerMediaConfirmation("recover")}>{t(confirmationRecovery)}</button> : null}
        <button type="button" onClick={() => answerMediaConfirmation("new")}>{t("assetCanvas.newVideoConfirm")}</button>
      </>}><p>{t(`assetCanvas.${confirmationType}Description`)}</p>
        {imageConfirmation ? <p>
          {imageConfirmation.model?.id} · {(imageConfirmation.outputFormat ?? "png").toUpperCase()} · {t(imageConfirmation.background === "transparent" ? "kunpoModels.transparent" : imageConfirmation.background === "opaque" ? "kunpoModels.opaque" : "kunpoModels.backgroundAuto")}<br />
          {imageConfirmation.pixelSize ?? (imageConfirmation.outputFormat === "gif" ? gptImage26FrameSize(imageConfirmation.aspectRatio) : [imageConfirmation.resolution, imageConfirmation.aspectRatio].filter(Boolean).join(" · "))}
          {imageConfirmation.outputFormat === "gif" ? ` · ${t("kunpoModels.animationSummary", { frames: imageConfirmation.frameCount ?? GPT_IMAGE_26_DEFAULTS.frameCount, ms: imageConfirmation.frameDurationMs ?? GPT_IMAGE_26_DEFAULTS.frameDurationMs })}` : ""}
        </p> : null}
      </CanvasConfirmationDialog> : null}
    </section>
  );
}

export function canvasHistoryKey(canvas: AssetCanvasDocument): string {
  return JSON.stringify({ viewport: canvas.viewport, nodes: canvas.nodes, edges: canvas.edges }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

function TextNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.textRuntime;
  return (
    <div className={`story-node story-text-node${selected ? " is-selected" : ""}`}>
      <CanvasNodeResizer selected={selected} runtime={data.resizeRuntime} />
      <div data-alignment-frame className="story-text-output">
        <CanvasNodeLabel icon={FileText} label={t("assetCanvas.node.text")} details={data.nodeDetails} />
        <CanvasTextarea
          className={selected ? "nodrag nowheel" : "nodrag"}
          aria-label={t("assetCanvas.textOutput")}
          rows={5}
          value={data.text ?? ""}
          disabled={runtime?.busy}
          readOnly={!selected}
          placeholder={t("assetCanvas.textPlaceholder")}
          onChange={(text) => runtime?.onChange({ ...data, textRuntime: undefined, text })}
        />
        <footer className={`design-document-node-footer nodrag nowheel${selected ? "" : " is-hidden"}`}><span /><div className="design-document-node-actions"><CanvasNodeSizeActions runtime={data.resizeRuntime} /></div></footer>
      </div>
      {data.panelOpen ? (
        <div className="canvas-node-auxiliary">
        <CanvasTextComposer models={runtime?.models ?? []} modelStatus={runtime?.modelStatus ?? "loading"} defaultModel={runtime?.defaultModel} defaultReasoningLevel={runtime?.defaultReasoningLevel}
          references={runtime ? <CanvasNodeReferenceStrip {...runtime} /> : null}
          model={data.textModel} reasoningLevel={data.reasoningLevel} instruction={data.instruction ?? ""} generating={runtime?.generating} busy={runtime?.busy} error={runtime?.error}
          onInstruction={(instruction) => runtime?.onChange({ ...data, textRuntime: undefined, instruction })}
          onModel={(textModel, reasoningLevel) => runtime?.onChange({ ...data, textRuntime: undefined, textModel, reasoningLevel })}
          onReasoningChange={(reasoningLevel) => runtime?.onChange({ ...data, textRuntime: undefined, textModel: data.textModel ?? runtime.defaultModel, reasoningLevel })}
          onGenerate={(model, reasoningLevel) => runtime?.onGenerate(model, reasoningLevel)} />
        </div>
      ) : null}
      <Handle className="story-text-output-handle" id="references" type="target" position={Position.Left} />
      <Handle className="story-text-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function ImageNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.imageRuntime;
  const [networkCheck, setNetworkCheck] = useState<ImageDownloadNetworkStatus["state"] | "checking">();
  const checkingNetwork = useRef(false);
  useEffect(() => { setNetworkCheck(undefined); }, [runtime?.error]);
  const checkNetwork = async () => {
    if (checkingNetwork.current) return;
    checkingNetwork.current = true; setNetworkCheck("checking");
    try { setNetworkCheck((await inspectImageDownloadNetwork()).state); }
    catch { setNetworkCheck("unavailable"); }
    finally { checkingNetwork.current = false; }
  };
  const selectedModel = runtime?.models.find((model) => sameImageModel(model, data.model));
  const modern = Boolean(selectedModel?.complexities?.length);
  const format = data.outputFormat ?? "png";
  const isGif = modern && format === "gif";
  const isSvg = modern && format === "svg";
  const [settingsReset, setSettingsReset] = useState(false);
  const [invalidDrafts, setInvalidDrafts] = useState<Partial<Record<"pixelSize" | "outputCompression" | "frameDurationMs", string>>>({});
  useEffect(() => setInvalidDrafts({}), [selectedModel?.id, format]);
  const modelOptions = selectedModel?.generationOptions ?? [];
  const resolutions = [...new Set(modelOptions.map((option) => option.resolution))];
  const aspectRatios = [...new Set(modelOptions
    .filter((option) => option.resolution === data.resolution)
    .map((option) => option.aspectRatio))];

  const referenceLimit = selectedModel?.maxReferenceImages ?? IMAGE_MAX_REFERENCE_IMAGES;
  const referenceCount = data.images?.length ?? 0;
  const referenceError = selectedModel && referenceCount > referenceLimit ? t("assetCanvas.modeLimit", { limit: referenceLimit })
    : !modern && data.mask && !referenceCount ? t("kunpoModels.maskNeedsReference") : undefined;
  const optionError = modern ? validateGptImage26Settings(selectedModel?.id, data, referenceCount, 1, key => t(`kunpoModels.imageProblem.${key}`))
    ?? (runtime?.references.some(ref => ref.contentType && !["image/png", "image/jpeg", "image/webp"].includes(ref.contentType)) ? t("kunpoModels.referenceFormats") : undefined) : undefined;
  const compatible = selectedModel ? compatibleImageSettings(data, selectedModel) : undefined;
  const incompatible = compatible && (Object.keys(compatible) as (keyof CanvasImageSettings)[]).some((key) => data[key] !== undefined && data[key] !== compatible[key]);
  const canGenerate = !runtime?.busy && !runtime?.generating && Boolean(effectivePrompt(data, runtime).trim() && selectedModel && !referenceError && !optionError && !incompatible && !Object.keys(invalidDrafts).length);

  function update(settings: Partial<CanvasImageSettings>) {
    setSettingsReset(false);
    runtime?.onChange({ ...data, imageRuntime: undefined, ...settings });
  }

  function inputField(field: keyof typeof invalidDrafts, label: string, placeholder: string, min?: number, max?: number) {
    const hint = field === "pixelSize" ? t("kunpoModels.pixelHint") : t("kunpoModels.integerRange", { min, max });
    return <label className="story-inspector-field">
      <span>{label}</span>
      <input aria-label={label} aria-invalid={invalidDrafts[field] !== undefined} title={hint} inputMode={field === "pixelSize" ? "text" : "numeric"}
        placeholder={placeholder} disabled={runtime?.busy} value={invalidDrafts[field] ?? data[field] ?? ""} onChange={(event) => {
          const raw = event.currentTarget.value;
          const next = field === "pixelSize" ? raw.trim().toLowerCase().replace("×", "x") : Number(raw);
          const valid = !raw || (field === "pixelSize"
            ? !validateGptImage26Settings(selectedModel?.id, { pixelSize: String(next) }, 0)
            : /^\d+$/.test(raw) && Number.isInteger(next) && Number(next) >= min! && Number(next) <= max!);
          setInvalidDrafts((previous) => {
            const drafts = { ...previous };
            if (valid) delete drafts[field]; else drafts[field] = raw;
            return drafts;
          });
          if (valid) update({ [field]: raw ? next : undefined });
        }} />
      {invalidDrafts[field] !== undefined ? <span role="alert">{hint}</span> : null}
    </label>;
  }

  function layerPicker(field: "mask" | "markup") {
    const ref = data[field];
    if (!ref && (isSvg || isGif || (field === "mask" ? data.markup : data.mask))) return null;
    return <CanvasChipSelect label={t(field === "mask" ? "kunpoModels.mask" : "kunpoModels.markup")}
      value={ref?.type === "library" ? ref.assetId : ref?.type === "node" ? `node:${ref.nodeId}` : ""}
      options={[{ value: "", label: t(field === "mask" ? "kunpoModels.noMask" : "kunpoModels.noMarkup") }, ...(ref?.type === "node" ? [{ value: `node:${ref.nodeId}`, label: t("assetCanvas.node.image"), disabled: true }] : []),
        ...(runtime?.libraryImages ?? []).filter((asset) => asset.contentType === "image/png").map((asset) => ({ value: asset.id, label: asset.name }))]}
      disabled={runtime?.busy || !referenceCount && !ref} onChange={(assetId) => update({ [field]: assetId ? { type: "library", assetId } : undefined })} />;
  }

  function selectModel(key: string): void {
    const model = runtime?.models.find((candidate) => !isMeshyModelReference(candidate) && modelRefKey(candidate) === key);
    const option = model?.generationOptions.find((candidate) => candidate.resolution === data.resolution && candidate.aspectRatio === data.aspectRatio)
      ?? preferredImageOption(model, data.aspectRatio);
    if (!model || !runtime) return;
    const settings = compatibleImageSettings(data, model);
    setSettingsReset((Object.keys(settings) as (keyof CanvasImageSettings)[]).some(key => data[key] !== undefined && data[key] !== settings[key]));
    runtime.onChange({ ...data, imageRuntime: undefined, model: { provider: model.provider, id: model.id }, ...settings, ...(option ? { resolution: option.resolution, aspectRatio: option.aspectRatio } : {}) });
  }

  function selectResolution(resolution: ImageResolution): void {
    const option = selectedModel?.generationOptions.find((candidate) => candidate.resolution === resolution && candidate.aspectRatio === data.aspectRatio)
      ?? selectedModel?.generationOptions.find((candidate) => candidate.resolution === resolution);
    if (!option || !runtime) return;
    runtime.onChange({ ...data, imageRuntime: undefined, resolution: option.resolution, aspectRatio: option.aspectRatio });
  }

  const managed = runtime?.managed;
  if (managed) return (
    <MediaNodeShell kind="image" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} assetAspectRatio={data.assetAspectRatio} aspectRatio={data.aspectRatio} runtime={runtime} details={data.nodeDetails}>
      <p className="story-media-status is-neutral" role="status">{t(`assetCanvas.characterView.${managed.state}`, { direction: managed.direction, revision: managed.viewRevision })}</p>
      {runtime.error ? <p className="story-media-status" role="alert">{imageRecoveryMessage(runtime.error)}</p> : null}
      <div className="story-media-controls">
        {managed.state === "available" || managed.state === "recoverable" ? <button type="button" className="canvas-chip story-media-recover" disabled={runtime.busy} onClick={runtime.onViewOriginal}>
          {managed.state === "available" ? <Maximize size={12} aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
          {t(managed.state === "available" ? "assetCanvas.characterView.viewOriginal" : "assetCanvas.characterView.recoverOriginal")}
        </button> : null}
        {runtime.onPrepareRevision && managed.state !== "preparing" && managed.state !== "running" ? <button type="button" className="canvas-chip" disabled={runtime.busy} onClick={runtime.onPrepareRevision}>{t("assetCanvas.characterView.prepareRevision")}</button> : null}
        {managed.state === "ready" || managed.state === "not-submitted" || managed.state === "running" && runtime.onCancel ? <GenerateMediaButton kind="image" runtime={runtime} disabled={runtime.busy} /> : null}
      </div>
    </MediaNodeShell>
  );

  return (
    <MediaNodeShell kind="image" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} assetAspectRatio={data.assetAspectRatio} aspectRatio={data.aspectRatio} runtime={runtime} details={data.nodeDetails}>
      <MediaReferenceStrip runtime={runtime} />
      <MediaPrompt
        kind="image"
        value={data.prompt ?? ""}
        runtime={runtime}
        onSubmit={canGenerate ? runtime?.onGenerate : undefined}
        onChange={(prompt) => runtime?.onChange({ ...data, imageRuntime: undefined, prompt })}
      />
      {networkCheck && networkCheck !== "checking" ? <p className={`story-media-status${networkCheck === "ready" ? " is-neutral" : ""}`} role="status">{t(`assetCanvas.imageNetwork.${networkCheck}`)}</p> : runtime?.error ? <p className={`story-media-status${isImageWaitCancelled(runtime.error) ? " is-neutral" : ""}`} role={isImageWaitCancelled(runtime.error) ? "status" : "alert"} aria-label={imageRecoveryMessage(runtime.error)} title={imageRecoveryMessage(runtime.error)}>{imageRecoveryMessage(runtime.error, true)}</p> : null}
      {referenceError || optionError ? <p className="story-media-status" role="alert">{referenceError ?? optionError}</p> : null}
      {settingsReset ? <p role="status" className="canvas-chip-menu-note">{t("kunpoModels.settingsReset")}</p> : null}
      {incompatible ? <p className="canvas-chip-menu-note">{t("kunpoModels.incompatibleSettings")} <button type="button" className="canvas-chip" disabled={runtime?.busy} onClick={() => { runtime?.onChange({ ...data, ...compatible }); }}>{t("kunpoModels.resetSettings")}</button></p> : null}
      <div className="story-media-controls">
        <CanvasChipSelect
          label={t("assetCanvas.imageModel")}
          wide
          value={selectedModel ? modelRefKey(selectedModel) : undefined}
          placeholder={data.model ? t("assetCanvas.unavailableModel") : runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.noImageModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelRefKey(model), label: mediaModelName(model), group: model.providerName }))}
          notes={providerNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={selectModel}
        />
        {!data.pixelSize && selectedModel?.supportsAspectRatio !== false ? <CanvasChipSelect
          label={t("assetCanvas.imageAspect")}
          value={data.aspectRatio}
          options={aspectRatios.map((ratio) => ({ value: ratio, label: ratio }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(aspectRatio) => runtime?.onChange({ ...data, imageRuntime: undefined, aspectRatio })}
        /> : null}
        {!isGif && !data.pixelSize && selectedModel?.supportsResolution !== false ? <CanvasChipSelect
          label={t("assetCanvas.imageResolution")}
          value={data.resolution}
          options={resolutions.map((resolution) => ({ value: resolution, label: resolution }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={selectResolution}
        /> : null}
        {selectedModel?.qualities?.length ? <CanvasChipSelect label={t("kunpoModels.quality")} value={data.quality ?? "auto"}
          options={selectedModel.qualities.map((quality) => ({ value: quality, label: t(`kunpoModels.qualities.${quality}`), shortLabel: `${t("kunpoModels.quality")} · ${t(`kunpoModels.qualities.${quality}`)}` }))} disabled={runtime?.busy}
          onChange={(quality) => runtime?.onChange({ ...data, quality: quality as ImageGenerationSettings["quality"] })} /> : null}
        {selectedModel?.outputFormats?.length ? <CanvasChipSelect label={t("kunpoModels.format")} value={data.outputFormat ?? "png"}
          options={selectedModel.outputFormats.map((value) => ({ value, label: value === "webp" ? "WebP" : value.toUpperCase() }))} disabled={runtime?.busy}
          onChange={(outputFormat) => update({ outputFormat,
            ...(outputFormat !== "jpeg" && outputFormat !== "webp" ? { outputCompression: undefined } : {}),
            ...(!modern && outputFormat === "jpeg" && data.background === "transparent" ? { background: "opaque" } : {}),
            ...(outputFormat !== "svg" ? { svgModel: undefined, svgReasoningEffort: undefined } : {}),
            ...(outputFormat !== "gif" ? { frameCount: undefined, frameDurationMs: undefined } : {}),
          })} /> : null}
        {selectedModel?.supportsTransparency ? <CanvasChipSelect label={t("kunpoModels.background")} value={data.background ?? "auto"}
          options={(["auto", "opaque", "transparent"] as const).map((background) => { const label = t(background === "auto" ? "kunpoModels.automatic" : `kunpoModels.${background}`); return { value: background, label, shortLabel: `${t("kunpoModels.background")} · ${label}` }; })} disabled={runtime?.busy}
          onChange={(background) => update({ background, ...(!modern && background === "transparent" ? { outputFormat: "png", outputCompression: undefined } : {}) })} /> : null}
        {!modern && selectedModel?.supportsMask ? layerPicker("mask") : null}
        {modern ? <details className="story-image-options nodrag nopan nowheel nokey">
          <summary>{t("kunpoModels.imageOptions")}</summary>
          <div className="story-media-controls">
            <CanvasChipSelect label={t("kunpoModels.complexity")} value={data.complexity ?? GPT_IMAGE_26_DEFAULTS.complexity} disabled={runtime?.busy}
              options={selectedModel!.complexities!.map(value => ({ value, label: t(`kunpoModels.qualities.${value}`), shortLabel: `${t("kunpoModels.complexity")} · ${t(`kunpoModels.qualities.${value}`)}` }))}
              onChange={(complexity) => update({ complexity })} />
            {isSvg ? <>
              <CanvasChipSelect label={t("kunpoModels.svgAuthor")} value={data.svgModel ?? GPT_IMAGE_26_DEFAULTS.svgModel} disabled={runtime?.busy}
                options={GPT_IMAGE_SVG_MODELS.map(value => ({ value, label: value }))} onChange={(svgModel) => update({ svgModel })} />
              <CanvasChipSelect label={t("kunpoModels.svgEffort")} value={data.svgReasoningEffort ?? GPT_IMAGE_26_DEFAULTS.svgReasoningEffort} disabled={runtime?.busy}
                options={GPT_IMAGE_SVG_EFFORTS.filter(value => value !== "none" || data.svgModel !== "gpt-6.1-sol").map(value => ({ value, label: value, shortLabel: `${t("kunpoModels.svgEffort")} · ${value}` }))} onChange={(svgReasoningEffort) => update({ svgReasoningEffort })} />
            </> : null}
            {selectedModel?.supportsMask ? layerPicker("mask") : null}
            {selectedModel?.supportsMarkup ? layerPicker("markup") : null}
          </div>
          <div className="story-image-fields">
            {inputField("pixelSize", t(isGif ? "kunpoModels.frameSize" : "kunpoModels.pixelSize"), isGif ? gptImage26FrameSize(data.aspectRatio) : t("kunpoModels.automatic"))}
            {format === "jpeg" || format === "webp" ? inputField("outputCompression", t("kunpoModels.compression"), t("kunpoModels.automatic"), 0, 100) : null}
            {isGif ? <>
              <label className="story-inspector-field"><span>{t("kunpoModels.frameCount")}</span><select value={data.frameCount ?? GPT_IMAGE_26_DEFAULTS.frameCount} disabled={runtime?.busy}
                onChange={(event) => update({ frameCount: Number(event.currentTarget.value) })}>{Array.from({ length: 15 }, (_, index) => <option key={index} value={index + 2}>{index + 2}</option>)}</select></label>
              {inputField("frameDurationMs", t("kunpoModels.frameDuration"), String(GPT_IMAGE_26_DEFAULTS.frameDurationMs), 20, 2000)}
            </> : null}
          </div>
        </details> : null}
        {networkCheck || runtime?.error && /Fake-IP|Image CDN|provider artifact address|download failed/.test(runtime.error) ? <button className="canvas-chip story-media-recover nodrag nopan" type="button" disabled={runtime?.busy || networkCheck === "checking"} title={t("assetCanvas.imageNetworkHint")} onClick={() => void checkNetwork()}>{networkCheck === "checking" ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <Search size={12} aria-hidden="true" />}<span>{t(networkCheck === "checking" ? "assetCanvas.imageNetworkChecking" : "assetCanvas.imageNetworkCheck")}</span></button> : null}
        {runtime?.onRecover || runtime?.recovering ? <button className="canvas-chip story-media-recover nodrag nopan" type="button" disabled={runtime.busy || runtime.recovering} title={t("assetCanvas.recoverImageHint")} onClick={runtime.onRecover}><Download size={12} aria-hidden="true" /><span>{t("assetCanvas.recoverImage")}</span></button> : null}
        <GenerateMediaButton kind="image" assetId={data.assetId} runtime={runtime} disabled={!canGenerate} />
      </div>
    </MediaNodeShell>
  );
}

export function compatibleImageSettings(data: CanvasImageSettings, model: ImageModel): CanvasImageSettings {
  const modern = Boolean(model.complexities?.length);
  const quality = model.qualities?.includes(data.quality ?? "auto") ? data.quality : model.qualities?.includes("auto") ? "auto" : model.qualities?.[0];
  const background = model.supportsTransparency ? data.background : undefined;
  const outputFormat = !modern && background === "transparent" ? "png" : model.outputFormats?.includes(data.outputFormat ?? "png") ? data.outputFormat : model.outputFormats?.[0];
  return {
    quality, outputFormat, background, outputCompression: outputFormat === "jpeg" || outputFormat === "webp" ? data.outputCompression : undefined,
    mask: model.supportsMask ? data.mask : undefined, markup: model.supportsMarkup ? data.markup : undefined,
    complexity: modern ? data.complexity : undefined, pixelSize: modern ? data.pixelSize : undefined,
    svgModel: modern && outputFormat === "svg" ? data.svgModel : undefined, svgReasoningEffort: modern && outputFormat === "svg" ? data.svgReasoningEffort : undefined,
    frameCount: modern && outputFormat === "gif" ? data.frameCount : undefined, frameDurationMs: modern && outputFormat === "gif" ? data.frameDurationMs : undefined,
  };
}

export function VideoNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.videoRuntime;
  const selectedModel = runtime?.models.find((model) => sameModel(model, data.videoModel));
  const aspectRatios = videoAspectRatios(selectedModel, data.references?.length ?? 0, data.referenceMode);
  const mode = videoReferenceMode(selectedModel, data.referenceMode);
  const references = data.references ?? [];
  const needsFirstFrame = Boolean(selectedModel && mode === "frame" && references.length === 0);
  // Display the empty frame slot's constraint without rewriting a saved draft or task.
  const displayedAspectRatio = needsFirstFrame && aspectRatios.length === 1 ? aspectRatios[0] : data.videoAspectRatio;
  const aliases = videoReferenceAliases(references, data.referenceMentions);
  const mentionOptions = references.map((reference, index) => ({
    alias: Object.keys(aliases).find((alias) => sameVideoReference(aliases[alias]!, reference))!,
    name: runtime?.references[index]?.name ?? t("assetCanvas.imageNumber", { number: index + 1 }),
    assetId: runtime?.references[index]?.assetId,
  }));
  let referenceError: string | undefined;
  try { resolveVideoMentions(effectivePrompt(data, runtime), references, aliases); }
  catch (cause) { referenceError = errorMessage(cause); }
  const limit = videoReferenceLimit(selectedModel, data.referenceMode);
  if (selectedModel && references.length > limit) referenceError = t("assetCanvas.modeLimit", { limit });

  const incompatibleAspect = Boolean(selectedModel && !aspectRatios.includes(data.videoAspectRatio as VideoAspectRatio));
  const canGenerate = !runtime?.busy && !runtime?.generating && Boolean(effectivePrompt(data, runtime).trim() && selectedModel && !referenceError && !incompatibleAspect && !needsFirstFrame);

  function selectModel(key: string): void {
    const model = runtime?.models.find((candidate) => modelKey(candidate) === key);
    if (!model || !runtime) return;
    const referenceMode = model.referenceModes?.includes(data.referenceMode!) ? data.referenceMode : model.imageReferenceMode;
    runtime.onChange({
      ...data,
      videoRuntime: undefined,
      videoModel: { provider: model.provider, id: model.id },
      videoResolution: model.resolutions.includes(data.videoResolution as VideoResolution) ? data.videoResolution : model.resolutions[0],
      videoAspectRatio: videoAspectRatios(model, data.references?.length ?? 0, referenceMode).includes(data.videoAspectRatio as VideoAspectRatio)
        ? data.videoAspectRatio
        : videoAspectRatios(model, data.references?.length ?? 0, referenceMode)[0],
      duration: model.durations.includes(data.duration ?? 0) ? data.duration : model.durations[0],
      referenceMode,
      references: data.references ?? [],
    });
  }

  return (
    <MediaNodeShell kind="video" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} assetAspectRatio={data.assetAspectRatio} aspectRatio={data.videoAspectRatio} runtime={runtime} details={data.nodeDetails}>
      <MediaReferenceStrip runtime={runtime ? { ...runtime, slotLabels: mode === "frame" ? [t("assetCanvas.firstFrame"), t("assetCanvas.lastFrame")] : mentionOptions.map((option) => `@${option.alias}`) } : undefined} />
      <VideoReferencePrompt
        value={data.prompt ?? ""}
        disabled={runtime?.busy}
        options={mentionOptions}
        onSubmit={canGenerate ? runtime?.onGenerate : undefined}
        onChange={(prompt) => runtime?.onChange({ ...data, videoRuntime: undefined, prompt, referenceMentions: aliases })}
      />
      {referenceError ? <p role="alert">{referenceError}</p> : null}
      {runtime?.error ? <p role="alert">{providerGenerationErrorMessage(runtime.error)}{runtime.notice ? ` ${runtime.notice}` : ""}</p> : null}
      {needsFirstFrame ? <p className="canvas-chip-menu-note" role="status">{t("assetCanvas.videoNeedsFirstFrame")}</p>
        : incompatibleAspect ? <p className="canvas-chip-menu-note" role="status">{t(references.length ? "assetCanvas.videoAspectIncompatible" : "assetCanvas.videoAspectNeedsReferences")}</p> : null}
      <div className="story-media-controls">
        <CanvasChipSelect
          label={t("assetCanvas.videoModel")}
          wide
          value={selectedModel ? modelKey(selectedModel) : undefined}
          placeholder={runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.noVideoModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelKey(model), label: mediaModelName(model), group: model.providerName }))}
          notes={providerNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={selectModel}
        />
        {selectedModel?.referenceModes?.length ? <CanvasChipSelect
          label={t("assetCanvas.referenceMode")} value={mode}
          options={selectedModel.referenceModes.map((value) => ({ value, label: value === "reference" ? t("assetCanvas.imageReferences") : t("assetCanvas.firstLast"),
            disabled: references.length > videoReferenceLimit(selectedModel, value), title: references.length > videoReferenceLimit(selectedModel, value) ? t("assetCanvas.modeLimit", { limit: videoReferenceLimit(selectedModel, value) }) : undefined }))}
          disabled={runtime?.busy}
          onChange={(value) => {
            const referenceMode = value as "frame" | "reference";
            const ratios = videoAspectRatios(selectedModel, references.length, referenceMode);
            const videoAspectRatio = ratios.includes(data.videoAspectRatio as VideoAspectRatio) ? data.videoAspectRatio : ratios[0];
            runtime?.onChange({ ...data, videoRuntime: undefined, referenceMode, videoAspectRatio });
          }}
        /> : null}
        <CanvasChipSelect
          label={t("assetCanvas.videoAspect")}
          value={displayedAspectRatio}
          placeholder={displayedAspectRatio}
          options={aspectRatios.map((ratio) => ({ value: ratio, label: ratio }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(videoAspectRatio) => { runtime?.onChange({ ...data, videoRuntime: undefined, videoAspectRatio }); }}
        />
        <CanvasChipSelect
          label={t("assetCanvas.videoResolution")}
          value={data.videoResolution}
          options={(selectedModel?.resolutions ?? []).map((resolution) => ({ value: resolution, label: resolution }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(videoResolution) => runtime?.onChange({ ...data, videoRuntime: undefined, videoResolution })}
        />
        <CanvasChipSelect
          label={t("assetCanvas.videoDuration")}
          value={data.duration === undefined ? undefined : String(data.duration)}
          options={(selectedModel?.durations ?? []).map((duration) => ({ value: String(duration), label: t("assetCanvas.seconds", { count: duration }) }))}
          disabled={!selectedModel || runtime?.busy}
          onChange={(duration) => runtime?.onChange({ ...data, videoRuntime: undefined, duration: Number(duration) })}
        />
        {runtime?.onRecover || runtime?.recovering ? <button className="canvas-chip story-media-recover nodrag nopan" type="button" disabled={runtime.busy || runtime.recovering} title={t("assetCanvas.recoverVideoHint")} onClick={runtime.onRecover}><Download size={12} aria-hidden="true" /><span>{t("assetCanvas.recoverVideo")}</span></button> : null}
        <GenerateMediaButton kind="video" assetId={data.assetId} runtime={runtime} disabled={!canGenerate} disabledReason={needsFirstFrame ? t("assetCanvas.videoNeedsFirstFrame") : undefined} />
      </div>
    </MediaNodeShell>
  );
}

function videoAspectRatios(model: VideoModel | undefined, referenceCount: number, mode?: "frame" | "reference"): readonly VideoAspectRatio[] {
  return videoReferenceAspectRatios(model, referenceCount, mode);
}

/** Only user edits call this; loading a node and recovering a task keep their saved inputs. */
export function compatibleVideoDraft(data: AssetCanvasFlowData, models: readonly VideoModel[]): AssetCanvasFlowData {
  const model = models.find((candidate) => sameModel(candidate, data.videoModel));
  if (!model) return data;
  const referenceMode = model.referenceModes?.includes(data.referenceMode ?? model.imageReferenceMode ?? "frame")
    ? data.referenceMode ?? model.imageReferenceMode : model.referenceModes?.[0] ?? model.imageReferenceMode;
  const aspectRatios = videoAspectRatios(model, data.references?.length ?? 0, referenceMode);
  return { ...data, referenceMode,
    videoAspectRatio: aspectRatios.includes(data.videoAspectRatio as VideoAspectRatio) ? data.videoAspectRatio : aspectRatios[0],
    videoResolution: model.resolutions.includes(data.videoResolution as VideoResolution) ? data.videoResolution : model.resolutions[0],
    duration: model.durations.includes(data.duration ?? 0) ? data.duration : model.durations[0] };
}

const SPEECH_SPEED_OPTIONS = [-50, -25, 0, 25, 50] as const;

function speechSpeedLabel(value: number): string {
  if (value === 0) return t("assetCanvas.speed.normal");
  if (value <= -50) return t("assetCanvas.speed.muchSlower");
  if (value < 0) return t("assetCanvas.speed.slower");
  if (value >= 50) return t("assetCanvas.speed.muchFaster");
  return t("assetCanvas.speed.faster");
}

export function VoiceNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.audioRuntime;
  const model = runtime?.models.find((candidate) => sameModel(candidate, data.audioModel));
  const canGenerate = !runtime?.busy && !runtime?.generating && Boolean(data.voiceDescription?.trim() && data.sampleText?.trim() && model?.capabilities.supportsVoiceDesign);
  return <MediaNodeShell kind="audio" label={t("assetCanvas.node.voice")} selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} runtime={runtime} details={data.nodeDetails}>
    <MediaPrompt kind="audio" label={t("assetCanvas.voiceDescription")} placeholder={t("assetCanvas.voiceDescriptionPlaceholder")} value={data.voiceDescription ?? ""} runtime={runtime} onChange={(voiceDescription) => runtime?.onChange({ ...data, voiceDescription })} onSubmit={canGenerate ? runtime?.onGenerate : undefined} />
    <MediaPrompt kind="audio" label={t("assetCanvas.voiceSampleText")} placeholder={t("assetCanvas.voiceSampleText")} value={data.sampleText ?? ""} runtime={runtime} onChange={(sampleText) => runtime?.onChange({ ...data, sampleText })} onSubmit={canGenerate ? runtime?.onGenerate : undefined} />
    {runtime?.error ? <p role="alert">{providerGenerationErrorMessage(runtime.error)}</p> : null}
    <div className="story-media-controls">
      <CanvasChipSelect label={t("assetCanvas.audioModel")} wide value={model ? modelRefKey(model) : undefined} placeholder={t("assetCanvas.selectModel")} options={(runtime?.models ?? []).map((candidate) => ({ value: modelRefKey(candidate), label: mediaModelName(candidate), group: candidate.providerName }))} disabled={runtime?.busy} onChange={(key) => { const candidate = runtime?.models.find((item) => modelRefKey(item) === key); if (candidate) runtime?.onChange({ ...data, audioModel: modelRef(candidate) }); }} />
      {data.assetId ? <button type="button" className="canvas-chip" disabled={runtime?.busy} onClick={runtime?.onSelectSample} title={t("assetCanvas.useVoiceSample")} aria-label={t("assetCanvas.useVoiceSample")}><Check size={14} />{t(data.selectedAssetId === data.assetId ? "assetCanvas.voiceSampleSelected" : "assetCanvas.useVoiceSample")}</button> : null}
      <GenerateMediaButton kind="audio" assetId={data.assetId} runtime={runtime} disabled={!canGenerate} />
    </div>
  </MediaNodeShell>;
}

export function SpeechNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.audioRuntime;
  const selectedModel = runtime?.models.find((model) => sameModel(model, data.audioModel));
  const canGenerate = !runtime?.busy && !runtime?.generating && Boolean(combineAssetCanvasPrompt(runtime?.linkedPrompt, data.text ?? "").trim() && selectedModel && (!data.referenceAssetId || selectedModel.capabilities.supportsReferenceAudio && runtime?.referenceReady) && (!data.voiceId || data.referenceAssetId) && selectedModel.capabilities.operationStatus?.speech !== "unavailable");

  function selectModel(key: string): void {
    const model = runtime?.models.find((candidate) => !isMeshyModelReference(candidate) && modelRefKey(candidate) === key);
    if (!model || !runtime) return;
    runtime.onChange({ ...data, audioRuntime: undefined, audioModel: { provider: model.provider, id: model.id } });
  }

  return (
    <MediaNodeShell kind="audio" textKind="speech" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} runtime={runtime} details={data.nodeDetails}>
      <MediaReferenceStrip runtime={runtime?.voiceReference} />
      {runtime?.onUpdateVoice ? <button className="canvas-chip" type="button" disabled={runtime.busy} onClick={runtime.onUpdateVoice} title={t("assetCanvas.updateVoice")} aria-label={t("assetCanvas.updateVoice")}><Undo2 size={14} />{t("assetCanvas.updateVoice")}</button> : null}
      {data.voiceId && !data.referenceAssetId ? <button className="canvas-chip" type="button" onClick={() => runtime?.onChange({ ...data, voiceId: undefined })}>{t("assetCanvas.noVoiceReference")}</button> : null}
      <MediaPrompt
        kind="audio"
        value={data.text ?? ""}
        label={t("assetCanvas.speechText")} placeholder={t("assetCanvas.speechTextPlaceholder")}
        runtime={runtime}
        onSubmit={canGenerate ? runtime?.onGenerate : undefined}
        onChange={(text) => runtime?.onChange({ ...data, audioRuntime: undefined, text })}
      />
      {runtime?.error ? <p role="alert">{providerGenerationErrorMessage(runtime.error)}</p> : null}
      <div className="story-media-controls">
        <CanvasChipSelect
          label={t("assetCanvas.audioModel")}
          wide
          value={selectedModel ? modelRefKey(selectedModel) : undefined}
          placeholder={data.audioModel ? t("assetCanvas.unavailableModel") : runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.noAudioModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelRefKey(model), label: mediaModelName(model), group: model.providerName }))}
          notes={audioProviderNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={selectModel}
        />
        <CanvasChipSelect
          label={t("assetCanvas.speechSpeed")}
          value={String(data.speed ?? 0)}
          options={SPEECH_SPEED_OPTIONS.map((value) => ({ value: String(value), label: speechSpeedLabel(value) }))}
          disabled={runtime?.busy}
          onChange={(value) => {
            const speed = Number(value);
            runtime?.onChange({ ...data, audioRuntime: undefined, speed: speed || undefined });
          }}
        />
        <GenerateMediaButton kind="speech" assetId={data.assetId} runtime={runtime} disabled={!canGenerate} disabledReason={data.referenceAssetId && !runtime?.referenceReady ? t("assetCanvas.audioReferenceInvalid") : data.voiceId && !data.referenceAssetId ? t("assetCanvas.legacyVoice") : undefined} />
      </div>
    </MediaNodeShell>
  );
}

function audioProviderNotes(providers: readonly AudioProviderCatalogStatus[] | undefined): CanvasChipNote[] {
  return (providers ?? []).flatMap((provider) => provider.state === "ready" || !provider.message ? [] : [{ group: provider.name, message: provider.message }]);
}

const AUDIO_DURATION_OPTIONS = [5, 10, 15, 30, 60, 120, 300, 600] as const;

function SoundEffectNode(props: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  return <PromptAudioNode {...props} operation="sound-effect" />;
}

function MusicNode(props: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  return <PromptAudioNode {...props} operation="music" />;
}

function PromptAudioNode({ data, selected, operation }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected"> & { operation: "sound-effect" | "music" }) {
  const runtime = data.audioRuntime;
  const selectedModel = runtime?.models.find((model) => sameModel(model, data.audioModel));
  const maximumDuration = selectedModel?.capabilities.maxDurationSeconds;
  const durations = AUDIO_DURATION_OPTIONS.filter((value) => maximumDuration === undefined || value <= maximumDuration);
  const durationOptions: number[] = data.durationSeconds !== undefined && !durations.some((duration) => duration === data.durationSeconds)
    ? [...durations, data.durationSeconds].sort((left, right) => left - right)
    : durations;
  const change = (next: Partial<AssetCanvasFlowData>) => runtime?.onChange({ ...data, ...next, audioRuntime: undefined });
  const selectModel = (key: string) => {
    const model = runtime?.models.find((candidate) => !isMeshyModelReference(candidate) && modelRefKey(candidate) === key);
    if (!model) return;
    const maxDuration = model.capabilities.maxDurationSeconds;
    change({
      audioModel: { provider: model.provider, id: model.id },
      ...(!model.capabilities.supportsLoop ? { loop: undefined } : {}),
      ...(!model.capabilities.supportsNegativePrompt ? { negativePrompt: undefined } : {}),
      ...(!model.capabilities.supportsLyrics ? { lyrics: undefined } : {}),
      ...(!model.capabilities.supportsInstrumental && operation === "music" ? { instrumental: true } : {}),
      ...(maxDuration !== undefined && data.durationSeconds !== undefined && data.durationSeconds > maxDuration ? { durationSeconds: maxDuration } : {}),
    });
  };
  const prompt = combineAssetCanvasPrompt(runtime?.linkedPrompt, data.prompt ?? "");
  const incompatible = Boolean(selectedModel && (data.loop && !selectedModel.capabilities.supportsLoop || data.lyrics && !selectedModel.capabilities.supportsLyrics || data.negativePrompt && !selectedModel.capabilities.supportsNegativePrompt || maximumDuration !== undefined && data.durationSeconds !== undefined && data.durationSeconds > maximumDuration));
  const canGenerate = !runtime?.busy && !runtime?.generating && Boolean(prompt.trim() && selectedModel && selectedModel.capabilities.operationStatus?.[operation] !== "unavailable" && !incompatible);
  const label = operation === "music" ? t("assetCanvas.node.music") : t("assetCanvas.node.soundEffect");

  return (
    <MediaNodeShell kind="audio" label={label} selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} runtime={runtime} details={data.nodeDetails}>
      <MediaPrompt
        kind="audio"
        label={operation === "music" ? t("assetCanvas.musicPrompt") : t("assetCanvas.soundEffectPrompt")}
        placeholder={operation === "music" ? t("assetCanvas.musicPromptPlaceholder") : t("assetCanvas.soundEffectPromptPlaceholder")}
        value={data.prompt ?? ""}
        runtime={runtime}
        onSubmit={canGenerate ? runtime?.onGenerate : undefined}
        onChange={(value) => change({ prompt: value })}
      />
      {operation === "sound-effect" && selectedModel?.capabilities.supportsNegativePrompt ? <CanvasTextarea
        aria-label={t("assetCanvas.negativePrompt")}
        rows={2}
        value={data.negativePrompt ?? ""}
        disabled={runtime?.busy}
        placeholder={t("assetCanvas.negativePromptPlaceholder")}
        onChange={(negativePrompt) => change({ negativePrompt: negativePrompt || undefined })}
      /> : null}
      {operation === "music" && selectedModel?.capabilities.supportsLyrics && data.instrumental === false ? <CanvasTextarea
        aria-label={t("assetCanvas.lyrics")}
        rows={3}
        value={data.lyrics ?? ""}
        disabled={runtime?.busy}
        placeholder={t("assetCanvas.lyricsPlaceholder")}
        onChange={(lyrics) => change({ lyrics: lyrics || undefined })}
      /> : null}
      {runtime?.error ? <p role="alert">{providerGenerationErrorMessage(runtime.error)}</p> : null}
      {operation === "music" && kunpoModelOption("music", selectedModel) ? <p className="canvas-chip-menu-note" title={t("kunpoModels.musicHelp")}>{t("kunpoModels.musicNotice")}</p> : null}
      {incompatible ? <p className="canvas-chip-menu-note">{t("kunpoModels.incompatibleSettings")} <button type="button" className="canvas-chip" disabled={runtime?.busy} onClick={() => selectedModel && selectModel(modelRefKey(selectedModel))}>{t("kunpoModels.resetSettings")}</button></p> : null}
      <div className="story-media-controls">
        <CanvasChipSelect
          label={t("assetCanvas.audioModel")}
          wide
          value={selectedModel ? modelRefKey(selectedModel) : undefined}
          placeholder={data.audioModel ? t("assetCanvas.unavailableModel") : runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.noCompatibleAudioModel")}
          options={(runtime?.models ?? []).map((model) => ({ value: modelRefKey(model), label: mediaModelName(model), group: model.providerName }))}
          notes={audioProviderNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={selectModel}
        />
        {durationOptions.length ? <CanvasChipSelect
          label={t("assetCanvas.audioDuration")}
          value={data.durationSeconds === undefined ? "" : String(data.durationSeconds)}
          options={[{ value: "", label: t("assetCanvas.automatic") }, ...durationOptions.map((duration) => ({ value: String(duration), label: t("assetCanvas.seconds", { count: duration }) }))]}
          disabled={!selectedModel || runtime?.busy}
          onChange={(value) => change({ durationSeconds: value ? Number(value) : undefined })}
        /> : null}
        {operation === "music" && selectedModel?.capabilities.supportsInstrumental ? <CanvasChipToggle
          label={t("assetCanvas.instrumental")}
          pressed={data.instrumental !== false}
          disabled={runtime?.busy}
          onChange={(instrumental) => change({ instrumental, ...(instrumental ? { lyrics: undefined } : {}) })}
        /> : null}
        {selectedModel?.capabilities.supportsLoop ? <CanvasChipToggle
          label={t("assetCanvas.loop")}
          pressed={data.loop === true}
          disabled={runtime?.busy}
          onChange={(loop) => change({ loop })}
        /> : null}
        <GenerateMediaButton kind="audio" assetId={data.assetId} runtime={runtime} disabled={!canGenerate} />
      </div>
    </MediaNodeShell>
  );
}

function audioOperationForNode(type: AssetCanvasNodeType): AudioOperation | undefined {
  if (type === "speech" || type === "voice") return "speech";
  if (type === "sound-effect" || type === "music") return type;
  return undefined;
}

export function canvasNodeTypeAvailable(type: AssetCanvasNodeType, audioOperations: ReadonlySet<AudioOperation>): boolean {
  const operation = audioOperationForNode(type);
  return operation === undefined || audioOperations.has(operation);
}

function Model3DNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.model3DRuntime;
  const unavailable = unavailableModel3DSelection({ type: "model-3d", data }, runtime?.models ?? []);
  const config = nodeModel3DConfig({ type: "model-3d", data });
  const selectedModel = nodeModel3D({ type: "model-3d", data }, runtime?.models ?? []);
  const operation = data.model3DOperation ?? "image";
  const basePolycount = operation === "remesh" ? remeshPolycount(selectedModel?.protocol) : selectedModel?.polycount;
  const quadLimit = selectedModel?.protocol === "tripo" && data.model3DOptions?.quad ? operation === "remesh" ? 10_000 : selectedModel.id === "P2-20260801" ? 25_000 : 150_000 : undefined;
  const polycount = basePolycount && quadLimit ? { ...basePolycount, max: Math.min(basePolycount.max, quadLimit), presets: basePolycount.presets.filter((value) => value <= quadLimit) } : basePolycount;
  const processing = operation === "retexture" || operation === "remesh";
  const hasInput = operation === "image" ? Boolean(data.images?.length) : operation === "text" ? Boolean(data.prompt?.trim() || runtime?.linkedPrompt?.trim())
    : Boolean(data.model3DSource) && (operation === "remesh" || (selectedModel?.protocol === "hyper3d" ? Boolean(data.images?.length) : Boolean(data.images?.length || data.prompt?.trim() || runtime?.linkedPrompt?.trim())));
  const canGenerate = !unavailable && !runtime?.busy && !runtime?.generating && !runtime?.viewIssue && Boolean(hasInput && selectedModel && !selectedModel.provider.startsWith("cloud-") && (!polycount || operation === "retexture" || config.targetPolycount >= polycount.min && config.targetPolycount <= polycount.max));
  const tripoInputPose = selectedModel?.protocol === "tripo" && operation === "image";
  const turnaround = requiresModelTurnaround(data.model3DOptions, selectedModel?.protocol, operation);
  const changeOperation = (operation: Exclude<Model3DOperation, "animate">) => {
    runtime?.onChange({ ...data, model3DOperation: operation, images: [], prompt: "", promptSource: undefined, model3DSource: undefined, model3DOptions: operation === "retexture" && selectedModel?.protocol === "tripo" ? { textureModel: runtime.modelSelections?.["3d-texture"]?.id ?? "v3.5-20260815" } : undefined });
  };
  const updateConfig = (next: Partial<Model3DGenerationConfig>) => runtime?.onChange({
    ...data,
    model3DRuntime: undefined,
    model3DConfig: normalizeModel3DConfig({ ...config, ...next }, processing
      ? resolveModel3DConnection(next.model ?? config.model, runtime.models) : resolveModel3D(next.model ?? config.model, runtime.models), operation),
  });
  return (
    <MediaNodeShell
      kind="model"
      selected={selected}
      panelOpen={data.panelOpen}
      assetId={data.assetId}
      runtime={runtime}
      details={data.nodeDetails}
      emptyHint={operation === "text" ? t("assetCanvas.hint.text3d") : operation === "retexture" ? t("assetCanvas.hint.retexture") : operation === "remesh" ? t("assetCanvas.hint.remesh") : undefined}
    >
      {processing ? <MediaReferenceStrip runtime={runtime?.sourceRuntime} large /> : null}
      {operation !== "remesh" ? <MediaReferenceStrip runtime={runtime} large /> : null}
      {operation === "text" || operation === "retexture" ? <MediaPrompt kind="model" value={data.prompt ?? ""} runtime={runtime} onSubmit={canGenerate ? runtime?.onGenerate : undefined} onChange={(prompt) => runtime?.onChange({ ...data, prompt })} /> : null}
      {unavailable ? <p role="status">{t("modelUsage.meshyUnavailable")}</p> : null}
      {runtime?.viewIssue ? <p role="status">{runtime.viewIssue}</p> : null}
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      <div className="story-media-controls is-3d">
        <CanvasChipSelect label={t("assetCanvas.operation")} value={operation} options={[
          { value: "image", label: t("assetCanvas.op.image") }, { value: "text", label: t("assetCanvas.op.text") }, { value: "retexture", label: t("assetCanvas.op.retexture") }, { value: "remesh", label: t("assetCanvas.op.remesh") },
        ]} disabled={runtime?.busy} onChange={(value) => changeOperation(value as Exclude<Model3DOperation, "animate">)} />
        <CanvasChipSelect
          label={processing ? t("assetCanvas.processingConnection") : t("assetCanvas.model3d")}
          wide
          value={selectedModel ? modelRefKey(selectedModel) : undefined}
          placeholder={processing ? t("assetCanvas.selectConnection") : runtime?.models.length ? t("assetCanvas.selectModel") : t("assetCanvas.no3dModel")}
          options={(runtime?.models ?? []).filter((model) => !isMeshyModelReference(model)).map((model) => ({ value: modelRefKey(model), label: model.name, group: model.id === MODEL3D_CONNECTION_ID ? undefined : model.providerName }))}
          notes={providerNotes(runtime?.providers)}
          action={MANAGE_PROVIDERS}
          disabled={runtime?.busy}
          onChange={(key) => {
            const model = runtime?.models.find((candidate) => !isMeshyModelReference(candidate) && modelRefKey(candidate) === key);
            const referenceMode = turnaround ? "turnaround" : data.model3DOptions?.referenceMode;
            if (model) { runtime?.onChange({ ...data, model3DOptions: operation === "image" && referenceMode ? { referenceMode, ...(tripoInputPose && model.protocol === "tripo" ? { pose: data.model3DOptions?.pose } : {}) } : undefined, model3DConfig: normalizeModel3DConfig({ ...config, model: modelRef(model), targetPolycount: model.polycount.default,
              texture: model.defaults?.texture ?? model.supportsTexture !== false, pbr: model.defaults?.pbr ?? false }, model, operation) }); }
          }}
        />
        {operation === "image" ? <CanvasChipSelect label={t("assetCanvas.modelViewMode")} value={turnaround ? "turnaround" : "provided-views"}
          options={[{ value: "provided-views", label: t("assetCanvas.providedViews"), disabled: tripoInputPose && Boolean(data.model3DOptions?.pose) }, { value: "turnaround", label: t("assetCanvas.turnaroundViews") }]}
          disabled={runtime?.busy} onChange={(referenceMode) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, referenceMode } })} /> : null}
        {operation !== "retexture" ? <CanvasChipSelect
          label={t("assetCanvas.polycount")}
          value={String(config.targetPolycount)}
          options={polycountOptions(polycount?.presets ?? [], config.targetPolycount)}
          disabled={runtime?.busy || !selectedModel}
          onChange={(value) => updateConfig({ targetPolycount: Number(value) })}
        /> : null}
        {operation === "image" || operation === "text" ? <CanvasChipToggle label={t("assetCanvas.texture")} pressed={config.texture} disabled={runtime?.busy || !selectedModel || selectedModel.supportsTexture === false} onChange={(texture) => updateConfig({ texture, ...(!texture ? { pbr: false } : {}) })} /> : null}
        {operation !== "remesh" ? <CanvasChipToggle label="PBR" pressed={config.pbr} disabled={runtime?.busy || !selectedModel || !config.texture || selectedModel.supportsPbr === false} onChange={(pbr) => updateConfig({ pbr })} /> : null}
        {selectedModel?.protocol === "tripo" && operation !== "retexture" ? <CanvasChipToggle label={t("kunpoModels.quad")} pressed={data.model3DOptions?.quad ?? false}
          disabled={runtime?.busy || ["P1-20260311", "v2.5-20250123"].includes(selectedModel.id)} onChange={(quad) => { const max = operation === "remesh" ? 10_000 : selectedModel.id === "P2-20260801" ? 25_000 : 150_000; runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, quad }, model3DConfig: { ...config, targetPolycount: quad ? Math.min(config.targetPolycount, max) : config.targetPolycount } }); }} /> : null}
        {selectedModel?.protocol === "tripo" && operation === "remesh" ? <CanvasChipToggle label={t("kunpoModels.smartUv")} pressed={data.model3DOptions?.smartUv ?? false} disabled={runtime?.busy} onChange={(smartUv) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, smartUv } })} /> : null}
        {(operation === "image" || operation === "text") && (selectedModel?.protocol === "meshy" || selectedModel?.protocol === "hyper3d" || tripoInputPose) ? <CanvasChipSelect
          label={t(tripoInputPose ? "assetCanvas.referencePose" : "assetCanvas.pose")} value={data.model3DOptions?.pose ?? "default"}
          options={[{ value: "default", label: t(tripoInputPose ? "assetCanvas.anyReferencePose" : "assetCanvas.defaultPose") },
            { value: "t-pose", label: t(tripoInputPose ? "assetCanvas.tPoseViews" : selectedModel.protocol === "hyper3d" ? "assetCanvas.atPose" : "assetCanvas.tPose") },
            ...(selectedModel.protocol !== "hyper3d" ? [{ value: "a-pose", label: t(tripoInputPose ? "assetCanvas.aPoseViews" : "assetCanvas.aPose") }] : [])]}
          onChange={(pose) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, pose: pose === "default" ? undefined : pose as Model3DOptions["pose"] } })} disabled={runtime?.busy} /> : null}
        {operation === "retexture" && selectedModel?.protocol === "tripo" ? <CanvasChipSelect label={t("assetCanvas.textureVersion")} value={data.model3DOptions?.textureModel ?? (selectedModel?.protocol === "tripo" ? "v3.5-20260815" : "latest")} options={(selectedModel?.protocol === "tripo" ? ["v3.5-20260815", "v3.0-20250812", "v2.5-20250123"] : ["latest", "meshy-7", "meshy-6", "meshy-6-lite"]).map((version) => ({ value: version, label: version }))} disabled={runtime?.busy} onChange={(textureModel) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, textureModel } })} /> : null}
        {operation === "retexture" && selectedModel?.protocol === "tripo" ? <CanvasChipSelect label={t("assetCanvas.textureQuality")} value={data.model3DOptions?.textureQuality ?? "standard"} options={(["fast", "standard", "detailed", "extreme"] as const).map((value) => ({ value, label: t(`assetCanvas.textureQualities.${value}`) }))} disabled={runtime?.busy} onChange={(textureQuality) => runtime?.onChange({ ...data, model3DOptions: { ...data.model3DOptions, textureQuality: textureQuality as Model3DOptions["textureQuality"] } })} /> : null}
        <GenerateMediaButton kind="model" assetId={data.assetId} runtime={runtime} disabled={!canGenerate} disabledReason={unavailable ? t("modelUsage.meshyUnavailable") : runtime?.viewIssue} />
        {runtime?.onRecover ? <button className="canvas-chip story-media-recover" type="button" disabled={runtime.busy || unavailable} onClick={runtime.onRecover}>{t("kunpoModels.recoverModel")}</button> : null}
      </div>
      {selectedModel?.protocol === "hyper3d" && operation === "retexture" ? <small>{t("assetCanvas.hyper3dRetexture")}</small> : null}
      {operation === "image" && selectedModel?.estimatedCredits !== undefined ? <div className="canvas-model-generation-label">{t("assetCanvas.apiKeyCredits", { credits: selectedModel.estimatedCredits })}</div> : null}
    </MediaNodeShell>
  );
}

function AssetNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const kind = data.mediaType ?? "image";
  const [modelPlayback, setModelPlayback] = useModelPlayback(data.assetId);
  const [element, visible] = useNearViewport<HTMLDivElement>(true);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [data.assetId]);
  const preview = useWorkspaceAssetUrl(undefined, "", 0, visible || selected || playing ? data.assetId : undefined);
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => { const element = image.current; return () => releaseImage(element, preview.url); }, [preview.url]);
  const Icon = kind === "video" ? Film : kind === "audio" ? Music2 : kind === "model" ? Box : ImageIcon;
  const mediaLayout = useMediaNodeLayout(data.assetId, data.assetAspectRatio);
  const style = kind === "audio" ? { "--story-media-width": "300px", "--story-media-height": "132px" } as CSSProperties : mediaLayout.style;
  return (
    <div ref={element} className={`story-node story-media-node story-library-asset-node story-library-${kind}-node${selected ? " is-selected" : ""}`} style={style}>
      <CanvasNodeLabel icon={Icon} label={data.name || titleCase(kind)} details={data.nodeDetails} trailing={<small>{data.assetOrigin === "Project" ? t("assetCanvas.project") : t("assetCanvas.library")}</small>} />
      <div data-alignment-frame className="story-media-stage">
        {preview.url && kind !== "audio" ? <MediaViewButton /> : null}
        {preview.url && kind === "image" ? <img ref={image} src={preview.url} alt={data.name || t("assetCanvas.libraryImage")} onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} onPlayingChange={setPlaying} /> : null}
        {preview.url && kind === "model" ? <ModelPreview source={preview.url} label={data.name || "3D model"} minHeight={220} interactive autoRotate rotationPerSecond="10deg" animate playback={modelPlayback} onPlaybackChange={setModelPlayback} /> : null}
        {preview.url && kind === "audio" ? <CanvasAudio src={preview.url} onPlayingChange={setPlaying} /> : null}
        {!preview.url ? <div className="story-media-empty"><Icon size={34} /><strong>{data.assetError || preview.error ? t("assetCanvas.assetUnavailable") : t("assetCanvas.loadingAsset")}</strong>{data.assetError ? <span>{data.assetError}</span> : <CanvasAssetRecovery preview={preview} />}</div> : null}
      </div>
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
    </div>
  );
}

function FileNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const filePath = data.path ?? "";
  const name = filePath.split("/").at(-1) || t(data.directory ? "assetCanvas.folder" : "assetCanvas.file");
  const extension = data.directory ? "" : fileExtension(name).slice(1).toUpperCase();
  const Icon = data.directory ? Folder : Package;
  return (
    <div className={`story-node story-media-node story-file-node${selected ? " is-selected" : ""}`} style={{ "--story-media-width": "300px", "--story-media-height": "150px" } as CSSProperties}>
      <CanvasNodeLabel icon={Icon} label={name} details={data.nodeDetails} trailing={data.directory ? <small>{t("assetCanvas.folder")}</small> : extension ? <small>{extension}</small> : undefined} />
      <div data-alignment-frame className="story-media-stage">
        <div className="story-media-empty">
          <Icon size={30} />
          <span title={filePath}>{filePath}</span>
          {data.fileRuntime?.onReveal ? <button className="canvas-asset-retry nodrag" type="button" onClick={data.fileRuntime.onReveal}>{t("assetCanvas.showInFolder")}</button> : null}
        </div>
      </div>
    </div>
  );
}

function FolderImportDialog({ folders, onAnswer }: { folders: DroppedFolder[]; onAnswer: (choice: "folder" | "files" | undefined) => void }) {
  const files = folders.reduce((count, folder) => count + folder.files.length, 0);
  const size = formatBytes(folders.reduce((bytes, folder) => bytes + folder.bytes, 0));
  return (
    <CanvasConfirmationDialog title={t("assetCanvas.folderImportTitle", { count: folders.length })} onClose={() => onAnswer(undefined)} actions={<>
      <button type="button" onClick={() => onAnswer(undefined)}>{t("common.cancel")}</button>
      <button type="button" onClick={() => onAnswer("files")}>{t("assetCanvas.importFilesSeparately")}</button>
      <button type="button" data-autofocus onClick={() => onAnswer("folder")}>{t("assetCanvas.importFolder", { count: folders.length })}</button>
    </>}>
        <p>{folders.length === 1
          ? tNodes(files === 1 ? "assetCanvas.folderImportOneFile" : "assetCanvas.folderImportFiles", { name: <strong>{folders[0]!.name}</strong>, count: files, size })
          : t("assetCanvas.folderImportMany", { folders: folders.length, count: files, size })}</p>
        <p>{t("assetCanvas.folderImportHint")}</p>
    </CanvasConfirmationDialog>
  );
}

function CanvasConfirmationDialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: ReactNode; onClose(): void }) {
  const id = useId(), dialog = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="design-modal-backdrop nokey" onPointerDown={(event) => { if (event.target === event.currentTarget) close.current(); }}>
    <section ref={dialog} className="design-modal" role="alertdialog" aria-modal="true" aria-labelledby={id} aria-describedby={`${id}-body`} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><h2 id={id}>{title}</h2></header><div id={`${id}-body`}>{children}</div><footer>{actions}</footer>
    </section>
  </div>, document.body);
}

const CHARACTER_HEIGHTS = [1, 1.2, 1.5, 1.7, 1.8, 2];

function Animate3DNode({ data, selected }: Pick<NodeProps<AssetCanvasFlowNode>, "data" | "selected">) {
  const runtime = data.animateRuntime;
  const unavailable = unavailableModel3DSelection({ type: "animate-3d", data }, runtime?.models ?? []);
  const selectedModel = data.animationModel ? resolveModel3DConnection(data.animationModel, runtime?.models ?? []) : undefined;
  const [pickerOpen, setPickerOpen] = useState(false);
  const actionIds = data.actionIds ?? [];
  const actionLimit = selectedModel?.protocol === "tripo" ? 5 : MAX_ANIMATION_ACTIONS;
  const selectionError = actionIds.length > actionLimit ? t("assetCanvas.animationTooManyMoves", { max: actionLimit }) : undefined;
  const height = data.heightMeters ?? DEFAULT_CHARACTER_HEIGHT_METERS;
  const heights = CHARACTER_HEIGHTS.includes(height) ? CHARACTER_HEIGHTS : [...CHARACTER_HEIGHTS, height].sort((a, b) => a - b);
  const update = (next: Partial<AssetCanvasFlowData>) => runtime?.onChange({ ...data, animateRuntime: undefined, ...next });
  return (
    <MediaNodeShell kind="animation" selected={selected} panelOpen={data.panelOpen} assetId={data.assetId} runtime={runtime} details={data.nodeDetails} emptyHint={t("assetCanvas.hint.animate")}>
      <MediaReferenceStrip runtime={runtime} large />
      {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
      {unavailable ? <p role="status">{t("modelUsage.meshyUnavailable")}</p> : null}
      {selectionError ? <p role="alert">{selectionError}</p> : null}
      <div className="story-media-controls is-3d">
        <CanvasChipSelect label={t("assetCanvas.animationProvider")} value={selectedModel ? modelRefKey(selectedModel) : undefined} placeholder={t("assetCanvas.selectAnimationProvider")} options={(runtime?.models ?? []).filter((model) => !isMeshyModelReference(model)).map((model) => ({ value: modelRefKey(model), label: model.name, group: model.id === MODEL3D_CONNECTION_ID ? undefined : model.providerName }))} disabled={runtime?.busy} action={MANAGE_PROVIDERS} onChange={(value) => {
          const model = runtime?.models.find((model) => !isMeshyModelReference(model) && modelRefKey(model) === value);
          if (model) { update({ animationModel: modelRef(model), actionIds: [], model3DOptions: model.protocol === "tripo" ? { rigModel: "v3.0-20260909", rigType: "biped" } : undefined }); }
        }} />
        {selectedModel?.protocol === "tripo" ? <>
          <CanvasChipSelect label={t("assetCanvas.rigVersion")} value={data.model3DOptions?.rigModel ?? "v1.0-20240301"} options={[{ value: "v1.0-20240301", label: "v1.0-20240301" }, { value: "v2.5-20260210", label: "v2.5-20260210" }, { value: "v3.0-20260909", label: "v3.0-20260909" }]} disabled={runtime?.busy} onChange={(rigModel) => { update({ model3DOptions: { ...data.model3DOptions, rigModel: rigModel as Model3DOptions["rigModel"], rigType: "biped" }, actionIds: [] }); }} />
          {data.model3DOptions?.rigModel && data.model3DOptions.rigModel !== "v1.0-20240301" ? <CanvasChipSelect label={t("assetCanvas.rigType")} value={data.model3DOptions.rigType ?? "biped"} options={tripoRigTypes(data.model3DOptions.rigModel).map((value) => ({ value, label: t(`assetCanvas.rigTypes.${value}`), disabled: value === "others" || value === "avian", title: value === "others" || value === "avian" ? t("kunpoModels.rigOnlyPending") : undefined }))} disabled={runtime?.busy} onChange={(rigType) => { update({ model3DOptions: { ...data.model3DOptions, rigType: rigType as Model3DOptions["rigType"] }, actionIds: [] }); }} /> : null}
          <CanvasChipToggle label={t("assetCanvas.inPlace")} pressed={data.model3DOptions?.animateInPlace ?? false} disabled={runtime?.busy} onChange={(animateInPlace) => update({ model3DOptions: { ...data.model3DOptions, animateInPlace } })} />
        </> : null}
        <button className="canvas-chip" type="button" disabled={runtime?.busy || unavailable || !selectedModel} onClick={() => setPickerOpen(true)}>
          <WandSparkles size={12} /><span>{t("assetCanvas.moveCount", { count: actionIds.length })}</span>
        </button>
        {selectedModel?.protocol !== "tripo" ? <CanvasChipSelect
          label={t("assetCanvas.characterHeight")}
          value={String(height)}
          options={heights.map((value) => ({ value: String(value), label: t("assetCanvas.meters", { value }) }))}
          disabled={runtime?.busy}
          onChange={(value) => update({ heightMeters: Number(value) })}
        /> : null}
        {runtime?.onRecover ? <button className="canvas-chip story-media-recover" type="button" disabled={runtime.busy || unavailable} onClick={runtime.onRecover}>{t("kunpoModels.recoverModel")}</button> : null}
        <GenerateMediaButton kind="animation" assetId={data.assetId} runtime={runtime} disabled={unavailable || !selectedModel || !data.images?.length || actionIds.length === 0 || actionIds.length > actionLimit} disabledReason={unavailable ? t("modelUsage.meshyUnavailable") : selectionError} />
      </div>
      {pickerOpen && runtime ? (
        <AnimationActionPicker
          model={selectedModel}
          options={data.model3DOptions}
          selectedIds={actionIds}
          onChange={(next) => update({ actionIds: next })}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </MediaNodeShell>
  );
}

export function tripoRigTypes(version: Model3DOptions["rigModel"]): NonNullable<Model3DOptions["rigType"]>[] {
  if (version === "v1.0-20240301") return ["biped"];
  if (version === "v3.0-20260909") return ["biped", "others"];
  return ["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others"];
}

function AnimationActionPicker({ model, options, selectedIds, onChange, onClose }: {
  model?: Model3DModel;
  options?: Model3DOptions;
  selectedIds: Model3DActionId[];
  onChange: (actionIds: Model3DActionId[]) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<{ key: string; actions: Model3DAnimationAction[]; status: "loading" | "ready" | "error" }>({ key: "", actions: [], status: "loading" });
  const [reload, setReload] = useState(0);
  const provider = model?.provider, id = model?.id;
  const rigModel = options?.rigModel, rigType = options?.rigType;
  const key = JSON.stringify([provider, id, rigModel, rigType]);
  const actions = state.key === key ? state.actions : [];
  const status = state.key === key ? state.status : "loading";
  const hasPreviews = actions.some((action) => action.previewUrl);
  useEffect(() => {
    let active = true;
    if (!provider || !id || isMeshyModelReference(model)) return;
    setState({ key, actions: [], status: "loading" });
    void listModel3DAnimations({ provider, id }, rigModel || rigType ? {
      ...(rigModel ? { rigModel } : {}), ...(rigType ? { rigType } : {}),
    } : undefined)
      .then((actions) => { if (active) setState({ key, actions, status: "ready" }); })
      .catch(() => { if (active) setState({ key, actions: [], status: "error" }); });
    return () => { active = false; };
  }, [key, reload, provider, id, rigModel, rigType]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>();
  const dialog = useRef<HTMLElement>(null);
  // The parent passes a fresh onClose on every render (e.g. when clicking the dialog selects the node); depending on
  // it would re-run this effect and pull focus out of the search field mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  const categories = useMemo(() => [...new Set(actions.map((action) => action.category))], [actions]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return actions.filter((action) => (!category || action.category === category)
      && (!normalized || `${action.name} ${action.subCategory}`.toLowerCase().includes(normalized)));
  }, [actions, category, query]);
  const byId = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);
  const actionLimit = model?.protocol === "tripo" ? 5 : MAX_ANIMATION_ACTIONS;
  const full = selectedIds.length >= actionLimit;
  const toggle = (id: Model3DActionId) => onChange(selectedIds.includes(id) ? selectedIds.filter((candidate) => candidate !== id) : [...selectedIds, id]);

  return createPortal(
    // Keys typed here (search, Backspace) must not reach React Flow's delete shortcut.
    <div className="story-video-picker-backdrop nokey" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="story-video-picker story-animation-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="story-animation-picker-title" tabIndex={-1}>
        <header><h2 id="story-animation-picker-title">{t("assetCanvas.chooseMoves")}</h2><button type="button" aria-label={t("assetCanvas.closePicker")} onClick={onClose}><X size={16} /></button></header>
        <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assetCanvas.searchMoves")} /></label>
        <div className="story-animation-picker-filters">
          {status === "ready" && actions.length > 0 && !hasPreviews ? <p className="story-animation-picker-note">{t("assetCanvas.noPreviews", { provider: model?.providerName ?? t("assetCanvas.thisProvider") })}</p> : null}
          {categories.length > 1 || category ? <div className="story-animation-picker-categories" role="group" aria-label={t("assetCanvas.moveCategories")}>
            <button className="canvas-chip is-toggle" type="button" aria-pressed={!category} onClick={() => setCategory(undefined)}>{t("common.all")}</button>
            {categories.map((name) => (
              <button className="canvas-chip is-toggle" type="button" key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>{splitCamelCase(name)}</button>
            ))}
          </div> : null}
        </div>
        <div className={`story-animation-picker-grid${!hasPreviews ? " is-list" : ""}`}>
          {!model ? <p>{tNodes("assetCanvas.setupProvider", { link: <button type="button" onClick={MANAGE_PROVIDERS.onSelect}>{t("modelSelector.manage")}</button> })}</p>
            : status === "loading" ? <p><LoaderCircle className="spin" size={16} /> {t("assetCanvas.loadingMoves")}</p>
            : status === "error" ? <p>{t("assetCanvas.movesFailed")} <button type="button" onClick={() => setReload((value) => value + 1)}>{t("common.tryAgain")}</button></p>
            : visible.length === 0 ? <p>{t("assetCanvas.noMovesMatch")}</p>
            : visible.map((action) => {
              const chosen = selectedIds.includes(action.id);
              return (
                <button type="button" key={action.id} className={!action.previewUrl ? "story-animation-picker-text-move" : undefined} aria-pressed={chosen} disabled={!chosen && full} onClick={() => toggle(action.id)} title={`${action.name} · ${splitCamelCase(action.subCategory)}`}>
                  {action.previewUrl ? <span className="story-animation-picker-preview">
                    <img src={action.previewUrl} alt="" loading="lazy" />
                    {chosen ? <span className="story-animation-picker-check"><Check size={12} /></span> : null}
                  </span> : null}
                  <strong>{action.name}</strong>
                  {!action.previewUrl ? <span className="story-animation-picker-selection" aria-hidden="true">{chosen ? <Check size={12} /> : null}</span> : null}
                </button>
              );
            })}
        </div>
        <footer>
          <span>{t(model?.protocol === "meshy" ? "assetCanvas.animationBatchSelection" : "assetCanvas.animationSelection", { count: selectedIds.length, max: actionLimit, batchSize: ANIMATION_ACTIONS_PER_REQUEST })}</span>
          <div className="story-animation-picker-selected" aria-label={t("assetCanvas.selectedMoves")}>
            {selectedIds.length === 0 ? <span>{t("assetCanvas.noMovesSelected")}</span> : selectedIds.map((id) => (
              <button className="canvas-chip" type="button" key={id} title={t("assetCanvas.removeMove")} onClick={() => toggle(id)}>
                <span>{byId.get(id)?.name ?? t("assetCanvas.moveId", { id })}</span><X size={11} />
              </button>
            ))}
          </div>
          <button className="story-animation-picker-done" type="button" onClick={onClose}>{t("common.done")}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

/** Meshy names categories in CamelCase ("WalkAndRun", and once "AttackingwithWeapon"); spaced words read better. */
function splitCamelCase(value: string): string {
  return value.replace(/([a-z])with([A-Z])/g, "$1With$2").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function MediaPrompt({ kind, label, placeholder, value, runtime, onChange, onSubmit }: {
  kind: "image" | "video" | "audio" | "model";
  label?: string;
  placeholder?: string;
  value: string;
  runtime?: MediaNodeRuntime;
  onChange: (prompt: string) => void;
  onSubmit?: () => void;
}) {
  return (
    <CanvasTextarea
      aria-label={label ?? t(`assetCanvas.media.${kind}.prompt`)}
      rows={3}
      value={value}
      disabled={runtime?.busy}
      placeholder={placeholder ?? t(`assetCanvas.media.${kind}.placeholder`)}
      onChange={onChange}
      onSubmit={onSubmit}
    />
  );
}

function MediaReferenceStrip({ runtime, large = false }: { runtime?: ReferenceStripRuntime; large?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState<"add" | { index: number; key: string }>();
  const references = runtime?.references ?? [];
  if (!runtime || (runtime.linkedPrompt === undefined && references.length === 0 && runtime.maxReferences === 0)) return null;
  // References fill positions in order, so only the next open slot takes an upload; later slots just show what can follow.
  const remainingSlots = runtime.slotLabels?.slice(references.length) ?? [];
  const [nextSlot, ...laterSlots] = remainingSlots;
  const addLabel = nextSlot ? t("assetCanvas.addSlot", { slot: nextSlot }) : runtime.addLabel;
  const replaceSlot = typeof picker === "object" ? picker : undefined;
  const canAdd = references.length < runtime.maxReferences;
  const canPick = replaceSlot ? runtime.orderedViews && references[replaceSlot.index]?.key === replaceSlot.key : canAdd;
  return (
    <div className={`story-media-references${large ? " is-large" : ""}`} aria-label={t("assetCanvas.references")}>
      {runtime?.linkedPrompt !== undefined ? <TextReferenceThumbnail runtime={runtime} /> : null}
      {references.map((reference, index) => (
        <CanvasReferenceThumbnail
          key={reference.key}
          reference={reference}
          caption={runtime.slotLabels?.[index]}
          disabled={runtime?.busy}
          onReplace={runtime.orderedViews ? () => setPicker({ index, key: reference.key }) : undefined}
          removeDisabledReason={runtime.orderedViews && index < references.length - 1 ? t("assetCanvas.removeLaterViewsFirst") : undefined}
          onRemove={() => runtime?.onRemoveReference(index)}
        />
      ))}
      {canAdd && !runtime.onUploadReferences ? (
        <div className="story-media-reference-slot" title={runtime.addLabel}><span>{nextSlot ?? runtime.addLabel}</span></div>
      ) : null}
      {runtime.onUploadReferences && (canAdd || runtime.orderedViews) ? <>
        {canAdd ? (
          <button
            className="story-media-reference-add"
            type="button"
            title={addLabel}
            aria-label={addLabel}
            disabled={runtime?.busy}
            onClick={() => runtime.onAddLibraryReference ? setPicker("add") : input.current?.click()}
          >
            {runtime?.uploading ? <LoaderCircle className="spin" size={large ? 20 : 16} /> : <Plus size={large ? 24 : 18} />}
            {nextSlot ? <span>{nextSlot}</span> : null}
          </button>
        ) : null}
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          accept={runtime.accept}
          multiple={!replaceSlot && runtime.maxReferences > 1}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            setPicker(undefined);
            if (canPick) runtime.onUploadReferences?.(files, replaceSlot?.index);
          }}
        />
        {picker && canPick && runtime.onAddLibraryReference ? <LibraryAssetPicker
          title={replaceSlot ? t("assetCanvas.replaceView", { view: references[replaceSlot.index]!.label }) : addLabel}
          includeReferences
          assets={runtime.libraryImages ?? []}
          onReload={runtime.onReloadLibrary}
          uploading={runtime.uploading}
          onUpload={() => input.current?.click()}
          onClose={() => setPicker(undefined)}
          onSelect={(asset) => { setPicker(undefined); runtime.onAddLibraryReference?.(asset, replaceSlot?.index); }}
        /> : null}
      </> : null}
      {runtime.showEmptySlots !== false ? (canAdd ? laterSlots : remainingSlots).map((label) => <div className="story-media-reference-slot" key={label} aria-hidden="true"><span>{label}</span></div>) : null}
    </div>
  );
}

function TextReferenceThumbnail({ runtime }: { runtime: Pick<MediaNodeRuntime, "busy" | "linkedPrompt" | "onDisconnectPrompt"> }) {
  const text = runtime.linkedPrompt?.trim() ?? "";
  return (
    <div className="story-media-reference story-text-reference" title={text || t("assetCanvas.emptyText")}>
      <FileText size={19} />
      <button type="button" title={t("assetCanvas.disconnectText")} aria-label={t("assetCanvas.disconnectText")} disabled={runtime.busy} onClick={() => runtime.onDisconnectPrompt?.()}><X size={11} /></button>
    </div>
  );
}

function MediaNodeShell({ kind, textKind, label: labelOverride, selected, panelOpen, assetId, assetAspectRatio, aspectRatio, runtime, details, emptyHint, children }: {
  kind: "image" | "video" | "audio" | "model" | "animation";
  textKind?: "speech";
  label?: string;
  selected: boolean;
  panelOpen?: boolean;
  assetId?: string;
  assetAspectRatio?: number;
  aspectRatio?: ImageAspectRatio | VideoAspectRatio;
  runtime?: MediaNodeRuntime;
  details?: CanvasNodeDetails;
  emptyHint?: string;
  children: React.ReactNode;
}) {
  const [modelPlayback, setModelPlayback] = useModelPlayback(assetId);
  const [element, visible] = useNearViewport<HTMLDivElement>(true);
  const [playing, setPlaying] = useState(false);
  useEffect(() => setPlaying(false), [assetId]);
  const preview = useWorkspaceAssetUrl(undefined, "", 0, visible || selected || playing ? assetId : undefined);
  const image = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => { const element = image.current; return () => releaseImage(element, preview.url); }, [preview.url]);
  const [modelFailed, setModelFailed] = useState(false);
  useEffect(() => setModelFailed(false), [preview.url]);
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : kind === "audio" ? Music2 : kind === "animation" ? WandSparkles : Box;
  const messageKind = textKind ?? kind;
  const label = labelOverride ?? t(`assetCanvas.media.${messageKind}.label`);
  const threeD = kind === "model" || kind === "animation";
  const audio = kind === "audio";
  const mediaLayout = useMediaNodeLayout(assetId, assetAspectRatio ?? parseAspectRatio(aspectRatio));
  const mediaStyle = audio ? { "--story-media-width": "520px", "--story-media-height": "170px" } as CSSProperties : mediaLayout.style;
  return (
    <div ref={element} className={`story-node story-media-node story-generation-media-node${selected ? " is-selected" : ""}`} style={mediaStyle}>
      <CanvasNodeLabel icon={Icon} label={label} details={details} />
      <div data-alignment-frame className={`story-media-stage${runtime?.generating ? " is-generating" : ""}`}>
        {preview.url || threeD && assetId ? kind === "audio" ? null : <MediaViewButton /> : null}
        {preview.url && kind === "image" ? <img ref={image} src={preview.url} alt={t("timeline.generatedImage")} onLoad={mediaLayout.onImageLoad} /> : null}
        {preview.url && kind === "video" ? <CanvasVideo src={preview.url} onLoadedMetadata={mediaLayout.onVideoMetadata} onPlayingChange={setPlaying} /> : null}
        {preview.url && audio ? <CanvasAudio src={preview.url} onPlayingChange={setPlaying} /> : null}
        {preview.url && threeD ? <ModelPreview source={preview.url} label={kind === "animation" ? t("assetCanvas.animated3d") : t("timeline.generated3d")} minHeight={220} interactive autoRotate rotationPerSecond="10deg" animate playback={modelPlayback} onPlaybackChange={setModelPlayback} onError={() => setModelFailed(true)} /> : null}
        {!preview.url && !runtime?.generating ? (
          <div className="story-media-empty">
            <Icon size={34} />
            <strong>{assetId ? preview.error ? t("assetCanvas.assetUnavailable") : t("assetCanvas.loadingAsset") : t(`assetCanvas.media.${messageKind}.none`)}</strong>
            {assetId ? <CanvasAssetRecovery preview={preview} /> : <span>{emptyHint ?? (kind === "animation" ? t("assetCanvas.hint.humanoid") : t(`assetCanvas.media.${textKind ?? kind}.describe`))}</span>}
          </div>
        ) : null}
        {!panelOpen && !runtime?.generating && runtime?.error ? <div className="story-media-job-error" role={runtime.generationStatus === "cancelled" ? "status" : "alert"} title={runtime.error}>
          <strong>{t(runtime.generationStatus === "cancelled" ? "assetCanvas.generationCancelled" : "assetCanvas.generationFailed")}</strong>
          <span>{kind === "image" ? imageRecoveryMessage(runtime.error, true) : providerGenerationErrorMessage(runtime.error)}</span>
        </div> : null}
        {runtime?.generating ? (
          <div className="story-media-empty story-media-generation" role="status">
            <LoaderCircle className="spin" size={20} />
            <strong>{runtime.recovering ? t(kind === "model" || kind === "animation" ? "kunpoModels.recoveringModel" : kind === "video" ? "assetCanvas.recoveringVideo" : "assetCanvas.recoveringImage") : kind === "animation" ? t("assetCanvas.rigging") : t(`assetCanvas.media.${textKind ?? kind}.generating`)}</strong>
            {runtime.recovering ? null : <span>{kind === "animation" ? t("assetCanvas.takesMinutes") : t("assetCanvas.takesMoment")}</span>}
          </div>
        ) : null}
      </div>
      <Handle className="story-media-input-handle" type="target" position={Position.Left} />
      <Handle className="story-media-output-handle" id={OUTPUT_HANDLE} type="source" position={Position.Right} />
      {panelOpen ? <div className="canvas-node-auxiliary"><div className="story-media-composer nodrag nowheel">{children}{threeD ? <FbxAssetActions assetId={assetId} failed={Boolean(preview.error) || modelFailed} onRebuilt={preview.retry} /> : null}</div></div> : null}
    </div>
  );
}

function CanvasAssetRecovery({ preview }: { preview: ReturnType<typeof useWorkspaceAssetUrl> }) {
  return preview.error ? <><span role="status">{preview.error}</span><button className="canvas-asset-retry nodrag" type="button" disabled={preview.loading} onClick={preview.retry}>{preview.loading ? t("assetCanvas.checking") : t("canvasDoc.checkAgain")}</button></> : null;
}

function CanvasVideo({ src, onLoadedMetadata, onPlayingChange }: {
  src: string;
  onLoadedMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useLayoutEffect(() => {
    const element = video.current;
    return () => releaseMedia(element, src);
  }, [src]);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  function updateDuration(element: HTMLVideoElement): void {
    setDuration(Number.isFinite(element.duration) ? element.duration : 0);
  }

  function togglePlayback(): void {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  }

  return (
    <>
      <video
        ref={video}
        className="story-canvas-video"
        src={src}
        draggable={false}
        muted={muted}
        playsInline
        preload="metadata"
        onDurationChange={(event) => updateDuration(event.currentTarget)}
        onEnded={() => { setPlaying(false); onPlayingChange(false); }}
        onLoadedMetadata={(event) => {
          updateDuration(event.currentTarget);
          onLoadedMetadata(event);
        }}
        onPause={() => { setPlaying(false); onPlayingChange(false); }}
        onPlay={() => { setPlaying(true); onPlayingChange(true); }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
      />
      <InlineVideoControls
        label={t("assetCanvas.node.video")}
        playing={playing}
        currentMs={currentTime * 1_000}
        totalMs={duration * 1_000}
        muted={muted}
        disabled={!duration}
        onToggle={togglePlayback}
        onSeek={(nextMs) => {
          const nextTime = nextMs / 1_000;
          if (video.current) video.current.currentTime = nextTime;
          setCurrentTime(nextTime);
        }}
        onToggleMuted={() => setMuted((current) => !current)}
      />
    </>
  );
}

function CanvasAudio({ src, onPlayingChange }: { src: string; onPlayingChange: (playing: boolean) => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useLayoutEffect(() => {
    const element = audio.current;
    return () => releaseMedia(element, src);
  }, [src]);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  function togglePlayback(): void {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play();
    else element.pause();
  }

  return (
    <div className="story-media-audio">
      <Music2 size={20} />
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onEnded={() => { setPlaying(false); onPlayingChange(false); }}
        onPause={() => { setPlaying(false); onPlayingChange(false); }}
        onPlay={() => { setPlaying(true); onPlayingChange(true); }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      />
      <InlineVideoControls
        label={t("assetCanvas.media.audio.label")}
        playing={playing}
        currentMs={currentTime * 1_000}
        totalMs={duration * 1_000}
        muted={muted}
        disabled={!duration}
        onToggle={togglePlayback}
        onSeek={(nextMs) => {
          if (audio.current) audio.current.currentTime = nextMs / 1_000;
          setCurrentTime(nextMs / 1_000);
        }}
        onToggleMuted={() => {
          const element = audio.current;
          if (!element) return;
          element.muted = !element.muted;
          setMuted(element.muted);
        }}
      />
    </div>
  );
}

function InlineVideoControls({ label, playing, currentMs, totalMs, muted, disabled = false, markers = [], onToggle, onSeek, onToggleMuted }: {
  label: string;
  playing: boolean;
  currentMs: number;
  totalMs: number;
  muted: boolean;
  disabled?: boolean;
  markers?: Array<{ id: string; timeMs: number; blocking?: boolean }>;
  onToggle: () => void;
  onSeek: (timeMs: number) => void;
  onToggleMuted: () => void;
}) {
  const duration = Math.max(0, totalMs);
  const current = Math.max(0, Math.min(currentMs, duration));
  const progress = duration ? current / duration * 100 : 0;
  return <div className="story-inline-video-controls nodrag nowheel" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" title={playing ? t("assetCanvas.pause", { label }) : t("assetCanvas.play", { label })} aria-label={playing ? t("assetCanvas.pause", { label }) : t("assetCanvas.play", { label })} disabled={disabled} onClick={onToggle}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
    <time>{formatPreviewTime(current)}</time>
    <div className="story-inline-video-scrubber">
      {markers.length ? <div className="story-inline-video-markers" aria-hidden="true">{markers.map((marker) => <i key={marker.id} className={marker.blocking ? "is-blocking" : ""} style={{ left: `${duration ? Math.max(0, Math.min(100, marker.timeMs / duration * 100)) : 0}%` }} />)}</div> : null}
      <input aria-label={`${label} position`} type="range" min={0} max={duration} step={40} value={current} disabled={disabled} style={{ "--video-progress": `${progress}%` } as CSSProperties} onChange={(event) => onSeek(Number(event.target.value))} />
    </div>
    <time>{formatPreviewTime(duration)}</time>
    <button type="button" title={muted ? t("assetCanvas.unmute", { label }) : t("assetCanvas.mute", { label })} aria-label={muted ? t("assetCanvas.unmute", { label }) : t("assetCanvas.mute", { label })} disabled={disabled} onClick={onToggleMuted}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
  </div>;
}

/** Sizes a media card from the loaded media, else from the ratio known in advance. */
function useMediaNodeLayout(assetId?: string, knownAspectRatio?: number): {
  style: CSSProperties;
  onImageLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onVideoMetadata: (event: SyntheticEvent<HTMLVideoElement>) => void;
} {
  const [intrinsic, setIntrinsic] = useState<{ assetId?: string; ratio: number }>();
  const size = fitMediaNode(intrinsic && intrinsic.assetId === assetId ? intrinsic.ratio : knownAspectRatio);

  function remember(width: number, height: number): void {
    if (width > 0 && height > 0) setIntrinsic({ assetId, ratio: width / height });
  }

  return {
    style: {
      "--story-media-width": `${size.width}px`,
      "--story-media-height": `${size.height}px`,
    } as CSSProperties,
    onImageLoad: (event) => remember(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight),
    onVideoMetadata: (event) => remember(event.currentTarget.videoWidth, event.currentTarget.videoHeight),
  };
}

function mediaAspectRatio(asset?: Pick<LibraryAsset, "width" | "height">): number | undefined {
  return asset?.width && asset.height ? asset.width / asset.height : undefined;
}

function parseAspectRatio(value?: ImageAspectRatio | VideoAspectRatio): number | undefined {
  if (!value || value === "adaptive") return undefined;
  const [width, height] = value.split(":").map(Number);
  return width && height ? width / height : undefined;
}

function fitMediaNode(aspectRatio = 16 / 10): { width: number; height: number } {
  const widthAtMaxHeight = MEDIA_NODE_MAX_HEIGHT * aspectRatio;
  const width = Math.min(MEDIA_NODE_MAX_WIDTH, Math.max(MEDIA_NODE_MIN_WIDTH, widthAtMaxHeight));
  const height = Math.min(MEDIA_NODE_MAX_HEIGHT, Math.max(MEDIA_NODE_MIN_HEIGHT, width / aspectRatio));
  return { width: Math.round(width), height: Math.round(height) };
}

const MANAGE_PROVIDERS = { label: t("modelSelector.manage"), onSelect: () => { window.location.hash = settingsHash("providers"); } };

/** OpenRouter names start with the vendor ("ByteDance: Seedance 2.5"); the provider heading already says where it runs. */
function mediaModelName(model: { provider: string; name: string }): string {
  return model.provider === "openrouter" ? model.name.replace(/^[^:]{1,40}:\s+/, "") : model.name;
}

function providerNotes(providers: readonly MediaProviderStatus[] | undefined): CanvasChipNote[] {
  return (providers ?? []).flatMap((provider) => provider.state === "ready" || !provider.message ? [] : [{ group: provider.providerName, message: provider.message }]);
}

function polycountOptions(presets: readonly number[], current: number): Array<{ value: string; label: string }> {
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: t("assetCanvas.polys", { value: value >= 1_000 ? `${value / 1_000}K` : value }) }));
}

function CanvasChipToggle({ label, pressed, disabled, onChange }: { label: string; pressed: boolean; disabled?: boolean; onChange: (pressed: boolean) => void }) {
  return (
    <button className="canvas-chip is-toggle" type="button" aria-pressed={pressed} disabled={disabled} onClick={() => onChange(!pressed)}>
      {pressed ? <Check size={12} /> : null}<span>{label}</span>
    </button>
  );
}

function GenerateMediaButton({ kind, assetId, runtime, disabled, disabledReason }: {
  kind: "image" | "video" | "audio" | "speech" | "model" | "animation";
  assetId?: string;
  runtime?: MediaNodeRuntime;
  disabled: boolean;
  disabledReason?: string;
}) {
  const label = assetId ? t(`assetCanvas.media.${kind}.again`) : t(`assetCanvas.media.${kind}.generate`);
  if (runtime?.onCancel && runtime.generating) {
    const cancelLabel = runtime.recovering ? t(kind === "video" ? "assetCanvas.cancelVideoRecovery" : "assetCanvas.cancelImageRecovery") : t("assetCanvas.cancelGeneration");
    return <button type="button" title={runtime.notice ? `${cancelLabel} · ${runtime.notice}` : cancelLabel} aria-label={cancelLabel} aria-description={runtime.notice} onClick={runtime.onCancel}><Square size={13} /></button>;
  }
  return (
    <button type="button" title={disabled && disabledReason ? disabledReason : runtime?.notice ? `${label} · ${runtime.notice}` : label} aria-label={label} aria-description={runtime?.notice} disabled={disabled || runtime?.busy} onClick={() => runtime?.onGenerate()}>
      {runtime?.generating ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
    </button>
  );
}

function formatPreviewTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1_000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function AssetCanvasAddControl({
  project,
  documents,
  tables,
  audioOperations,
  libraryAssets,
  onReloadLibrary,
  importing,
  onAdd,
  onAddAsset,
  onUpload,
}: {
  project: Pick<ProjectState, "id" | "name" | "type">;
  documents: CanvasDocuments;
  tables: CanvasTables;
  audioOperations: ReadonlySet<AudioOperation>;
  libraryAssets: LibraryAsset[];
  onReloadLibrary: () => Promise<void>;
  importing: boolean;
  onAdd: (type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, documentId?: string) => void;
  onAddAsset: (asset: LibraryAsset, position: { x: number; y: number }) => void;
  onUpload: (files: File[], position: { x: number; y: number }) => void;
}) {
  const creationGroups = canvasCreationGroups(documents, tables, audioOperations);
  const [addOpen, setAddOpen] = useState(false);
  const [openCreationBranch, setOpenCreationBranch] = useState<OpenCanvasNodeCreationBranch>();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const addMenu = useRef<HTMLDivElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const placementPosition = useCanvasCenter();

  useEffect(() => {
    if (!addOpen) return;

    const closeOutside = (event: PointerEvent) => {
      if (!addMenu.current?.contains(event.target as globalThis.Node)) setAddOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addOpen]);

  function addItem(item: CanvasNodeCreationLeaf): void {
    const position = placementPosition();
    if (!position) return;
    onAdd(item.action.type, position, item.action.documentId ?? item.action.tableId);
    setAddOpen(false);
  }

  return <>
      <div ref={addMenu} className="story-add-node">
        {addOpen ? (
          <div className="story-add-node-menu-shell">
            <div className="story-add-node-menu" role="menu" aria-label={t("assetCanvas.addNode")}>
              {creationGroups.map((group) => <Fragment key={group.label}>
                <span className="story-add-node-menu-label">{group.label}</span>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  if (!isCanvasNodeCreationLeaf(item)) return <button
                    type="button"
                    role="menuitem"
                    key={item.label}
                    aria-haspopup="menu"
                    aria-expanded={openCreationBranch?.branch === item}
                    onPointerEnter={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
                    onClick={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
                  ><Icon size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span><ChevronRight className="story-add-node-submenu-arrow" size={13} /></button>;
                  return <button type="button" role="menuitem" key={item.label} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => addItem(item)}><Icon size={15} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>;
                })}
              </Fragment>)}
              <button type="button" role="menuitem" disabled={importing} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span><strong>{importing ? t("assetCanvas.uploading") : t("assetCanvas.upload")}</strong><small>{t("assetCanvas.uploadHint")}</small></span></button>
              <button type="button" role="menuitem" onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => { setAddOpen(false); setLibraryOpen(true); }}><Folder size={15} /><span><strong>{t("assetCanvas.fromLibrary")}</strong><small>{t("assetCanvas.fromLibraryHint")}</small></span></button>
            </div>
            {openCreationBranch ? <div className="story-add-node-submenu" role="menu" aria-label={openCreationBranch.branch.label} style={{ top: openCreationBranch.top }}>
              {openCreationBranch.branch.children.map((child) => { const ChildIcon = child.icon; return <button type="button" role="menuitem" key={child.label} onClick={() => addItem(child)}><ChildIcon size={15} /><span><strong>{child.label}</strong><small>{child.description}</small></span></button>; })}
            </div> : null}
          </div>
        ) : null}
        <input
          ref={uploadInput}
          hidden
          type="file"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            const position = placementPosition();
            if (files.length && position) onUpload(files, position);
            setAddOpen(false);
          }}
        />
        <button className={addOpen ? "is-active" : undefined} type="button" title={t("assetCanvas.addNode")} aria-label={t("assetCanvas.addNode")} aria-expanded={addOpen} onClick={() => { setOpenCreationBranch(undefined); setAddOpen((open) => !open); }}>
          <Plus size={18} />
        </button>
      </div>
      {libraryOpen ? <LibraryAssetPicker title={t("assetCanvas.addFromLibrary")} projectId={project.id} project={project} assets={libraryAssets} onReload={onReloadLibrary} onClose={() => setLibraryOpen(false)} onSelect={(asset) => {
        const position = placementPosition();
        if (position) onAddAsset(asset, position);
        setLibraryOpen(false);
      }} /> : null}
  </>;
}

interface ViewableCanvasAsset {
  /** The node the viewer was opened from. */
  nodeId: string;
  assetId: string;
  mediaType: Exclude<AssetMediaType, "audio">;
}

function viewableCanvasAsset(node: AssetCanvasFlowNode): ViewableCanvasAsset | undefined {
  const assetId = node.data.assetId;
  if (!assetId) return undefined;
  const nodeId = node.id;
  if (node.type === "image") return { nodeId, assetId, mediaType: "image" };
  if (node.type === "video") return { nodeId, assetId, mediaType: "video" };
  if (node.type === "model-3d" || node.type === "animate-3d") return { nodeId, assetId, mediaType: "model" };
  const mediaType = node.data.mediaType;
  return node.type === "asset" && mediaType && mediaType !== "audio" ? { nodeId, assetId, mediaType } : undefined;
}

/** The workspace opens the viewer from onNodeClick, which already knows the node. */
function MediaViewButton() {
  return (
    <button className="story-media-view-button nodrag" type="button" title={t("assetCanvas.viewAction")} aria-label={t("assetCanvas.viewAction")} onDoubleClick={(event) => event.stopPropagation()}>
      <Maximize size={14} />
    </button>
  );
}

function eventWithin(event: { target: EventTarget | null }, selector: string): boolean {
  return event.target instanceof Element && Boolean(event.target.closest(selector));
}

function CanvasAssetViewer({ asset, name, onDownload, onSendToProject, onClose, trimmer }: {
  asset: ViewableCanvasAsset;
  name: string;
  onDownload: (name: string) => void;
  onSendToProject: (name: string) => void;
  onClose: () => void;
  /** Shows a video with handles to trim it, saving the kept part as a new video. */
  trimmer?: { loadSource: (signal?: AbortSignal, contentSha256?: string) => Promise<Blob>; onSave: (video: Blob, trim: VideoTrim) => Promise<void> };
}) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, asset.assetId);
  const [modelFailed, setModelFailed] = useState(false);
  useEffect(() => setModelFailed(false), [preview.url]);
  // React Flow ignores key presses inside .nokey, so Backspace/Delete here never removes the node behind the dialog.
  return <div className="nokey">
    <AssetDialogShell
      title={name}
      labelledBy="canvas-asset-viewer-title"
      headerActions={<>
        <button type="button" title={t("assetCanvas.addToProject")} aria-label={t("assetCanvas.addNameToProject", { name })} onClick={() => onSendToProject(name)}><FolderPlus size={17} /></button>
        <button type="button" title={t("assetCanvas.download")} aria-label={t("assetCanvas.downloadName", { name })} onClick={() => onDownload(name)}><Download size={17} /></button>
      </>}
      onClose={onClose}
      preview={preview.url
        ? trimmer && asset.mediaType === "video"
          ? <VideoTrimmer key={asset.assetId} url={preview.url} label={name} loadSource={trimmer.loadSource} onSave={trimmer.onSave} />
          : <AssetMedia type={asset.mediaType} url={preview.url} label={name} onModelError={() => setModelFailed(true)} />
        : <span className="library-dialog-state">{preview.error ? t("assetCanvas.assetUnavailable") : t("assetCanvas.loadingAsset")}</span>}
      footer={<FbxAssetActions assetId={asset.assetId} name={name} failed={Boolean(preview.error) || modelFailed} onRebuilt={preview.retry} />}
    />
  </div>;
}

function AssetCanvasContextMenu({
  documents,
  tables,
  audioOperations,
  onUseInDocument,
  menu,
  canUndo,
  canRedo,
  canPaste,
  canDuplicate,
  canView,
  canDownload,
  canSendToProject,
  nodeActionsDisabled,
  importing,
  onClose,
  onUndo,
  onRedo,
  onPaste,
  onAdd,
  onUpload,
  onView,
  onDownload,
  onSendToProject,
  onCopy,
  onDuplicate,
  onDelete,
  onDetails,
}: {
  documents: CanvasDocuments;
  tables: CanvasTables;
  audioOperations: ReadonlySet<AudioOperation>;
  onUseInDocument?: () => void;
  menu: CanvasContextMenuState;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  canDuplicate: boolean;
  canView: boolean;
  canDownload: boolean;
  canSendToProject: boolean;
  nodeActionsDisabled: boolean;
  importing: boolean;
  onClose: () => void;
  onUndo: () => unknown;
  onRedo: () => unknown;
  onPaste: () => void;
  onAdd: (item: CanvasNodeCreationLeaf) => void;
  onUpload: (files: File[]) => void;
  onView: () => void;
  onDownload: () => void;
  onSendToProject: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onDetails?: () => void;
}) {
  const creationGroups = canvasCreationGroups(documents, tables, audioOperations);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [openCreationBranch, setOpenCreationBranch] = useState<OpenCanvasNodeCreationBranch>();
  const run = (action: () => unknown) => {
    action();
    onClose();
  };
  const creationItems = <>
    {creationGroups.map((group) => <Fragment key={group.label}>
      <span className="story-canvas-context-menu-label">{group.label}</span>
      {group.items.map((item) => {
        const Icon = item.icon;
        if (!isCanvasNodeCreationLeaf(item)) return <button
          type="button"
          role="menuitem"
          key={item.label}
          aria-haspopup="menu"
          aria-expanded={openCreationBranch?.branch === item}
          onPointerEnter={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
          onClick={(event) => setOpenCreationBranch({ branch: item, top: event.currentTarget.offsetTop })}
        ><Icon size={15} /><span>{item.label}</span><ChevronRight size={13} /></button>;
        return <button type="button" role="menuitem" key={item.label} onPointerEnter={() => setOpenCreationBranch(undefined)} onClick={() => run(() => onAdd(item))}><Icon size={15} /><span>{item.label}</span></button>;
      })}
    </Fragment>)}
  </>;
  const creationBranch = openCreationBranch ? <div className="story-canvas-context-branch-menu" role="menu" aria-label={openCreationBranch.branch.label} style={{ top: openCreationBranch.top }}>
    {openCreationBranch.branch.children.map((child) => { const ChildIcon = child.icon; return <button type="button" role="menuitem" key={child.label} onClick={() => run(() => onAdd(child))}><ChildIcon size={15} /><span>{child.label}</span></button>; })}
  </div> : null;

  // A double-click on the canvas opens just the Add node list.
  if (menu.kind === "add") return (
    <CanvasContextMenu screenPosition={menu.screenPosition} label={t("assetCanvas.addNode")} onClose={onClose}>
      {creationItems}
      {creationBranch}
    </CanvasContextMenu>
  );

  return (
    <CanvasContextMenu screenPosition={menu.screenPosition} label={menu.kind === "pane" ? t("assetCanvas.canvasActions") : t("assetCanvas.nodeActions")} onClose={onClose}>
      {onDetails ? <button type="button" role="menuitem" onClick={() => run(onDetails)}><Pencil size={15} /><span>{t("assetCanvas.nodeDetails")}</span></button> : null}
      {onUseInDocument ? <button type="button" role="menuitem" onClick={() => run(onUseInDocument)}><FileText size={15} /><span>{t("assetCanvas.addToDocument")}</span></button> : null}
      {menu.kind === "pane" ? <>
        <div className="story-canvas-context-submenu-root" onPointerEnter={() => setAddOpen(true)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen(true)}><Plus size={15} /><span>{t("assetCanvas.addNode")}</span><ChevronRight size={13} /></button>
          {addOpen ? <div className="story-canvas-context-add-menu">
            <div className="story-canvas-context-submenu" role="menu" aria-label={t("assetCanvas.addNode")}>{creationItems}</div>
            {creationBranch}
          </div> : null}
        </div>
        <button type="button" role="menuitem" disabled={importing} onClick={() => uploadInput.current?.click()}><Upload size={15} /><span>{importing ? t("assetCanvas.uploading") : t("assetCanvas.upload")}</span></button>
        <input
          ref={uploadInput}
          hidden
          type="file"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length) onUpload(files);
            onClose();
          }}
        />
        <div className="playable-project-menu-separator" role="separator" />
        <button type="button" role="menuitem" disabled={!canUndo} onClick={() => run(onUndo)}><Undo2 size={15} /><span>{t("assetCanvas.undo")}</span></button>
        <button type="button" role="menuitem" disabled={!canRedo} onClick={() => run(onRedo)}><Redo2 size={15} /><span>{t("assetCanvas.redo")}</span></button>
        <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPaste)}><Clipboard size={15} /><span>{t("assetCanvas.paste")}</span></button>
      </> : <>
        {canView ? <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onView)}><Maximize size={15} /><span>{t("assetCanvas.viewAction")}</span></button> : null}
        {canDownload ? <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onDownload)}><Download size={15} /><span>{t("assetCanvas.download")}</span></button> : null}
        {canSendToProject ? <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onSendToProject)}><FolderPlus size={15} /><span>{t("assetCanvas.addToProjectEllipsis")}</span></button> : null}
        <button type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onCopy)}><Copy size={15} /><span>{t("assetCanvas.copyNode")}</span></button>
        <button type="button" role="menuitem" disabled={nodeActionsDisabled || !canDuplicate} onClick={() => run(onDuplicate)}><Plus size={15} /><span>{t("common.duplicate")}</span></button>
        <button className="is-danger" type="button" role="menuitem" disabled={nodeActionsDisabled} onClick={() => run(onDelete)}><Trash2 size={15} /><span>{t("common.delete")}</span></button>
      </>}
    </CanvasContextMenu>
  );
}

export function toFlowNode(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[], previous?: AssetCanvasFlowNode): AssetCanvasFlowNode {
  // Clearing measured on a mounted node also clears React Flow's handle bounds.
  // Keep them across document updates; ResizeObserver handles actual size changes.
  const measured = previous?.id === node.id && previous.type === node.type ? previous.measured : undefined;
  return { ...flowNodeData(node, imageModels, videoModels), ...(measured ? { measured } : {}), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function flowNodeData(node: AssetCanvasNode, imageModels: ImageModel[], videoModels: VideoModel[]): AssetCanvasFlowNode {
  if (node.type === "asset" || node.type === "file") return { ...node, deletable: true };
  if (node.type === "text") return {
    id: node.id,
    type: "text",
    position: node.position,
    deletable: true,
    data: {
      text: node.data.text,
      instruction: node.data.instruction,
      ...(node.data.references ? { references: node.data.references } : {}),
      ...(node.data.model ? { textModel: node.data.model } : {}),
      ...(node.data.reasoningLevel ? { reasoningLevel: node.data.reasoningLevel } : {}),
    },
  };
  if (node.type === "video") {
    const model = videoModels.find((candidate) => sameModel(candidate, node.data.model));
    return {
      id: node.id,
      type: "video",
      position: node.position,
      deletable: true,
      data: {
        prompt: node.data.prompt,
        ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
        ...(model ? { videoModel: { provider: model.provider, id: model.id } } : node.data.model ? { videoModel: node.data.model } : {}),
        videoResolution: model?.resolutions.includes(node.data.resolution) ? node.data.resolution : model?.resolutions[0] ?? node.data.resolution,
        videoAspectRatio: model?.aspectRatios.includes(node.data.aspectRatio) ? node.data.aspectRatio : model?.aspectRatios[0] ?? node.data.aspectRatio,
        duration: model?.durations.includes(node.data.duration) ? node.data.duration : model?.durations[0] ?? node.data.duration,
        references: node.data.references,
        referenceMode: node.data.referenceMode,
        referenceMentions: node.data.referenceMentions,
        ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      },
    };
  }
  if (node.type === "voice") return { id: node.id, type: "voice", position: node.position, deletable: true, data: { voiceDescription: node.data.description, sampleText: node.data.sampleText, ...audioNodeSettings(node.data), ...(node.data.model ? { audioModel: node.data.model } : {}), ...(node.data.assetId ? { assetId: node.data.assetId } : {}), ...(node.data.selectedAssetId ? { selectedAssetId: node.data.selectedAssetId, selectedSha256: node.data.selectedSha256 } : {}) } };
  if (node.type === "speech") return {
    id: node.id,
    type: "speech",
    position: node.position,
    deletable: true,
    data: {
      ...audioNodeSettings(node.data),
      text: node.data.text,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { audioModel: node.data.model } : {}),
      ...(node.data.voiceId ? { voiceId: node.data.voiceId } : {}),
      ...(node.data.referenceAssetId ? { referenceAssetId: node.data.referenceAssetId } : {}),
      ...(node.data.referenceSha256 ? { referenceSha256: node.data.referenceSha256 } : {}),
      ...(node.data.voiceSourceNodeId ? { voiceSourceNodeId: node.data.voiceSourceNodeId } : {}),
      ...(node.data.speed !== undefined ? { speed: node.data.speed } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "sound-effect") return {
    id: node.id,
    type: "sound-effect",
    position: node.position,
    deletable: true,
    data: {
      ...audioNodeSettings(node.data),
      prompt: node.data.prompt,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { audioModel: node.data.model } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.negativePrompt ? { negativePrompt: node.data.negativePrompt } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "music") return {
    id: node.id,
    type: "music",
    position: node.position,
    deletable: true,
    data: {
      ...audioNodeSettings(node.data),
      prompt: node.data.prompt,
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { audioModel: node.data.model } : {}),
      instrumental: node.data.instrumental,
      ...(node.data.lyrics ? { lyrics: node.data.lyrics } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "animate-3d") return {
    id: node.id,
    type: "animate-3d",
    position: node.position,
    deletable: true,
    // The flow keeps the source in `images` so connections, edges, and removal share the reference code paths.
    data: {
      images: node.data.source ? [node.data.source] : [],
      animationModel: node.data.model,
      model3DOptions: node.data.options,
      heightMeters: node.data.heightMeters,
      actionIds: node.data.actionIds,
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "model-3d") return {
    id: node.id,
    type: "model-3d",
    position: node.position,
    deletable: true,
    data: {
      prompt: node.data.prompt ?? "",
      promptSource: node.data.promptSource,
      model3DOperation: node.data.operation,
      model3DSource: node.data.source,
      model3DOptions: node.data.options,
      model3DConfig: normalizeModel3DConfig({
        model: node.data.model,
        targetPolycount: node.data.targetPolycount,
        texture: node.data.texture,
        pbr: node.data.pbr,
      }, undefined, node.data.operation),
      images: node.data.images.slice(0, MODEL_3D_MAX_REFERENCE_IMAGES),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type !== "image" || node.data.model) return { ...node, deletable: true };
  const model = imageModels[0];
  return {
    ...node,
    deletable: true,
    data: {
      ...node.data,
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
    },
  };
}

function createFlowNode(type: Exclude<AssetCanvasNodeType, "asset">, position: { x: number; y: number }, imageModels: ImageModel[], videoModels: VideoModel[], defaultTextModel?: AgentModelRef): AssetCanvasFlowNode {
  if (type === "image") {
    const model = imageModels[0];
    const option = preferredImageOption(model);
    return toFlowNode(createAssetGenerationNode(type, position, {
      ...(model ? { imageModel: { provider: model.provider, id: model.id } } : {}),
      ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
    }), imageModels, videoModels);
  }
  if (type === "video") {
    const model = videoModels[0];
    const aspectRatio = videoAspectRatios(model, 0, model?.imageReferenceMode)[0] ?? DEFAULT_VIDEO_NODE_CONFIG.aspectRatio;
    return toFlowNode(createAssetGenerationNode(type, position, { ...(model ? { videoModel: { provider: model.provider, id: model.id }, videoReferenceMode: model.imageReferenceMode } : {}), videoAspectRatio: aspectRatio }), imageModels, videoModels);
  }
  if (type === "model-3d") return toFlowNode(createAssetGenerationNode(type, position), imageModels, videoModels);
  if (type === "voice") return { id: crypto.randomUUID(), type, position, data: { voiceDescription: "", sampleText: t("assetCanvas.voiceSampleDefault") } };
  if (type === "speech") return { id: crypto.randomUUID(), type, position, data: { text: "" } };
  if (type === "sound-effect") return { id: crypto.randomUUID(), type, position, data: { prompt: "" } };
  if (type === "music") return { id: crypto.randomUUID(), type, position, data: { prompt: "", instrumental: true } };
  if (type === "animate-3d") {
    return { id: crypto.randomUUID(), type, position, data: { images: [], animationModel: { provider: "tripo", id: MODEL3D_CONNECTION_ID }, model3DOptions: { rigModel: "v3.0-20260909", rigType: "biped" }, heightMeters: DEFAULT_CHARACTER_HEIGHT_METERS, actionIds: [...DEFAULT_ANIMATION_ACTION_IDS] } };
  }
  const id = crypto.randomUUID();
  return { id, type: "text", position, data: { text: "", instruction: "", ...(defaultTextModel ? { textModel: defaultTextModel } : {}) } };
}

/** The generation settings a node passes on to the next node of its type. */
type NodeGenerationSettings = GptImage26Options & Pick<AssetCanvasFlowData, "textModel" | "reasoningLevel" | "model" | "resolution" | "aspectRatio" | "quality" | "outputFormat" | "outputCompression" | "background" | "videoModel" | "videoResolution" | "videoAspectRatio" | "duration" | "audioModel" | "speed" | "durationSeconds" | "loop" | "instrumental" | "model3DConfig">;
type RememberedSettings = Partial<Record<AssetCanvasNodeType, NodeGenerationSettings>>;

export function nodeGenerationSettings(node: Pick<AssetCanvasFlowNode, "type" | "data">): NodeGenerationSettings | undefined {
  const { data } = node;
  if (node.type === "text") return { ...(data.textModel ? { textModel: { provider: data.textModel.provider, id: data.textModel.id } } : {}), ...(data.reasoningLevel ? { reasoningLevel: data.reasoningLevel } : {}) };
  if (node.type === "image") return { model: data.model, resolution: data.resolution, aspectRatio: data.aspectRatio, quality: data.quality, outputFormat: data.outputFormat, outputCompression: data.outputCompression, background: data.background, ...gptImage26Options(data) };
  if (node.type === "video") return { videoModel: data.videoModel, videoResolution: data.videoResolution, videoAspectRatio: data.videoAspectRatio, duration: data.duration };
  if (node.type === "voice") return { ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}) };
  if (node.type === "speech") return { ...(data.audioModel ? { audioModel: { provider: data.audioModel.provider, id: data.audioModel.id } } : {}), ...(data.speed !== undefined ? { speed: data.speed } : {}) };
  if (node.type === "sound-effect") return { ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}) };
  if (node.type === "music") return { ...(data.audioModel ? { audioModel: modelRef(data.audioModel) } : {}), ...(data.durationSeconds !== undefined ? { durationSeconds: data.durationSeconds } : {}), ...(data.loop !== undefined ? { loop: data.loop } : {}), ...(data.instrumental !== undefined ? { instrumental: data.instrumental } : {}) };
  if (node.type === "model-3d") return { model3DConfig: data.model3DConfig };
  return undefined;
}

/** Starts a new node with supported remembered options and configured media defaults. */
export function applyRememberedSettings(
  node: AssetCanvasFlowNode,
  settings: NodeGenerationSettings | undefined,
  catalogs: { imageModels: readonly ImageModel[]; defaultImageModel?: ImageModelRef; videoModels: readonly VideoModel[]; defaultVideoModel?: ModelRef; audioModels?: readonly AudioModel[]; model3DModels?: readonly Model3DModel[]; defaultModel3D?: ModelRef; textModels: readonly AgentModel[]; modelSelections?: KunpoModelSelections },
): AssetCanvasFlowNode {
  if (node.type === "image") {
    const reference = catalogs.defaultImageModel ?? settings?.model;
    if (!reference) return node;
    const model = catalogs.imageModels.find((candidate) => sameImageModel(candidate, reference));
    if (!model) return catalogs.defaultImageModel ? { ...node, data: { ...node.data, model: reference } } : node;
    const options = settings ?? node.data;
    const option = model.generationOptions.find((candidate) => candidate.resolution === options.resolution && candidate.aspectRatio === options.aspectRatio)
      ?? preferredImageOption(model, options.aspectRatio);
    return { ...node, data: { ...node.data, model: { provider: model.provider, id: model.id }, ...compatibleImageSettings(options, model), ...(option ? { resolution: option.resolution, aspectRatio: option.aspectRatio } : {}) } };
  }
  if (node.type === "video") {
    const reference = catalogs.defaultVideoModel ?? settings?.videoModel ?? node.data.videoModel;
    const model = catalogs.videoModels.find((candidate) => sameModel(candidate, reference));
    if (!model && catalogs.defaultVideoModel) return { ...node, data: { ...node.data, videoModel: catalogs.defaultVideoModel } };
    if (!model) return node;
    const options = settings ?? node.data;
    const requestedMode = node.data.referenceMode ?? model.imageReferenceMode ?? "reference";
    const referenceMode = model.referenceModes?.includes(requestedMode) ? requestedMode : model.referenceModes?.[0] ?? model.imageReferenceMode;
    const aspectRatios = videoAspectRatios(model, node.data.references?.length ?? 0, referenceMode);
    return {
      ...node,
      data: {
        ...node.data,
        videoModel: { provider: model.provider, id: model.id },
        videoResolution: options.videoResolution && model.resolutions.includes(options.videoResolution) ? options.videoResolution : model.resolutions[0],
        videoAspectRatio: options.videoAspectRatio && aspectRatios.includes(options.videoAspectRatio) ? options.videoAspectRatio : aspectRatios[0],
        duration: options.duration !== undefined && model.durations.includes(options.duration) ? options.duration : model.durations[0],
        referenceMode,
      },
    };
  }
  if (node.type === "model-3d") {
    const reference = catalogs.defaultModel3D ?? settings?.model3DConfig?.model;
    const model = reference ? catalogs.model3DModels?.find((candidate) => sameModel(candidate, reference)) : catalogs.model3DModels?.[0];
    if (reference && !model) return { ...node, data: { ...node.data, model3DConfig: normalizeModel3DConfig({ ...settings?.model3DConfig, model: reference }) } };
    if (model) {
      const options = settings?.model3DConfig;
      return { ...node, data: { ...node.data, model3DConfig: normalizeModel3DConfig({ ...options, model: modelRef(model),
        targetPolycount: options && options.targetPolycount >= model.polycount.min && options.targetPolycount <= model.polycount.max ? options.targetPolycount : model.polycount.default,
        texture: options?.texture, pbr: options?.pbr }, model) } };
    }
    if (settings?.model3DConfig) return { ...node, data: { ...node.data, model3DConfig: normalizeModel3DConfig(settings.model3DConfig) } };
  }
  if (node.type === "speech" || node.type === "voice" || node.type === "sound-effect" || node.type === "music") {
    const operation = audioOperationForNode(node.type)!;
    const compatibleModels = catalogs.audioModels?.filter((candidate) => candidate.capabilities.operations.includes(operation)) ?? [];
    const reference = catalogs.modelSelections?.[operation as "speech" | "sound-effect" | "music"] ?? settings?.audioModel;
    const model = reference ? compatibleModels.find((candidate) => sameModel(candidate, reference)) : operation === "music" ? undefined : compatibleModels[0];
    return {
      ...node,
      data: {
        ...node.data,
        ...(model ? { audioModel: { provider: model.provider, id: model.id } } : reference ? { audioModel: reference } : {}),
        ...(settings?.speed !== undefined ? { speed: settings.speed } : {}),
        ...(settings?.durationSeconds !== undefined ? { durationSeconds: settings.durationSeconds } : {}),
        ...(settings?.loop !== undefined ? { loop: settings.loop } : {}),
        ...(settings?.instrumental !== undefined ? { instrumental: settings.instrumental } : {}),
      },
    };
  }
  if (node.type === "animate-3d" && catalogs.modelSelections?.["3d-rig"]) {
    const rig = catalogs.modelSelections["3d-rig"];
    return { ...node, data: { ...node.data, animationModel: { provider: rig.provider, id: MODEL3D_CONNECTION_ID }, model3DOptions: { rigModel: rig.id as Model3DOptions["rigModel"], rigType: "biped" }, actionIds: [] } };
  }
  if (!settings) return node;
  if (node.type === "text") {
    const model = catalogs.textModels.find((candidate) => sameModel(candidate, settings.textModel));
    if (model) return { ...node, data: { ...node.data, textModel: settings.textModel, ...(settings.reasoningLevel ? { reasoningLevel: clampReasoningLevel(settings.reasoningLevel, model.reasoningLevels) } : {}) } };
  }
  return node;
}

function assetCanvasDocument(
  viewport: { width: number; height: number },
  nodes: AssetCanvasFlowNode[],
  edges: Edge[],
  editorLayout: AssetCanvasEditorLayout,
  model3DModels: readonly Model3DModel[],
): AssetCanvasDocument {
  return {
    version: 1,
    editorLayout,
    viewport,
    nodes: nodes.map((node) => toAssetCanvasNode(node, model3DModels)),
    edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) })),
  };
}

export function toAssetCanvasNode(node: AssetCanvasFlowNode, model3DModels?: readonly Model3DModel[]): AssetCanvasNode {
  return { ...assetCanvasNodeData(node, model3DModels), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}), ...(node.title !== undefined ? { title: node.title } : {}), ...(node.description !== undefined ? { description: node.description } : {}) };
}
function assetCanvasNodeData(node: AssetCanvasFlowNode, model3DModels?: readonly Model3DModel[]): AssetCanvasNode {
  if (node.type === "animate-3d") {
    const source = node.data.images?.[0];
    return {
      id: node.id,
      type: "animate-3d",
      position: node.position,
      data: {
        ...(source ? { source } : {}),
        ...(node.data.animationModel ? { model: node.data.animationModel } : {}),
        ...(node.data.model3DOptions ? { options: node.data.model3DOptions } : {}),
        heightMeters: node.data.heightMeters ?? DEFAULT_CHARACTER_HEIGHT_METERS,
        actionIds: node.data.actionIds ?? [],
        ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      },
    };
  }
  if (node.type === "table") return { id: node.id, type: "table", position: node.position, data: { tableId: node.data.tableId ?? "" } };
  if (node.type === "file") return { id: node.id, type: "file", position: node.position, data: { path: node.data.path ?? "", ...(node.data.directory ? { directory: true as const } : {}) } };
  if (node.type === "document") return { id: node.id, type: "document", position: node.position, data: { documentId: node.data.documentId ?? "", ...(node.data.references ? { references: textNodeReferences(node) } : {}) } };
  if (node.type === "asset") return {
    id: node.id,
    type: "asset",
    position: node.position,
    data: { assetId: node.data.assetId ?? "", mediaType: node.data.mediaType ?? "image" },
  };
  if (node.type === "text") return {
    id: node.id,
    type: "text",
    position: node.position,
    data: {
      text: node.data.text ?? "",
      instruction: node.data.instruction ?? "",
      ...(node.data.references ? { references: textNodeReferences(node) } : {}),
      ...(node.data.textModel ? { model: modelRef(node.data.textModel) } : {}),
      ...(node.data.reasoningLevel ? { reasoningLevel: node.data.reasoningLevel } : {}),
    },
  };
  if (node.type === "image") return {
    id: node.id,
    type: "image",
    position: node.position,
    data: {
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.model ? { model: modelRef(node.data.model) } : {}),
      resolution: node.data.resolution ?? DEFAULT_IMAGE_NODE_CONFIG.resolution,
      aspectRatio: node.data.aspectRatio ?? DEFAULT_IMAGE_NODE_CONFIG.aspectRatio,
      ...(node.data.quality ? { quality: node.data.quality } : {}),
      ...(node.data.outputFormat ? { outputFormat: node.data.outputFormat } : {}),
      ...(node.data.outputCompression !== undefined ? { outputCompression: node.data.outputCompression } : {}),
      ...(node.data.background ? { background: node.data.background } : {}),
      ...gptImage26Options(node.data),
      ...(node.data.mask ? { mask: node.data.mask } : {}),
      ...(node.data.markup ? { markup: node.data.markup } : {}),
      images: node.data.images ?? [],
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "video") return {
    id: node.id,
    type: "video",
    position: node.position,
    data: {
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.videoModel ? { model: modelRef(node.data.videoModel) } : {}),
      resolution: node.data.videoResolution ?? DEFAULT_VIDEO_NODE_CONFIG.resolution,
      aspectRatio: node.data.videoAspectRatio ?? DEFAULT_VIDEO_NODE_CONFIG.aspectRatio,
      duration: node.data.duration ?? DEFAULT_VIDEO_NODE_CONFIG.duration,
      references: node.data.references ?? [],
      ...(node.data.referenceMode ? { referenceMode: node.data.referenceMode } : {}),
      ...(node.data.referenceMentions ? { referenceMentions: node.data.referenceMentions } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "voice") return { id: node.id, type: "voice", position: node.position, data: { description: node.data.voiceDescription ?? "", sampleText: node.data.sampleText ?? "", ...audioNodeSettings(node.data), ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}), ...(node.data.assetId ? { assetId: node.data.assetId } : {}), ...(node.data.selectedAssetId ? { selectedAssetId: node.data.selectedAssetId, selectedSha256: node.data.selectedSha256 } : {}) } };
  if (node.type === "speech") return {
    id: node.id,
    type: "speech",
    position: node.position,
    data: {
      ...audioNodeSettings(node.data),
      text: node.data.text ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}),
      ...(node.data.voiceId ? { voiceId: node.data.voiceId } : {}),
      ...(node.data.referenceAssetId ? { referenceAssetId: node.data.referenceAssetId } : {}),
      ...(node.data.referenceSha256 ? { referenceSha256: node.data.referenceSha256 } : {}),
      ...(node.data.voiceSourceNodeId ? { voiceSourceNodeId: node.data.voiceSourceNodeId } : {}),
      ...(node.data.speed !== undefined ? { speed: node.data.speed } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "sound-effect") return {
    id: node.id,
    type: "sound-effect",
    position: node.position,
    data: {
      ...audioNodeSettings(node.data),
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.negativePrompt ? { negativePrompt: node.data.negativePrompt } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "music") return {
    id: node.id,
    type: "music",
    position: node.position,
    data: {
      ...audioNodeSettings(node.data),
      prompt: node.data.prompt ?? "",
      ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
      ...(node.data.audioModel ? { model: modelRef(node.data.audioModel) } : {}),
      instrumental: node.data.instrumental !== false,
      ...(node.data.lyrics ? { lyrics: node.data.lyrics } : {}),
      ...(node.data.durationSeconds !== undefined ? { durationSeconds: node.data.durationSeconds } : {}),
      ...(node.data.loop !== undefined ? { loop: node.data.loop } : {}),
      ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
    },
  };
  if (node.type === "model-3d") {
    const config = nodeModel3DConfig(node, model3DModels);
    return {
      id: node.id,
      type: "model-3d",
      position: node.position,
      data: {
        ...(node.data.model3DOperation ? { operation: node.data.model3DOperation } : {}),
        ...(node.data.prompt ? { prompt: node.data.prompt } : {}),
        ...(node.data.promptSource ? { promptSource: node.data.promptSource } : {}),
        ...(node.data.model3DSource ? { source: node.data.model3DSource } : {}),
        ...(node.data.model3DOptions ? { options: node.data.model3DOptions } : {}),
        ...(config.model ? { model: config.model } : {}),
        targetPolycount: config.targetPolycount,
        texture: config.texture,
        pbr: config.pbr,
        images: (node.data.images ?? []).slice(0, MODEL_3D_MAX_REFERENCE_IMAGES),
        ...(node.data.assetId ? { assetId: node.data.assetId } : {}),
      },
    };
  }
  throw new Error("Unsupported Asset Canvas Node type");
}

/** Keeps only the reference fields accepted by the persisted board schema. */
function textNodeReferences(node: AssetCanvasFlowNode): AssetCanvasTextReference[] {
  return (node.data.references ?? []).flatMap((reference) => reference.type === "node" ? [{ type: "node" as const, nodeId: reference.nodeId }] : []);
}

function modelRef<T extends { provider: string; id: string }>(model: T): { provider: string; id: string } {
  return { provider: model.provider, id: model.id };
}

function modelRefKey(model: ModelRef): string {
  return `${model.provider}:${model.id}`;
}

function sameImageModel(left: ImageModelRef, right?: ImageModelRef): boolean {
  return Boolean(right && left.provider === right.provider && left.id === right.id);
}

function imageReferenceViews(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[], viewLabels?: readonly string[]): MediaReferenceView[] {
  if (node.type !== "image" && node.type !== "model-3d") return [];
  return (node.data.images ?? []).map((reference, index) => {
    const label = viewLabels ? viewLabels[index] ?? t("assetCanvas.viewNumber", { number: index + 1 }) : t("assetCanvas.imageNumber", { number: index + 1 });
    if (reference.type === "library") {
      const asset = libraryAssets.find((candidate) => candidate.id === reference.assetId);
      return { assetId: reference.assetId, contentType: asset?.contentType, key: `library:${reference.assetId}:${index}`, name: asset?.name ?? t("assetCanvas.missingImage"), label, type: "image" };
    }
    const source = nodes.find((candidate) => candidate.id === reference.nodeId && isImageFlowSource(candidate));
    const assetId = source?.data.assetId;
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    return {
      contentType: asset?.contentType ?? source?.data.contentType,
      ...(assetId ? { assetId } : {}),
      key: `node:${reference.nodeId}`,
      type: "image",
      label,
      name: source?.type === "image"
        ? source.data.prompt?.trim() || t("assetCanvas.connectedImage")
        : asset?.name ?? (source ? t("assetCanvas.connectedImage") : t("assetCanvas.missingImageNode")),
    };
  });
}

function modelReferenceViews(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[]): MediaReferenceView[] {
  const source = node.type === "animate-3d" ? node.data.images?.[0] : node.type === "model-3d" ? node.data.model3DSource : undefined;
  if (!source) return [];
  if (source.type === "library") {
    const asset = libraryAssets.find((candidate) => candidate.id === source.assetId);
    return [{ assetId: source.assetId, key: `library:${source.assetId}`, name: asset?.name ?? t("assetCanvas.missingModel"), label: t("assetCanvas.model"), type: "model" }];
  }
  const sourceNode = nodes.find((candidate) => candidate.id === source.nodeId);
  const assetId = sourceNode?.data.assetId;
  const asset = libraryAssets.find((candidate) => candidate.id === assetId);
  return [{
    ...(assetId ? { assetId } : {}),
    key: `node:${source.nodeId}`,
    type: "model",
    label: t("assetCanvas.model"),
    name: asset?.name ?? (sourceNode ? t("assetCanvas.connected3d") : t("assetCanvas.missingModelNode")),
  }];
}

function videoReferenceViews(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[]): MediaReferenceView[] {
  if (node.type !== "video") return [];
  const counts = { image: 0, video: 0, audio: 0 };
  return (node.data.references ?? []).map((reference, index) => {
    const source = reference.type === "node" ? nodes.find((candidate) => candidate.id === reference.nodeId) : undefined;
    const assetId = reference.type === "library" ? reference.assetId : source?.data.assetId;
    const asset = libraryAssets.find((candidate) => candidate.id === assetId);
    const type = asset?.mediaType === "image" || asset?.mediaType === "video" || asset?.mediaType === "audio"
      ? asset.mediaType
      : videoReferenceType(source, libraryAssets) ?? "image";
    counts[type] += 1;
    return {
      ...(assetId ? { assetId } : {}),
      key: reference.type === "library" ? `library:${reference.assetId}:${index}` : `node:${reference.nodeId}`,
      name: asset?.name ?? (source?.type === "image" || source?.type === "video" ? source.data.prompt?.trim() || t(`assetCanvas.ref.${type}.connected`) : source ? t(`assetCanvas.ref.${type}.connected`) : t(`assetCanvas.ref.${type}.missing`)),
      label: t(`assetCanvas.ref.${type}.label`, { number: counts[type] }),
      type,
      ...(asset?.duration !== undefined ? { duration: asset.duration } : {}),
    };
  });
}

function imageReferenceLimit(node: AssetCanvasFlowNode, imageModels: ImageModel[]): number {
  if (node.type !== "image") return 0;
  const model = imageModels.find((candidate) => sameImageModel(candidate, node.data.model));
  if (model?.complexities?.length && node.data.outputFormat === "svg") return 0;
  return model?.supportsReferenceImage ? Math.min(IMAGE_MAX_REFERENCE_IMAGES, model.maxReferenceImages ?? IMAGE_MAX_REFERENCE_IMAGES) : 0;
}

function selectedVideoModel(node: AssetCanvasFlowNode, videoModels: VideoModel[]): VideoModel | undefined {
  return node.type === "video" ? videoModels.find((model) => sameModel(model, node.data.videoModel)) : undefined;
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}:${model.id}`;
}

function sameModel(model: ModelRef, ref?: ModelRef): boolean {
  return Boolean(ref && model.provider === ref.provider && model.id === ref.id);
}

/** A turnaround supplies its own view order, independently of a provider's generic slots. */
export function model3DViewLabels(model?: Model3DModel, turnaround = false): string[] {
  if (turnaround) return [t("assetCanvas.view.Front"), t("assetCanvas.view.Left"), t("assetCanvas.view.Back"), ...(model?.maxReferenceImages === 3 ? [] : [t("assetCanvas.optionalRight")])];
  return Array.from({ length: model?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES }, (_, index) =>
    viewLabel(model?.referenceImageLabels?.[index]) ?? t("assetCanvas.referenceNumber", { number: index + 1 }));
}

function modelReferenceLimit(node: AssetCanvasFlowNode, model?: Model3DModel): number {
  const operation = node.data.model3DOperation ?? "image";
  if (operation === "text" || operation === "remesh") return 0;
  if (operation === "retexture") return 1;
  const max = model?.maxReferenceImages ?? MODEL_3D_MAX_REFERENCE_IMAGES;
  return requiresModelTurnaround(node.data.model3DOptions, model?.protocol, operation) ? Math.min(4, max) : max;
}

function turnaroundViewIssue(references: readonly MediaReferenceView[], labels: readonly string[], model: Model3DModel | undefined, images: readonly LibraryAsset[], assetPaths: ReturnType<typeof useCanvasAssetSources>): string | undefined {
  if (model && model.maxReferenceImages < 3) return t("assetCanvas.turnaroundModelRequired");
  if (references.length > labels.length) return t("assetCanvas.removeExtraViews", { count: labels.length });
  const seen = new Set<string>();
  const missing = labels.slice(0, Math.max(3, references.length)).filter((_, index) => {
    const id = references[index]?.assetId;
    const image = id && images.find((candidate) => candidate.id === id);
    if (!image || assetPaths.get(image.id)?.error || !["image/jpeg", "image/png", "image/webp"].includes(image.contentType)) return true;
    const original = image.libraryAssetId ?? image.id;
    if (seen.has(original)) return true;
    seen.add(original);
    return false;
  });
  return missing.length ? t("assetCanvas.turnaroundMissing", { views: missing.join(t("assetCanvas.viewSeparator")) }) : undefined;
}

function viewLabel(label?: string): string | undefined {
  return label === "Front" || label === "Left" || label === "Back" || label === "Right" ? t(`assetCanvas.view.${label}`) : label;
}

function unavailableModel3DSelection(node: Pick<AssetCanvasFlowNode, "type" | "data">, models: readonly Model3DModel[]): boolean {
  if (node.type !== "model-3d" && node.type !== "animate-3d") return false;
  const ref = node.type === "animate-3d" ? node.data.animationModel : node.data.model3DConfig?.model;
  return isMeshyModelReference(ref) || Boolean(ref && models.some((model) => model.provider === ref.provider && (model.id === ref.id || model.id === MODEL3D_CONNECTION_ID) && isMeshyModelReference(model)))
    || node.type === "animate-3d" && !ref && Boolean(node.data.actionIds?.some((id) => typeof id === "number"));
}

function nodeModel3D(node: Pick<AssetCanvasFlowNode, "type" | "data">, models: readonly Model3DModel[] = node.data.model3DRuntime?.models ?? []): Model3DModel | undefined {
  if (node.data.model3DOperation === "retexture" || node.data.model3DOperation === "remesh") return resolveModel3DConnection(node.data.model3DConfig?.model, models);
  return resolveModel3D(node.data.model3DConfig?.model, models);
}

function nodeModel3DConfig(node: Pick<AssetCanvasFlowNode, "type" | "data">, models?: readonly Model3DModel[]): Model3DGenerationConfig {
  if (node.type !== "model-3d") return DEFAULT_MODEL_3D_CONFIG;
  const config = node.data.model3DConfig;
  return normalizeModel3DConfig(config, nodeModel3D(node, models), node.data.model3DOperation);
}

type ConnectionRelation = "voice-reference" | "image-reference" | "video-reference" | "model-reference" | "prompt" | "text-reference";

export function connectionRelation(
  source: AssetCanvasFlowNode,
  target: AssetCanvasFlowNode,
  _sourceHandle: string | null | undefined,
  nodes: AssetCanvasFlowNode[],
  libraryAssets: LibraryAsset[],
  imageModels: ImageModel[],
  model3DModels: readonly Model3DModel[] = [],
): ConnectionRelation | undefined {
  if (source.id === target.id) return undefined;
  if (target.type === "speech" && source.type === "asset") { const asset = libraryAssets.find((item) => item.id === source.data.assetId); return asset?.mediaType === "audio" && ["audio/mpeg", "audio/wav"].includes(asset.contentType) && asset.size <= AUDIO_REFERENCE_MAX_BYTES && (!asset.duration || asset.duration <= 30) && target.data.voiceSourceNodeId !== source.id ? "voice-reference" : undefined; }
  if (target.type === "speech" && source.type === "voice") return (source.data.selectedAssetId ?? source.data.assetId) && target.data.voiceSourceNodeId !== source.id ? "voice-reference" : undefined;
  if (target.type === "text" || target.type === "document") {
    if (source.type === "asset" && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(libraryAssets.find((asset) => asset.id === source.data.assetId)?.contentType ?? "")) return undefined;
    if (!isTextGenerationReferenceNode(source) || (target.data.references?.length ?? 0) >= MAX_TEXT_NODE_REFERENCES ||
      target.data.references?.some((reference) => reference.type === "node" && reference.nodeId === source.id) ||
      (source.type === "document" && target.type === "document" && source.data.documentId === target.data.documentId)) return undefined;
    return "text-reference";
  }
  if (isSupportedImageReferenceSource(source, libraryAssets) && target.type === "image") {
    return (target.data.images?.length ?? 0) < imageReferenceLimit(target, imageModels) &&
      !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id)
      ? "image-reference"
      : undefined;
  }
  if (isSupportedImageReferenceSource(source, libraryAssets) && target.type === "model-3d") {
    if (target.data.model3DOperation === "text" || target.data.model3DOperation === "remesh") return undefined;
    if (target.data.model3DOperation === "retexture" && (target.data.images?.length ?? 0) >= 1) return undefined;
    return (target.data.images?.length ?? 0) < modelReferenceLimit(target, nodeModel3D(target, model3DModels)) &&
      !(target.data.images ?? []).some((image) => image.type === "node" && image.nodeId === source.id)
      ? "image-reference"
      : undefined;
  }
  if (target.type === "model-3d" && (target.data.model3DOperation === "retexture" || target.data.model3DOperation === "remesh") && isModelSource(source, libraryAssets)) {
    const current = target.data.model3DSource;
    return current?.type === "node" && current.nodeId === source.id ? undefined : "model-reference";
  }
  if (target.type === "animate-3d") {
    const current = target.data.images?.[0];
    return isModelSource(source, libraryAssets) && !(current?.type === "node" && current.nodeId === source.id) ? "model-reference" : undefined;
  }
  if ((source.type === "text" || source.type === "document") && (target.type === "image" || target.type === "video" || target.type === "speech" || target.type === "sound-effect" || target.type === "music" || target.type === "model-3d" && (target.data.model3DOperation === "text" || target.data.model3DOperation === "retexture"))) {
    return target.data.promptSource?.nodeId === source.id ? undefined : "prompt";
  }
  if (target.type === "video") {
    return canAddVideoReference(target, source, nodes, libraryAssets) ? "video-reference" : undefined;
  }
  return undefined;
}

function isMediaNodeType(type: AssetCanvasNodeType): type is "image" | "video" {
  return type === "image" || type === "video";
}

/** FBX originals are processed through their retained GLB preview; unsupported previews fail before provider submission. */
function isModelSource(node: AssetCanvasFlowNode, libraryAssets: LibraryAsset[]): boolean {
  if (node.type === "model-3d" || node.type === "animate-3d") return true;
  if (node.type !== "asset" || node.data.mediaType !== "model") return false;
  const asset = libraryAssets.find((asset) => asset.id === node.data.assetId);
  return asset?.contentType === "model/gltf-binary" || asset?.contentType === "application/vnd.autodesk.fbx" && asset.model3d?.preview?.status === "ready";
}

function isImageFlowSource(node: AssetCanvasFlowNode | undefined): boolean {
  return node?.type === "image" || (node?.type === "asset" && node.data.mediaType === "image");
}

function isSupportedImageReferenceSource(node: AssetCanvasFlowNode, libraryAssets: LibraryAsset[]): boolean {
  if (node.type === "image") return true;
  if (node.type !== "asset" || node.data.mediaType !== "image") return false;
  const contentType = libraryAssets.find((asset) => asset.id === node.data.assetId)?.contentType;
  return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
}

function videoReferenceType(node: AssetCanvasFlowNode | undefined, libraryAssets: LibraryAsset[]): VideoGenerationReference["type"] | undefined {
  if (node?.type === "image") return "image";
  if (node?.type !== "asset" || node.data.mediaType !== "image") return undefined;
  const asset = libraryAssets.find((candidate) => candidate.id === node.data.assetId);
  return asset?.contentType === "image/png" || asset?.contentType === "image/jpeg" || asset?.contentType === "image/webp" ? "image" : undefined;
}

function canAddVideoReference(target: AssetCanvasFlowNode, source: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], libraryAssets: LibraryAsset[]): boolean {
  if (target.type !== "video" || target.id === source.id || (target.data.references ?? []).some((reference) => reference.type === "node" && reference.nodeId === source.id)) return false;
  const type = videoReferenceType(source, libraryAssets);
  if (!type) return false;
  const references = videoReferenceViews(target, nodes, libraryAssets);
  return references.filter((reference) => reference.type === type).length < 9;
}

function assetEdgeId(relation: "scene" | "image" | "model" | "reference" | "prompt" | "presentation", targetId: string, referenceId: string): string {
  return `${ASSET_EDGE_PREFIX}${relation}:${targetId}:${referenceId}`;
}

export function removeNodesAndReferences(nodes: AssetCanvasFlowNode[], removedIds: ReadonlySet<string>): AssetCanvasFlowNode[] {
  return nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) => node.type === "image" || node.type === "model-3d" || node.type === "animate-3d"
        ? {
            ...node,
            data: {
              ...node.data,
              ...(node.data.mask?.type === "node" && removedIds.has(node.data.mask.nodeId) ? { mask: undefined } : {}),
              ...(node.data.markup?.type === "node" && removedIds.has(node.data.markup.nodeId) ? { markup: undefined } : {}),
              ...(node.data.model3DSource?.type === "node" && removedIds.has(node.data.model3DSource.nodeId) ? { model3DSource: undefined } : {}),
              images: (node.data.images ?? []).filter((image) => image.type !== "node" || !removedIds.has(image.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node.type === "video" || node.type === "text" || node.type === "document"
        ? {
            ...node,
            data: {
              ...node.data,
              references: (node.data.references ?? []).filter((reference) => reference.type !== "node" || !removedIds.has(reference.nodeId)),
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
            },
          }
      : node.type === "speech" || node.type === "voice" || node.type === "sound-effect" || node.type === "music"
        ? {
            ...node,
            data: {
              ...node.data,
              ...(node.data.promptSource && removedIds.has(node.data.promptSource.nodeId) ? { promptSource: undefined } : {}),
              ...(node.data.voiceSourceNodeId && removedIds.has(node.data.voiceSourceNodeId) ? { voiceSourceNodeId: undefined } : {}),
            },
          }
      : node);
}

function resolveLinkedPrompt(node: AssetCanvasFlowNode, nodes: AssetCanvasFlowNode[], documents: CanvasDocuments): string | undefined {
  if (!node.data.promptSource) return undefined;
  const source = nodes.find((candidate) => candidate.id === node.data.promptSource?.nodeId);
  return source?.type === "document" ? documents.documents.find((doc) => doc.id === source.data.documentId)?.markdown : source?.type === "text" ? source.data.text ?? "" : undefined;
}

function effectivePrompt(data: AssetCanvasFlowData, runtime?: MediaNodeRuntime): string {
  return combineAssetCanvasPrompt(runtime?.linkedPrompt, data.prompt ?? "");
}

async function promptImage(blob: Blob): Promise<CreateLibraryImageRequest["image"]> {
  if (blob.type !== "image/png" && blob.type !== "image/jpeg" && blob.type !== "image/webp") {
    throw new Error("Connected images must be PNG, JPEG, or WebP.");
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("assetCanvas.readImageFailed")));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return { mediaType: blob.type, data: dataUrl.split(",", 2)[1] ?? "" };
}

async function readUploadImage(file: File): Promise<{ name: string; image: CreateLibraryImageRequest["image"] }> {
  if (file.type !== "image/png" && file.type !== "image/jpeg" && file.type !== "image/webp") {
    throw new Error("Use PNG, JPEG, or WebP reference images.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error(t("assetCanvas.referenceSize"));
  return { name: file.name, image: await promptImage(file) };
}

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Translate only our fixed daemon error envelope; do not classify provider prose. */
export function videoReferencePreparationNotice(value: unknown): string | undefined {
  if (!validVideoReferencePreparation(value)) return;
  if (value.version !== 1) {
    if (value.version === 3 && !value.requestBudgetMet) return;
    const notes = [value.version === 3 && value.requestBudgetResized ? t("assetCanvas.referenceBudgetResized") : value.jpegConverted || value.version === 3 && value.requestBudgetConverted ? t("assetCanvas.referenceJpegConverted") : undefined,
      value.jpegTransparent ? t("assetCanvas.referenceJpegTransparent") : value.jpegLimited ? t("assetCanvas.referenceJpegLimited") : value.jpegSkipped ? t("assetCanvas.referenceJpegSkipped") : undefined].filter(Boolean);
    if (notes.length) return notes.join(" ");
  }
  const key = value.invalid ? "pngOriginalInvalid" : value.limited ? "pngOriginalLimited" : value.unsupported ? "pngOriginalUnsupported"
    : value.unchanged ? "pngOriginalUnchanged" : value.optimized ? "pngLosslesslyOptimized" : undefined;
  return key ? t(`assetCanvas.${key}`) : undefined;
}

function providerGenerationErrorMessage(message: string): string {
  if (message === VIDEO_REFERENCE_BUDGET_ERROR) return t("assetCanvas.videoReferenceBudgetExceeded");
  const match = /^(Kunpo (?:rejected the video request|video status request failed) \(HTTP [1-5]\d{2}; )(?:bad-response-status|unclassified|reason unknown)(\))$/.exec(message)
    ?? /^(Kunpo audio request failed \([1-5]\d{2}; )reason unknown(\)(?:; completion is unknown and will not be retried automatically)?)$/.exec(message);
  return match ? `${match[1]}${t("assetCanvas.providerReasonUnknown")}${match[2]}` : message;
}

function isImageWaitCancelled(message: string): boolean {
  return ["This operation was aborted", "Generation cancelled"].includes(message);
}

function imageRecoveryMessage(message: string, compact = false): string {
  const key = isImageWaitCancelled(message) ? "imageWaitCancelled"
    : message.includes("Fake-IP DNS") ? message.includes("No generation request was submitted") ? "imageFakeIpNotSubmitted" : "imageFakeIpReceived"
    : message.startsWith("Image CDN could not be reached safely") ? "imageCdnNotSubmitted"
    : message.startsWith("No saved image result is available") || message.startsWith("The previous image submission could not be confirmed") ? "imageRecoveryUnavailable"
    : message.startsWith("The image result was received") || message.startsWith("Invalid provider artifact address") && message.includes("image result was received") ? "imageDownloadFailed"
    : message === "Invalid provider artifact address" ? "imageAddressRejected" : undefined;
  if (key) return t(`assetCanvas.${key}${compact ? "Short" : ""}`);
  return message;
}

async function projectCoverBlob(source: AssetCanvasCoverSource, assets: LibraryAsset[], content: (id: string) => Promise<Blob> = getLibraryAsset): Promise<Blob | undefined> {
  const asset = assets.find((candidate) => candidate.id === source.assetId);
  if (!asset || (asset.mediaType !== "image" && asset.mediaType !== "video") || asset.contentType === "image/svg+xml" || asset.name.toLowerCase().endsWith(".svg")) return undefined;
  return mediaBlobToWebP(await content(asset.id), asset.mediaType);
}

async function mediaBlobToWebP(blob: Blob, mediaType: "image" | "video"): Promise<Blob | undefined> {
  if (mediaType === "image") {
    const image = await createImageBitmap(blob);
    try {
      return bitmapToWebP(image);
    } finally {
      image.close();
    }
  }
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error(t("assetCanvas.videoCoverFailed"))), { once: true });
      video.load();
    });
    video.currentTime = 0;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvasToWebP(canvas);
  } finally {
    URL.revokeObjectURL(url);
    video.remove();
  }
}

function bitmapToWebP(image: ImageBitmap): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas");
  const width = Math.min(800, image.width);
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(image.height * width / image.width));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToWebP(canvas);
}

function canvasToWebP(canvas: HTMLCanvasElement): Promise<Blob | undefined> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? undefined), "image/webp", 0.8));
}

async function audioReferenceDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function audioNodeSettings(data: { language?: string; style?: string; speed?: number; output?: import("../shared/audio.js").AudioOutputSettings }) {
  return { ...(data.language !== undefined ? { language: data.language } : {}), ...(data.style !== undefined ? { style: data.style } : {}), ...(data.speed !== undefined ? { speed: data.speed } : {}), ...(data.output ? { output: data.output } : {}) };
}
