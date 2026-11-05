#!/bin/sh
# Chromium refuses to start as root unless the sandbox is off. Cloud containers
# run as root, so Hallmark's browser checks point CHROME_PATH at this wrapper.
exec "${HALLMARK_CHROMIUM:-/opt/pw-browsers/chromium}" --no-sandbox "$@"
