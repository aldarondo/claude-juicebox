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

# Patch exception handlers so JuicePassProxy does not crash when the JuiceBox
# is unreachable at startup.
#
# Background: get_juicebox_id() (and get_enelx_server_port() when
# IGNORE_ENELX=false, and JuiceboxUDPCUpdater._connect() when UPDATE_UDPC=true)
# open a telnet connection to the JuiceBox during startup. The existing
# handlers catch only TimeoutError and ConnectionResetError. When the
# JuiceBox is off/unplugged/misconfigured, telnetlib3 raises other OSError
# subclasses instead — ConnectionRefusedError (closed port), OSError
# ENETUNREACH/EHOSTUNREACH (no route), or socket.gaierror (DNS failure).
# None of those are caught, so the exception propagates out of async_main()
# and the container exits, causing Docker to restart it in a loop.
#
# Fix: broaden the three handler clauses to also catch OSError, which is
# the common ancestor of all the above. TimeoutError is handled by its own
# earlier clause (even though it is itself an OSError subclass in 3.10+,
# Python matches the first `except` that fits).

RUN python3 - <<'EOF'
import pathlib, re, sys

# (filename, regex_pattern) — each pattern must uniquely identify the
# handler(s) we want to broaden. We deliberately do NOT do a blanket
# replace across juicebox_udpcupdater.py because that file already has a
# paired `except OSError` handler alongside one of its ConnectionResetError
# blocks; a blanket replace would render the sibling unreachable.
patches = [
    # juicepassproxy.py: both handlers (get_enelx_server_port +
    # get_juicebox_id) log via "... via Telnet." and have no sibling
    # OSError handler — safe to broaden both.
    (
        "juicepassproxy.py",
        re.compile(
            r'(except )ConnectionResetError( as e:\s+_LOGGER\.warning\(\s*"Error in getting )'
        ),
    ),
    # juicebox_udpcupdater.py: only the handler in _connect() needs
    # broadening. It is uniquely identified by its "JuiceboxUDPCUpdater
    # Telnet Connection Error. Reconnecting." warning message. The other
    # handler in _udpc_update_handler() already has a paired OSError
    # handler below it.
    (
        "juicebox_udpcupdater.py",
        re.compile(
            r'(except )ConnectionResetError( as e:\s+_LOGGER\.warning\(\s*"JuiceboxUDPCUpdater Telnet Connection Error\. Reconnecting)'
        ),
    ),
]

for filename, pattern in patches:
    files = list(pathlib.Path("/").rglob(filename))
    if not files:
        print(f"WARNING: {filename} not found — skipping crash-on-unreachable patch", file=sys.stderr)
        continue
    target = files[0]
    src = target.read_text()
    patched, n = pattern.subn(r'\1(ConnectionResetError, OSError)\2', src)
    if n == 0:
        print(
            f"WARNING: crash-on-unreachable pattern not found in {target} — "
            "already patched or upstream source changed. "
            "Review juicepassproxy/Dockerfile.",
            file=sys.stderr,
        )
    else:
        target.write_text(patched)
        print(f"Patched {n} exception handler(s) in {target}")
EOF
