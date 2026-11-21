#!/bin/sh
set -eu

policy="$SCRIPT_INPUT_FILE_1"
if [ ! -f "$policy" ]; then
    echo "error: Missing iOS web assets. Run node ios/tools/build-web.mjs from the repository root."
    exit 1
fi

format=$(/usr/bin/plutil -extract format raw -o - "$policy")
editor=$(/usr/bin/plutil -extract editor raw -o - "$policy")
simulation=$(/usr/bin/plutil -extract simulation raw -o - "$policy")
transit=$(/usr/bin/plutil -extract transit raw -o - "$policy")
if [ "$format" != lanedev-ios-client-v2 ] || [ "$editor" != false ] ||
   [ "$simulation" != false ] || [ "$transit" != false ]; then
    echo "error: Incompatible iOS web assets. Run node ios/tools/build-web.mjs from the repository root."
    exit 1
fi
