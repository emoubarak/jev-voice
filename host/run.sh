#!/bin/sh
# Started by the browser (Native Messaging). stdout carries the protocol: nothing else may write to it.
HERE=$(dirname "$(readlink -f "$0")")
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/jev-voice"
umask 077  # logs hold your commands and page goals: readable by you only
mkdir -p "$STATE" && chmod 700 "$STATE"
# Keep the error log small: past 1 MB, the previous one is kept once as host.err.1.
[ -f "$STATE/host.err" ] && [ "$(wc -c <"$STATE/host.err")" -gt 1000000 ] && mv -f "$STATE/host.err" "$STATE/host.err.1"
exec "$HERE/.venv/bin/python" -u "$HERE/jev_voice_host.py" "$@" 2>>"$STATE/host.err"
