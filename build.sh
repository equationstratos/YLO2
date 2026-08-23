#!/usr/bin/env bash
# Assemble le visualiseur en un fichier autonome.
#   index.html            -> page complète, ouvrable directement dans un navigateur
#   dist/artifact.html    -> même contenu sans <html>/<head>/<body> (publication Artifact)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

fragment() {
  cat src/page.html
  printf '\n<script>\n'; cat vendor/three.min.js; printf '\n</script>\n'
  printf '<script>\n';  cat src/app.js;          printf '\n</script>\n'
}

fragment > dist/artifact.html

split=$(grep -n '<div class="shell">' src/page.html | head -1 | cut -d: -f1)
{
  printf '<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
  head -n "$((split - 1))" src/page.html
  printf '</head>\n<body>\n'
  tail -n "+$split" src/page.html
  printf '\n<script>\n'; cat vendor/three.min.js; printf '\n</script>\n'
  printf '<script>\n';  cat src/app.js;          printf '\n</script>\n'
  printf '</body>\n</html>\n'
} > index.html

printf 'index.html         %s\n' "$(du -h index.html | cut -f1)"
printf 'dist/artifact.html %s\n' "$(du -h dist/artifact.html | cut -f1)"
