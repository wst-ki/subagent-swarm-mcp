import { withClient, parse } from "./client.mjs";
const call = async (c, name, args) => parse(await c.callTool({ name, arguments: args }));
const slp = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now(); const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const short = (o) => JSON.stringify(o).slice(0, 260);

await withClient(async (c) => {
  console.log("== 1. cancel");
  const a = await call(c, "zcode_run", { model: "GLM-5.3-Flash", prompt: "请运行 shell 命令 sleep 90,然后回复 done。" });
  console.log(ts(), "run", short(a));
  for (let i = 0; i < 30; i++) { const s = await call(c, "zcode_status", { taskId: a.taskId }); if (s.currentTool) { console.log(ts(), "tool running:", s.currentTool); break; } await slp(1000); }
  const cx = await call(c, "zcode_cancel", { taskId: a.taskId });
  console.log(ts(), "cancel", short(cx));
  console.log(ts(), "status after", short(await call(c, "zcode_status", { taskId: a.taskId })));

  console.log("== 2. follow-up keeps context");
  let prev = process.env.ZCODE_E2E_PREV_SESSION;
  if (!prev) {
    const seed = await call(c, "zcode_run", { model: "GLM-5.3-Flash", prompt: "请只回复字符串 MARKER-E2E-7。" });
    console.log(ts(), "seed", short(seed));
    if (!seed.taskId) throw new Error("failed to create seed session for follow-up");
    const waitedSeed = await call(c, "zcode_wait", { taskId: seed.taskId, timeoutSec: 45 });
    console.log(ts(), "seed wait", short(waitedSeed));
    prev = seed.taskId;
  }
  console.log(ts(), "followup", short(await call(c, "zcode_followup", { taskId: prev, prompt: "我之前让你回复的标记字符串是什么?只回复该字符串。" })));
  console.log(ts(), "wait", short(await call(c, "zcode_wait", { taskId: prev, timeoutSec: 60 })));

  console.log("== 3. error paths");
  console.log(short(await call(c, "zcode_run", { prompt: "x", model: "GLM-5.1" })));
  console.log(short(await call(c, "zcode_status", { taskId: "session_doesnotexist" })));
  console.log(short(await call(c, "zcode_cancel", { taskId: prev })));
});
