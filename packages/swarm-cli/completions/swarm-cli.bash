# bash completion for swarm-cli — talk to Jarvis (the whole OSHAL swarm) from a terminal.
#
# Install (any one):
#   eval "$(swarm-cli completion bash)"                 # this shell only
#   swarm-cli completion bash > ~/.swarm-cli-completion.bash \
#     && echo 'source ~/.swarm-cli-completion.bash' >> ~/.bashrc
#   swarm-cli completion bash | sudo tee /etc/bash_completion.d/swarm-cli >/dev/null
#
# Works when `swarm-cli` is a bin on PATH or a shell alias for `node scripts/swarm-cli.js`,
# because completion keys off the typed command word (`swarm-cli`), not the resolved binary.

_swarm_cli() {
    local cur prev cmd w i
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # Full command + flag surface.
    local subcommands="login logout whoami ask chat history catalog tasks tokens completion version help"
    local global_flags="--url --token --secret --sub --context --label --session --new --json --timeout --poll --quiet --no-banner --version --help"

    # Flags that consume the following word as their value.
    local value_flags=" --url --token --secret --sub --context --label --session --timeout --poll "

    # After a value-taking flag we have no candidate list (URLs, tokens, ids, numbers) —
    # return nothing rather than offer a misleading completion.
    if [[ "$value_flags" == *" $prev "* ]]; then
        COMPREPLY=()
        return 0
    fi

    # Find the subcommand: the first bare word that is not a flag and not a flag's value.
    cmd=""
    for (( i = 1; i < COMP_CWORD; i++ )); do
        w="${COMP_WORDS[i]}"
        if [[ "$value_flags" == *" $w "* ]]; then
            i=$(( i + 1 ))          # skip the value that belongs to this flag
            continue
        fi
        case "$w" in
            --*) continue ;;        # any other flag: skip
            *)   cmd="$w"; break ;;
        esac
    done

    # Subcommand-specific completions.
    case "$cmd" in
        completion)
            # `completion <bash|zsh|powershell>` — only the shell name, right after the verb.
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") )
            elif [[ "$prev" == "completion" ]]; then
                COMPREPLY=( $(compgen -W "bash zsh powershell" -- "$cur") )
            else
                COMPREPLY=()
            fi
            return 0
            ;;
        tokens)
            # `tokens [revoke <id>]` — offer `revoke`; the id after it is unknown.
            if [[ "$cur" == -* ]]; then
                COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") )
            elif [[ "$prev" == "revoke" ]]; then
                COMPREPLY=()
            else
                COMPREPLY=( $(compgen -W "revoke" -- "$cur") )
            fi
            return 0
            ;;
    esac

    # No subcommand chosen yet: complete the subcommand list, or global flags on a dash.
    if [[ -z "$cmd" ]]; then
        if [[ "$cur" == -* ]]; then
            COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") )
        else
            COMPREPLY=( $(compgen -W "$subcommands" -- "$cur") )
        fi
        return 0
    fi

    # A subcommand is set (ask/chat/history/catalog/tasks/login/logout/whoami/version/help):
    # global flags apply everywhere; their message/positional args are free text.
    if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") )
        return 0
    fi

    COMPREPLY=()
    return 0
}

complete -F _swarm_cli swarm-cli
