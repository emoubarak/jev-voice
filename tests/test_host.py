import io
import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host"))

import jev_voice_host as host  # noqa: E402


def test_frames_round_trip():
    frames = host.encode({"type": "ping"}) + host.encode({"type": "status", "text": "héllo"})
    assert list(host.read_messages(io.BytesIO(frames))) == [{"type": "ping"}, {"type": "status", "text": "héllo"}]


def test_oversized_message_is_refused():
    with pytest.raises(RuntimeError):
        host.encode({"type": "x", "text": "a" * (host.MAX_MESSAGE + 1)})


def test_env_file():
    text = """# comment
export TYPESAFE_API_KEY="abc"
CLOUDFLARE_ACCOUNT_ID='123'
EMPTY=
 # TEXT_MODEL=ignored
TEXT_MODEL=deepseek-chat
"""
    assert host.parse_env_file(text) == {"TYPESAFE_API_KEY": "abc", "CLOUDFLARE_ACCOUNT_ID": "123", "EMPTY": "",
                                         "TEXT_MODEL": "deepseek-chat"}


def test_environment_wins_over_config(tmp_path, monkeypatch):
    conf = tmp_path / "env"
    conf.write_text("TYPESAFE_API_KEY=from-file\nCLOUDFLARE_ACCOUNT_ID=file-id\n")
    monkeypatch.setenv("TYPESAFE_API_KEY", "from-env")
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    host.load_keys(conf)
    assert host.os.environ["TYPESAFE_API_KEY"] == "from-env"
    assert host.os.environ["CLOUDFLARE_ACCOUNT_ID"] == "file-id"


@pytest.mark.parametrize("url", ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "https://"])
def test_only_web_addresses(url):
    with pytest.raises(RuntimeError):
        host.check_url(url)


def test_jev_imports_without_its_cdp_driver():
    choose, field_context, field_text, max_steps = host.load_jev()
    assert callable(choose) and callable(field_text) and max_steps > 0
    assert "jev_ultrafast.browser" not in sys.modules


def test_host_answers_ping(tmp_path):
    """The real host process, through the same launcher the browser uses."""
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin", "XDG_STATE_HOME": str(tmp_path / "state"),
           "XDG_CONFIG_HOME": str(tmp_path / "config")}
    proc = subprocess.run([str(ROOT / "host/run.sh"), "chrome-extension://test/"], input=host.encode({"type": "ping"}),
                          capture_output=True, env=env, timeout=30)
    (n,) = struct.unpack("=I", proc.stdout[:4])
    pong = json.loads(proc.stdout[4:4 + n])
    assert pong["type"] == "pong" and pong["jev"] is True
    assert pong["keys"] == {k: False for k in host.REQUIRED_KEYS}
    assert pong["voice_keys"] == {k: False for k in host.VOICE_KEYS}


def test_live_transcription_is_a_websocket(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct")
    url = host.nova_url("multi")
    assert url.startswith("wss://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/deepgram/nova-3?")
    assert "language=multi" in url


def test_service_error_shows_the_reason():
    class Response:
        body = bytearray(b'{"name":"AiError","message":"AiError: AiError: you have used up your daily free allocation"}')

    class Refused(Exception):
        response = Response()

    assert host.service_error(Refused("HTTP 429")) == "you have used up your daily free allocation"
    assert host.service_error(RuntimeError("boom")) == "boom"
