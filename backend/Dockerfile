# Compile exactly the QEMU version required by the assignment.
FROM debian:trixie AS qemu-build
ARG QEMU_VERSION=11.0.5

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential ninja-build pkg-config python3 python3-venv \
    libglib2.0-dev libpixman-1-dev zlib1g-dev libfdt-dev libslirp-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN curl -fL --retry 3 "https://download.qemu.org/qemu-${QEMU_VERSION}.tar.xz" -o qemu.tar.xz \
    && tar xf qemu.tar.xz \
    && mv "qemu-${QEMU_VERSION}" qemu

WORKDIR /src/qemu
RUN ./configure --prefix=/opt/qemu --target-list=x86_64-softmmu --disable-docs \
    --disable-gtk --disable-sdl --disable-vnc --enable-slirp --disable-modules \
    && ninja -C build && ninja -C build install

# Only runtime libraries and the installed QEMU binary end up in this image.
FROM python:3.13-slim-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libpixman-1-0 zlib1g libfdt1 libslirp0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=qemu-build /opt/qemu/ /opt/qemu/
ENV PATH="/opt/qemu/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]