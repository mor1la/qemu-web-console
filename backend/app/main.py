import asyncio
import os
import subprocess
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import asyncssh
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .qmp import execute, QMPError

DISK = Path(os.getenv("VM_DISK", "/data/debian.qcow2"))
SEED = Path(os.getenv("VM_SEED", "/data/seed.iso"))
SSH_KEY = Path(os.getenv("VM_SSH_KEY", "/data/keys/id_ed25519"))
RUN_DIR = Path("/data/run")
QMP = RUN_DIR / "qmp.sock"
SERIAL = RUN_DIR / "serial.sock"
SSH_PORT = 2222
lock = asyncio.Lock()
process = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    yield
    global process
    if process is not None and process.poll() is None:
        with suppress(Exception):
            await execute(str(QMP), "system_powerdown")
        try:
            await asyncio.wait_for(asyncio.to_thread(process.wait), timeout=15)
        except asyncio.TimeoutError:
            with suppress(Exception):
                await execute(str(QMP), "quit")
            with suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)


app = FastAPI(title="QEMU Web Console", lifespan=lifespan)


@app.exception_handler(QMPError)
async def qmp_error_handler(request, exc):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


def require_image():
    if not DISK.is_file() or not SEED.is_file():
        raise HTTPException(400, "VM disk or seed.iso missing; run scripts/prepare-image.sh")


async def vm_status():
    try:
        data = await execute(str(QMP), "query-status")
        return {"state": data.get("status", "unknown"), "running": bool(data.get("running"))}
    except QMPError:
        # A live QEMU process with unavailable QMP is not the same as a stopped VM.
        if process is not None and process.poll() is None:
            return {"state": "unknown", "running": False}
        return {"state": "off", "running": False}


@app.get("/api/status")
async def status():
    return await vm_status()


@app.post("/api/start")
async def start():
    global process
    async with lock:
        current = await vm_status()
        if current["state"] != "off":
            raise HTTPException(409, "VM is already started")
        require_image()
        if process and process.poll() is None:
            raise HTTPException(409, "QEMU process exists but QMP not ready")
        for socket in (QMP, SERIAL):
            if socket.exists():
                socket.unlink()
        accel = os.getenv("VM_ACCEL", "kvm").lower()
        if accel not in ("kvm", "tcg"):
            raise HTTPException(500, "VM_ACCEL must be kvm or tcg")
        argv = [
            "qemu-system-x86_64", "-name", "debian13", "-machine", f"q35,accel={accel}",
            "-cpu", "host" if accel == "kvm" else "max",
            "-m", os.getenv("VM_MEMORY_MB", "2048"), "-smp", os.getenv("VM_CPUS", "2"),
            "-display", "none", "-monitor", "none",
            "-drive", f"file={DISK},if=virtio,format=qcow2",
            "-drive", f"file={SEED},if=virtio,media=cdrom,format=raw,readonly=on",
            "-netdev", f"user,id=net0,hostfwd=tcp:127.0.0.1:{SSH_PORT}-:22",
            "-device", "virtio-net-pci,netdev=net0",
            "-qmp", f"unix:{QMP},server=on,wait=off",
            "-chardev", f"socket,id=console,path={SERIAL},server=on,wait=off",
            "-serial", "chardev:console",
        ]
        log = open(RUN_DIR / "qemu.log", "ab", buffering=0)
        try:
            process = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT)
        finally:
            log.close()
        for _ in range(60):
            if process.poll() is not None:
                raise HTTPException(500, "QEMU exited; inspect data/run/qemu.log")
            current = await vm_status()
            if current["state"] not in ("off", "unknown"):
                return current
            await asyncio.sleep(.25)
        raise HTTPException(504, "QEMU did not expose QMP in time")


@app.post("/api/reboot")
async def reboot():
    async with lock:
        state = (await vm_status())["state"]
        if state == "off":
            raise HTTPException(409, "VM is off")
        if state == "unknown":
            raise HTTPException(503, "QMP is not ready")
        await execute(str(QMP), "system_reset")
        return {"message": "Hard reset requested"}


@app.post("/api/stop")
async def stop():
    async with lock:
        state = (await vm_status())["state"]
        if state == "off":
            raise HTTPException(409, "VM is off")
        if state == "unknown":
            raise HTTPException(503, "QMP is not ready")
        await execute(str(QMP), "system_powerdown")
        return {"message": "ACPI shutdown requested; wait for guest to stop"}


async def relay_websocket_to_stream(ws: WebSocket, writer):
    while True:
        data = await ws.receive_text()
        writer.write(data.encode())
        await writer.drain()


async def relay_stream_to_websocket(ws: WebSocket, reader):
    while True:
        data = await reader.read(4096)
        if not data:
            break
        await ws.send_text(data.decode(errors="replace"))


async def bridge(ws: WebSocket, reader, writer):
    incoming = asyncio.create_task(relay_websocket_to_stream(ws, writer))
    outgoing = asyncio.create_task(relay_stream_to_websocket(ws, reader))
    done, pending = await asyncio.wait({incoming, outgoing}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    for task in done:
        with suppress(WebSocketDisconnect, ConnectionError, OSError, asyncio.CancelledError):
            task.result()


@app.websocket("/api/terminal/serial")
async def serial(ws: WebSocket):
    await ws.accept()
    try:
        reader, writer = await asyncio.open_unix_connection(str(SERIAL))
        try:
            await bridge(ws, reader, writer)
        finally:
            writer.close()
            await writer.wait_closed()
    except OSError as exc:
        with suppress(Exception):
            await ws.send_text(f"\r\n[Serial unavailable: {exc}]\r\n")
    finally:
        with suppress(Exception):
            await ws.close()


@app.websocket("/api/terminal/ssh")
async def ssh(ws: WebSocket):
    await ws.accept()
    if not SSH_KEY.is_file():
        await ws.send_text("\r\n[SSH private key missing]\r\n")
        await ws.close()
        return
    connection = None
    try:
        # SSH tunnel ends at QEMU user-mode port forwarding on container loopback.
        connection = await asyncssh.connect(
            "127.0.0.1",
            port=SSH_PORT,
            username=os.getenv("VM_USER", "debian"),
            client_keys=[str(SSH_KEY)],
            known_hosts=None,
            connect_timeout=8,
        )
        proc = await connection.create_process(term_type="xterm-256color", term_size=(100, 30))

        async def websocket_input():
            while True:
                message = await ws.receive_json()
                if message.get("type") == "resize":
                    proc.change_terminal_size(int(message.get("cols", 100)), int(message.get("rows", 30)))
                elif message.get("type") == "input":
                    proc.stdin.write(str(message.get("data", "")))

        async def ssh_output():
            while True:
                data = await proc.stdout.read(4096)
                if not data:
                    break
                await ws.send_text(data)

        tasks = {asyncio.create_task(websocket_input()), asyncio.create_task(ssh_output())}
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            with suppress(WebSocketDisconnect, ConnectionError, OSError, asyncio.CancelledError):
                task.result()
    except (OSError, asyncssh.Error) as exc:
        with suppress(Exception):
            await ws.send_text(f"\r\n[SSH unavailable: {exc}]\r\n")
    finally:
        if connection:
            connection.close()
            await connection.wait_closed()
        with suppress(Exception):
            await ws.close()
