// Manual end-to-end helper: node test/client.mjs <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--disable-warning=ExperimentalWarning", new URL("../src/server.mjs", import.meta.url).pathname],
    env: process.env,
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
export const parse = (r) => (r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text));

if (import.meta.url === `file://${process.argv[1]}`) {
  await withClient(async (c) => {
    if (!process.argv[2]) return console.log((await c.listTools()).tools.map((t) => t.name));
    const r = await c.callTool({ name: process.argv[2], arguments: JSON.parse(process.argv[3] ?? "{}") });
    console.log(JSON.stringify(parse(r), null, 2));
  });
}
