import { withClient, parse } from "./client.mjs";
const call = async (c, name, args) => parse(await c.callTool({ name, arguments: args }));
await withClient(async (c) => {
  const t0 = Date.now();
  const run = await call(c, "zcode_run", {
    model: "GLM-5.3",
    prompt: "第一行:这是多行提示词测试。\n第二行:请先运行 shell 命令 `sleep 20`,然后运行 `echo MARKER-42`。\n第三行:最后只回复你在输出里看到的标记字符串。",
  });
  console.log("RUN", ((Date.now() - t0) / 1000).toFixed(1) + "s", JSON.stringify(run));
  if (run.error) return;
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const st = await call(c, "zcode_status", { taskId: run.taskId });
    const key = `${st.status}|${st.currentTool}|${st.toolCalls}`;
    if (!seen.has(key)) { seen.add(key); console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(st)); }
    if (st.status !== "running" && st.status !== "starting") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("WAIT", JSON.stringify(await call(c, "zcode_wait", { taskId: run.taskId, timeoutSec: 30 }), null, 1));
});
