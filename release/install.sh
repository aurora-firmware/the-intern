#!/bin/sh
# Installs The Intern from a release bundle into ~/.local/lib/the-intern and links ~/.local/bin/bob.
# Usage: install.sh [--version X.Y.Z]
# BOB_RELEASE_URL overrides the download location (a / or file: path, or an http(s) URL).
# The release workflow writes the release's version into the next line.
VERSION=""

RELEASE_BASE="https://github.com/aurora-firmware/the-intern/releases/download"

refuse() {
    printf 'bob install: %s\n' "$1" >&2
    return 1
}

# check_platform <system> <machine> <glibc version, empty when none> <systemd: yes|no>
check_platform() {
    case "$1" in
        Linux)
            case "$2" in
                x86_64) ;;
                *) refuse "Linux on $2 is not supported: only x86_64 on Linux (Linux on ARM is not supported)"; return 1 ;;
            esac
            [ -n "$3" ] || { refuse "this Linux has no glibc (a musl C library is not supported)"; return 1; }
            [ "$4" = yes ] || { refuse "this Linux does not run systemd as its init system"; return 1; }
            ;;
        Darwin)
            [ "$2" = arm64 ] || { refuse "an Intel Mac ($2) is not supported: only Apple silicon (arm64)"; return 1; }
            ;;
        *)
            refuse "$1 is not supported: only Linux x86_64 and Apple silicon Macs"
            return 1
            ;;
    esac
}

# check_user <user id>
check_user() {
    [ "$1" != 0 ] || { refuse "run as root: run the install script as your own account, never as root"; return 1; }
}

# check_home <home folder>
check_home() {
    case "/$1/" in
        */node_modules/*) refuse "the home folder $1 has a node_modules segment"; return 1 ;;
    esac
}

# check_not_installed <program folder> <bob link>
check_not_installed() {
    if [ -e "$1/current" ] || [ -L "$1/current" ]; then
        installed=unknown
        if [ -L "$1/current" ]; then
            installed=$(basename "$(readlink "$1/current")")
        fi
        refuse "The Intern $installed is already installed in $1; to change version, run: bob upgrade"
        return 1
    fi
    if [ -e "$2" ] || [ -L "$2" ]; then
        if [ ! -L "$2" ] || [ "$(readlink "$2")" != "$1/current/bin/bob" ]; then
            refuse "$2 already exists and is not this program's link (installed version unknown); if it is The Intern, run: bob upgrade"
            return 1
        fi
    fi
}

# check_version <version>
check_version() {
    case "$1" in
        "") refuse "no version to install: pass --version X.Y.Z"; return 1 ;;
        *[!0-9A-Za-z.+-]*) refuse "the version $1 is not a release version such as 1.2.3"; return 1 ;;
    esac
}

# platform_name <system> <machine>
platform_name() {
    case "$1" in
        Linux) echo linux-x64 ;;
        Darwin) echo darwin-arm64 ;;
    esac
}

# asset_url <release url or empty> <version> <asset>
asset_url() {
    if [ -z "$1" ]; then
        echo "$RELEASE_BASE/v$2/$3"
        return
    fi
    base=${1%/}
    case "$base" in
        http:* | https:*) echo "$base/v$2/$3" ;;
        file:*)
            path=${base#file:}
            path=${path#//}
            echo "file://$path/v$2/$3"
            ;;
        /*) echo "file://$base/v$2/$3" ;;
        *) refuse "BOB_RELEASE_URL must be a / or file: path or an http(s) URL"; return 1 ;;
    esac
}

# first_missing <path>: the topmost folder of the path that does not exist yet, empty when all exist
first_missing() {
    missing=""
    probe=$1
    while [ ! -e "$probe" ] && [ ! -L "$probe" ]; do
        missing=$probe
        probe=$(dirname "$probe")
    done
    echo "$missing"
}

# Removes whatever a failed run made; done is set once the install is complete.
cleanup() {
    if [ -n "$done" ]; then
        return
    fi
    if [ -n "$linked_current" ]; then
        rm -f "$linked_current"
    fi
    if [ -n "$staging" ]; then
        rm -rf "$staging"
    fi
    if [ -n "$placed" ]; then
        rm -rf "$placed"
    fi
    if [ -n "$made_bin" ]; then
        rm -rf "$made_bin"
    fi
    if [ -n "$made_program" ]; then
        rm -rf "$made_program"
    fi
}

fetch() {
    curl -fsSL -o "$2" "$1"
}

verify_checksum() {
    if command -v sha256sum >/dev/null 2>&1; then
        (cd "$1" && sha256sum -c "$2") >/dev/null 2>&1
    elif command -v shasum >/dev/null 2>&1; then
        (cd "$1" && shasum -a 256 -c "$2") >/dev/null 2>&1
    else
        refuse "neither sha256sum nor shasum is installed"
        return 1
    fi
}

install_bundle() {
    version=$1
    program=$2
    bin_link=$3
    asset=$4
    url=$5

    made_program=$(first_missing "$program")
    mkdir -p "$program" "$program/versions" || { refuse "cannot create $program"; return 1; }
    staging=$(mktemp -d "$program/.staging-XXXXXX") || { refuse "cannot create a staging folder in $program"; return 1; }

    fetch "$url" "$staging/$asset" || { refuse "download of $url failed: check the version and the network"; return 1; }
    fetch "$url.sha256" "$staging/$asset.sha256" || { refuse "no checksum file at $url.sha256: refusing to install an unchecked bundle"; return 1; }
    verify_checksum "$staging" "$asset.sha256" || { refuse "the checksum of $asset does not match"; return 1; }

    mkdir "$staging/unpacked"
    tar -xzf "$staging/$asset" -C "$staging/unpacked" || { refuse "cannot unpack $asset"; return 1; }
    set -- "$staging"/unpacked/*/
    if [ "$#" -ne 1 ] || [ ! -f "$1/bin/bob" ]; then
        refuse "$asset does not hold bin/bob"
        return 1
    fi
    folder=${1%/}

    [ ! -e "$program/versions/$version" ] || { refuse "$program/versions/$version already exists"; return 1; }
    placed="$program/versions/$version"
    mv "$folder" "$placed" || { refuse "cannot move the bundle into $placed"; return 1; }
    linked_current="$program/current"
    ln -sfn "versions/$version" "$program/current" || { refuse "cannot link $program/current"; return 1; }
    made_bin=$(first_missing "$(dirname "$bin_link")")
    mkdir -p "$(dirname "$bin_link")" || { refuse "cannot create $(dirname "$bin_link")"; return 1; }
    ln -sfn "$program/current/bin/bob" "$bin_link" || { refuse "cannot link $bin_link"; return 1; }
    done=yes
}

