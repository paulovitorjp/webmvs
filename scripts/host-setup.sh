#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# install host packages on the build host (Ubuntu 24.04).
# emsdk 6.0.13 is already installed at ~/emsdk; this script only checks it.
set -uo pipefail
mkdir -p ~/webmvs/logs ~/src
PKGS="build-essential autoconf automake libtool cmake git zlib1g-dev libbz2-dev s3270 x3270 c3270 nginx python3 brotli zstd unzip jq websockify"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q $PKGS
rc=$?
echo "apt-get install rc=$rc"
for p in $PKGS; do
  printf '%-16s %s\n' "$p" "$(dpkg-query -W -f='${Status} ${Version}' "$p" 2>/dev/null || echo MISSING)"
done
if [ -f ~/emsdk/emsdk_env.sh ]; then
  source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
  emcc --version | head -1
  (cd ~/emsdk && echo "emsdk git: $(git rev-parse HEAD)")
else
  echo "emsdk NOT FOUND at ~/emsdk"
fi
exit $rc
