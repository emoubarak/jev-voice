"""Each safety promise of the README, checked against the host code."""

import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host"))

import jev_voice_host as host  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch, tmp_path):
    sent = []
    monkeypatch.setattr(host, "send", sent.append)
    monkeypatch.setattr(host, "STATE", tmp_path / "state")
    monkeypatch.setattr(host, "_LOG", None)
    host.STOP.clear()
    host.CONFIRM["ok"] = False
    yield sent
    host.STOP.clear()


def answer_later(*, ok=None, stop=False, delay=0.3):
    """What the panel does: an Approve / Decline answer, or the Stop button (which also wakes the wait)."""

    def run():
        time.sleep(delay)
        if stop:
            host.STOP.set()
        else:
            host.CONFIRM["ok"] = ok
        host.CONFIRM["event"].set()

    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- Stop
def test_stop_during_an_approval_is_never_an_approval(fresh_state):
    host.CONFIRM["ok"] = True  # left over from an earlier "Approve"
    answer_later(stop=True)
    with pytest.raises(host.Stopped):
        host.ask_confirmation("Open https://example.org/ in a background tab")


def test_an_earlier_approval_does_not_carry_over(fresh_state):
    host.CONFIRM["ok"] = True
    answer_later(ok=False)
    assert host.ask_confirmation("Send") is False


@pytest.mark.parametrize("op", ["act", "navigate"])
def test_nothing_changes_in_the_browser_after_stop(fresh_state, op):
    host.STOP.set()
    with pytest.raises(host.Stopped):
        host.rpc(op, tab=1, url="https://example.org/")
    assert fresh_state == []  # the request never reached the extension


def test_stop_kills_the_planner(fresh_state, tmp_path, monkeypatch):
    slow = tmp_path / "claude"
    slow.write_text("#!/bin/sh\nsleep 30\n")
    slow.chmod(0o755)
    monkeypatch.setenv("JEV_VOICE_CLAUDE", str(slow))
    threading.Timer(0.3, host.STOP.set).start()
    started = time.monotonic()
    with pytest.raises(host.Stopped):
        host.claude_json("plan this", host.ANSWER_SCHEMA, "sonnet")
    assert time.monotonic() - started < 3


# ---------------------------------------------------------------- leaving the site of your tab
@pytest.mark.parametrize("url, home, said, ask", [
    ("https://evil.example/?q=secret+from+your+tab", "mail.example.com", "summarize this page", True),
    ("https://mail.example.com/inbox?q=invoice", "mail.example.com", "find the invoice", False),
    ("https://en.wikipedia.org/w/index.php?search=Ada", None, "search wikipedia.org for Ada Lovelace", False),
    ("https://en.wikipedia.org/", "news.example.com", "open en.wikipedia.org", False),
    ("https://www.bbc.co.uk/news", None, "what is on bbc.co.uk", False),
    # a site name without its domain is not enough: it could be any domain the page chose
    ("https://en.wikipedia.org/w/index.php?search=Ada", None, "search Wikipedia for Ada Lovelace", True),
    ("https://www.bbc.co.uk/news", None, "what is on the BBC front page", True),
    ("https://wikipedia.evil.example/", None, "search wikipedia.org for Ada Lovelace", True),
    ("https://example.net/", None, "open the weather", True),
    # found by review: a word of the command read as a domain, or a piece of a named domain
    ("https://inbox.us.to/?d=secret", None, "summarize my inbox", True),
    ("https://the.eu.org/?d=secret", None, "summarize the page", True),
    ("https://page.xyz/?d=secret", None, "summarize this page", True),
    ("https://pedia.org/?d=secret", None, "open en.wikipedia.org and summarize", True),
    ("https://evil.en.wikipedia.org.example/", None, "open en.wikipedia.org", True),
])
def test_other_sites_need_approval(url, home, said, ask):
    assert host.needs_approval(url, home, said) is ask


