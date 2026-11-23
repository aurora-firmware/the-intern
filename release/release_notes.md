# The Intern

## Install

On Linux x64 or macOS on Apple silicon, run:

```
curl -fsSL https://github.com/aurora-firmware/the-intern/releases/latest/download/install.sh | sh
```

To install this exact version, add `-s -- --version X.Y.Z` after `sh`, with this release's version. Then sign in to pi
if you haven't, and run `bob service install`.

To check a bundle by hand, download it with its `.sha256` file and run `sha256sum -c` (`shasum -a 256 -c` on macOS).

## macOS on Apple silicon

macOS on Apple silicon is released like Linux, but it isn't yet verified on a real Mac. Its behaviour is covered by
unit tests only.
