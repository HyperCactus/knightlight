//! Application-wide preferences survive browser clearing, URL aliases and relaunches.
use axum::{extract::State, http::header, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Snapshot {
    pub updated_at: u64,
    pub values: Map<String, Value>,
}

#[derive(Default)]
pub struct Store {
    pub snapshot: Option<Snapshot>,
}

fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.updated_at == 0 || snapshot.updated_at > 9_007_199_254_740_991 {
        return Err("Invalid settings revision".into());
    }
    for (key, value) in &snapshot.values {
        let valid = match key.as_str() {
            "voice" | "sound" | "uiSounds" | "moveSounds" | "rewards" | "autoDiagrams"
            | "predict" | "coach" | "reviewChallenges" | "coordinates" | "legal" | "assist" => {
                value.is_boolean()
            }
            "speed" => value.as_f64().is_some_and(|n| (0.75..=1.5).contains(&n)),
            "voiceVolume" | "soundVolume" => {
                value.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n))
            }
            "botRating" => value.as_u64().is_some_and(|n| (400..=2400).contains(&n)),
            "botLevel" => value.as_u64().is_some_and(|n| n <= 20),
            "goal" => value.as_u64().is_some_and(|n| [3, 5, 10].contains(&n)),
            "reviewPause" => value
                .as_u64()
                .is_some_and(|n| [800, 1400, 2250].contains(&n)),
            "voiceName" => value
                .as_str()
                .is_some_and(|s| ["af_heart", "am_michael", "bf_emma", "piper"].contains(&s)),
            "theme" => value
                .as_str()
                .is_some_and(|s| ["dark", "light", "system"].contains(&s)),
            "board" => value
                .as_str()
                .is_some_and(|s| ["sage", "walnut", "slate"].contains(&s)),
            "pace" => value
                .as_str()
                .is_some_and(|s| ["normal", "calm", "brisk"].contains(&s)),
            "motion" => value
                .as_str()
                .is_some_and(|s| ["system", "full", "reduced"].contains(&s)),
            "text" => value
                .as_str()
                .is_some_and(|s| ["comfortable", "large"].contains(&s)),
            "botMode" => value
                .as_str()
                .is_some_and(|s| ["auto", "manual"].contains(&s)),
            "botStyle" => value
                .as_str()
                .is_some_and(|s| ["varied", "balanced", "attacking", "positional"].contains(&s)),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid setting: {key}"));
        }
    }
    Ok(())
}

impl Store {
    pub fn load(path: &Path) -> Result<Self, String> {
        let snapshot = crate::history::read_json::<Snapshot>(path)?;
        if let Some(value) = &snapshot {
            validate(value)?;
        }
        Ok(Self { snapshot })
    }

    fn save(&mut self, path: &Path, next: Snapshot) -> Result<(), crate::ApiError> {
        validate(&next).map_err(crate::bad)?;
        if let Some(current) = &self.snapshot {
            if next.updated_at < current.updated_at
                || (next.updated_at == current.updated_at && next.values != current.values)
            {
                return Err(crate::error(
                    axum::http::StatusCode::CONFLICT,
                    "Settings changed in another window. Reload to see the latest choices.",
                ));
            }
            if next.updated_at == current.updated_at {
                return Ok(()); // Retrying the same update is safe.
            }
        }
        crate::history::write_json(path, &next).map_err(crate::unavailable)?;
        self.snapshot = Some(next);
        Ok(())
    }
}

pub async fn get(State(app): State<crate::Shared>) -> impl axum::response::IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(app.preferences.lock().unwrap().snapshot.clone()),
    )
}

pub async fn bootstrap(State(app): State<crate::Shared>) -> impl axum::response::IntoResponse {
    let snapshot = app.preferences.lock().unwrap().snapshot.clone();
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (
                axum::http::HeaderName::from_static("cross-origin-resource-policy"),
                "same-origin",
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            ),
        ],
        format!(
            "window.knightlightSavedPreferences = {};",
            serde_json::to_string(&snapshot).unwrap()
        ),
    )
}

pub async fn put(
    State(app): State<crate::Shared>,
    Json(next): Json<Snapshot>,
) -> Result<impl axum::response::IntoResponse, crate::ApiError> {
    let mut store = app.preferences.lock().unwrap();
    store.save(Path::new("data/preferences.json"), next)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(store.snapshot.clone()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_values_are_rejected() {
        for (key, value) in [
            ("theme", serde_json::json!("invisible")),
            ("speed", serde_json::json!(20)),
            ("voice", serde_json::json!("off")),
            ("botRating", serde_json::json!(300)),
            ("unexpected", serde_json::json!(true)),
        ] {
            let mut values = Map::new();
            values.insert(key.into(), value);
            assert!(validate(&Snapshot {
                updated_at: 1,
                values
            })
            .is_err());
        }
    }
    #[test]
    fn durable_ordered_idempotent_updates() {
        let dir = std::env::temp_dir().join(format!(
            "knightlight-prefs-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let path = dir.join("preferences.json");
        let mut store = Store::load(&path).unwrap();
        assert!(store.snapshot.is_none());
        let next = Snapshot {
            updated_at: 20,
            values: serde_json::from_value(
                serde_json::json!({"voice":false,"theme":"light","speed":1.25}),
            )
            .unwrap(),
        };
        store.save(&path, next.clone()).unwrap();
        store.save(&path, next.clone()).unwrap();
        let mut stale = next.clone();
        stale.updated_at = 19;
        assert_eq!(
            store.save(&path, stale).unwrap_err().0,
            axum::http::StatusCode::CONFLICT
        );
        let restored = Store::load(&path).unwrap().snapshot.unwrap();
        assert_eq!(restored.values, next.values);
        assert_eq!(restored.updated_at, 20);
        std::fs::write(&path, "broken").unwrap();
        let mut newer = next;
        newer.updated_at = 21;
        assert_eq!(
            store.save(&path, newer).unwrap_err().0,
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
        assert_eq!(store.snapshot.unwrap().updated_at, 20);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
