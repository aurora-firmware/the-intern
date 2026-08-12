use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let version = std::env::var("GITHUB_REF_NAME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "unknown".to_string())
        });
    println!("cargo:rustc-env=APP_VERSION={version}");
    println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");

    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set for bob"),
    );
    let package_root = manifest_dir
        .join("../../../email-skills/.pi/skills")
        .canonicalize()
        .unwrap_or_else(|err| {
            panic!(
                "failed to resolve canonical email-skills package path from {}: {err}",
                manifest_dir.display()
            )
        });
    let mut asset_files = Vec::new();

    track_and_collect_files(&package_root, &mut asset_files).unwrap_or_else(|err| {
        panic!(
            "failed to collect embedded pi skill assets from {}: {err}",
            package_root.display()
        )
    });
    asset_files.sort();

    let generated_assets =
        render_embedded_assets(&package_root, &asset_files).unwrap_or_else(|err| {
            panic!(
                "failed to render embedded pi skill assets for {}: {err}",
                package_root.display()
            )
        });
    let out_dir =
        PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR must be set for bob build script"));
    let output_path = out_dir.join("embedded_pi_skill_assets.rs");

    fs::write(&output_path, generated_assets).unwrap_or_else(|err| {
        panic!(
            "failed to write embedded pi skill asset table to {}: {err}",
            output_path.display()
        )
    });
}

fn track_and_collect_files(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut entries = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            track_and_collect_files(&path, files)?;
            continue;
        }

        if file_type.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push(path);
        }
    }

    Ok(())
}

fn render_embedded_assets(source_dir: &Path, files: &[PathBuf]) -> Result<String, std::fmt::Error> {
    let mut generated = String::new();
    let source_dir_literal = source_dir.display().to_string();

    writeln!(
        generated,
        "pub(crate) const EMBEDDED_PI_SKILL_PACKAGE_SOURCE_DIR: &str = {source_dir_literal:?};"
    )?;
    writeln!(
        generated,
        "pub(crate) static EMBEDDED_PI_SKILL_ASSETS: &[EmbeddedAsset] = &["
    )?;

    for file in files {
        let relative_path = relative_path_literal(source_dir, file);
        let absolute_path = file.display().to_string();

        writeln!(
            generated,
            "    EmbeddedAsset::new({relative_path:?}, include_bytes!({absolute_path:?})),"
        )?;
    }

    writeln!(generated, "];")?;

    Ok(generated)
}

fn relative_path_literal(source_dir: &Path, file: &Path) -> String {
    file.strip_prefix(source_dir)
        .expect("embedded asset must live under the package source dir")
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}
