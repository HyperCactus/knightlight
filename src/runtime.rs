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
    command.env("PYTHONIOENCODING", "utf-8");
    command.env("PYTHONUTF8", "1");
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

// Keep ownership of real process handles, rather than PIDs which can be reused.
// Native updates must release worker executables/DLLs before replacing resources.
use std::sync::{Arc, Mutex, OnceLock, Weak};
type Process = Arc<Mutex<std::process::Child>>;
#[derive(Default)]
struct ProcessRegistry {
    processes: Mutex<(bool, Vec<Weak<Mutex<std::process::Child>>>)>,
}
impl ProcessRegistry {
    fn register(&self, child: std::process::Child) -> WorkerProcess {
        let process = Arc::new(Mutex::new(child));
        let worker = WorkerProcess(process.clone());
        let mut registry = self.processes.lock().unwrap();
        registry.1.retain(|p| p.strong_count() > 0);
        if registry.0 {
            worker.stop();
        } else {
            registry.1.push(Arc::downgrade(&process));
        }
        worker
    }
    fn shutdown(&self) {
        let children: Vec<Process> = {
            let mut registry = self.processes.lock().unwrap();
            registry.0 = true;
            registry.1.drain(..).filter_map(|p| p.upgrade()).collect()
        };
        for child in children {
            stop_process(&child);
        }
    }
}
fn registry() -> &'static ProcessRegistry {
    static REGISTRY: OnceLock<ProcessRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ProcessRegistry::default)
}
fn stop_process(child: &Process) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
pub struct WorkerProcess(Process);
impl WorkerProcess {
    pub fn stop(&self) {
        stop_process(&self.0);
    }
}
impl Drop for WorkerProcess {
    fn drop(&mut self) {
        self.stop();
    }
}
pub fn track_worker(child: std::process::Child) -> WorkerProcess {
    registry().register(child)
}
pub fn shutdown_workers() {
    registry().shutdown();
}

#[cfg(test)]
mod process_tests {
    use super::*;
    fn child() -> std::process::Child {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "runtime::process_tests::worker_fixture",
                "--exact",
                "--ignored",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap()
    }
    #[test]
    #[ignore = "subprocess fixture: terminated by its owning test"]
    fn worker_fixture() {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    #[test]
    fn shutdown_reaps_workers_and_prevents_late_processes_surviving() {
        let registry = ProcessRegistry::default();
        let first = registry.register(child());
        assert!(first.0.lock().unwrap().try_wait().unwrap().is_none());
        registry.shutdown();
        assert!(first.0.lock().unwrap().try_wait().unwrap().is_some());
        let late = registry.register(child());
        assert!(late.0.lock().unwrap().try_wait().unwrap().is_some());
        registry.shutdown(); // idempotent
    }
    #[test]
    fn dropping_the_owner_stops_its_worker_without_a_global_shutdown() {
        let registry = ProcessRegistry::default();
        let worker = registry.register(child());
        let handle = worker.0.clone();
        drop(worker);
        assert!(handle.lock().unwrap().try_wait().unwrap().is_some());
    }
}