def plan_with(monkeypatch, steps, use_current_tab=False):
    plan = {"use_current_tab": use_current_tab, "steps": steps, "language": "English", "question": None,
            "reply": None}
    monkeypatch.setattr(host, "claude_json", lambda *a, **k: (plan, 1))
    calls = []

    def fake_rpc(op, timeout=40, **args):
        calls.append((op, args))
        return 7 if op == "navigate" else None

    monkeypatch.setattr(host, "rpc", fake_rpc)
    return calls


CONTEXT = {"tab": 3, "url": "https://mail.example.com/inbox", "title": "Inbox", "text": "secret"}


def test_a_crafted_url_in_a_background_tab_asks_with_the_full_address(fresh_state, monkeypatch):
    url = "https://evil.example/collect?d=secret"
    calls = plan_with(monkeypatch, [{"url": url, "goal": "Open it."}])
    asked = []
    monkeypatch.setattr(host, "ask_confirmation", lambda label: asked.append(label) or False)
    host.run_command("summarize my inbox", CONTEXT, {})
    assert asked == [f"Open {url} in a background tab"]
    assert calls == []  # declined: nothing opened
    assert fresh_state[-1]["result"] == "blocked"


def test_a_domain_written_in_the_command_opens_without_asking(fresh_state, monkeypatch):
    calls = plan_with(monkeypatch, [{"url": "https://en.wikipedia.org/wiki/Ada_Lovelace", "goal": "Done."}])
    monkeypatch.setattr(host, "ask_confirmation", lambda label: pytest.fail("asked: " + label))
    monkeypatch.setattr(host, "run_goal", lambda *a: ("done", None, None))
    host.run_command("open wikipedia.org on Ada Lovelace", CONTEXT, {})
    assert calls[0] == ("navigate", {"tab": None, "url": "https://en.wikipedia.org/wiki/Ada_Lovelace",
                                     "expect": "en.wikipedia.org"})


@pytest.mark.parametrize("url", [
    "https://evil.example\\@mail.example.com/?d=secret",  # the browser opens evil.example
    "https://user@mail.example.com/",
    "https://mail.example.com/\tx",
    "https://mail.example.com/\nx",
])
def test_addresses_the_browser_reads_differently_are_refused(fresh_state, monkeypatch, url):
    calls = plan_with(monkeypatch, [{"url": url, "goal": "x"}])
    with pytest.raises(RuntimeError, match="address refused"):
        host.run_command("summarize my inbox", CONTEXT, {})
    assert calls == []


@pytest.mark.parametrize("url, instruction", [  # the review's proofs, kept as they were written
    ("https://evil.example\\@mail.example.com/?d=secret", "summarize my inbox"),
    ("https://inbox.us.to/?d=secret", "summarize my inbox"),
    ("https://the.eu.org/?d=secret", "summarize the page"),
    ("https://page.xyz/?d=secret", "summarize this page"),
    ("https://pedia.org/?d=secret", "open en.wikipedia.org and summarize"),
])
def test_another_site_is_never_opened_without_asking(fresh_state, monkeypatch, url, instruction):
    calls = plan_with(monkeypatch, [{"url": url, "goal": "x"}])
    asked = []
    monkeypatch.setattr(host, "ask_confirmation", lambda label: asked.append(label) or False)
    monkeypatch.setattr(host, "run_goal", lambda *a: ("done", None, None))
    try:
        host.run_command(instruction, CONTEXT, {})
    except RuntimeError as e:
        assert "address refused" in str(e)
        return
    assert asked or not [c for c in calls if c[0] == "navigate"], f"opened {url} without approval"


def test_stop_while_asking_opens_nothing(fresh_state, monkeypatch):
    calls = plan_with(monkeypatch, [{"url": "https://evil.example/?d=secret", "goal": "x"}], use_current_tab=True)
    answer_later(stop=True)
    with pytest.raises(host.Stopped):
        host.run_command("summarize this", CONTEXT, {})
    assert calls == []


