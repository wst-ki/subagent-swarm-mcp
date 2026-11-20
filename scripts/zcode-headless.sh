#!/usr/bin/env bash
# Run the official app on a private virtual display. Run as a supervised service;
# never attach to, stop, or replace an existing ZCode process.
set -euo pipefail
port="${ZCODE_MCP_CDP_PORT:-9222}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "Invalid ZCODE_MCP_CDP_PORT" >&2; exit 1
fi
mem_high="${ZCODE_MEMORY_HIGH:-5G}"
mem_max="${ZCODE_MEMORY_MAX:-6G}"
swap_max="${ZCODE_MEMORY_SWAP_MAX:-0}"
for pair in "ZCODE_MEMORY_HIGH:$mem_high" "ZCODE_MEMORY_MAX:$mem_max" "ZCODE_MEMORY_SWAP_MAX:$swap_max"; do
  name="${pair%%:*}"
  val="${pair#*:}"
  if ! [[ "$val" =~ ^[0-9]+[KMGTkmgt]?$ ]]; then
    echo "Invalid $name: $val" >&2; exit 1
  fi
done
command -v xvfb-run >/dev/null || { echo "xvfb-run is required" >&2; exit 1; }
zcode_bin="${ZCODE_MCP_BIN:-$(command -v zcode || echo /usr/bin/zcode)}"
if pgrep -u "$(id -u)" -x ZCode >/dev/null || pgrep -u "$(id -u)" -x zcode >/dev/null; then
  echo "ZCode is already running; refusing to start or interrupt it." >&2; exit 1
fi
if ! node -e 'const s = require("node:net").createServer(); s.on("error", () => process.exit(1)); s.listen(Number(process.argv[1]), "127.0.0.1", () => s.close());' "$port"; then
  echo "The configured debugging port is already in use; refusing to attach." >&2; exit 1
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

cgroup_capped() {
  node -e '
    const fs = require("fs");
    const parse = (s) => {
      const m = /^([0-9]+)([KMGT]?)$/i.exec(String(s).trim());
      if (!m) return NaN;
      const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
      return Number(m[1]) * mult;
    };
    const wantMem = parse(process.argv[1]);
    const wantSwap = parse(process.argv[2]);
    const cgLine = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find(l => l.startsWith("0::"));
    if (!cgLine) process.exit(1);
    const cgPath = "/sys/fs/cgroup" + cgLine.slice(3);
    const curMem = fs.readFileSync(cgPath + "/memory.max", "utf8").trim();
    const curSwap = fs.readFileSync(cgPath + "/memory.swap.max", "utf8").trim();
    if (curMem === "max" || Number(curMem) > wantMem) process.exit(1);
    if (curSwap === "max" || Number(curSwap) > wantSwap) process.exit(1);
  ' "$mem_max" "$swap_max" 2>/dev/null
}

if ! cgroup_capped; then
  command -v systemd-run >/dev/null || { echo "systemd-run is required to enforce MemoryMax=$mem_max" >&2; exit 1; }
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
  self_script="$(readlink -f "$0")"
  env_args=(
    -E "ZCODE_MCP_CDP_PORT=${port}"
    -E "ZCODE_MEMORY_HIGH=${mem_high}"
    -E "ZCODE_MEMORY_MAX=${mem_max}"
    -E "ZCODE_MEMORY_SWAP_MAX=${swap_max}"
    -E "PATH=${PATH}"
  )
  if [ -n "${ZCODE_MCP_HOME:-}" ]; then
    env_args+=(-E "ZCODE_MCP_HOME=${ZCODE_MCP_HOME}")
  fi
  if [ -n "${ZCODE_MCP_BIN:-}" ]; then
    env_args+=(-E "ZCODE_MCP_BIN=${ZCODE_MCP_BIN}")
  fi
  exec systemd-run --user --collect --wait --pipe --quiet \
    --slice=zcode.slice \
    -p "MemoryHigh=${mem_high}" \
    -p "MemoryMax=${mem_max}" \
    -p "MemorySwapMax=${swap_max}" \
    -p "OOMPolicy=kill" \
    -p "OOMScoreAdjust=500" \
    -p "KillMode=control-group" \
    -p "Description=ZCode headless (${mem_max} RAM cap, swap=${swap_max})" \
    "${env_args[@]}" \
    "$self_script" "$@"
fi

unset ELECTRON_RUN_AS_NODE
# Prevent Electron/Chromium from calling systemd1 StartTransientUnit over D-Bus
# and migrating out of the MemoryMax-capped cgroup into an uncapped app-zcode-*.scope.
export DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null
exec xvfb-run -a -s '-screen 0 1280x800x24 -nolisten tcp' "$zcode_bin" \
  --remote-debugging-port="$port" --remote-debugging-address=127.0.0.1
