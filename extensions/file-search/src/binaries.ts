import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const FD_VERSION = "10.4.2";
export const FD_INTEL_DARWIN_VERSION = "10.3.0";
export const RG_VERSION = "15.2.0";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 10;

const FD_SHA256: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin":
    "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
  "x86_64-apple-darwin":
    "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
  "aarch64-unknown-linux-musl":
    "f32d3657473fba74e2600babc8db0b93420d51169223b7e8143b2ed55d8fd9e8",
  "x86_64-unknown-linux-musl":
    "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde",
};

const RG_SHA256: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin":
    "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  "x86_64-apple-darwin":
    "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
  "aarch64-unknown-linux-musl":
    "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
  "x86_64-unknown-linux-musl":
    "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
};

export type ToolName = "fd" | "rg";
export type BinarySource = "system" | "bundled" | "installed";

export interface ToolSpec {
  readonly tool: ToolName;
  readonly systemCommands: readonly string[];
  readonly binaryName: string;
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  fd: { tool: "fd", systemCommands: ["fd", "fdfind"], binaryName: "fd" },
  rg: { tool: "rg", systemCommands: ["rg"], binaryName: "rg" },
};

export interface PlatformTarget {
  readonly os: string;
  readonly arch: string;
}

export interface ReleaseAsset {
  readonly url: string;
  readonly fileName: string;
  readonly archiveDir: string;
  readonly binaryName: string;
  readonly version: string;
  readonly sha256: string;
}

function targetTriple(target: PlatformTarget) {
  const cpu =
    target.arch === "arm64"
      ? "aarch64"
      : target.arch === "x64"
        ? "x86_64"
        : undefined;
  if (!cpu) return undefined;
  if (target.os === "darwin") return `${cpu}-apple-darwin`;
  if (target.os === "linux") return `${cpu}-unknown-linux-musl`;
  return undefined;
}

export function releaseAsset(
  tool: ToolName,
  target: PlatformTarget,
): ReleaseAsset | undefined {
  const triple = targetTriple(target);
  if (!triple) return undefined;

  if (tool === "fd") {
    const sha256 = FD_SHA256[triple];
    if (!sha256) return undefined;
    const version =
      triple === "x86_64-apple-darwin" ? FD_INTEL_DARWIN_VERSION : FD_VERSION;
    const archiveDir = `fd-v${version}-${triple}`;
    const fileName = `${archiveDir}.tar.gz`;
    return {
      url: `https://github.com/sharkdp/fd/releases/download/v${version}/${fileName}`,
      fileName,
      archiveDir,
      binaryName: "fd",
      version,
      sha256,
    };
  }

  const sha256 = RG_SHA256[triple];
  if (!sha256) return undefined;
  const archiveDir = `ripgrep-${RG_VERSION}-${triple}`;
  const fileName = `${archiveDir}.tar.gz`;
  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${fileName}`,
    fileName,
    archiveDir,
    binaryName: "rg",
    version: RG_VERSION,
    sha256,
  };
}

export function currentTarget(): PlatformTarget {
  return { os: process.platform, arch: process.arch };
}

export function repositoryBinDir() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..", "..", "bin");
}

export class UnsupportedPlatformError extends Error {
  override name = "UnsupportedPlatformError";
}

export class InstallError extends Error {
  override name = "InstallError";
}

export interface BinaryEnv {
  readonly probe: (command: string, tool: ToolName) => Promise<boolean>;
  readonly install: (asset: ReleaseAsset, destination: string) => Promise<void>;
}

export interface ResolvedBinary {
  readonly tool: ToolName;
  readonly command: string;
  readonly source: BinarySource;
  readonly version?: string;
}

export async function resolveBinary(
  spec: ToolSpec,
  binDir: string,
  target: PlatformTarget,
  env: BinaryEnv,
): Promise<ResolvedBinary> {
  for (const command of spec.systemCommands) {
    if (await env.probe(command, spec.tool)) {
      return { tool: spec.tool, command, source: "system" };
    }
  }

  const bundled = join(binDir, spec.binaryName);
  if (await env.probe(bundled, spec.tool)) {
    return { tool: spec.tool, command: bundled, source: "bundled" };
  }

  const asset = releaseAsset(spec.tool, target);
  if (!asset) {
    throw new UnsupportedPlatformError(
      `No ${spec.tool} binary is available for ${target.os}/${target.arch}. Install ${spec.tool} manually and restart pi.`,
    );
  }

  await env.install(asset, bundled);
  if (!(await env.probe(bundled, spec.tool))) {
    throw new InstallError(
      `${spec.tool} ${asset.version} was installed to ${bundled} but failed to run.`,
    );
  }

  return {
    tool: spec.tool,
    command: bundled,
    source: "installed",
    version: asset.version,
  };
}

export async function readBoundedResponse(
  response: Response,
  maxBytes = MAX_ARCHIVE_BYTES,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`download exceeds the ${maxBytes}-byte size limit`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`download exceeds the ${maxBytes}-byte size limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadAsset(initialUrl: URL) {
  let url = initialUrl;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);

  for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
    if (url.protocol !== "https:") {
      throw new Error(`refusing non-HTTPS download URL: ${url.href}`);
    }

    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location)
        throw new Error(`redirect from ${url.href} had no location`);
      if (redirects === MAX_DOWNLOAD_REDIRECTS) {
        throw new Error(
          `download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`,
        );
      }
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    return readBoundedResponse(response);
  }

  throw new Error("download redirect handling failed");
}

async function installAsset(asset: ReleaseAsset, destination: string) {
  if (!URL.canParse(asset.url))
    throw new InstallError(`Invalid URL: ${asset.url}`);

  const workDir = await mkdtemp(join(tmpdir(), "pi-file-search-"));
  const stagedDestination = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const bytes = await downloadAsset(new URL(asset.url));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${asset.fileName}: expected ${asset.sha256}, received ${digest}`,
      );
    }

    const archivePath = join(workDir, asset.fileName);
    await writeFile(archivePath, bytes);
    await execFileAsync("tar", ["-xzf", archivePath, "-C", workDir], {
      timeout: 60_000,
    });

    const extracted = join(workDir, asset.archiveDir, asset.binaryName);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(extracted, stagedDestination);
    await chmod(stagedDestination, 0o755);
    await rename(stagedDestination, destination);
  } catch (error) {
    throw new InstallError(
      `Failed to install ${asset.binaryName} ${asset.version} from ${asset.url}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await rm(stagedDestination, { force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

export const liveBinaryEnv: BinaryEnv = {
  async probe(command, tool) {
    try {
      const args =
        tool === "fd" ? ["--max-results", "1", "--", ""] : ["--version"];
      await execFileAsync(command, args, { cwd: tmpdir(), timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  },
  install: installAsset,
};