# ---------------------------------------------------------------- approval words
ASK = [
    # English
    "Send", "Post reply", "Publish", "Tweet", "Retweet", "Repost", "Reply", "Forward", "Share", "Buy now",
    "Purchase", "Pay", "Pay with PayPal", "Proceed to checkout", "Donate", "Place order", "Order", "Book now",
    "Subscribe", "Unsubscribe", "Unfollow", "Submit", "Confirm", "Approve", "Accept", "Accept invitation", "Allow",
    "Allow all", "Authorize", "Install", "Merge pull request", "Invite", "Transfer", "Cancel subscription",
    "Delete account", "Remove", "Discard", "Move to trash", "Empty trash", "Close account", "Close your account",
    "Comment", "Add a comment",
    # French
    "Envoyer", "Publier", "Répondre", "Transférer", "Partager", "Acheter", "Payer", "Commander", "Faire un don",
    "Réserver", "S'abonner", "Valider", "Confirmer", "Approuver", "Accepter", "Autoriser", "Installer",
    "Fusionner", "Inviter", "Effectuer le virement", "Annuler", "Résilier", "Supprimer", "Commenter",
    # German
    "Senden", "Veröffentlichen", "Antworten", "Weiterleiten", "Teilen", "Jetzt kaufen", "Zahlungspflichtig bestellen",
    "Bezahlen", "Spenden", "Jetzt buchen", "Abonnieren", "Bestätigen", "Einreichen", "Genehmigen", "Akzeptieren",
    "Erlauben", "Installieren", "Zusammenführen", "Einladen", "Überweisen", "Stornieren", "Kündigen", "Löschen",
    "Verwerfen",
    # Spanish
    "Enviar", "Publicar", "Responder", "Compartir", "Comprar", "Pagar", "Donar", "Pedir", "Realizar pedido",
    "Reservar", "Suscribirse", "Confirmar", "Aprobar", "Aceptar", "Permitir", "Instalar", "Invitar", "Cancelar",
    "Eliminar", "Borrar", "Descartar",
]
DONT_ASK = [
    "Next page", "Search", "Open menu", "Price: low to high", "Books", "My orders", "Posts", "Comments", "Replies",
    "Shared with me", "Invitations", "Sharp TVs",
    # navigation links the review found asking
    "Order history", "Sort order", "Subscriptions", "Payments", "Bookmarks", "Postal code", "Deleted items",
    "Mes commandes", "Commentaires", "Comment ça marche", "Réservations", "Abonnements", "Envoyés", "Virements",
    "Bestellungen", "Suscripciones", "Mis pedidos", "Bücher", "Partagés", "Einkaufen", "Installation guide",
    # cookie banners
    "Accept all", "Accept all cookies", "Allow all cookies", "Accept cookies", "Tout accepter",
    "Accepter les cookies", "Alle akzeptieren", "Cookies akzeptieren", "Aceptar todo", "Aceptar cookies",
]


@pytest.mark.parametrize("label", ASK)
def test_irreversible_clicks_ask_first(label):
    assert host.asks_before_click(label)


@pytest.mark.parametrize("label", DONT_ASK)
def test_ordinary_clicks_do_not_ask(label):
    assert not host.asks_before_click(label)


# ---------------------------------------------------------------- what other local users can see
def test_the_prompt_is_not_on_the_command_line(fresh_state, tmp_path, monkeypatch):
    fake = tmp_path / "claude"
    fake.write_text(f"""#!{sys.executable}
import json, sys
print(json.dumps({{"structured_output": {{"answer": sys.stdin.read()}}, "argv": sys.argv}}))
""")
    fake.chmod(0o755)
    monkeypatch.setenv("JEV_VOICE_CLAUDE", str(fake))
    prompt = "my private command and the text of my inbox"
    out, _ = host.claude_json(prompt, host.ANSWER_SCHEMA, "sonnet")
    assert out["answer"] == prompt
    assert all(prompt not in arg for arg in host.claude_command(host.ANSWER_SCHEMA, "sonnet"))


