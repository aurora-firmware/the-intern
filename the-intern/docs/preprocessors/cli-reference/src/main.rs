use std::path::PathBuf;
use std::process::{Command, Stdio};

use mdbook::book::{Book, BookItem, Chapter};

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // mdbook calls `<cmd> supports <renderer>` to probe renderer support.
    if args.len() >= 2 && args[1] == "supports" {
        // We support all renderers.
        std::process::exit(0);
    }

    // Normal preprocessing mode: read mdBook's [context, book] JSON from stdin
    // and write the modified Book JSON to stdout.
    let (book_root, book) = parse_mdbook_input(std::io::stdin())
        .expect("failed to parse mdbook preprocessor input from stdin");

    match run(book_root, book) {
        Ok(processed) => {
            serde_json::to_writer(std::io::stdout(), &processed)
                .expect("failed to write processed book to stdout");
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

/// Locate the `bob` binary using the documented discovery rule.
///
/// Order of precedence:
/// 1. `BOB_BIN` environment variable (when set and non-empty).
/// 2. `<workspace_root>/service/target/release/bob` relative to the book root.
/// 3. `<workspace_root>/service/target/debug/bob` relative to the book root.
///
/// Returns the path if the resolved file exists and is executable, or an error
/// message naming `BOB_BIN` and the fallback paths.
///
/// # Errors
///
/// Returns an error string when no usable binary is found at any candidate path.
fn find_bob_binary(book_root: &std::path::Path) -> Result<PathBuf, String> {
    find_bob_binary_with_env(book_root, std::env::var("BOB_BIN").ok().as_deref())
}

/// Inner implementation of [`find_bob_binary`] that accepts the `BOB_BIN`
/// value explicitly, enabling deterministic unit tests without env-var races.
fn find_bob_binary_with_env(
    book_root: &std::path::Path,
    bob_bin_env: Option<&str>,
) -> Result<PathBuf, String> {
    // The docs directory is the book root; the service workspace is one level up.
    let workspace_root = book_root.parent().unwrap_or(book_root);

    let release_path = workspace_root.join("service/target/release/bob");
    let debug_path = workspace_root.join("service/target/debug/bob");

    // 1. Explicit override via BOB_BIN.
    if let Some(val) = bob_bin_env {
        if !val.is_empty() {
            let p = PathBuf::from(val);
            if p.is_file() {
                return Ok(p);
            }
            return Err(format!(
                "BOB_BIN is set to '{val}' but no file exists at that path.\n\
                 Build the binary or set BOB_BIN to a valid path.\n\
                 Fallback paths that were not tried (BOB_BIN takes precedence):\n\
                 - {release_path}\n\
                 - {debug_path}",
                release_path = release_path.display(),
                debug_path = debug_path.display(),
            ));
        }
    }

    // 2. Release build.
    if release_path.is_file() {
        return Ok(release_path);
    }

    // 3. Debug build.
    if debug_path.is_file() {
        return Ok(debug_path);
    }

    Err(format!(
        "No usable `bob` binary found. The CLI reference cannot be generated.\n\
         \n\
         Tried (in order):\n\
         - BOB_BIN environment variable (not set or empty)\n\
         - {release_path}\n\
         - {debug_path}\n\
         \n\
         To fix: build the binary first, then run `mdbook build` again:\n\
         \n\
         \tcargo build -p bob --release\n\
         \tBOB_BIN=\"$PWD/../service/target/release/bob\" mdbook build",
        release_path = release_path.display(),
        debug_path = debug_path.display(),
    ))
}

/// Parse mdBook preprocessor input while avoiding full `PreprocessorContext`
/// deserialization.
///
/// mdBook sends `[context, book]` as JSON. Recent mdBook versions may include
/// JSON `null` values in the merged config inside `context`; those cannot be
/// represented as TOML values, so deserializing the full context can fail even
/// though this preprocessor only needs `context.root`.
fn parse_mdbook_input<R: std::io::Read>(reader: R) -> serde_json::Result<(PathBuf, Book)> {
    let mut input: serde_json::Value = serde_json::from_reader(reader)?;
    let items = input.as_array_mut().ok_or_else(|| {
        serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "expected mdBook preprocessor input array",
        ))
    })?;

    if items.len() != 2 {
        return Err(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "expected mdBook preprocessor input [context, book]",
        )));
    }

    let root = items[0]
        .get("root")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "expected context.root string in mdBook preprocessor input",
            ))
        })?;
    let book = serde_json::from_value(items.remove(1))?;

    Ok((PathBuf::from(root), book))
}

