#!/usr/bin/env bash
#
# check-file-sizes.sh - reject files that are too big to commit.
#
# Every file (blob) introduced by the commits being checked is compared
# against a size limit chosen by its file type. Limits can be overridden or
# raised per path in a committed allowlist file (.filesize-allow).
#
# Usage:
#   check-file-sizes.sh --pre-push <remote> [<url>]   (run as a git pre-push hook;
#                                                       reads ref lines on stdin)
#   check-file-sizes.sh --range <rev-range> [--allow-from <commit>]
#   check-file-sizes.sh --tree [<commit>]
#   check-file-sizes.sh --list-defaults
#   check-file-sizes.sh --help
#
# Exit status: 0 = all files within limits, 1 = oversized files found,
#              2 = usage or configuration error.
#
# Compatible with bash 3.2 (macOS default) and later.

set -euo pipefail

ALLOW_FILE=".filesize-allow"
ZERO_SHA_RE='^0+$'

# ---------------------------------------------------------------------------
# Default limits by file type.
#
# Rows are checked in order and the first match wins. Each row is:
#   <match-by> <category> <limit> <names-or-extensions...>
# match-by "name" compares the file's basename, "ext" its last extension.
# Matching is case-insensitive. Files matching no row use FALLBACK_*.
# ---------------------------------------------------------------------------
DEFAULT_RULES='
name lockfile 2MB   package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb Cargo.lock Gemfile.lock poetry.lock Pipfile.lock uv.lock composer.lock go.sum flake.lock mix.lock pubspec.lock Podfile.lock packages.lock.json gradle.lockfile
name text     500KB Makefile GNUmakefile Dockerfile Containerfile Jenkinsfile Vagrantfile Rakefile Gemfile Procfile LICENSE COPYING NOTICE AUTHORS CHANGELOG README
ext  svg      200KB svg svgz
ext  text     500KB c h cc cpp cxx hh hpp hxx cs fs go rs java kt kts scala groovy gradle swift m mm py pyi rb php pl pm sh bash zsh fish ps1 psm1 bat cmd js mjs cjs jsx ts mts cts tsx vue svelte astro css scss sass less styl html htm xhtml md markdown mdx rst adoc txt tex yml yaml toml ini cfg conf env properties cmake mk lua r jl ex exs erl hrl hs elm ml mli clj cljs edn dart zig nim v sv vhd tf hcl proto graphql gql nix diff patch
ext  data     2MB   csv tsv json jsonl ndjson geojson xml sql ipynb parquet avro arrow feather
ext  image    1MB   png jpg jpeg gif webp avif heic heif ico icns bmp tif tiff psd
ext  font     1MB   woff woff2 ttf otf eot
ext  document 5MB   pdf doc docx ppt pptx xls xlsx odt ods odp rtf epub
ext  archive  5MB   zip tar gz tgz bz2 xz zst 7z rar jar war ear aar apk ipa whl deb rpm dmg iso exe msi dll so dylib a o lib obj bin wasm class pyc
ext  media    10MB  mp3 wav flac ogg oga opus m4a aac mp4 m4v mov webm mkv avi
'
FALLBACK_CATEGORY="other"
FALLBACK_LIMIT="1MB"

# ---------------------------------------------------------------------------

die() { echo "check-file-sizes: $*" >&2; exit 2; }

usage() { sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; }

# parse_limit <text> -> prints the limit in bytes, or -1 for unlimited.
parse_limit() {
  local text=$1 re='^([0-9]+)[[:space:]]*([KMG]?i?B?)$' n unit
  case "$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')" in
    none|unlimited|off) echo -1; return 0 ;;
  esac
  text=$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]' | sed 's/IB$/iB/')
  [[ $text =~ $re ]] || return 1
  n=${BASH_REMATCH[1]}; unit=${BASH_REMATCH[2]}
  case "$unit" in
    ''|B)       echo "$n" ;;
    K|KB|KiB)   echo $(( n * 1024 )) ;;
    M|MB|MiB)   echo $(( n * 1024 * 1024 )) ;;
    G|GB|GiB)   echo $(( n * 1024 * 1024 * 1024 )) ;;
    *)          return 1 ;;
  esac
}

human() {
  awk -v b="$1" 'BEGIN {
    if (b < 0)            print "unlimited";
    else if (b >= 1073741824) printf "%.2f GB\n", b / 1073741824;
    else if (b >= 1048576)    printf "%.2f MB\n", b / 1048576;
    else if (b >= 1024)       printf "%.1f KB\n", b / 1024;
    else                      printf "%d B\n", b;
  }'
}

# Parsed default rules, as parallel arrays.
RULE_KIND=(); RULE_CAT=(); RULE_LIMIT=(); RULE_LIST=(); RULE_LIMIT_TEXT=()
load_defaults() {
  local kind cat limit list bytes
  while read -r kind cat limit list; do
    [[ -z ${kind:-} ]] && continue
    bytes=$(parse_limit "$limit") || die "bad default limit '$limit'"
    RULE_KIND+=("$kind"); RULE_CAT+=("$cat"); RULE_LIMIT+=("$bytes")
    RULE_LIMIT_TEXT+=("$limit"); RULE_LIST+=(" $list ")
  done <<< "$DEFAULT_RULES"
  FALLBACK_BYTES=$(parse_limit "$FALLBACK_LIMIT") || die "bad fallback limit"
}

