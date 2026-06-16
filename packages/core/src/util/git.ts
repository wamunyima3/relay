import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitInfo {
  repo: string | null;
  commit: string | null;
  branch: string | null;
}

/**
 * Best-effort git metadata for a directory. Relay never syncs code (git is the
 * file-transport, §4) — it just records enough to warn about repo drift on the
 * destination machine.
 */
export async function detectGit(cwd: string): Promise<GitInfo> {
  const info: GitInfo = { repo: null, commit: null, branch: null };
  const tryGit = async (args: string[]) => {
    try {
      const { stdout } = await run("git", args, { cwd });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  info.repo = await tryGit(["config", "--get", "remote.origin.url"]);
  info.commit = await tryGit(["rev-parse", "HEAD"]);
  info.branch = await tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  return info;
}
