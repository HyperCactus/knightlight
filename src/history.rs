//! Durable history storage. Legacy archives remain readable; live sessions are
//! updated individually so a move never rewrites the complete library.
use serde::{de::DeserializeOwned, Serialize};
use std::{io::Write, path::Path};

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "Cannot read saved history {}: {e}. The original file has been preserved.",
                path.display()
            ))
        }
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|e| {
        format!("Cannot read saved history {}: {e}. The original file has been preserved. Restore a known-good {}.bak before restarting.", path.display(), path.display())
    })
}

fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
    let mut output = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    output
        .write_all(bytes)
        .and_then(|_| output.sync_all())
        .map_err(|e| e.to_string())?;
    drop(output);
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

pub fn write_json<T: Serialize + DeserializeOwned>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Never replace unreadable state, even if it changed after application startup.
    if let Some(previous) = read_json::<T>(path)? {
        let backup = path.with_file_name(format!(
            "{}.bak",
            path.file_name().unwrap().to_string_lossy()
        ));
        replace(
            &backup,
            &serde_json::to_vec(&previous).map_err(|e| e.to_string())?,
        )?;
    }
    replace(path, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

pub fn session_path(id: &str) -> std::path::PathBuf {
    // Collision-free encoding also prevents session identifiers becoming paths.
    let encoded: String = id.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
    Path::new("data/sessions").join(format!("{encoded}.json"))
}

#[derive(serde::Deserialize, Serialize)]
struct SessionRecord {
    index: usize,
    game: crate::Game,
}

pub fn save_session(index: usize, game: &crate::Game) -> Result<(), String> {
    write_json(
        &session_path(&game.session_id),
        &SessionRecord {
            index,
            game: game.clone(),
        },
    )
}

pub fn load() -> Result<Vec<crate::Game>, String> {
    let mut games = Vec::new();
    for path in ["data/imports.json", "data/sessions.json"] {
        if let Some(saved) = read_json::<Vec<crate::Game>>(Path::new(path))? {
            games.extend(saved);
        }
    }
    match std::fs::read_dir("data/sessions") {
        Ok(entries) => {
            let mut files = Vec::new();
            for entry in entries {
                let path = entry
                    .map_err(|e| format!("Cannot read session history: {e}"))?
                    .path();
                if path.extension().is_some_and(|x| x == "json") {
                    files.push(path);
                }
            }
            files.sort();
            let mut records = Vec::new();
            for path in files {
                if let Some(record) = read_json::<SessionRecord>(&path)? {
                    records.push(record);
                }
            }
            records.sort_by_key(|record| record.index);
            games.extend(records.into_iter().map(|record| record.game));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot read session history: {e}")),
    }
    Ok(games)
}

// Numeric review indices must remain stable when imports and live sessions are
// interleaved. This small identity manifest changes only when games are added.
pub fn save_order(games: &[crate::Game]) -> Result<(), String> {
    let order: Vec<_> = games.iter().map(crate::library::identity).collect();
    write_json(Path::new("data/library-order.json"), &order)
}

pub fn restore_order(games: &mut [crate::Game]) -> Result<(), String> {
    if let Some(order) = read_json::<Vec<String>>(Path::new("data/library-order.json"))? {
        let ranks: std::collections::HashMap<_, _> = order
            .into_iter()
            .enumerate()
            .map(|(index, id)| (id, index))
            .collect();
        // Stable sort retains source order for newly discovered PGNs.
        games.sort_by_key(|game| {
            ranks
                .get(&crate::library::identity(game))
                .copied()
                .unwrap_or(usize::MAX)
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_cannot_escape_the_session_directory() {
        let path = session_path("../x/../y");
        assert_eq!(path.parent(), Some(Path::new("data/sessions")));
        assert!(!path.file_name().unwrap().to_string_lossy().contains(".."));
    }
}
