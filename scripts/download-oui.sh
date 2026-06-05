#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../data" && pwd)"
mkdir -p "$DIR"

echo "Downloading IEEE OUI-24 (MA-L)..."
curl -sL "https://standards-oui.ieee.org/oui/oui.csv" -o "$DIR/oui24.csv"
echo "  → $(wc -l < "$DIR/oui24.csv") lines"

echo "Downloading IEEE OUI-36 (MA-S)..."
curl -sL "https://standards-oui.ieee.org/oui36/oui36.csv" -o "$DIR/oui36.csv"
echo "  → $(wc -l < "$DIR/oui36.csv") lines"

echo "Done. Files saved to $DIR/"