/// Run `<bob_bin> [subcommand] --help` and return the captured stdout.
///
/// # Errors
///
/// Returns an error if the process cannot be spawned or exits with a non-zero
/// status code.
fn capture_help(bob_bin: &std::path::Path, subcommand: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(bob_bin);
    if let Some(sub) = subcommand {
        cmd.arg(sub);
    }
    cmd.arg("--help");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn '{}': {e}", bob_bin.display()))?;

    // clap writes --help output to stdout with exit code 0.
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.is_empty() {
        // Fall back to stderr (some clap versions write help there).
        let err_text = String::from_utf8_lossy(&output.stderr).into_owned();
        if !err_text.is_empty() {
            return Ok(err_text);
        }
    }
    Ok(text)
}

/// Parse the top-level subcommand names out of `bob --help` output.
///
/// Reads clap's `Commands:` section and returns each listed command name, in
/// the order clap lists them, excluding the auto-generated `help` command
/// (which is not a documented subcommand of its own). Deriving the list from
/// the binary's own `--help` output — rather than a hardcoded list — means a
/// newly added top-level subcommand gets a generated CLI reference chapter
/// automatically, with no matching edit required here.
fn parse_subcommand_names(help_text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_commands_section = false;

    for line in help_text.lines() {
        if line.trim_end() == "Commands:" {
            in_commands_section = true;
            continue;
        }

        if !in_commands_section {
            continue;
        }

        if line.trim().is_empty() {
            break;
        }

        if let Some(name) = line.trim_start().split_whitespace().next() {
            if name != "help" {
                names.push(name.to_string());
            }
        }
    }

    names
}

/// Wrap a `--help` capture in a markdown code block with a heading.
fn format_help_page(command_display: &str, help_text: &str) -> String {
    format!(
        "# `{command_display}`\n\n```text\n{help_text}\n```\n",
        command_display = command_display,
        help_text = help_text.trim_end(),
    )
}

/// Build the mdBook chapter path for a CLI reference page.
fn chapter_path(name: &str) -> String {
    format!("cli-reference/{name}.md")
}

/// Run the preprocessor: locate the bob binary, capture help output, and
/// inject CLI reference chapters into the book.
///
/// # Errors
///
/// Returns an error string when the bob binary cannot be found.
fn run(book_root: PathBuf, mut book: Book) -> Result<Book, String> {
    // The book root is where book.toml lives.
    let bob_bin = find_bob_binary(&book_root)?;

    // Collect (chapter_path, title, content) for the root command and each subcommand.
    let mut new_chapters: Vec<(String, String, String)> = Vec::new();

    // Root `bob --help`.
    let root_help =
        capture_help(&bob_bin, None).map_err(|e| format!("failed to capture `bob --help`: {e}"))?;
    new_chapters.push((
        chapter_path("bob"),
        "bob".to_string(),
        format_help_page("bob", &root_help),
    ));

    // Each first-level subcommand, derived from the binary's own `--help`
    // output so newly added subcommands are documented without a matching
    // edit to this preprocessor.
    let subcommands = parse_subcommand_names(&root_help);
    for sub in &subcommands {
        let help = capture_help(&bob_bin, Some(sub))
            .map_err(|e| format!("failed to capture `bob {sub} --help`: {e}"))?;
        new_chapters.push((
            chapter_path(sub),
            format!("bob {sub}"),
            format_help_page(&format!("bob {sub}"), &help),
        ));
    }

    // Inject the generated chapters into the book.  We look for the existing
    // CLI Reference chapter (cli-reference/index.md) and replace its content,
    // then append the subcommand chapters as its sub-items.
    inject_cli_reference(&mut book.sections, new_chapters);

    Ok(book)
}

