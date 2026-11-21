"""``subetha-reticulum --config gateway.toml``"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import threading

from . import __version__
from .bridge import Bridge
from .config import ConfigError, load_config
from .health import serve_health
from .lxmf_rns import RnsLxmfPort
from .relay_http import HttpRelayPort
from .store import SubscriberStore

log = logging.getLogger("subetha_reticulum")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="subetha-reticulum", description="Bridge Reticulum/LXMF to SubEtha topics.")
    ap.add_argument("--config", "-c", required=True, help="path to gateway.toml")
    ap.add_argument("--verbose", "-v", action="store_true", help="debug logging")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        cfg = load_config(args.config)
    except (OSError, ConfigError, ValueError) as e:
        print(f"subetha-reticulum: {e}", file=sys.stderr)
        return 2
    if not cfg.token:
        log.warning("no API token configured (token / SUBETHA_TOKEN); publishing relies on topic policy")

    relay = HttpRelayPort(cfg.relay_url, cfg.token)
    lxmf = RnsLxmfPort(
        cfg.data_dir,
        reticulum_config_dir=cfg.reticulum_config_dir,
        propagation_node=cfg.propagation_node,
        delivery_method=cfg.delivery_method,
        stamp_cost=cfg.stamp_cost,
    )
    bridge = Bridge(lxmf, relay, cfg.topics, SubscriberStore(cfg.data_dir / "state.json"))

    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())

    if cfg.health_port:  # up first, so the platform sees the container as started
        serve_health(
            cfg.health_port,
            lambda: {"ok": True, "version": __version__, "topics": bridge.destinations()},
            deliver=bridge.deliver_direct,
            deliver_secret=cfg.deliver_secret,
        )

    bridge.start()
    for topic, dest in bridge.destinations().items():
        print(f"{topic}  ->  LXMF <{dest}>", flush=True)

    while not stop.wait(cfg.announce_interval or None):
        bridge.announce()
    log.info("shutting down")
    bridge.stop()
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
