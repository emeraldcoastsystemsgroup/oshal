#!/usr/bin/env zsh
# =============================================================================
# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR                      | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: presses TAB in a REAL interactive zsh and prints what zsh's own completion system offers. An inner `zsh -f -i` runs on a pseudo-terminal (zsh/zpty), loads compsys with compinit, installs the completion under test the way a user would - `eval` of the script (the ~/.zshrc install) or the script as `_name` on $fpath (the autoload install) - and has each typed line completed by the complete-word widget. The only thing replaced is the last step: compadd is wrapped so each match compsys would insert is printed as `MATCH:<word>` instead, which is how the matches are read back without scraping a rendered listing. Used by tests/unit/swarm-cli-zsh-completion.spec.ts.
# =============================================================================
#
# usage: zsh zsh-complete.zsh <sourced|autoload> <script> <typed line>...
#   sourced   - `eval "$(<script)"` after compinit, as `eval "$(swarm-cli completion zsh)"` does
#   autoload  - <script> must be named _<function>; its directory goes on $fpath BEFORE compinit
#   Each typed line is sent to the same prompt in turn (the previous one cleared first) and TAB is
#   pressed at its end.
# stdout: for each typed line, a `ZCAP-LINE <n>` header (1-based) followed by everything the inner
#   shell printed while completing it: one `MATCH:<word>` line per match, then `ZCAP-END`.
# exit: 0 when every completion ran to the completion system's post-hook; 3 on a usage/setup
#   error; 4 when the inner shell never became ready; 5 when a completion never finished.
# The inner shell is started as `zsh` from $PATH: put the zsh under test first on $PATH.

emulate -L zsh
setopt no_unset

if (( $# < 3 )); then
  print -u2 -- 'usage: zsh zsh-complete.zsh <sourced|autoload> <script> <typed line>...'
  exit 3
fi
case $1 in
  sourced|autoload) ;;
  *) print -u2 -- "zsh-complete: unknown mode '$1'"; exit 3 ;;
esac
if [[ ! -r $2 ]]; then
  print -u2 -- "zsh-complete: cannot read the completion script '$2'"
  exit 3
fi
if ! zmodload zsh/zpty 2>/dev/null; then
  print -u2 -- 'zsh-complete: this zsh has no zsh/zpty module'
  exit 3
fi

# The inner shell reads its instructions from the environment, so nothing is interpolated into
# shell code: a path with spaces or quotes cannot change what runs.
export ZCAP_MODE=$1 ZCAP_SCRIPT=${2:A}
shift 2
local setup
setup=$(mktemp "${TMPDIR:-/tmp}/zsh-complete.XXXXXX") || { print -u2 -- 'zsh-complete: mktemp failed'; exit 3; }
cat > $setup <<'SETUP'
PS1='' PROMPT='' RPROMPT=''
unsetopt beep
bindkey -e
bindkey '^I' complete-word
if [[ $ZCAP_MODE == autoload ]]; then
  fpath=( ${ZCAP_SCRIPT:h} $fpath )
fi
autoload -Uz compinit
compinit -u -D
if [[ $ZCAP_MODE == sourced ]]; then
  eval "$(<$ZCAP_SCRIPT)"
fi
zstyle ':completion:*' list-grouped false
zstyle ':completion:*' insert-tab false
# Print, instead of inserting, what each completion function asks compsys to add. Calls that
# only collect or describe (-O / -A / -D) are compsys plumbing and pass through untouched.
compadd() {
  if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then
    builtin compadd "$@"
    return $?
  fi
  local -a zcap_hits
  builtin compadd -A zcap_hits "$@"
  local zcap_hit
  for zcap_hit in $zcap_hits; do
    print -r -- "MATCH:$zcap_hit"
  done
}
# _main_complete empties comppostfuncs before running it, so the hook re-arms itself for the
# next line.
zcap_end() { print -r -- 'ZCAP-END'; comppostfuncs=( zcap_end ) }
comppostfuncs=( zcap_end )
print -r -- 'ZCAP-READY'
SETUP

local out='' typed
integer n=0 rc=0
zpty zcap zsh -f -i
zpty -w zcap "source ${(q)setup}"
if ! zpty -r -m zcap out '*ZCAP-READY*'; then
  print -r -- "$out"
  print -u2 -- 'zsh-complete: the inner shell never became ready'
  rc=4
else
  for typed in "$@"; do
    (( ++n ))
    print -r -- "ZCAP-LINE $n"
    # ^U clears whatever the previous line left in the buffer; nothing is ever executed.
    zpty -w -n zcap $'\C-u'"$typed"$'\t'
    out=''
    if ! zpty -r -m zcap out '*ZCAP-END*'; then
      print -r -- "$out"
      print -u2 -- "zsh-complete: completing line $n never reached the post-hook"
      rc=5
      break
    fi
    print -r -- "$out"
  done
fi
rm -f $setup
zpty -d zcap 2>/dev/null
exit $rc
