import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packaged = ["authenti8verify.exe", "authenti8verifynativehost.exe"]
  .includes(basename(process.execPath).toLowerCase());
const nativeDirectory = packaged ? resolve(dirname(process.execPath), "native")
  : resolve(dirname(fileURLToPath(import.meta.url)), "../native");
declare const __AUTHENTI8_NATIVE_SCRIPTS__: Readonly<Record<string, string>> | undefined;

function nativeScriptPath(scriptName: string) {
  if (!/^[a-z0-9-]+\.ps1$/i.test(scriptName)) throw new Error("Invalid native script name.");
  return resolve(nativeDirectory, scriptName);
}

export function windowsSystemExecutable(name: "powershell.exe" | "tar.exe",
  environment: NodeJS.ProcessEnv = process.env) {
  const systemRoot = windowsSystemRoot(environment);
  return name === "powershell.exe"
    ? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", name)
    : win32.join(systemRoot, "System32", name);
}

export function windowsSystemRoot(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.SystemRoot ?? environment.windir;
  if (!value || !win32.isAbsolute(value) || !/^[a-z]:\\/i.test(value)) {
    throw new Error("Windows did not provide a valid system directory.");
  }
  return win32.normalize(value);
}

export function nativeScriptInvocation(scriptName: string, arguments_: string[] = []) {
  const executable = windowsSystemExecutable("powershell.exe");
  const common = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  if (!packaged) return { executable, arguments: [...common, "-File",
    nativeScriptPath(scriptName), ...arguments_] };
  const source = typeof __AUTHENTI8_NATIVE_SCRIPTS__ === "object"
    ? __AUTHENTI8_NATIVE_SCRIPTS__[scriptName] : undefined;
  if (!source) throw new Error(`Native script ${scriptName} is not embedded in this build.`);
  return { executable, arguments: [...common, "-EncodedCommand",
    encodedInvocation(source, arguments_)] };
}

export async function runSensor<T>(scriptName: string, arguments_: string[] = []): Promise<T[]> {
  assertWindows();
  const invocation = nativeScriptInvocation(scriptName, arguments_);
  const result = await execute(invocation.executable, invocation.arguments,
    { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed as T[] : [parsed as T];
}

function encodedInvocation(source: string, arguments_: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "Authenti8-Arguments-"));
  const argumentPath = join(directory, "arguments.json");
  writeFileSync(argumentPath, JSON.stringify(arguments_), { mode: 0o600 });
  const path = Buffer.from(argumentPath).toString("base64");
  const wrapper = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${path}'));`
    + `try{$a=ConvertFrom-Json ([IO.File]::ReadAllText($p));`
    + `$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'));`
    + `& ([ScriptBlock]::Create($s)) @a}finally{Remove-Item -LiteralPath (Split-Path $p) -Recurse -Force}`;
  return Buffer.from(wrapper, "utf16le").toString("base64");
}

function assertWindows() {
  if (process.platform !== "win32") throw new Error("Windows sensors require Windows 11.");
}
