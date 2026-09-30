#!/usr/bin/env bash
# Imports (or updates) the dashboard through Grafana's HTTP API.
# Usage: GRAFANA_USER=admin GRAFANA_PASSWORD=... ./grafana/import.sh
# Alternative without credentials on the command line:
#   Grafana UI → Dashboards → New → Import → upload grafana/dashboard.json
set -euo pipefail
cd "$(dirname "$0")"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:4000}"
: "${GRAFANA_USER:?set GRAFANA_USER}" "${GRAFANA_PASSWORD:?set GRAFANA_PASSWORD}"

# Wrap the dashboard in the import envelope; overwrite keeps the same uid/URL.
payload=$(node -e 'const d=require("./dashboard.json"); process.stdout.write(JSON.stringify({dashboard:d, overwrite:true}))')
curl -fsS -u "$GRAFANA_USER:$GRAFANA_PASSWORD" -H 'content-type: application/json' \
  -X POST "$GRAFANA_URL/api/dashboards/db" -d "$payload"
echo
