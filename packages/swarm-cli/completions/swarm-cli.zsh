#compdef swarm-cli
# swarm-cli zsh completion — OSHAL "Open Swarm": talk to Jarvis from a terminal.
# Emitted by: swarm-cli completion zsh
#
# Install (either works):
#   • eval:   add  eval "$(swarm-cli completion zsh)"  to ~/.zshrc (after `compinit`)
#   • fpath:  swarm-cli completion zsh > "${fpath[1]}/_swarm-cli"  then restart zsh

# Context names live in the login config; offer them for --context.
_swarm-cli_contexts() {
  local dir=${OSHAL_CLI_STATE_DIR:-$HOME/.oshal}
  local file=$dir/config.json
  [[ -r $file ]] || return 1
  local -a ctxs
  ctxs=(${(f)"$(node -e 'try{const c=require(process.argv[1]);process.stdout.write(Object.keys(c.contexts||{}).join("\n"))}catch(e){}' "$file" 2>/dev/null)"})
  (( ${#ctxs} )) && _describe -t contexts 'context' ctxs
}

_swarm-cli() {
  local curcontext="$curcontext" state line ret=1
  typeset -A opt_args

  # Global flags — accepted before or after the subcommand.
  local -a _global_flags
  _global_flags=(
    '--url[controller base URL]:url:_urls'
    '--token[personal access token]:token:'
    '--secret[trusted-service secret (bootstrap only)]:secret:'
    '--sub[user sub to act as]:sub:'
    '--context[named context]:context:_swarm-cli_contexts'
    '--label[token label for login/mint]:label:'
    '--session[thread/session id]:session:'
    '--new[start a fresh thread]'
    '--json[machine-readable JSON output]'
    '--timeout[max wait for an answer, seconds]:seconds:'
    '--poll[poll interval, milliseconds]:ms:'
    '--quiet[suppress stderr status notes]'
    '--no-banner[suppress the startup banner]'
    '--version[print the CLI version]'
    '--help[show usage and exit]'
  )

  _arguments -C \
    "${_global_flags[@]}" \
    '1: :->command' \
    '*:: :->args' \
    && ret=0

  case $state in
    command)
      local -a commands
      commands=(
        'login:sign in — mint a personal token, save a context'
        'logout:forget the current context credentials'
        'whoami:show the server-resolved identity'
        'ask:one-shot question; prints the answer to stdout'
        'chat:interactive REPL on a persistent thread'
        'history:print the current thread transcript'
        'catalog:list the apps/agents Jarvis can reach'
        'tasks:list durable handed-off work items and results'
        'tokens:list or revoke personal access tokens'
        'completion:print a shell-completion script'
        'version:print the CLI version'
        'help:show usage'
      )
      _describe -t commands 'swarm-cli command' commands && ret=0
      ;;
    args)
      case $line[1] in
        completion)
          _arguments \
            "${_global_flags[@]}" \
            '1:shell:(bash zsh powershell)' \
            && ret=0
          ;;
        tokens)
          _arguments \
            "${_global_flags[@]}" \
            '1:action:(revoke)' \
            '2:token id:' \
            && ret=0
          ;;
        ask)
          _arguments \
            "${_global_flags[@]}" \
            '*:message:' \
            && ret=0
          ;;
        login|logout|whoami|chat|history|catalog|tasks|version|help)
          _arguments "${_global_flags[@]}" && ret=0
          ;;
        *)
          _arguments "${_global_flags[@]}" && ret=0
          ;;
      esac
      ;;
  esac

  return ret
}

# Autoloaded from $fpath → zsh runs the function directly (funcstack[1] is _swarm-cli).
# Sourced/eval'd from ~/.zshrc → register the completer explicitly instead.
if [ "$funcstack[1]" = "_swarm-cli" ]; then
  _swarm-cli "$@"
else
  compdef _swarm-cli swarm-cli
fi
