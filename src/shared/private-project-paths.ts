import { mediaFileInfo } from "./media-files.js";

/** Filename policy only. This does not detect secrets embedded in ordinary project content. */
const PRIVATE_DIRECTORIES = new Set([
  ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".codex", ".claude", ".agents",
  "pi-agent", "agent-runtimes", "external-mcp", "plugin-data", "plugin-setup",
  "agent-attachments", "request-image-previews", "request-files",
  "agent-media", "audio-attempts", "image-requests", "provider-image-sources", "video-tasks", "model3d-tasks", "manual-vm.lock",
]);
const PRIVATE_SETTINGS = new Set([
  "openai-images.json", "seedance.json", "minimax.json", "volcengine-tts.json", "volcengine-seed-audio.json",
  "meshy.json", "tripo.json", "hyper3d.json", "network-settings.json", "web-search-settings.json", "plugin-settings.json", "isolated-execution.json",
]);

export function isPrivateCredentialName(value: string): boolean {
  const name = value.toLowerCase().replace(/[. ]+$/, "");
  if (PRIVATE_DIRECTORIES.has(name) || PRIVATE_SETTINGS.has(name) || name.startsWith(".env") ||
    /\.(?:pem|key|p12|pfx|jks|keystore)(?:[._-]|$)/i.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-]|$)/i.test(name)) return true;
  // A key or token can also be an ordinary game asset. Content checks still apply.
  if ((mediaFileInfo(name) || /\.(?:bmp|gltf|obj|mtl)$/i.test(name))
    && !/\.(?:json|ya?ml|toml|ini|conf|txt)\./i.test(name)) return false;
  return (
    /(?:^|[._-])(?:auth|credentials?|secrets?|keys?|api[-_]?keys?|local[-_]api[-_]keys?|tokens?|passwords?|daemon[-_]runtime)(?:[._-]|$)/i.test(name) ||
    PRIVATE_SETTINGS.has(name)
  );
}

export function isPrivateProjectPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).filter(Boolean).some(isPrivateCredentialName);
}
