"""Gateway configuration (TOML). See gateway.example.toml."""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from subetha import DEFAULT_BASE_URL
from subetha.protocol import is_topic

from .bridge import TopicMapping
from .lxmf_rns import DELIVERY_METHODS

_HASH_RE = re.compile(r"[0-9a-f]{32}")


class ConfigError(ValueError):
    pass


@dataclass
class GatewayConfig:
    relay_url: str = DEFAULT_BASE_URL
    token: str | None = None
    data_dir: Path = Path("data")
    #: Seconds between LXMF announces of every topic destination (0 = only at startup).
    announce_interval: int = 1800
    reticulum_config_dir: Path | None = None
    propagation_node: str | None = None
    delivery_method: str = "direct"
    stamp_cost: int | None = None
    #: Port for a tiny HTTP health endpoint (needed by Cloudflare Containers). None = off.
    health_port: int | None = None
    #: Shared secret for POST /deliver (relay LXMF_GATEWAY_SECRET). None = /deliver disabled.
    deliver_secret: str | None = None
    topics: list[TopicMapping] = field(default_factory=list)


def _hash(value: Any, where: str) -> str:
    if not isinstance(value, str) or not _HASH_RE.fullmatch(value.strip().lower().strip("<>")):
        raise ConfigError(f"{where}: expected a 32-character hex LXMF address, got {value!r}")
    return value.strip().lower().strip("<>")


def parse_config(data: Mapping[str, Any], base_dir: Path = Path("."), env: Mapping[str, str] | None = None) -> GatewayConfig:
    env = os.environ if env is None else env
    cfg = GatewayConfig()
    cfg.relay_url = str(data.get("relay_url", DEFAULT_BASE_URL)).rstrip("/")

    token_env = data.get("token_env", "SUBETHA_TOKEN")
    cfg.token = data.get("token") or env.get(token_env) or None

    def path(key: str, default: Path | None) -> Path | None:
        v = data.get(key)
        if v is None or v == "":
            return default
        p = Path(os.path.expanduser(str(v)))
        return p if p.is_absolute() else (base_dir / p)

    cfg.data_dir = path("data_dir", base_dir / "data")  # type: ignore[assignment]
    cfg.reticulum_config_dir = path("reticulum_config_dir", None)

    interval = data.get("announce_interval", cfg.announce_interval)
    if not isinstance(interval, int) or interval < 0:
        raise ConfigError("announce_interval must be a non-negative integer (seconds)")
    cfg.announce_interval = interval

    if data.get("propagation_node"):
        cfg.propagation_node = _hash(data["propagation_node"], "propagation_node")
    cfg.delivery_method = data.get("delivery_method", "direct")
    if cfg.delivery_method not in DELIVERY_METHODS:
        raise ConfigError(f"delivery_method must be one of {', '.join(DELIVERY_METHODS)}")
    if cfg.delivery_method == "propagated" and not cfg.propagation_node:
        raise ConfigError("delivery_method = 'propagated' needs propagation_node")
    if data.get("stamp_cost") is not None:
        cfg.stamp_cost = int(data["stamp_cost"])
    if data.get("health_port") is not None:
        cfg.health_port = int(data["health_port"])
    cfg.deliver_secret = (env or {}).get("SUBETHA_DELIVER_SECRET") or data.get("deliver_secret") or None

    topics = data.get("topics", [])
    if not isinstance(topics, list) or not topics:
        raise ConfigError("at least one [[topics]] entry is required")
    seen: set[str] = set()
    for i, t in enumerate(topics):
        where = f"topics[{i}]"
        if not isinstance(t, dict):
            raise ConfigError(f"{where}: must be a table")
        topic = t.get("topic")
        if not is_topic(topic):
            raise ConfigError(f"{where}: invalid topic {topic!r} (expected @handle/name or t_<26 base32>)")
        if topic in seen:
            raise ConfigError(f"{where}: duplicate topic {topic}")
        seen.add(topic)
        allow = t.get("allow", [])
        if not isinstance(allow, list):
            raise ConfigError(f"{where}.allow: must be a list of LXMF addresses")
        cfg.topics.append(
            TopicMapping(
                topic=topic,
                name=t.get("name"),
                publish=bool(t.get("publish", True)),
                deliver=bool(t.get("deliver", True)),
                allow=frozenset(_hash(a, f"{where}.allow") for a in allow),
            )
        )
    return cfg


def load_config(path: str | Path, env: Mapping[str, str] | None = None) -> GatewayConfig:
    p = Path(path)
    with p.open("rb") as f:
        data = tomllib.load(f)
    return parse_config(data, base_dir=p.resolve().parent, env=env)
