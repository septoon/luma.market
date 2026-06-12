#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm install
npm run build
pm2 restart luma-market-api --update-env
