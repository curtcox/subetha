# SubEtha <-> Reticulum/LXMF gateway.
#
# Build from the repository root (the image needs the local Python SDK too):
#   docker build -f gateways/reticulum/Dockerfile -t subetha-reticulum .
# Run:
#   docker run -d --name subetha-reticulum \
#     -e SUBETHA_TOKEN=se_... \
#     -v subetha-reticulum:/data \
#     -v $PWD/gateway.toml:/config/gateway.toml:ro \
#     subetha-reticulum
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /src
COPY sdk/python /src/sdk/python
COPY gateways/reticulum /src/gateways/reticulum
RUN pip install /src/sdk/python "/src/gateways/reticulum[rns]" \
 && rm -rf /src

# Defaults: a config that reads its token from SUBETHA_TOKEN, and a Reticulum config that
# connects outbound over TCP. Mount your own files over /config to change either.
COPY gateways/reticulum/docker/gateway.toml /config/gateway.toml
COPY gateways/reticulum/docker/reticulum/config /config/reticulum/config

RUN useradd --system --home-dir /data --uid 10001 gateway \
 && mkdir -p /data \
 && chown -R gateway /data /config
USER gateway

# Identities, LXMF storage, and subscriber state. Must persist: losing it changes every
# topic's LXMF address and forgets subscribers.
VOLUME ["/data"]
# Health endpoint (health_port in gateway.toml), used by Cloudflare Containers.
EXPOSE 8080

ENTRYPOINT ["subetha-reticulum"]
CMD ["--config", "/config/gateway.toml"]
