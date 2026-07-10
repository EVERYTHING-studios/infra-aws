# Post-process container: converts the pipeline's raw GLB into FBX/OBJ/USDZ
# and renders a thumbnail, then uploads everything to the model-assets bucket.
# Runs as a Fargate task driven by Step Functions (ecs:runTask.sync).

FROM ubuntu:24.04

ARG BLENDER_VERSION=4.2.5
ARG BLENDER_SERIES=4.2

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
    python3 \
    python3-pip \
    # Blender headless runtime deps
    libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 \
    libxkbcommon0 libsm6 libice6 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://download.blender.org/release/Blender${BLENDER_SERIES}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      -o /tmp/blender.tar.xz \
    && mkdir -p /opt/blender \
    && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
    && rm /tmp/blender.tar.xz

ENV PATH="/opt/blender:${PATH}"

RUN pip3 install --no-cache-dir --break-system-packages boto3

WORKDIR /app
COPY entrypoint.py convert.py ./

ENTRYPOINT ["python3", "/app/entrypoint.py"]
