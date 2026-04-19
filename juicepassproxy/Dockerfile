FROM ghcr.io/juicerescue/juicepassproxy:latest

# Patch MITM_RECV_TIMEOUT so it can be set via the MITM_RECV_TIMEOUT
# environment variable at runtime.
#
# Background: JuicePassProxy restarts its MITM loop after each receive
# timeout. The upstream default is 120 s, which causes a container restart
# every ~3.3 hours when the JuiceBox is idle (charger only sends directed
# UDP while actively charging). Setting 600 s reduces restarts to ~once per
# 10 minutes of idle time, which is acceptable.
#
# The patch uses Python to find the installed module and replace the
# hardcoded constant with an os.environ lookup. It prints a warning if the
# pattern is not found (e.g. upstream changed the constant name) so the
# build still succeeds but the operator knows to revisit this Dockerfile.

RUN python3 - <<'EOF'
import pathlib, re, sys

files = list(pathlib.Path("/").rglob("juicepassproxy.py"))
if not files:
    print("ERROR: juicepassproxy.py not found", file=sys.stderr)
    sys.exit(1)

target = files[0]
src = target.read_text()

patched = re.sub(
    r'MITM_RECV_TIMEOUT\s*=\s*\d+',
    'MITM_RECV_TIMEOUT = int(__import__("os").environ.get("MITM_RECV_TIMEOUT", "120"))',
    src,
)

if patched == src:
    print(
        f"WARNING: MITM_RECV_TIMEOUT pattern not found in {target} — "
        "already patched or upstream source changed. "
        "Set MITM_RECV_TIMEOUT env var manually if needed.",
        file=sys.stderr,
    )
else:
    target.write_text(patched)
    print(f"Patched MITM_RECV_TIMEOUT in {target}")
EOF
