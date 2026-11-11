/** Retired compatibility hook. Only the daemon's explicit --local-env path may load credentials. */
export function loadEnvironmentFiles(
  _repositoryRoot: string,
  _mode: "development" | "production",
): void {}
