#!/bin/sh
# Next standalone server for LearnHarness (browser mode, no Electron shell).
#
# The app's defaults put data/ and auth.json next to server.js, which is
# read-only in the store, so point them at XDG dirs unless already set.
# Browser mode has no API auth, so bind to loopback like the Electron shell
# does; set LH_HOST to expose it elsewhere. HOSTNAME is not honoured here
# because most shells export it as the machine name.
data_home="${XDG_DATA_HOME:-$HOME/.local/share}/learnharness"
export LH_DATA_DIR="${LH_DATA_DIR:-$data_home/data}"
export LH_AUTH_FILE="${LH_AUTH_FILE:-$data_home/auth.json}"
export HOSTNAME="${LH_HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export NEXT_TELEMETRY_DISABLED=1
# LiteLLM proxy: LITELLM_BASE_URL plus LITELLM_API_KEY, or a key file.
if [ -z "$LITELLM_API_KEY" ] && [ -n "$LITELLM_API_KEY_FILE" ]; then
	LITELLM_API_KEY="$(tr -d '[:space:]' < "$LITELLM_API_KEY_FILE")" || exit 1
	export LITELLM_API_KEY
fi
mkdir -p "$LH_DATA_DIR" "$(dirname "$LH_AUTH_FILE")"
echo "LearnHarness: http://$HOSTNAME:$PORT (data: $LH_DATA_DIR)" >&2
exec @node@ @out@/lib/learnharness/server.js "$@"
