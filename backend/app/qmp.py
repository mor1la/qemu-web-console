import asyncio
import json


class QMPError(Exception):
    pass


async def execute(socket_path: str, command: str, arguments: dict | None = None):
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(socket_path), 3)
    except (OSError, TimeoutError) as exc:
        raise QMPError(f"QMP is unavailable: {exc}") from exc
    try:
        greeting = await asyncio.wait_for(reader.readline(), 3)
        if not greeting or "QMP" not in json.loads(greeting):
            raise QMPError("Invalid QMP greeting")
        async def exchange(payload):
            writer.write((json.dumps(payload) + "\r\n").encode())
            await writer.drain()
            for _ in range(100):
                line = await asyncio.wait_for(reader.readline(), 5)
                if not line:
                    raise QMPError("QMP connection closed")
                message = json.loads(line)
                if "return" in message:
                    return message["return"]
                if "error" in message:
                    raise QMPError(str(message["error"]))
            raise QMPError("Too many QMP events")
        await exchange({"execute": "qmp_capabilities"})
        payload = {"execute": command}
        if arguments:
            payload["arguments"] = arguments
        return await exchange(payload)
    except (ValueError, TimeoutError, OSError) as exc:
        raise QMPError(f"QMP failure: {exc}") from exc
    finally:
        writer.close()
        await writer.wait_closed()
