// Local worktrees share the source object database while keeping files and index isolated.
// Remote repositories and HUB_CHECKOUT_MODE=clone retain the independent-clone path.
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { git } from "./repo.mjs";

export function checkoutMode(env = process.env) {
  const mode = env.HUB_CHECKOUT_MODE ?? "worktree";
  if (!["worktree", "clone"].includes(mode)) throw new Error("HUB_CHECKOUT_MODE must be worktree or clone");
  return mode;
}

export async function removeCheckout(workdir) {
  const dotgit = join(workdir, ".git");
  // Registered worktrees must be removed through Git so their source repo keeps no stale
  // worktree/index entries. Legacy clones and plain task directories need only rm.
  if (existsSync(dotgit) && lstatSync(dotgit).isFile()) {
    const top = (await git(workdir, ["rev-parse", "--show-toplevel"])).trim();
    if (realpathSync(top) !== realpathSync(workdir)) throw new Error(`checkout root mismatch: ${workdir}`);
    const common = (await git(workdir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    await git(null, ["--git-dir", common, "worktree", "remove", "--force", workdir]);
  } else {
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function prepareCheckout(task, workdir, { fresh, mode = checkoutMode() } = {}) {
  const spec = task.spec ?? {};
  if (!["code", "review"].includes(spec.kind) || !spec.repo) {
    mkdirSync(workdir, { recursive: true });
    return;
  }
  if (fresh) await removeCheckout(workdir);
  else if (existsSync(join(workdir, ".git"))) return; // preserve follow-up changes
  mkdirSync(dirname(workdir), { recursive: true });
  if (mode === "worktree" && isAbsolute(spec.repo) && existsSync(spec.repo)) {
    await git(spec.repo, ["worktree", "add", "--detach", workdir, spec.base ?? "HEAD"]);
  } else {
    await git(dirname(workdir), ["clone", "--no-checkout", spec.repo, workdir]);
    await git(workdir, ["checkout", "--detach", spec.base ?? "HEAD"]);
  }
}
