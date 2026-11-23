from __future__ import annotations

import sys
from pathlib import Path

import pytest

from subetha_reticulum.config import ConfigError, load_config, parse_config

EXAMPLE = Path(__file__).resolve().parents[1] / "gateway.example.toml"


def test_example_config_loads():
    cfg = load_config(EXAMPLE, env={"SUBETHA_TOKEN": "tk_env"})
    assert cfg.relay_url == "https://subetha.us"
    assert cfg.token == "tk_env"
    assert cfg.data_dir.is_absolute()
    assert cfg.topics and cfg.topics[0].topic == "@alice/doorbell"


def test_full_config(tmp_path):
    p = tmp_path / "gw.toml"
    p.write_text(
        """
relay_url = "https://relay.example/"
token = "tk_file"
data_dir = "state"
announce_interval = 600
propagation_node = "<0123456789ABCDEF0123456789abcdef>"
delivery_method = "propagated"
health_port = 8080

[[topics]]
topic = "@alice/doorbell"
name = "Doorbell"
allow = ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]

[[topics]]
topic = "t_mfrggzdfmztwq2lknnwg23tpoa"
publish = false
"""
    )
    cfg = load_config(p, env={"SUBETHA_TOKEN": "ignored"})
    assert cfg.relay_url == "https://relay.example"
    assert cfg.token == "tk_file"
    assert cfg.data_dir == tmp_path / "state"
    assert cfg.announce_interval == 600
    assert cfg.propagation_node == "0123456789abcdef0123456789abcdef"
    assert cfg.delivery_method == "propagated"
    assert cfg.health_port == 8080
    a, b = cfg.topics
    assert a.name == "Doorbell" and a.allow == frozenset({"a" * 32}) and a.publish and a.deliver
    assert b.topic.startswith("t_") and not b.publish and b.deliver


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"topics": [{"topic": "doorbell"}]},
        {"topics": [{"topic": "@a/b"}, {"topic": "@a/b"}]},
        {"topics": [{"topic": "@a/b", "allow": ["nothex"]}]},
        {"topics": [{"topic": "@a/b"}], "delivery_method": "pigeon"},
        {"topics": [{"topic": "@a/b"}], "delivery_method": "propagated"},
        {"topics": [{"topic": "@a/b"}], "announce_interval": -1},
    ],
)
def test_invalid_configs(data):
    with pytest.raises(ConfigError):
        parse_config(data, env={})


def test_cli_rejects_bad_config(tmp_path, capsys):
    from subetha_reticulum.cli import main

    p = tmp_path / "bad.toml"
    p.write_text("topics = []\n")
    assert main(["--config", str(p)]) == 2
    assert "topics" in capsys.readouterr().err


def test_rns_port_imports_lazily(tmp_path):
    from subetha_reticulum.lxmf_rns import RnsLxmfPort, topic_slug

    RnsLxmfPort(tmp_path)
    assert "RNS" not in sys.modules  # constructing must not import RNS
    assert topic_slug("@alice/door_bell") == "alice__door_bell"
    with pytest.raises(ValueError):
        RnsLxmfPort(tmp_path, delivery_method="propagated")
