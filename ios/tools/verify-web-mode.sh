#!/bin/sh
set -eu

policy="$SCRIPT_INPUT_FILE_1"
expected_mode=ios-release
expected_tools=false
if [ "$CONFIGURATION" = Debug ] && [ "$PLATFORM_NAME" = iphonesimulator ]; then
    expected_mode=ios-simulator
    expected_tools=true
fi
case " ${SWIFT_ACTIVE_COMPILATION_CONDITIONS:-} " in
    *" LANE_SIMULATOR_NAVIGATION "*) native_tools=true ;;
    *) native_tools=false ;;
esac
if [ "$native_tools" != "$expected_tools" ]; then
    echo "error: Simulator navigation compile flag does not match $CONFIGURATION/$PLATFORM_NAME."
    exit 1
fi
if [ ! -f "$policy" ]; then
    echo "error: Missing $expected_mode web assets. Run node ios/tools/build-web.mjs from the repository root."
    exit 1
fi

format=$(/usr/bin/plutil -extract format raw -o - "$policy")
mode=$(/usr/bin/plutil -extract mode raw -o - "$policy")
simulator_tools=$(/usr/bin/plutil -extract simulatorTools raw -o - "$policy")
if [ "$format" != lanedev-ios-client-v1 ] || [ "$mode" != "$expected_mode" ] ||
   [ "$LANE_WEB_MODE" != "$expected_mode" ] || [ "$simulator_tools" != "$expected_tools" ]; then
    echo "error: Wrong web assets ($format, $mode) for $CONFIGURATION/$PLATFORM_NAME. Expected $expected_mode."
    exit 1
fi

