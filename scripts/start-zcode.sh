#!/usr/bin/env bash
# Start ZCode with a local-only DevTools port, as required by glm-zcode-mcp.
# Run it inside the desktop session (or set DISPLAY / XAUTHORITY yourself, e.g. an Xvfb display).
set -euo pipefail
PORT="${ZCODE_MCP_CDP_PORT:-9222}"
MEM_HIGH="${ZCODE_MEMORY_HIGH:-5G}"
MEM_MAX="${ZCODE_MEMORY_MAX:-6G}"
SWAP_MAX="${ZCODE_MEMORY_SWAP_MAX:-0}"
for pair in "ZCODE_MEMORY_HIGH:$MEM_HIGH" "ZCODE_MEMORY_MAX:$MEM_MAX" "ZCODE_MEMORY_SWAP_MAX:$SWAP_MAX"; do
  name="${pair%%:*}"
  val="${pair#*:}"
  if ! [[ "$val" =~ ^[0-9]+[KMGTkmgt]?$ ]]; then
    echo "Invalid $name: $val" >&2; exit 1
  fi
done
if curl -fs "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "ZCode already listening on 127.0.0.1:${PORT}"; exit 0
fi
if pgrep -u "$(id -u)" -x ZCode >/dev/null || pgrep -u "$(id -u)" -x zcode >/dev/null; then
  echo "ZCode is running WITHOUT the debugging port. Quit it first, then re-run this script." >&2; exit 1
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"
LOG_FILE="${XDG_RUNTIME_DIR:-/tmp}/zcode-start.log"
ZCODE_BIN="${ZCODE_MCP_BIN:-$(command -v zcode || echo /usr/bin/zcode)}"
ZCODE_KEEP_DBUS="${ZCODE_KEEP_DBUS:-0}"

check_pid_cgroup_capped() {
  local pid="$1"
  node -e '
    const fs = require("fs");
    const path = require("path");
    const parse = (s) => {
      const m = /^([0-9]+)([KMGT]?)$/i.exec(String(s).trim());
      if (!m) return NaN;
      const mult = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
      return Number(m[1]) * mult;
    };
    const pid = process.argv[1];
    const wantMem = parse(process.argv[2]);
    const wantSwap = parse(process.argv[3]);
    const cgLine = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find(l => l.startsWith("0::"));
    if (!cgLine) process.exit(1);
    let cur = path.posix.normalize(cgLine.slice(3));
    let minMem = Infinity;
    let minSwap = Infinity;
    while (true) {
      const dir = "/sys/fs/cgroup" + (cur === "/" ? "" : cur);
      try {
        const m = fs.readFileSync(dir + "/memory.max", "utf8").trim();
        if (m !== "max") minMem = Math.min(minMem, Number(m));
      } catch {}
      try {
        const s = fs.readFileSync(dir + "/memory.swap.max", "utf8").trim();
        if (s !== "max") minSwap = Math.min(minSwap, Number(s));
      } catch {}
      if (cur === "/" || cur === ".") break;
      cur = path.posix.dirname(cur);
    }
    if (!Number.isFinite(minMem) || minMem > wantMem) process.exit(1);
    if (!Number.isFinite(minSwap) || minSwap > wantSwap) process.exit(1);
  ' "$pid" "$MEM_MAX" "$SWAP_MAX" 2>/dev/null
}

unset ELECTRON_RUN_AS_NODE
# Prevent Electron/Chromium from migrating to an uncapped app-zcode-*.scope over D-Bus
# unless interactive desktop OAuth needs D-Bus (app-zcode-.scope.d still enforces limits).
if [ "$ZCODE_KEEP_DBUS" = "1" ]; then
  cmd=("${ZCODE_BIN}" --remote-debugging-port="${PORT}" --remote-debugging-address=127.0.0.1)
else
  cmd=(env DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null "${ZCODE_BIN}" --remote-debugging-port="${PORT}" --remote-debugging-address=127.0.0.1)
fi
if check_pid_cgroup_capped "$$"; then
  nohup "${cmd[@]}" >"${LOG_FILE}" 2>&1 &
else
  command -v systemd-run >/dev/null || { echo "systemd-run is required to enforce MemoryMax=$MEM_MAX" >&2; exit 1; }
  nohup systemd-run --user --scope --quiet \
    --slice=zcode.slice \
    -p "MemoryHigh=${MEM_HIGH}" \
    -p "MemoryMax=${MEM_MAX}" \
    -p "MemorySwapMax=${SWAP_MAX}" \
    -p "Description=ZCode desktop (${MEM_MAX} RAM cap, swap=${SWAP_MAX})" \
    "${cmd[@]}" >"${LOG_FILE}" 2>&1 &
fi
for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    zpid="$(pgrep -u "$(id -u)" -x ZCode | head -n 1 || pgrep -u "$(id -u)" -x zcode | head -n 1 || true)"
    if [ -z "$zpid" ] || ! check_pid_cgroup_capped "$zpid"; then
      echo "ZCode started on 127.0.0.1:${PORT}, but cgroup memory cap verification failed for PID ${zpid:-unknown}." >&2
      exit 1
    fi
    echo "ZCode ready on 127.0.0.1:${PORT} (MemoryHigh=${MEM_HIGH}, MemoryMax=${MEM_MAX}, MemorySwapMax=${SWAP_MAX})"
    exit 0
  fi
  sleep 1
done
echo "ZCode did not open the debugging port; see ${LOG_FILE}" >&2; exit 1
