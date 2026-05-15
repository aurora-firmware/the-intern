# Tests

This directory contains shell-based repository checks. Run them from the
repository root.

## Requirements

- `bash`
- `python3`
- Python `yaml` module, used by `test_workflows.sh`

## Run All Tests

```sh
for t in tests/*.sh; do bash "$t"; done
```

## Run One Test File

```sh
bash tests/test_workflows.sh
bash tests/test_coding_guidelines.sh
bash tests/test_the_intern_structure.sh
bash tests/test_roadmap.sh
```

Each script prints `PASS` or `FAIL` lines, summarizes its result count, and
exits nonzero if any check fails.
