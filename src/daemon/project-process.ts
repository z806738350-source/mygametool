/**
 * App-owned native binaries must not override a project's own dependencies,
 * and the daemon's own settings, such as its access token, are not for
 * project code.
 */
export function projectProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG", "TZ"]);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (allowed.has(name.toUpperCase()) && value !== undefined) result[name] = value;
  }
  return result;
}