main() {
    version=$VERSION
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --version)
                [ "$#" -ge 2 ] || { refuse "--version needs a value"; exit 1; }
                version=$2
                shift 2
                ;;
            *) refuse "unknown argument $1"; exit 1 ;;
        esac
    done

    umask 077
    program="$HOME/.local/lib/the-intern"
    bin_link="$HOME/.local/bin/bob"

    check_user "$(id -u)" || exit 1
    check_home "$HOME" || exit 1
    check_not_installed "$program" "$bin_link" || exit 1
    check_version "$version" || exit 1

    system=$(uname -s)
    machine=$(uname -m)
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || glibc=""
    systemd=no
    [ -d /run/systemd/system ] && systemd=yes
    check_platform "$system" "$machine" "$glibc" "$systemd" || exit 1

    for tool in curl tar; do
        command -v "$tool" >/dev/null 2>&1 || { refuse "$tool is not installed"; exit 1; }
    done

    asset="the-intern-$version-$(platform_name "$system" "$machine").tar.gz"
    url=$(asset_url "$BOB_RELEASE_URL" "$version" "$asset") || exit 1

    staging=""
    placed=""
    linked_current=""
    made_program=""
    made_bin=""
    done=""
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM
    install_bundle "$version" "$program" "$bin_link" "$asset" "$url" || exit 1

    echo "Installed The Intern $version."
    echo "Program folder: $program"
    echo "bob: $bin_link"
    echo "Next: sign in to pi if you have not, then run: bob service install"
    case ":$PATH:" in
        *":$HOME/.local/bin:"*) ;;
        *) echo "Add bob to your PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
    esac
}

if [ -z "${BOB_INSTALL_LIB:-}" ]; then
    main "$@"
fi
