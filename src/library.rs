//! PGN interchange preserves headers and validates the complete main line.
use crate::{bad, error, rating, training, unavailable, ApiError, Game, Shared};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use pgn_reader::{Outcome, RawTag, Reader, SanPlus, Skip, Visitor};
use serde::Deserialize;
use serde_json::{json, Value};
use shakmaty::{uci::UciMove, Chess, Position};
use std::{
    collections::{BTreeMap, HashSet},
    io::Cursor,
    ops::ControlFlow,
};
pub const MAX_PGN_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_PGN_GAMES: usize = 100_000;
struct Importer;
struct Line {
    game: Game,
    pos: Chess,
}
impl Visitor for Importer {
    type Tags = BTreeMap<String, String>;
    type Movetext = Line;
    type Output = Result<Game, String>;
    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        ControlFlow::Continue(BTreeMap::new())
    }
    fn tag(
        &mut self,
        tags: &mut Self::Tags,
        name: &[u8],
        value: RawTag<'_>,
    ) -> ControlFlow<Self::Output> {
        if tags.len() < 64 && name.len() <= 64 {
            tags.insert(
                String::from_utf8_lossy(name).into(),
                value.decode_utf8_lossy().chars().take(1000).collect(),
            );
        }
        ControlFlow::Continue(())
    }
    fn begin_movetext(&mut self, tags: Self::Tags) -> ControlFlow<Self::Output, Line> {
        if tags
            .get("Variant")
            .is_some_and(|v| v != "Standard" && v != "Chess")
        {
            return ControlFlow::Break(Err("Only standard chess games are supported".into()));
        }
        if let Some(f) = tags.get("FEN") {
            if crate::position(f)
                .ok()
                .is_none_or(|p| crate::fen(&p) != crate::fen(&Chess::default()))
            {
                return ControlFlow::Break(Err(
                    "Custom starting positions are not supported in game imports".into(),
                ));
            }
        }
        let get = |key: &str| tags.get(key).cloned().unwrap_or_default();
        let number = |key: &str| {
            tags.get(key)
                .and_then(|s| s.parse::<i32>().ok())
                .filter(|n| (100..=3500).contains(n))
        };
        let played_at = tags.get("ChessStudyPlayedAt").cloned();
        let game = Game {
            white: get("White"),
            black: get("Black"),
            result: tags.get("Result").cloned().unwrap_or_else(|| "*".into()),
            date: get("Date"),
            event: get("Event"),
            white_elo: number("WhiteElo"),
            black_elo: number("BlackElo"),
            opponent_rating: number("ChessStudyOpponentRating"),
            rating_sample: number("ChessStudyRating"),
            played_at,
            session_id: get("ChessStudySession"),
            tags,
            source: "import".into(),
            ..Default::default()
        };
        ControlFlow::Continue(Line {
            game,
            pos: Chess::default(),
        })
    }
    fn san(&mut self, line: &mut Line, san: SanPlus) -> ControlFlow<Self::Output> {
        if line.game.moves.len() >= 600 {
            return ControlFlow::Break(Err("Game exceeds 600 plies".into()));
        }
        match san.san.to_move(&line.pos) {
            Ok(m) => {
                line.game.moves.push(UciMove::from_standard(m).to_string());
                line.pos.play_unchecked(m);
                ControlFlow::Continue(())
            }
            Err(e) => ControlFlow::Break(Err(format!(
                "Illegal move {} at ply {}: {e}",
                san,
                line.game.moves.len() + 1
            ))),
        }
    }
    fn begin_variation(&mut self, _: &mut Line) -> ControlFlow<Self::Output, Skip> {
        ControlFlow::Continue(Skip(true))
    }
    fn outcome(&mut self, line: &mut Line, outcome: Outcome) -> ControlFlow<Self::Output> {
        line.game.result = outcome.to_string();
        ControlFlow::Continue(())
    }
    fn end_game(&mut self, line: Line) -> Self::Output {
        if line.game.moves.is_empty() {
            Err("Game contains no legal moves".into())
        } else {
            Ok(line.game)
        }
    }
}
#[derive(Default)]
pub struct Parsed {
    pub games: Vec<Game>,
    pub rejected: Vec<String>,
}
pub fn identity(g: &Game) -> String {
    if !g.session_id.is_empty() {
        return training::key(&("session", &g.session_id));
    }
    training::key(&(&g.white, &g.black, &g.date, &g.result, &g.moves))
}
// Import matching is separate from persisted identities: normalizing metadata
// must not change the keys used by saved library order or review references.
pub fn duplicate_key(g: &Game) -> String {
    if !g.session_id.is_empty() {
        return identity(g);
    }
    let raw_date = g.date.trim();
    let date = chrono::NaiveDate::parse_from_str(raw_date, "%Y.%m.%d")
        .or_else(|_| chrono::NaiveDate::parse_from_str(raw_date, "%Y-%m-%d"))
        .map(|d| d.format("%Y.%m.%d").to_string())
        .unwrap_or_else(|_| raw_date.replace('-', "."));
    training::key(&(
        g.white.trim().to_ascii_lowercase(),
        g.black.trim().to_ascii_lowercase(),
        date,
        g.result.trim(),
        &g.moves,
    ))
}
pub fn parse(text: &str) -> Result<Parsed, String> {
    if text.len() > MAX_PGN_BYTES {
        return Err("Choose a PGN file up to 128 MB".into());
    }
    // Exported/imported tag values may contain up to 1000 Unicode characters.
    // The reader's default 255-byte line window cannot reliably read them back.
    let mut reader = Reader::build(Cursor::new(text.as_bytes()))
        .set_supported_tag_line_length(8192)
        .finish();
    let mut out = Parsed::default();
    let mut count = 0;
    while let Some(game) = reader
        .read_game(&mut Importer)
        .map_err(|e| format!("PGN parse error: {e}"))?
    {
        count += 1;
        if count > MAX_PGN_GAMES {
            return Err("Import at most 100,000 games per file".into());
        }
        match game {
            Ok(g) => out.games.push(g),
            Err(e) => out.rejected.push(format!("Game {count}: {e}")),
        }
    }
    Ok(out)
}
pub fn export(game: &Game) -> Result<String, String> {
    let mut tags = game.tags.clone();
    for (k, v) in [
        ("Event", game.event.as_str()),
        ("Date", game.date.as_str()),
        ("White", game.white.as_str()),
        ("Black", game.black.as_str()),
        ("Result", game.result.as_str()),
    ] {
        tags.insert(k.into(), v.into());
    }
    tags.entry("Site".into())
        .or_insert_with(|| "Chess Study".into());
    tags.entry("Round".into()).or_insert_with(|| "-".into());
    for (k, v) in [
        ("WhiteElo", game.white_elo),
        ("BlackElo", game.black_elo),
        ("ChessStudyRating", game.rating_sample),
        ("ChessStudyOpponentRating", game.opponent_rating),
    ] {
        if let Some(n) = v {
            tags.insert(k.into(), n.to_string());
        }
    }
    if let Some(at) = &game.played_at {
        tags.insert("ChessStudyPlayedAt".into(), at.clone());
    }
    if !game.session_id.is_empty() {
        tags.insert("ChessStudySession".into(), game.session_id.clone());
    }
    let mut output = String::new();
    let mut emit = |key: &str, value: &str| {
        if key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            output.push_str(&format!(
                "[{key} \"{}\"]\n",
                value
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace(['\r', '\n'], " ")
            ));
        }
    };
    for key in ["Event", "Site", "Date", "Round", "White", "Black", "Result"] {
        if let Some(value) = tags.get(key) {
            emit(key, value)
        }
    }
    for (key, value) in &tags {
        if !["Event", "Site", "Date", "Round", "White", "Black", "Result"].contains(&key.as_str()) {
            emit(key, value)
        }
    }
    output.push('\n');
    let mut pos = Chess::default();
    let mut line = String::new();
    for (i, u) in game.moves.iter().enumerate() {
        let m = u
            .parse::<UciMove>()
            .map_err(|e| e.to_string())?
            .to_move(&pos)
            .map_err(|e| e.to_string())?;
        let name = SanPlus::from_move_and_play_unchecked(&mut pos, m).to_string();
        let token = if i % 2 == 0 {
            format!("{}. {name}", i / 2 + 1)
        } else {
            name
        };
        if line.len() + token.len() > 78 {
            output.push_str(&line);
            output.push('\n');
            line.clear();
        }
        if !line.is_empty() {
            line.push(' ')
        }
        line.push_str(&token);
    }
    if !line.is_empty() {
        output.push_str(&line);
        output.push(' ')
    }
    output.push_str(&game.result);
    output.push_str("\n\n");
    Ok(output)
}
fn download(text: String, name: &str) -> Response {
    (
        [
            (
                header::CONTENT_TYPE,
                "application/x-chess-pgn; charset=utf-8",
            ),
            (
                header::CONTENT_DISPOSITION,
                &format!("attachment; filename=\"{name}\""),
            ),
        ],
        text,
    )
        .into_response()
}
pub async fn export_all(State(app): State<Shared>) -> Result<Response, ApiError> {
    let games = app.data.lock().unwrap().games.clone();
    let mut out = String::new();
    for g in games {
        out.push_str(&export(&g).map_err(unavailable)?)
    }
    Ok(download(out, "chess-study-games.pgn"))
}
pub async fn export_one(
    State(app): State<Shared>,
    Path(id): Path<usize>,
) -> Result<Response, ApiError> {
    let game = app
        .data
        .lock()
        .unwrap()
        .games
        .get(id)
        .cloned()
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Game not found"))?;
    Ok(download(
        export(&game).map_err(unavailable)?,
        &format!("chess-study-game-{}.pgn", id + 1),
    ))
}
#[derive(Deserialize)]
pub struct ImportRequest {
    pgn: String,
}
pub async fn import(
    State(app): State<Shared>,
    Json(req): Json<ImportRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.pgn.is_empty() || req.pgn.len() > MAX_PGN_BYTES {
        return Err(bad("Choose a PGN file up to 128 MB"));
    }
    let gate = app.history_write.clone().lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let _gate = gate;
        import_blocking(&app, &req.pgn).map(Json)
    })
    .await
    .map_err(unavailable)?
}
fn import_blocking(app: &Shared, pgn: &str) -> Result<Value, ApiError> {
    let parsed = parse(pgn).map_err(bad)?;
    if parsed.games.is_empty() {
        return Err(bad(parsed
            .rejected
            .first()
            .map_or("No playable games found", String::as_str)));
    }
    let (mut next, mut player) = {
        let d = app.data.lock().unwrap();
        (d.games.clone(), d.player.clone())
    };
    let mut known: HashSet<_> = next.iter().map(duplicate_key).collect();
    let mut added = vec![];
    let mut duplicates = 0;
    for mut game in parsed.games {
        if !known.insert(duplicate_key(&game)) {
            duplicates += 1;
            continue;
        }
        game.source = "upload".into();
        let index = next.len();
        next.push(game.clone());
        added.push((index, game));
    }
    if !added.is_empty() {
        crate::history::save_order(&next).map_err(unavailable)?;
        let stored: Vec<_> = next
            .iter()
            .filter(|g| g.source == "upload")
            .cloned()
            .collect();
        crate::history::write_json(std::path::Path::new("data/imports.json"), &stored)
            .map_err(unavailable)?;
    }
    if player.is_empty() {
        let mut counts = std::collections::HashMap::new();
        for g in &next {
            *counts.entry(g.white.clone()).or_insert(0usize) += 1;
            *counts.entry(g.black.clone()).or_insert(0usize) += 1;
        }
        player = counts
            .into_iter()
            .max_by_key(|(_, n)| *n)
            .map(|(p, _)| p)
            .unwrap_or_default();
    }
    let weighted = rating::weighted(&next, &player);
    {
        let mut d = app.data.lock().unwrap();
        d.games = next;
        d.player = player.clone();
    }
    {
        let mut l = app.learner.lock().unwrap();
        // First import into an empty library establishes ownership before its
        // reviews teach the model. A nonempty library keeps the configured owner.
        if !l.owner.eq_ignore_ascii_case(&player) {
            *l = crate::training::Learner::load_for_player(&player).map_err(unavailable)?;
        }
        l.practice_rating = weighted.rating;
        l.save().map_err(unavailable)?;
    }
    let indices: Vec<_> = added.iter().map(|(i, _)| *i).collect();
    crate::queue_reviews(app, added);
    Ok(
        json!({"imported":indices.len(),"duplicates":duplicates,"rejected":parsed.rejected,"indices":indices}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_imports_ignore_formatting_and_cosmetic_metadata() {
        let original = parse(
            "[White \"Tester\"]\n[Black \"Other\"]\n[Date \"2026.11.09\"]\n\n1. e4 e5 2. Nf3 Nc6 *",
        )
        .unwrap()
        .games
        .remove(0);
        let changed = parse("[Event \"Different export\"]\n[White \"tester\"]\n[Black \"OTHER\"]\n[Date \"2026-11-09\"]\n[WhiteElo \"1400\"]\n\n1. e4 {annotation} e5 (1... c5) 2. Nf3 Nc6 *").unwrap().games.remove(0);
        assert_eq!(duplicate_key(&original), duplicate_key(&changed));
        assert_eq!(
            duplicate_key(&original),
            duplicate_key(&parse(&export(&original).unwrap()).unwrap().games[0])
        );
        let mut separate = original.clone();
        separate.date = "2026.11.10".into();
        assert_ne!(duplicate_key(&original), duplicate_key(&separate));
        separate = original.clone();
        separate.moves.push("f1b5".into());
        assert_ne!(duplicate_key(&original), duplicate_key(&separate));
    }
    #[test]
    fn separate_practice_sessions_are_distinct_even_with_identical_moves() {
        let a = Game {
            session_id: "first".into(),
            ..Default::default()
        };
        let b = Game {
            session_id: "second".into(),
            ..a.clone()
        };
        assert_ne!(duplicate_key(&a), duplicate_key(&b));
        assert_eq!(duplicate_key(&a), duplicate_key(&a.clone()));
    }
    #[test]
    fn comments_nested_variations_and_headers_roundtrip() {
        let p="[Event \"Quoted \\\"title\\\"\"]\n[White \"Me\"]\n[Black \"Other\"]\n[WhiteElo \"1200\"]\n[Date \"2026.11.06\"]\n\n1. e4 {note} e5 (1... c5 (1... e6)) 2. Nf3 Nc6 *";
        let a = parse(p).unwrap();
        assert_eq!(a.games.len(), 1);
        assert_eq!(a.games[0].moves.len(), 4);
        let b = parse(&export(&a.games[0]).unwrap()).unwrap();
        assert_eq!(b.games[0].moves, a.games[0].moves);
        assert_eq!(b.games[0].event, "Quoted \"title\"");
        assert_eq!(b.games[0].white_elo, Some(1200));
    }
    #[test]
    fn illegal_mainline_is_rejected_whole() {
        let p = "[White \"Me\"]\n[Black \"Other\"]\n\n1. e4 e5 2. Ke3 *";
        let a = parse(p).unwrap();
        assert!(a.games.is_empty());
        assert_eq!(a.rejected.len(), 1);
    }
}
