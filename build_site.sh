#!/bin/bash
# Builds the Stash plugin source published on GitHub Pages:
#   <outdir>/index.yml           the listing Stash reads (Settings > Plugins > Available Plugins)
#   <outdir>/InfiniteScroll.zip  the plugin folder's files
# Same format as stashapp/CommunityScripts. Usage: ./build_site.sh [outdir]
set -euo pipefail

outdir="${1:-_site}"
rm -rf "$outdir"
mkdir -p "$outdir"

dir=InfiniteScroll
f="$dir/InfiniteScroll.yml"
plugin_id=$(basename "$f" .yml)
field() { grep "^$1:" "$f" | head -n 1 | cut -d' ' -f2- | sed -e 's/\r//' -e 's/^"\(.*\)"$/\1/'; }

commit=$(git log -n 1 --pretty=format:%h -- "$dir")
updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir")
zipfile=$(realpath "$outdir")/$plugin_id.zip
(cd "$dir" && zip -r -X "$zipfile" . > /dev/null)

cat > "$outdir/index.yml" <<EOF
- id: $plugin_id
  name: $(field name)
  metadata:
    description: $(field description)
  version: $(field version)-$commit
  date: $updated
  path: $plugin_id.zip
  sha256: $(sha256sum "$zipfile" | cut -d' ' -f1)
EOF
cat "$outdir/index.yml"
