bob install bundle

This bundle contains:
- bob: the bob binary that will be installed on your PATH
- bob.ts: the pi-agent extension bob uses at runtime
- install.sh: installs bob, bob.ts and the bob skills into their default user-local locations
- README.txt: this note

Install:
Run ./install.sh
That is the only required installation step for this bundle.

Existing installs:
If a bob binary is already installed at ~/.local/bin/bob, or the default skill
folder (bob/skills under your data directory) holds anything at all, install.sh
asks "Overwrite? [y/N]" before writing anything. Any answer other than y, or no
input at all, stops the install with nothing changed.
Before the prompt, install.sh warns when:
- a different bob version is installed: the installed skills (the documentation
  skill included) and the extension will be replaced and may differ from what
  is there now, local edits included;
- skills are installed but no binary is: the existing skills will be replaced.
Run ./install.sh -y to skip the prompt (the warnings are still printed).

Skills:
The default skill folder is replaced on every install, a reinstall of the same
version included: install.sh empties it and installs the skills shipped with
this bundle, so local edits are not kept and files the bundle does not ship are
removed. A skill folder configured elsewhere (skill_install_path in config.toml)
is never touched. If the skills step fails, bob and bob.ts stay installed and
install.sh warns that skills may be missing; rerun install.sh to repair them.

Next:
Run bob init <workspace> to create your bob workspace.
For the full first-run quickstart and prerequisites, see:
https://github.com/aurora-firmware/the-intern/blob/main/the-intern/docs/src/quickstart/index.md
