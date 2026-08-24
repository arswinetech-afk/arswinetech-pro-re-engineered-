#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ARSwineTech Pro — build a deployable layout + Cloudflare Pages zip.
#
# index.html, sw.js and manifest.webmanifest reference:
#   css/app.css, js/*.js, supabase/config.js, supabase/client.js,
#   assets/*.png, icons/*.png
# but the repository keeps every file at the root. This script assembles the
# exact directory tree the app expects, then packages it as a zip for
# Cloudflare Pages (direct upload) or any static host.
#
# Usage:  qa/build-deploy-layout.sh [output-dir]   (default ./deploy)
# ---------------------------------------------------------------------------
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$SRC/deploy}"
VERSION="$(date +%Y%m%d)"
ZIP="$SRC/releases/arswinetech-pro-cloudflare-v${VERSION}.zip"

echo "Source: $SRC"
echo "Output: $OUT"

rm -rf "$OUT"
mkdir -p "$OUT/js" "$OUT/css" "$OUT/supabase" "$OUT/assets" "$OUT/icons"

# Static shell
cp "$SRC"/index.html "$SRC"/manifest.webmanifest "$SRC"/sw.js "$SRC"/register-sw.js "$SRC"/_headers "$OUT"/

# Styles
cp "$SRC"/app.css "$OUT"/css/app.css

# Scripts (client/config belong to supabase/ per index.html — never duplicate)
for f in "$SRC"/*.js; do
  b="$(basename "$f")"
  case "$b" in
    sw.js|register-sw.js|register-sw\ \(2\).js|config.js|client.js) continue ;;
  esac
  cp "$f" "$OUT"/js/
done
cp "$SRC"/config.js "$OUT"/supabase/config.js
cp "$SRC"/client.js "$OUT"/supabase/client.js

# Media
cp "$SRC"/arswinetech-logo.png "$SRC"/semen-bottle.png "$OUT"/assets/
cp "$SRC"/icon-192.png "$SRC"/icon-512.png "$OUT"/icons/

# Cloudflare instructions inside the package
cp "$SRC"/docs/CLOUDFLARE-DEPLOY.md "$OUT"/README-DEPLOY.md 2>/dev/null || true

echo
echo "✔ Deploy layout ready at $OUT"

# Zip (exclude nothing else — layout only contains needed files; keep .txt README)
mkdir -p "$SRC/releases"
if command -v zip >/dev/null 2>&1; then
  (cd "$OUT" && zip -qr "$ZIP" .)
else
  python3 - <<PY
import zipfile, os
root = "$OUT"
out = "$ZIP"
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, root))
print('zip written')
PY
fi
echo "✔ Cloudflare zip: $ZIP ($(du -h "$ZIP" | cut -f1))"
