//! Installed assets are read-only; all mutable data stays in the working profile.
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn resource(path: impl AsRef<Path>) -> PathBuf {
    std::env::var_os("KNIGHTLIGHT_RESOURCES")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(path)
}

pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW for worker processes.
    }
    // Keep the same function on every platform without a platform-specific warning.
    command.env("PYTHONUNBUFFERED", "1");
    command
}

fn worker_binary(name: &str) -> PathBuf {
    resource(format!(
        "workers/{name}/{name}{}",
        std::env::consts::EXE_SUFFIX
    ))
}

fn python(name: &str) -> PathBuf {
    let env = if name == "speech" { "speech" } else { "maia" };
    resource(if cfg!(windows) {
        format!("vendor/{env}-env/Scripts/python.exe")
    } else {
        format!("vendor/{env}-env/bin/python")
    })
}

pub fn worker_available(name: &str) -> bool {
    shared_worker().is_file() || worker_binary(name).is_file() || python(name).is_file()
}

fn shared_worker() -> PathBuf {
    resource(format!(
        "workers/coach-runtime/coach-runtime{}",
        std::env::consts::EXE_SUFFIX
    ))
}

pub fn worker(name: &str) -> Command {
    if shared_worker().is_file() {
        let mut command = quiet_command(shared_worker());
        command.arg(name);
        return command;
    }
    let binary = worker_binary(name);
    if binary.is_file() {
        quiet_command(binary)
    } else {
        let mut command = quiet_command(python(name));
        command
            .arg("-u")
            .arg(resource(format!("scripts/{name}.py")));
        command
    }
}

/// A stable per-user profile keeps upgrades and read-only application installs safe.
pub fn prepare_profile(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(path.join("data"))?;
    std::env::set_current_dir(path)
}