def test_the_planner_never_gets_an_api_key(monkeypatch, tmp_path):
    fake = tmp_path / "claude"
    fake.write_text(f"""#!{sys.executable}
import json, os, sys
sys.stdin.read()
print(json.dumps({{"structured_output": {{"answer": json.dumps(sorted(os.environ))}}}}))
""")
    fake.chmod(0o755)
    monkeypatch.setenv("JEV_VOICE_CLAUDE", str(fake))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("TYPESAFE_API_KEY", "ts-test")
    out, _ = host.claude_json("hi", host.ANSWER_SCHEMA, "sonnet")
    seen = json.loads(out["answer"])
    assert "ANTHROPIC_API_KEY" not in seen and "TYPESAFE_API_KEY" not in seen


def test_logs_are_private_and_bounded(fresh_state):
    host.STATE.mkdir(parents=True)
    (host.STATE / "host.log").write_bytes(b"x" * (host.LOG_LIMIT + 1))
    host.log("plan", "something private")
    assert stat.S_IMODE(os.stat(host.STATE).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(host.STATE / "host.log").st_mode) == 0o600
    assert (host.STATE / "host.log.1").stat().st_size == host.LOG_LIMIT + 1
    assert (host.STATE / "host.log").stat().st_size < 100


def test_logs_rotate_while_running(fresh_state):
    host.log("x" * (host.LOG_LIMIT + 10))  # one long line crosses the limit
    host.log("next")
    assert (host.STATE / "host.log.1").stat().st_size > host.LOG_LIMIT
    assert (host.STATE / "host.log").read_text().endswith("next\n")


def test_the_recorder_does_not_inherit_api_keys(monkeypatch):
    for k in ("TYPESAFE_API_KEY", "CLOUDFLARE_API_TOKEN", "OPENROUTER_API_KEY", "TEXT_MODEL_API_KEY"):
        monkeypatch.setenv(k, "secret")
    monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")
    env = host.recorder_env()
    assert "XDG_RUNTIME_DIR" in env
    assert not any("KEY" in k or "TOKEN" in k for k in env)


# ---------------------------------------------------------------- settings coming from the extension
@pytest.mark.parametrize("given, used", [("haiku", "haiku"), ("sonnet", "sonnet"), ("opus --tools Bash", "sonnet"),
                                         (None, "sonnet")])
def test_planner_model_is_from_the_list(given, used):
    assert host.clean_model(given) == used
    assert host.claude_command({}, given)[host.claude_command({}, given).index("--model") + 1] == used


@pytest.mark.parametrize("given, used", [("fr", "fr"), ("multi", "multi"), ("en&token=x", "en"), (None, "en")])
def test_speech_language_is_from_the_list(given, used):
    assert host.clean_language(given) == used


def test_the_extension_asks_for_no_more_than_it_uses():
    manifest = json.loads((ROOT / "extension/manifest.json").read_text())
    assert set(manifest["permissions"]) == {"sidePanel", "scripting", "nativeMessaging", "storage"}


NODE = shutil.which("node")


@pytest.mark.skipif(not NODE, reason="node is not installed")
@pytest.mark.parametrize("url, expect, ok", [
    ("https://en.wikipedia.org/wiki/Ada", "en.wikipedia.org", True),
    ("http://en.wikipedia.org/", "en.wikipedia.org", True),
    ("https://evil.example\\@mail.example.com/", "mail.example.com", False),  # the browser reads evil.example
    ("https://user@mail.example.com/", "mail.example.com", False),
    ("https://mail.example.com.evil.example/", "mail.example.com", False),
    ("javascript:alert(1)//mail.example.com", "mail.example.com", False),
    ("https://evil.example/", "evil.example/@mail.example.com", False),
    ("https://EN.Wikipedia.org/", "en.wikipedia.org", True),
])
def test_the_extension_checks_the_site_again(url, expect, ok):
    script = f"const {{sameSite}} = require({json.dumps(str(ROOT / 'extension/guard.js'))});" \
             f"process.stdout.write(String(sameSite({json.dumps(url)}, {json.dumps(expect)})))"
    assert subprocess.run([NODE, "-e", script], capture_output=True, text=True).stdout == str(ok).lower()
