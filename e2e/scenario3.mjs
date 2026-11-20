import { withClient, parse } from "./client.mjs";
const T0 = Date.now(); const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const submit = (n) => withClient(async (c) => {
  const r = parse(await c.callTool({ name: "zcode_run", arguments: { model: "GLM-5.3-Flash", prompt: `请运行 shell 命令 sleep 25,然后只回复数字 ${n}。` } }));
  console.log(ts(), `client${n}`, r.error ?? r.taskId);
  return { n, ...r };
});
const results = await Promise.all([1, 2, 3, 4].map(submit));
const ok = results.filter((r) => r.taskId);
console.log("accepted:", ok.length, "rejected:", results.filter((r) => r.error).map((r) => r.error));
await withClient(async (c) => {
  for (const r of ok) {
    const w = parse(await c.callTool({ name: "zcode_wait", arguments: { taskId: r.taskId, timeoutSec: 100 } }));
    console.log(ts(), `task${r.n} expected ${r.n} ->`, w.status, JSON.stringify(w.result));
  }
});
