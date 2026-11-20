// Worker<->supervisor message channel: two append-only streams per task, stored as git refs and
// never on main. Each message is one commit on the empty tree whose subject is the text, author
// name the sender and author date the send time. refs/progress/<id> flows worker -> supervisors,
// refs/inbox/<id> flows supervisor/master -> worker.
import { git } from "./repo.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const STREAMS = ["progress", "inbox"];

// Append one message. Fast-forward only: a push lost to a concurrent appender is retried after
// re-fetching the tip, so a stream is always one linear chain no matter who appends.
export async function appendMessage(repo, stream, taskId, from, text, { at = Date.now() } = {}) {
  if (!STREAMS.includes(stream)) throw new Error(`invalid stream ${stream}`);
  const sender = String(from ?? "").trim();
  if (!sender) throw new Error("channel message needs a sender");
  const msg = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!msg) throw new Error("channel message is empty");
  const ref = `refs/${stream}/${taskId}`;
  const g = (args, opts = {}) => git(repo.workdir, args, { actor: sender, ...opts });
  for (let i = 0; ; i++) {
    await g(["fetch", "--quiet", "--force", "origin", `+${ref}:${ref}`], { ok: [128] }); // 128 = no such ref yet
    const parent = (await g(["rev-parse", "-q", "--verify", ref], { ok: [1] })).trim();
    const tree = (await g(["hash-object", "-w", "-t", "tree", "/dev/null"])).trim();
    const args = ["commit-tree", tree, "-m", msg];
    if (parent) args.push("-p", parent);
    const sha = (await g(args, { date: at })).trim();
    try {
      await g(["push", "--quiet", "origin", `${sha}:${ref}`]);
      return sha;
    } catch (e) {
      if (i >= 8) throw e;
      await sleep(200 + Math.floor(Math.random() * 500));
    }
  }
}

// All messages of one stream, oldest first: [{ sha, at (ms), from, text }]. `after` is a sha
// returned by appendMessage/readMessages; only strictly newer messages are returned (all of them
// when the sha is unknown).
export async function readMessages(repo, stream, taskId, { after } = {}) {
  if (!STREAMS.includes(stream)) throw new Error(`invalid stream ${stream}`);
  const ref = `refs/${stream}/${taskId}`;
  await git(repo.workdir, ["fetch", "--quiet", "--force", "origin", `+${ref}:${ref}`], { ok: [128] });
  const out = await git(repo.workdir, ["log", "--reverse", "--format=%H%x01%at%x01%an%x01%s", ref], { ok: [128] });
  const msgs = out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, at, from, ...text] = line.split("\x01");
      return { sha, at: Number(at) * 1000, from, text: text.join("\x01") };
    });
  const idx = after ? msgs.findIndex((m) => m.sha === after) : -1;
  return idx === -1 ? msgs : msgs.slice(idx + 1);
}
