// Debug helper: save a screenshot of the ZCode window. Usage: node scripts/screenshot.mjs [out.png]
import { writeFileSync } from "node:fs";
import { Cdp } from "../src/cdp.mjs";
import { config } from "../src/config.mjs";
const cdp = await Cdp.connect(config.cdpPort);
writeFileSync(process.argv[2] ?? "/tmp/zcode.png", await cdp.screenshot());
cdp.close();
