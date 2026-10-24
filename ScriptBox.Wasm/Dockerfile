# The pinned environment the guest artifacts are built in. Use docker-build.sh,
# which passes the values from toolchain.env.
ARG BUILD_IMAGE=debian:bookworm-slim
FROM ${BUILD_IMAGE}

ARG WASI_SDK_URL
ARG WASI_SDK_SHA256
ARG QUICKJS_REPO
ARG QUICKJS_COMMIT

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "${WASI_SDK_URL}" -o /tmp/wasi-sdk.tar.gz \
    && echo "${WASI_SDK_SHA256}  /tmp/wasi-sdk.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/wasi-sdk \
    && tar -xzf /tmp/wasi-sdk.tar.gz --strip-components=1 -C /opt/wasi-sdk \
    && rm /tmp/wasi-sdk.tar.gz

RUN git clone --filter=blob:none "${QUICKJS_REPO}" /opt/quickjs \
    && git -C /opt/quickjs -c advice.detachedHead=false checkout "${QUICKJS_COMMIT}"

ENV WASI_SDK_PATH=/opt/wasi-sdk
ENV QUICKJS_DIR=/opt/quickjs
