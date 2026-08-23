#!/usr/bin/env bash
# Assemble le visualiseur en un fichier autonome.
#   index.html            -> page complète, ouvrable directement dans un navigateur
#   dist/artifact.html    -> même contenu sans <html>/<head>/<body> (publication Artifact)
#
# Les maillages (assets/ylo2-geometry.bin, produit par tools/convert_meshes.py)
# sont gzippés puis encodés en base64 dans la page : aucune requête réseau, ce qui
# permet d'ouvrir index.html en file://.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

GEN=src/_geometry.gen.js
if [ -f assets/ylo2-geometry.bin ]; then
  python3 - <<'PY' > "$GEN"
import base64, gzip, json
blob = open('assets/ylo2-geometry.bin', 'rb').read()
index = json.load(open('assets/ylo2-geometry.json'))
print('window.YLO2_GEO_INDEX=%s;' % json.dumps(index, separators=(',', ':')))
print('window.YLO2_GEO_B64="%s";' % base64.b64encode(gzip.compress(blob, 9)).decode())
PY
else
  echo "// maillages absents : lancer tools/convert_meshes.py" > "$GEN"
fi

APP=(src/10-data.js src/20-materials.js src/30-robot.js src/40-motion.js
     src/44-locomotion.js src/50-app.js)

emit_scripts() {
  printf '\n<script>\n'; cat vendor/three.min.js; printf '\n</script>\n'
  printf '<script>\n';   cat "$GEN";              printf '\n</script>\n'
  printf '<script>\n';   cat "${APP[@]}";         printf '\n</script>\n'
}

{ cat src/page.html; emit_scripts; } > dist/artifact.html

split=$(grep -n '<div class="shell">' src/page.html | head -1 | cut -d: -f1)
{
  printf '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
  head -n "$((split - 1))" src/page.html
  printf '</head>\n<body>\n'
  tail -n "+$split" src/page.html
  emit_scripts
  printf '</body>\n</html>\n'
} > index.html

printf 'index.html         %s\n' "$(du -h index.html | cut -f1)"
printf 'dist/artifact.html %s\n' "$(du -h dist/artifact.html | cut -f1)"