/// Walk the chapter tree and either replace the CLI Reference index chapter or
/// append the generated chapters at the top level.
fn inject_cli_reference(sections: &mut Vec<BookItem>, mut chapters: Vec<(String, String, String)>) {
    // Try to find and update the existing cli-reference/index.md chapter.
    let mut found_index = false;
    for item in sections.iter_mut() {
        if let BookItem::Chapter(chapter) = item {
            if chapter.path.as_deref() == Some(std::path::Path::new("cli-reference/index.md")) {
                // Replace the stub content and attach generated sub-chapters.
                chapter.content = build_index_content(&chapters);
                chapter.sub_items = chapters
                    .drain(..)
                    .map(|(path, name, content)| {
                        BookItem::Chapter(Chapter {
                            name,
                            content,
                            number: None,
                            sub_items: Vec::new(),
                            path: Some(PathBuf::from(path)),
                            source_path: None,
                            parent_names: vec!["CLI Reference".to_string()],
                        })
                    })
                    .collect();
                found_index = true;
                break;
            }
            // Recurse into nested chapters.
            if !chapters.is_empty() && !chapter.sub_items.is_empty() {
                inject_cli_reference(&mut chapter.sub_items, std::mem::take(&mut chapters));
                if chapters.is_empty() {
                    found_index = true;
                    break;
                }
            }
        }
    }

    // Fallback: if the index chapter was not found, append a new CLI Reference
    // chapter with the generated content as sub-items.
    if !found_index && !chapters.is_empty() {
        let sub_items: Vec<BookItem> = chapters
            .into_iter()
            .map(|(path, name, content)| {
                BookItem::Chapter(Chapter {
                    name,
                    content,
                    number: None,
                    sub_items: Vec::new(),
                    path: Some(PathBuf::from(path)),
                    source_path: None,
                    parent_names: vec!["CLI Reference".to_string()],
                })
            })
            .collect();

        let index_chapter = Chapter {
            name: "CLI Reference".to_string(),
            content: build_index_content(
                &sub_items
                    .iter()
                    .filter_map(|i| {
                        if let BookItem::Chapter(c) = i {
                            Some((
                                c.path
                                    .as_ref()
                                    .map(|p| p.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                c.name.clone(),
                                String::new(),
                            ))
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>(),
            ),
            number: None,
            sub_items,
            path: Some(PathBuf::from("cli-reference/index.md")),
            source_path: None,
            parent_names: Vec::new(),
        };
        sections.push(BookItem::Chapter(index_chapter));
    }
}

/// Build the index page content listing all CLI reference sub-pages.
fn build_index_content(chapters: &[(String, String, String)]) -> String {
    let mut content =
        "# CLI Reference\n\nReference pages generated from the live `bob` binary.\n\n".to_string();
    for (path, name, _) in chapters {
        let file_name = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        content.push_str(&format!("- [`{name}`]({file_name})\n"));
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn make_fake_bob(dir: &std::path::Path, subcommands: &[&str]) -> PathBuf {
        let script_path = dir.join("bob");
        let help_lines: String = subcommands.iter().map(|s| format!("  {s}\n")).collect();
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--help\" ] || [ \"$2\" = \"--help\" ]; then\n\
             echo \"bob serve\"\n\
             echo \"{help_lines}\"\n\
             fi\n"
        );
        std::fs::write(&script_path, script).unwrap();
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
        script_path
    }

    // -------------------------------------------------------------------------
    // AC-1 / find_bob_binary: BOB_BIN takes precedence when set to a real file
    // -------------------------------------------------------------------------

    #[test]
    fn find_bob_binary_returns_bob_bin_env_when_set_to_existing_file() {
        let tmp = TempDir::new().unwrap();
        let bin_path = make_fake_bob(tmp.path(), &[]);
        // Use a dummy book root; BOB_BIN is an absolute path so book_root is irrelevant.
        let book_root = TempDir::new().unwrap();

        let result = find_bob_binary_with_env(book_root.path(), Some(bin_path.to_str().unwrap()));

        assert_eq!(result.unwrap(), bin_path);
    }

    // -------------------------------------------------------------------------
    // AC-2 / find_bob_binary: errors with BOB_BIN message when set to bad path
    // -------------------------------------------------------------------------

    #[test]
    fn find_bob_binary_errors_naming_bob_bin_when_env_points_to_nonexistent_path() {
        let book_root = TempDir::new().unwrap();
        let result = find_bob_binary_with_env(book_root.path(), Some("/no/such/path/bob"));

        let err = result.unwrap_err();
        assert!(
            err.contains("BOB_BIN"),
            "error should mention BOB_BIN, got: {err}"
        );
        assert!(
            err.contains("/no/such/path/bob"),
            "error should name the bad path, got: {err}"
        );
    }

    // -------------------------------------------------------------------------
    // AC-2 / find_bob_binary: errors listing all candidates when nothing found
    // -------------------------------------------------------------------------

    #[test]
    fn find_bob_binary_errors_listing_all_fallback_paths_when_nothing_found() {
        let book_root = TempDir::new().unwrap();

        let result = find_bob_binary_with_env(book_root.path(), None);

        let err = result.unwrap_err();
        assert!(
            err.contains("BOB_BIN"),
            "error should mention BOB_BIN, got: {err}"
        );
        assert!(
            err.contains("target/release/bob"),
            "error should mention release path, got: {err}"
        );
        assert!(
            err.contains("target/debug/bob"),
            "error should mention debug path, got: {err}"
        );
    }

    // -------------------------------------------------------------------------
    // AC-1 / find_bob_binary: falls back to release path
    // -------------------------------------------------------------------------

    #[test]
    fn find_bob_binary_falls_back_to_release_path_when_bob_bin_not_set() {
        let tmp = TempDir::new().unwrap();
        // Create the expected directory structure.
        let release_dir = tmp.path().join("service/target/release");
        std::fs::create_dir_all(&release_dir).unwrap();
        let release_bob = make_fake_bob(&release_dir, &[]);

        // Create docs/ subdirectory as the book root.
        let docs_dir = tmp.path().join("docs");
        std::fs::create_dir_all(&docs_dir).unwrap();

        let result = find_bob_binary_with_env(&docs_dir, None);

        assert_eq!(result.unwrap(), release_bob);
    }

    // -------------------------------------------------------------------------
    // AC-1 / find_bob_binary: falls back to debug path when release absent
    // -------------------------------------------------------------------------

    #[test]
    fn find_bob_binary_falls_back_to_debug_path_when_release_absent() {
        let tmp = TempDir::new().unwrap();
        let debug_dir = tmp.path().join("service/target/debug");
        std::fs::create_dir_all(&debug_dir).unwrap();
        let debug_bob = make_fake_bob(&debug_dir, &[]);

        let docs_dir = tmp.path().join("docs");
        std::fs::create_dir_all(&docs_dir).unwrap();

        let result = find_bob_binary_with_env(&docs_dir, None);

        assert_eq!(result.unwrap(), debug_bob);
    }

    // -------------------------------------------------------------------------
    // AC-1 / capture_help: captures help output from a real binary
    // -------------------------------------------------------------------------

    #[test]
    fn capture_help_returns_stdout_when_binary_runs_successfully() {
        let tmp = TempDir::new().unwrap();
        let bin = make_fake_bob(tmp.path(), &["serve", "status"]);
        let output = capture_help(&bin, None).unwrap();
        assert!(
            output.contains("bob serve"),
            "expected help text, got: {output}"
        );
    }

    // -------------------------------------------------------------------------
    // AC-1 / format_help_page: wraps help text in markdown code fence
    // -------------------------------------------------------------------------

    #[test]
    fn format_help_page_wraps_help_text_in_code_fence_with_heading() {
        let page = format_help_page("bob serve", "Usage: bob serve [OPTIONS]");
        assert!(page.starts_with("# `bob serve`"), "missing heading: {page}");
        assert!(page.contains("```text"), "missing code fence: {page}");
        assert!(
            page.contains("Usage: bob serve [OPTIONS]"),
            "missing content: {page}"
        );
    }

    // -------------------------------------------------------------------------
    // AC-1 / build_index_content: lists all commands with links
    // -------------------------------------------------------------------------

    #[test]
    fn build_index_content_lists_all_commands_with_relative_links() {
        let chapters = vec![
            (
                "cli-reference/bob.md".to_string(),
                "bob".to_string(),
                String::new(),
            ),
            (
                "cli-reference/serve.md".to_string(),
                "bob serve".to_string(),
                String::new(),
            ),
        ];
        let content = build_index_content(&chapters);
        assert!(
            content.contains("[`bob`](bob.md)"),
            "missing bob link: {content}"
        );
        assert!(
            content.contains("[`bob serve`](serve.md)"),
            "missing serve link: {content}"
        );
    }

    // -------------------------------------------------------------------------
    // parse_subcommand_names: derives the documented subcommand list from the
    // binary's own `--help` output instead of a hardcoded constant, so a new
    // top-level subcommand (e.g. `task`) is picked up automatically.
    // -------------------------------------------------------------------------

    #[test]
    fn parse_subcommand_names_extracts_top_level_commands_excluding_help() {
        let help_text = "Bob service CLI\n\
             \n\
             Usage: bob [OPTIONS] <COMMAND>\n\
             \n\
             Commands:\n\
             \x20\x20init      \n\
             \x20\x20task      \n\
             \x20\x20serve     \n\
             \x20\x20status    \n\
             \x20\x20help      Print this message or the help of the given subcommand(s)\n\
             \n\
             Options:\n\
             \x20\x20-h, --help     Print help\n";

        let names = parse_subcommand_names(help_text);

        assert_eq!(names, vec!["init", "task", "serve", "status"]);
    }

    #[test]
    fn parse_mdbook_input_accepts_null_values_in_context_config() {
        let tmp = TempDir::new().unwrap();
        let input = serde_json::json!([
            {
                "root": tmp.path(),
                "config": {
                    "output": {
                        "html": {
                            "site-url": null
                        }
                    }
                }
            },
            Book::new()
        ]);

        let serialized = serde_json::to_vec(&input).unwrap();
        let (root, book) = parse_mdbook_input(serialized.as_slice()).unwrap();

        assert_eq!(root, tmp.path());
        assert!(book.sections.is_empty());
    }
}
