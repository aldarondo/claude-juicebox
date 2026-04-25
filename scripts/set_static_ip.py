import asyncio, telnetlib3, sys

IP = sys.argv[1] if len(sys.argv) > 1 else "192.168.0.69"

async def configure():
    reader, writer = await asyncio.wait_for(
        telnetlib3.open_connection(IP, 2000, encoding=False), timeout=10)
    await asyncio.sleep(1)
    try:
        await asyncio.wait_for(reader.read(512), timeout=2)
    except:
        pass

    async def cmd(s):
        writer.write(b"\n")
        await asyncio.sleep(0.3)
        writer.write(s.encode() + b"\n")
        await writer.drain()
        await asyncio.sleep(1.5)
        out = b""
        try:
            out = await asyncio.wait_for(reader.read(512), timeout=2)
        except:
            pass
        print(f"{s!r} -> {out.decode(errors='replace').strip()!r}")

    await cmd("set wlan.static.ip 192.168.0.2")
    await cmd("set wlan.static.gateway 192.168.0.1")
    await cmd("set wlan.static.netmask 255.255.255.0")
    await cmd("set wlan.static.dns 192.168.0.64")
    await cmd("set wlan.dhcp.enabled 0")
    await cmd("save")
    await cmd("reboot")
    writer.close()

asyncio.run(configure())