# Allowlist entries, as parallel arrays.
ALLOW_PAT=(); ALLOW_LIMIT=()
# load_allowlist <commit>: read .filesize-allow as committed in <commit>, so
# that exceptions are only honoured once they are part of reviewed history.
load_allowlist() {
  local commit=$1 line pattern limit bytes lineno=0 content
  local entry_re='^(.*[^[:space:]])[[:space:]]+([0-9]+([[:space:]]*[A-Za-z]+)?|none|unlimited|off)$'
  ALLOW_PAT=(); ALLOW_LIMIT=()
  content=$(git show "$commit:$ALLOW_FILE" 2>/dev/null) || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    lineno=$((lineno + 1))
    line=${line%%#*}
    line=$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [[ -z $line ]] && continue
    [[ $line =~ $entry_re ]] || die "$ALLOW_FILE:$lineno: expected '<pattern> <limit>', got '$line'"
    pattern=${BASH_REMATCH[1]}; limit=${BASH_REMATCH[2]}
    bytes=$(parse_limit "$limit") || die "$ALLOW_FILE:$lineno: bad limit '$limit'"
    ALLOW_PAT+=("$pattern"); ALLOW_LIMIT+=("$bytes")
  done <<< "$content"
}

# limit_for <path>: sets LIMIT (bytes, -1 = unlimited) and CATEGORY.
limit_for() {
  local path=$1 base=${1##*/} ext="" i pat
  # Allowlist: last matching entry wins. Patterns without a '/' match the
  # basename; patterns with one match the whole path. '*' also matches '/'.
  for (( i = ${#ALLOW_PAT[@]} - 1; i >= 0; i-- )); do
    pat=${ALLOW_PAT[$i]}
    if [[ $pat == */* ]]; then
      pat=${pat#/}
      # shellcheck disable=SC2053  # unquoted on purpose: glob match
      [[ $path == $pat ]] || continue
    else
      # shellcheck disable=SC2053
      [[ $base == $pat ]] || continue
    fi
    LIMIT=${ALLOW_LIMIT[$i]}; CATEGORY="allowlist: ${ALLOW_PAT[$i]}"
    return
  done

  local stripped=${base#.}                 # ".eslintrc.json" -> json, ".gitignore" -> none
  [[ $stripped == *.* ]] && ext=${stripped##*.}
  shopt -s nocasematch
  for (( i = 0; i < ${#RULE_KIND[@]}; i++ )); do
    if [[ ${RULE_KIND[$i]} == name ]]; then
      [[ ${RULE_LIST[$i]} == *" $base "* ]] || continue
    else
      [[ -n $ext && ${RULE_LIST[$i]} == *" $ext "* ]] || continue
    fi
    shopt -u nocasematch
    LIMIT=${RULE_LIMIT[$i]}; CATEGORY=${RULE_CAT[$i]}
    return
  done
  shopt -u nocasematch
  LIMIT=$FALLBACK_BYTES; CATEGORY=$FALLBACK_CATEGORY
}

VIOLATIONS=()
CHECKED=0
# check_list <lines>: takes "<size>\t<path>" lines and records violations.
check_list() {
  local size path
  while IFS=$'\t' read -r size path; do
    [[ -z ${path:-} ]] && continue
    CHECKED=$((CHECKED + 1))
    limit_for "$path"
    if (( LIMIT >= 0 && size > LIMIT )); then
      VIOLATIONS+=("$(printf '%10s  %10s  %-22s %s' "$(human "$size")" "$(human "$LIMIT")" "$CATEGORY" "$path")")
    fi
  done <<< "$1"
}

# Files introduced by the commits selected by the given rev-list arguments.
# A blob counts only if it is new (not reachable from excluded commits), and
# it is reported at every path a commit in the range adds or changes it at,
# so identical content stored under several names is checked under each name.
blobs_in_revs() {
  local new_blobs changes
  new_blobs=$(git rev-list --objects "$@" \
    | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
    | awk '$1 == "blob" { print $2, $3; next }
           $1 != "tree" && $1 != "commit" && $1 != "tag" { bad = 1 }   # "missing"
           END { exit bad }') || return 1
  [[ -n $new_blobs ]] || return 0
  # -m: also diff merges against each parent, so blobs that only appear in a
  # merge resolution are attributed to a path.
  changes=$(git rev-list "$@" \
    | git diff-tree --stdin -r -m --root --no-commit-id --no-renames \
        --diff-filter=AMT -z \
    | tr '\0' '\n') || return 1
  # First input: "<sha> <size>" of new blobs. Second: diff-tree records, which
  # strictly alternate ":<mode> <mode> <old> <new> <status>" and "<path>".
  awk '
    FNR == NR { size[$1] = $2; next }
    !want_path { split($0, m, " "); sha = m[4]; want_path = 1; next }
    {
      want_path = 0
      if ((sha in size) && !((sha, $0) in seen)) { seen[sha, $0] = 1; print size[sha] "\t" $0 }
    }' <(printf '%s\n' "$new_blobs") - <<< "$changes"
}

# Every file in the tree of a commit.
blobs_in_tree() {
  git ls-tree -r -l -z "$1" \
    | tr '\0' '\n' \
    | awk -F '\t' '{ split($1, m, / +/); if (m[2] == "blob") print m[4] "\t" $2 }'
}

report() {
  if (( ${#VIOLATIONS[@]} == 0 )); then
    return 0
  fi
  {
    echo
    echo "File size check failed: ${#VIOLATIONS[@]} file(s) exceed their size limit."
    echo
    printf '%10s  %10s  %-22s %s\n' "SIZE" "LIMIT" "RULE" "PATH"
    printf '%s\n' "${VIOLATIONS[@]}"
    echo
    echo "To fix, either:"
    echo "  * remove the file from the offending commit(s), e.g. 'git rm --cached <path>'"
    echo "    then 'git commit --amend' or 'git rebase -i', so it never enters history; or"
    echo "  * if the file really belongs in the repo, add a line '<path-or-glob> <limit>'"
    echo "    (e.g. 'assets/hero.png 3MB') to $ALLOW_FILE and commit it."
    echo
    echo "Run 'scripts/check-file-sizes.sh --list-defaults' to see the default limits."
  } >&2
  return 1
}

list_defaults() {
  local i items chunk first
  printf '%-10s %8s  %s\n' "CATEGORY" "LIMIT" "MATCHES (first matching row wins)"
  for (( i = 0; i < ${#RULE_KIND[@]}; i++ )); do
    # shellcheck disable=SC2086  # word-split the list on purpose
    if [[ ${RULE_KIND[$i]} == ext ]]; then
      items=$(printf '.%s ' ${RULE_LIST[$i]})
    else
      items=$(printf '%s ' ${RULE_LIST[$i]})
    fi
    first=1
    while IFS= read -r chunk; do
      if (( first )); then
        printf '%-10s %8s  %s\n' "${RULE_CAT[$i]}" "${RULE_LIMIT_TEXT[$i]}" "$chunk"
        first=0
      else
        printf '%21s%s\n' '' "$chunk"
      fi
    done < <(printf '%s\n' "$items" | fold -s -w 80)
  done
  printf '%-10s %8s  %s\n' "$FALLBACK_CATEGORY" "$FALLBACK_LIMIT" "(anything else)"
}

# --pre-push: git passes "<local ref> <local sha> <remote ref> <remote sha>"
# lines on stdin, one per ref being pushed.
run_pre_push() {
  local local_ref local_sha remote_ref remote_sha list
  while read -r local_ref local_sha remote_ref remote_sha; do
    [[ $local_sha =~ $ZERO_SHA_RE ]] && continue        # deleting a ref
    load_allowlist "$local_sha"
    if [[ $remote_sha =~ $ZERO_SHA_RE ]] \
       || ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
      # New branch, or remote tip unknown locally: check everything not
      # already on any remote-tracking branch.
      list=$(blobs_in_revs "$local_sha" --not --remotes) || die "could not list objects for $local_ref"
    else
      list=$(blobs_in_revs "$remote_sha..$local_sha") || die "could not list objects for $local_ref"
    fi
    check_list "$list"
  done
}

main() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
  cd "$(git rev-parse --show-toplevel)"
  load_defaults

  local mode=${1:-}
  [[ $# -gt 0 ]] && shift
  case "$mode" in
    --pre-push)
      run_pre_push
      ;;
    --range)
      [[ $# -ge 1 ]] || die "--range needs a revision range, e.g. origin/main..HEAD"
      local range=$1 allow_from=HEAD; shift
      if [[ ${1:-} == --allow-from ]]; then
        [[ $# -ge 2 ]] || die "--allow-from needs a commit"
        allow_from=$2; shift 2
      fi
      [[ $# -eq 0 ]] || die "unexpected argument: $1"
      load_allowlist "$allow_from"
      local list
      # shellcheck disable=SC2086  # allow "A B" style multi-arg ranges
      list=$(blobs_in_revs $range) || die "invalid revision range: $range"
      check_list "$list"
      ;;
    --tree)
      local commit=${1:-HEAD}
      git rev-parse --verify --quiet "$commit^{commit}" >/dev/null || die "unknown commit: $commit"
      load_allowlist "$commit"
      local list
      list=$(blobs_in_tree "$commit") || die "could not list files in $commit"
      check_list "$list"
      ;;
    --list-defaults)
      list_defaults; exit 0
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      usage >&2; exit 2
      ;;
  esac

  report || exit 1
  echo "File size check passed ($CHECKED file(s) checked)."
}

main "$@"
