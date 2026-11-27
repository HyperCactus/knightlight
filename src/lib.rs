mod assist;
mod engine;
mod exchange;
mod game_summary;
mod history;
mod library;
mod opponent;
mod perspective;
mod practice;
mod preferences;
mod puzzles;
mod rating;
mod review_pacing;
pub mod runtime;
mod speech;
mod strategy;
mod tactics;
mod training;
use axum::{
    extract::Request,
    extract::{Path, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Position};
use std::{
    collections::HashMap,
    str::FromStr,
    sync::{Arc, Mutex},
};
use tower_http::services::ServeDir;
use training::{Learner, Opening, Review, ReviewMove};
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Game {
    white: String,
    black: String,
    result: String,
    date: String,
    event: String,
    moves: Vec<String>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    opponent_rating: Option<i32>,
    #[serde(default)]
    white_elo: Option<i32>,
    #[serde(default)]
    black_elo: Option<i32>,
    #[serde(default)]
    rating_sample: Option<i32>,
    #[serde(default)]
    played_at: Option<String>,
    #[serde(default)]
    tags: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Serialize)]
struct Puzzle {
    fen: String,
    best: String,
    played: String,
    loss: i32,
    game: Option<usize>,
    ply: usize,
    theme: String,
    id: String,
    priority: f64,
    source: String,
    rating: Option<i32>,
    source_url: Option<String>,
    #[serde(skip_serializing)]
    solution: Vec<String>,
    #[serde(skip_serializing)]
    tags: Vec<String>,
    position_key: String,
    reason: String,
}
#[derive(Clone, Serialize)]
struct Data {
    player: String,
    games: Vec<Game>,
    puzzles: Vec<Puzzle>,
    progress: usize,
    total: usize,
    ready: bool,
    error: Option<String>,
}
struct App {
    preferences: Mutex<preferences::Store>,
    analysis: Mutex<()>,
    data: Mutex<Data>,
    reviews: Mutex<HashMap<usize, Review>>,
    perspectives: Mutex<HashMap<usize, Vec<perspective::Challenge>>>,
    learner: Mutex<Learner>,
    openings: Vec<Opening>,
    puzzle_bank: puzzles::Bank,
    speech: Mutex<Option<speech::Speech>>,
    compute: Arc<tokio::sync::Semaphore>,
    practice: Mutex<practice::Practice>,
    opponent: Mutex<Option<opponent::Opponent>>,
    opponent_status: std::sync::atomic::AtomicU8,
    review_jobs: Mutex<std::collections::HashSet<String>>,
    history_write: Arc<tokio::sync::Mutex<()>>,
}
type Shared = Arc<App>;
type ApiError = (StatusCode, Json<serde_json::Value>);
fn error(status: StatusCode, message: impl ToString) -> ApiError {
    (
        status,
        Json(serde_json::json!({"error":{"message":message.to_string()}})),
    )
}
fn bad(e: impl ToString) -> ApiError {
    error(StatusCode::BAD_REQUEST, e)
}
fn unavailable(e: impl ToString) -> ApiError {
    error(StatusCode::SERVICE_UNAVAILABLE, e)
}
pub fn fen(pos: &Chess) -> String {
    Fen::from_position(pos, EnPassantMode::Legal).to_string()
}
pub fn position(s: &str) -> Result<Chess, String> {
    if s.len() > 200 {
        return Err("Invalid position".into());
    }
    Fen::from_str(s)
        .map_err(|e| e.to_string())?
        .into_position(CastlingMode::Standard)
        .map_err(|e| e.to_string())
}
fn load_games() -> Result<Vec<Game>, String> {
    let mut games = vec![];
    let mut files: Vec<_> = std::fs::read_dir(".")
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("pgn")))
        .collect();
    files.sort();
    for path in files {
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len()
            > library::MAX_PGN_BYTES as u64
        {
            return Err(format!(
                "{} exceeds the 128 MB PGN file limit",
                path.display()
            ));
        }
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let parsed = library::parse(&text)?;
        for message in parsed.rejected {
            eprintln!("PGN import: {message}")
        }
        games.extend(parsed.games);
    }
    games.extend(history::load()?);
    let mut known = HashMap::new();
    let mut merged: Vec<Game> = Vec::new();
    for game in games {
        let identity = library::duplicate_key(&game);
        if let Some(&index) = known.get(&identity) {
            // Individual session records override their older legacy archive.
            merged[index] = game;
        } else {
            known.insert(identity, merged.len());
            merged.push(game);
        }
    }
    history::restore_order(&mut merged)?;
    Ok(merged)
}
fn queue_reviews(app: &Shared, games: Vec<(usize, Game)>) {
    let mut work = vec![];
    {
        let mut jobs = app.review_jobs.lock().unwrap();
        for (index, game) in games {
            let key = training::key(&(index, &game.moves, &game.white, &game.black));
            if jobs.insert(key.clone()) {
                work.push((index, game, key));
            }
        }
    }
    if work.is_empty() {
        return;
    }
    {
        let mut d = app.data.lock().unwrap();
        d.total += work.len();
        d.ready = false;
        d.error = None;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for (index, game, key) in work {
            if let Err(e) = process_review(&app, index, &game) {
                app.data.lock().unwrap().error = Some(e);
            }
            app.review_jobs.lock().unwrap().remove(&key);
            let mut d = app.data.lock().unwrap();
            d.progress += 1;
            d.ready = d.progress >= d.total;
        }
    });
}
fn process_review(app: &Shared, index: usize, game: &Game) -> Result<(), String> {
    let _analysis = app.analysis.lock().unwrap();
    let player = app.data.lock().unwrap().player.clone();
    let r = training::review(game, &player)?;
    // Publish a review only against the same committed game revision. The
    // expensive engine work remains outside the persistence transaction.
    let _history = app.history_write.blocking_lock();
    if app
        .data
        .lock()
        .unwrap()
        .games
        .get(index)
        .is_none_or(|current| current.moves != game.moves)
    {
        return Ok(());
    }
    let mut learner = app.learner.lock().unwrap();
    for m in r.moves.iter().filter(|m| m.player) {
        learner.observe(training::key(&(&m.before, &m.uci)), m);
    }
    learner.save()?;
    let puzzles = r
        .moves
        .iter()
        .filter(|m| {
            m.player
                && m.loss >= 150
                && m.best != m.uci
                && m.eval_before
                    * if m.before.split_whitespace().nth(1) == Some("w") {
                        1
                    } else {
                        -1
                    }
                    >= -120
                && !m.best_line.is_empty()
        })
        .map(|m| {
            let id = training::key(&(&m.before, &m.best));
            let risk = position(&m.before)
                .map(|p| {
                    learner.predict(training::features(
                        &p,
                        m.eval_before * if p.turn() == Color::White { 1 } else { -1 },
                    ))
                })
                .unwrap_or(0.5);
            let attempts = learner.attempts.get(&id).cloned().unwrap_or_default();
            let priority =
                risk * 3.0 + (m.loss.min(500) as f64) / 500.0 + attempts.missed as f64 * 0.4
                    - attempts.solved as f64 * 0.8;
            Puzzle {
                fen: m.before.clone(),
                best: m.best.clone(),
                played: m.uci.clone(),
                loss: m.loss,
                game: Some(index),
                ply: m.ply,
                theme: m.theme.clone(),
                id,
                priority,
                source: "personal".into(),
                rating: None,
                source_url: None,
                solution: vec![],
                tags: vec![],
                position_key: puzzles::position_key(&m.before),
                reason: "A missed opportunity from your game".into(),
            }
        })
        .collect::<Vec<_>>();
    drop(learner);
    app.perspectives.lock().unwrap().remove(&index);
    app.reviews.lock().unwrap().insert(index, r);
    let mut d = app.data.lock().unwrap();
    d.puzzles.retain(|p| p.game != Some(index));
    d.puzzles.extend(puzzles);
    d.puzzles.sort_by(|a, b| b.priority.total_cmp(&a.priority));
    Ok(())
}
#[derive(Deserialize)]
struct FenRequest {
    fen: String,
}
#[derive(Deserialize)]
struct MoveRequest {
    fen: String,
    from: String,
    to: String,
    promotion: Option<String>,
    #[serde(default)]
    history: Vec<String>,
}
#[derive(Serialize)]
struct BoardResponse {
    fen: String,
    legal: Vec<String>,
    turn: String,
    outcome: Option<String>,
    check: bool,
    threats: assist::ThreatMap,
}
fn board(p: &Chess) -> BoardResponse {
    let legal = p
        .legal_moves()
        .iter()
        .map(|m| UciMove::from_standard(*m).to_string())
        .collect();
    let outcome = if p.is_checkmate() {
        Some(format!(
            "{} wins by checkmate",
            if p.turn() == Color::White {
                "Black"
            } else {
                "White"
            }
        ))
    } else if p.is_stalemate() {
        Some("Draw by stalemate".into())
    } else if p.is_insufficient_material() {
        Some("Draw by insufficient material".into())
    } else if p.halfmoves() >= 100 {
        Some("Draw by the fifty-move rule".into())
    } else {
        None
    };
    BoardResponse {
        fen: fen(p),
        legal,
        turn: if p.turn() == Color::White {
            "white"
        } else {
            "black"
        }
        .into(),
        outcome,
        check: p.is_check(),
        threats: assist::threats(p),
    }
}
async fn state(State(app): State<Shared>) -> Json<Data> {
    Json(app.data.lock().unwrap().clone())
}
async fn get_board(Json(req): Json<FenRequest>) -> Result<Json<BoardResponse>, ApiError> {
    Ok(Json(board(&position(&req.fen).map_err(bad)?)))
}
async fn make_move(Json(req): Json<MoveRequest>) -> Result<Json<BoardResponse>, ApiError> {
    let mut p = position(&req.fen).map_err(bad)?;
    let mut positions = vec![fen(&Chess::default())
        .split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")];
    if !req.history.is_empty() {
        if req.history.len() > 600 {
            return Err(bad("Too many moves"));
        }
        let mut previous = Chess::default();
        for u in &req.history {
            training::play(&mut previous, u).map_err(bad)?;
            positions.push(
                fen(&previous)
                    .split_whitespace()
                    .take(4)
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        if fen(&previous) != fen(&p) {
            return Err(bad("History does not match the board"));
        }
    }
    training::play(
        &mut p,
        &format!(
            "{}{}{}",
            req.from,
            req.to,
            req.promotion.unwrap_or_default()
        ),
    )
    .map_err(bad)?;
    let mut result = board(&p);
    if !req.history.is_empty() {
        let key = fen(&p)
            .split_whitespace()
            .take(4)
            .collect::<Vec<_>>()
            .join(" ");
        if positions.iter().filter(|k| **k == key).count() >= 2 {
            result.outcome = Some("Draw by threefold repetition".into());
        }
    }
    Ok(Json(result))
}
async fn profile(State(app): State<Shared>) -> Json<serde_json::Value> {
    let mut themes: std::collections::BTreeMap<String, training::ThemeStats> =
        std::collections::BTreeMap::new();
    for r in app.reviews.lock().unwrap().values() {
        for m in r.moves.iter().filter(|m| m.player) {
            let t = themes.entry(m.theme.clone()).or_default();
            t.count += 1;
            t.errors += (m.loss >= 100) as u32;
            t.loss += m.loss.min(600) as f64;
        }
    }
    let (weighted, adaptive_rating) = {
        let d = app.data.lock().unwrap();
        let weighted = rating::weighted(&d.games, &d.player);
        let adaptive_rating = rating::adaptive(&d.games, &d.player, weighted.rating);
        (weighted, adaptive_rating)
    };
    let l = app.learner.lock().unwrap();
    Json(
        serde_json::json!({"samples":l.samples,"average_loss":l.average_loss,"adaptive_level":rating::to_level(adaptive_rating),"practice_rating":weighted.rating,"adaptive_rating":adaptive_rating,"rated_games":l.rated_games,"rating_history":weighted.history,"initial_rating":weighted.history.first().map_or(1000,|p|p.rating),"rating_origin":"Date-weighted game history","rating_samples":weighted.samples,"rating_half_life_days":rating::HALF_LIFE_DAYS,"themes":themes,"opening_count":app.openings.len(),"voice_available":runtime::resource("vendor/voices/en/en_US/lessac/medium/en_US-lessac-medium.onnx").exists(),"human_opponent":opponent::available(),"model":"Personal error prediction · online learning","voice":if runtime::resource("vendor/kokoro/onnx/model_quantized.onnx").exists(){"Kokoro · local neural voices"}else{"Piper · Lessac · local neural voice"},"voices":["af_heart","am_michael","bf_emma","piper"]}),
    )
}
async fn review(
    State(app): State<Shared>,
    Path(id): Path<usize>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    if id >= app.data.lock().unwrap().games.len() {
        return Err(error(StatusCode::NOT_FOUND, "Game not found"));
    }
    let (game, player) = {
        let d = app.data.lock().unwrap();
        (d.games[id].clone(), d.player.clone())
    };
    if let Some(r) = app.reviews.lock().unwrap().get(&id) {
        let mut response = serde_json::to_value(r).unwrap();
        response["summary"] =
            serde_json::to_value(game_summary::summarize(&game, r, &player)).unwrap();
        return Ok((StatusCode::OK, Json(response)));
    }
    queue_reviews(&app, vec![(id, game)]);
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"status":"analyzing"})),
    ))
}
#[derive(Deserialize)]
struct CoachRequest {
    fen: String,
    uci: Option<String>,
    #[serde(default)]
    learn: bool,
}
async fn coach(
    State(app): State<Shared>,
    Json(req): Json<CoachRequest>,
) -> Result<Json<ReviewMove>, ApiError> {
    let pos = position(&req.fen).map_err(bad)?;
    if pos.is_game_over() {
        return Err(bad("The game is over"));
    }
    if let Some(u) = &req.uci {
        training::play(&mut pos.clone(), u).map_err(bad)?;
    }
    let permit = app
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(unavailable)?;
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut e = engine::Engine::new()?;
        let a = training::eval(&mut e, &pos, 11)?;
        let u = req.uci.unwrap_or_else(|| a.pv[0].clone());
        let mut after = pos.clone();
        training::play(&mut after, &u)?;
        let b = training::eval(&mut e, &after, 11)?;
        let r = training::describe(
            &pos,
            &u,
            &a,
            &b,
            ((pos.fullmoves().get() - 1) * 2) as usize,
            true,
        );
        if req.learn {
            let mut l = app.learner.lock().unwrap();
            l.observe(training::key(&(&r.before, &r.uci)), &r);
            l.save()?;
        }
        Ok::<_, String>(r)
    })
    .await
    .map_err(unavailable)?
    .map_err(unavailable)?;
    Ok(Json(result))
}
#[derive(Deserialize)]
struct BotRequest {
    fen: String,
    skill: Option<u8>,
    rating: Option<i32>,
    style: Option<String>,
    session_id: Option<String>,
    #[serde(default)]
    moves: Vec<String>,
}
async fn bot(
    State(app): State<Shared>,
    Json(req): Json<BotRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let pos = position(&req.fen).map_err(bad)?;
    if pos.is_game_over() {
        return Err(bad("The game is over"));
    }
    if req.moves.len() > 600
        || req.moves.iter().any(|u| u.len() > 5)
        || req.session_id.as_ref().is_some_and(|s| s.len() > 100)
    {
        return Err(bad("Invalid game history"));
    }
    if req.skill.is_some_and(|s| s > 20) || req.rating.is_some_and(|r| !(400..=2400).contains(&r)) {
        return Err(bad("Rating must be between 400 and 2400"));
    }
    let (player_rating, adaptive_target) = {
        let d = app.data.lock().unwrap();
        let rating = rating::weighted(&d.games, &d.player).rating;
        (rating, rating::adaptive(&d.games, &d.player, rating))
    };
    if !req.moves.is_empty() {
        let mut history = Chess::default();
        for u in &req.moves {
            training::play(&mut history, u).map_err(bad)?;
        }
        if fen(&history) != fen(&pos) {
            return Err(bad("History does not match the board"));
        }
    }
    let target = req
        .rating
        .unwrap_or_else(|| req.skill.map(rating::from_level).unwrap_or(adaptive_target));
    let skill = req.skill.unwrap_or_else(|| rating::to_level(target));
    let requested = req.style.unwrap_or_else(|| "varied".into());
    if !["varied", "balanced", "attacking", "positional"].contains(&requested.as_str()) {
        return Err(bad("Unknown play style"));
    }
    let style = if requested == "varied" {
        let n = req
            .session_id
            .as_ref()
            .map(|id| u64::from_str_radix(&training::key(id), 16).unwrap_or(0) as usize % 3)
            .unwrap_or_else(|| rand::rng().random_range(0..3));
        ["balanced", "attacking", "positional"][n].to_string()
    } else {
        requested
    };
    let loading = app
        .opponent_status
        .load(std::sync::atomic::Ordering::Acquire)
        != 2;
    if loading {
        if let Some(candidates) = opponent::opening_policy(&pos, target) {
            let (chosen, count) =
                opponent::sample(&pos, candidates, &style).map_err(unavailable)?;
            return Ok(Json(serde_json::json!({
                "move":chosen,"level":skill,"rating":target,"style":style,
                "book":true,"cached":true,"candidates":count,
                "source":"Maia-3 · cached opening policy","inference_ms":0
            })));
        }
    }
    let book: Vec<String> = if req.moves.len() < 14 {
        app.openings
            .iter()
            .filter(|o| o.moves.starts_with(&req.moves) && o.moves.len() > req.moves.len())
            .map(|o| o.moves[req.moves.len()].clone())
            .collect()
    } else {
        vec![]
    };
    let permit = app
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(unavailable)?;
    let result=tokio::task::spawn_blocking(move|| -> Result<serde_json::Value, String> {
        let _permit=permit;
        let mut source="Stockfish · varied policy"; let mut inference_ms=0;
        let mut weighted=vec![];
        if opponent::available() && app.opponent_status.load(std::sync::atomic::Ordering::Acquire) == 2 {
            let mut guard=app.opponent.lock().unwrap();
            let policy = (|| {
                if guard.is_none(){*guard=Some(opponent::Opponent::new()?)}
                guard.as_mut().unwrap().policy(&fen(&pos),&req.moves,target,player_rating)
            })();
            match policy {
                Ok(policy)=>{source="Maia-3 · human move model";inference_ms=policy.inference_ms;for c in policy.candidates {if c.probability.is_finite()&&c.probability>0.0{weighted.push((c.uci,c.probability));}}},
                Err(e)=>{eprintln!("Human opponent unavailable: {e}");*guard=None;app.opponent_status.store(3, std::sync::atomic::Ordering::Release);}
            }
        }
        if weighted.is_empty(){
            let mut e=engine::Engine::new()?;let candidates=e.evaluate(&fen(&pos),9,12)?;let top=candidates[0].score;
            let temp=15.0+(20-skill)as f64*8.0;let max_loss=25+(20-skill)as i32*24;
            for c in candidates{if let Some(u)=c.pv.first(){let loss=(top-c.score).max(0);if loss<=max_loss{weighted.push((u.clone(),(-(loss as f64)/temp).exp()));}}}
        }
        let (chosen, candidate_count) = opponent::sample(&pos, weighted, &style)?;
        Ok(serde_json::json!({"move":chosen,"level":skill,"rating":target,"style":style,"book":book.contains(&chosen),"candidates":candidate_count,"cached":false,"source":source,"inference_ms":inference_ms}))
    }).await.map_err(unavailable)?.map_err(unavailable)?;
    Ok(Json(result))
}
#[derive(Deserialize)]
struct OpeningRequest {
    #[serde(default)]
    moves: Vec<String>,
}
async fn opening(
    State(app): State<Shared>,
    Json(req): Json<OpeningRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.moves.len() > 600 {
        return Err(bad("Too many moves"));
    }
    let matched = app
        .openings
        .iter()
        .filter(|o| req.moves.starts_with(&o.moves))
        .max_by_key(|o| o.moves.len());
    let mut next: HashMap<String, usize> = HashMap::new();
    for o in &app.openings {
        if o.moves.starts_with(&req.moves) && o.moves.len() > req.moves.len() {
            *next.entry(o.moves[req.moves.len()].clone()).or_default() += 1
        }
    }
    let mut next: Vec<_> = next.into_iter().collect();
    next.sort_by_key(|a| std::cmp::Reverse(a.1));
    next.truncate(6);
    Ok(Json(
        serde_json::json!({"opening":matched,"continuations":next,"source":"Lichess open opening database (CC0)","entries":app.openings.len(),"note":"Continuation counts are named variations, not game frequencies."}),
    ))
}
#[derive(Deserialize)]
struct SpeechRequest {
    text: String,
    #[serde(default = "default_voice")]
    voice: String,
    #[serde(default)]
    prefetch: bool,
}
fn default_voice() -> String {
    "af_heart".into()
}
async fn speak(
    State(app): State<Shared>,
    Json(req): Json<SpeechRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.text.trim().is_empty() || req.text.len() > 1800 {
        return Err(bad("Speech text must contain 1–1800 bytes"));
    }
    if !["af_heart", "am_michael", "bf_emma", "piper"].contains(&req.voice.as_str()) {
        return Err(bad("Choose one of the installed coach voices"));
    }
    let text = speech::normalize(&req.text);
    if let Some(cached) = speech::cached(&text, &req.voice) {
        return Ok(Json(cached));
    }
    let out = tokio::task::spawn_blocking(move || {
        let mut guard = if req.prefetch {
            app.speech
                .try_lock()
                .map_err(|_| "Voice is still speaking. Try again in a moment.".to_string())?
        } else {
            app.speech
                .lock()
                .map_err(|_| "Local voice unavailable".to_string())?
        };
        if let Some(cached) = speech::cached(&text, &req.voice) {
            return Ok(cached);
        }
        if guard.is_none() {
            *guard = Some(speech::Speech::new()?)
        }
        let result = guard.as_mut().unwrap().speak(&text, &req.voice);
        if result.is_err() {
            *guard = None;
        }
        result
    })
    .await
    .map_err(unavailable)?
    .map_err(unavailable)?;
    Ok(Json(out))
}
#[derive(Deserialize)]
struct AttemptRequest {
    id: String,
    solved: bool,
}
async fn attempt(
    State(app): State<Shared>,
    Json(req): Json<AttemptRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !app
        .data
        .lock()
        .unwrap()
        .puzzles
        .iter()
        .any(|p| p.id == req.id)
    {
        return Err(bad("Unknown puzzle"));
    }
    let mut l = app.learner.lock().unwrap();
    let a = l.attempts.entry(req.id.clone()).or_default();
    if req.solved {
        a.solved += 1
    } else {
        a.missed += 1
    }
    l.save().map_err(unavailable)?;
    drop(l);
    let mut data = app.data.lock().unwrap();
    for puzzle in data.puzzles.iter_mut().filter(|p| p.id == req.id) {
        puzzle.priority += if req.solved { -0.8 } else { 0.4 };
    }
    data.puzzles
        .sort_by(|a, b| b.priority.total_cmp(&a.priority));
    Ok(Json(serde_json::json!({"saved":true})))
}
#[derive(Deserialize)]
struct SaveGameRequest {
    #[serde(flatten)]
    game: Game,
    #[serde(default = "analyze_default")]
    analyze: bool,
}
fn analyze_default() -> bool {
    true
}
fn saved_game_response(app: &Shared, index: usize, game: &Game, rating: i32) -> serde_json::Value {
    let d = app.data.lock().unwrap();
    let adaptive_rating = rating::adaptive(&d.games, &d.player, rating);
    serde_json::json!({"index":index,"saved":true,"game":game,"practice_rating":rating,"adaptive_rating":adaptive_rating,
        "ready":d.ready,"progress":d.progress,"total":d.total})
}
async fn save_game(
    State(app): State<Shared>,
    Json(req): Json<SaveGameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    // The owned gate remains inside the blocking job if the HTTP client disconnects.
    let gate = app.history_write.clone().lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let _gate = gate;
        save_game_blocking(&app, req).map(Json)
    })
    .await
    .map_err(unavailable)?
}
fn save_game_blocking(app: &Shared, req: SaveGameRequest) -> Result<serde_json::Value, ApiError> {
    let mut game = req.game;
    if game.moves.is_empty()
        || game.moves.len() > 600
        || game.session_id.is_empty()
        || game.session_id.len() > 100
    {
        return Err(bad("Invalid practice game"));
    }
    let mut p = Chess::default();
    for u in &game.moves {
        training::play(&mut p, u).map_err(bad)?;
    }
    if !["*", "1-0", "0-1", "1/2-1/2"].contains(&game.result.as_str()) {
        return Err(bad("Invalid result"));
    }
    if game
        .opponent_rating
        .is_some_and(|r| !(400..=2400).contains(&r))
    {
        return Err(bad("Invalid opponent rating"));
    }
    game.source = "practice".into();
    game.black = game.black.chars().take(60).collect();
    game.event = "Practice game".into();
    game.date = game.date.chars().take(20).collect();
    if game
        .played_at
        .as_ref()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_err())
    {
        return Err(bad("Invalid play date"));
    }
    let (player, index, previous) = {
        let d = app.data.lock().unwrap();
        let existing = d.games.iter().position(|g| g.session_id == game.session_id);
        (
            d.player.clone(),
            existing.unwrap_or(d.games.len()),
            existing.map(|i| d.games[i].clone()),
        )
    };
    game.white = player.clone();
    let base = app.learner.lock().unwrap().practice_rating;
    if let Some(previous) = &previous {
        if !req.analyze
            && previous.moves.len() > game.moves.len()
            && previous.moves.starts_with(&game.moves)
        {
            return Ok(saved_game_response(app, index, previous, base));
        }
        if previous.rating_sample.is_some() && previous.result != game.result {
            return Err(error(StatusCode::CONFLICT,"This completed game is already in history. Start a new practice session to explore another result."));
        }
        game.rating_sample = previous.rating_sample;
        game.played_at = previous.played_at.clone().or(game.played_at);
        game.white_elo = previous.white_elo;
        game.tags = previous.tags.clone();
    } else {
        game.rating_sample = None;
        game.white_elo = Some(base);
    }
    if game.played_at.is_none() {
        game.played_at = Some(chrono::Utc::now().to_rfc3339());
    }
    if let Some(r) = game.opponent_rating {
        game.black_elo = Some(r);
        if game.result != "*" && game.rating_sample.is_none() {
            let count = app.learner.lock().unwrap().rated_games;
            game.rating_sample = Some(rating::update(
                base,
                r,
                rating::result(&game, &player).unwrap(),
                count,
            ));
        }
    }
    // Only this session is written. Archives imported by previous versions are
    // left byte-for-byte intact; startup overlays these newer records by ID.
    if previous.is_none() {
        let mut ordered = app.data.lock().unwrap().games.clone();
        ordered.push(game.clone());
        history::save_order(&ordered).map_err(unavailable)?;
    }
    history::save_session(index, &game).map_err(unavailable)?;
    let changed = previous.as_ref().is_none_or(|old| old.moves != game.moves);
    let weighted_rating = {
        let mut d = app.data.lock().unwrap();
        if index < d.games.len() {
            d.games[index] = game.clone();
        } else {
            d.games.push(game.clone());
        }
        if game.result == "*" {
            base
        } else {
            rating::weighted(&d.games, &d.player).rating
        }
    };
    if game.result != "*" {
        let mut l = app.learner.lock().unwrap();
        l.outcome(&game.session_id, &game.result);
        if let Some(r) = game.opponent_rating {
            l.rated_outcome(&game.session_id, &game.result, r);
        }
        l.practice_rating = weighted_rating;
        l.save().map_err(unavailable)?;
    }
    if changed {
        app.reviews.lock().unwrap().remove(&index);
        app.perspectives.lock().unwrap().remove(&index);
    }
    if (req.analyze || game.result != "*") && !app.reviews.lock().unwrap().contains_key(&index) {
        queue_reviews(app, vec![(index, game.clone())]);
    }
    Ok(saved_game_response(app, index, &game, weighted_rating))
}
async fn local_only(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let name = host.split(':').next().unwrap_or("");
    if !["127.0.0.1", "localhost"].contains(&name) {
        return error(
            StatusCode::FORBIDDEN,
            "This app is available on localhost only",
        )
        .into_response();
    }
    if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok()) {
        if origin != format!("http://{host}") {
            return error(
                StatusCode::FORBIDDEN,
                "Cross-origin requests are not allowed",
            )
            .into_response();
        }
    }
    next.run(req).await
}
pub async fn serve(listener: tokio::net::TcpListener) -> std::io::Result<()> {
    std::fs::create_dir_all("data").unwrap();
    let games = load_games().expect("Could not read PGN files");
    let mut names = HashMap::new();
    for g in &games {
        *names.entry(g.white.clone()).or_insert(0usize) += 1;
        *names.entry(g.black.clone()).or_insert(0usize) += 1;
    }
    let player = std::env::var("CHESS_PLAYER").unwrap_or_else(|_| {
        names
            .into_iter()
            .max_by_key(|x| x.1)
            .map(|x| x.0)
            .unwrap_or_default()
    });
    let mut learner =
        Learner::load_for_player(&player).expect("Could not read player learning history");
    let weighted = rating::weighted(&games, &player);
    learner.practice_rating = weighted.rating;
    learner.rating_seeded = true;
    learner.initial_rating = weighted.history.first().map_or(1000, |p| p.rating);
    learner.rating_origin = "Date-weighted game history".into();
    let puzzle_bank = puzzles::Bank::bootstrap();
    let bootstrap = puzzle_bank.snapshot().iter().take(24).cloned().collect();
    let app = Arc::new(App {
        preferences: Mutex::new(
            preferences::Store::load(std::path::Path::new("data/preferences.json"))
                .expect("Could not read saved preferences"),
        ),
        analysis: Mutex::new(()),
        data: Mutex::new(Data {
            player,
            games: games.clone(),
            puzzles: bootstrap,
            progress: 0,
            total: 0,
            ready: true,
            error: None,
        }),
        reviews: Mutex::new(HashMap::new()),
        perspectives: Mutex::new(HashMap::new()),
        learner: Mutex::new(learner),
        openings: training::openings(),
        puzzle_bank,
        speech: Mutex::new(None),
        compute: Arc::new(tokio::sync::Semaphore::new(2)),
        practice: Mutex::new(practice::Practice::load().expect("Could not read training progress")),
        opponent: Mutex::new(None),
        opponent_status: std::sync::atomic::AtomicU8::new(0),
        review_jobs: Mutex::new(std::collections::HashSet::new()),
        history_write: Arc::new(tokio::sync::Mutex::new(())),
    });
    let bank_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        match puzzles::load_bank() {
            Ok(bank) => {
                let count = bank.len();
                bank_app.puzzle_bank.publish(bank);
                eprintln!(
                    "Offline puzzle collection ready: {count} positions in {} ms",
                    started.elapsed().as_millis()
                );
            }
            Err(error) => eprintln!(
                "Full puzzle collection unavailable; starter collection remains playable: {error}"
            ),
        }
        // Stop UI loading polls even if only the embedded starter pack is available.
        bank_app.puzzle_bank.finish_loading();
    });
    speech::warm(&app);
    opponent::warm(&app);
    queue_reviews(&app, games.into_iter().enumerate().collect());
    let router = Router::new()
        .route(
            "/api/health",
            get(|| async {
                Json(serde_json::json!({
                    "app": "knightlight",
                    "version": env!("CARGO_PKG_VERSION"),
                    "workspace": std::env::current_dir().ok().and_then(|p| p.canonicalize().ok())
                }))
            }),
        )
        .route("/api/data", get(state))
        .route(
            "/api/preferences",
            get(preferences::get)
                .put(preferences::put)
                .post(preferences::put),
        )
        .route("/api/preferences/bootstrap.js", get(preferences::bootstrap))
        .route("/api/board", post(get_board))
        .route("/api/move", post(make_move))
        .route("/api/bot", post(bot))
        .route("/api/profile", get(profile))
        .route("/api/reviews/{id}", get(review))
        .route("/api/reviews/{id}/perspectives", get(perspective::prepare))
        .route(
            "/api/reviews/{id}/perspectives/{ply}/moves",
            post(perspective::answer),
        )
        .route("/api/coach", post(coach))
        .route("/api/opening", post(opening))
        .route("/api/speech", post(speak))
        .route("/api/attempts", post(attempt))
        .route("/api/practice", get(practice::summary))
        .route("/api/drills", post(practice::start))
        .route("/api/drills/{id}/moves", post(practice::play))
        .route("/api/drills/{id}/help", post(practice::help))
        .route("/api/drills/{id}/reflection", post(practice::reflect))
        .route("/api/games", post(save_game))
        .route(
            "/api/imports",
            post(library::import).layer(axum::extract::DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/games/pgn", get(library::export_all))
        .route("/api/games/{id}/pgn", get(library::export_one))
        .nest_service("/audio", ServeDir::new("data/audio"))
        .fallback_service(
            ServeDir::new(runtime::resource("static")).append_index_html_on_directories(true),
        )
        .layer(middleware::from_fn(local_only))
        .with_state(app);
    println!("Knightlight: http://{}", listener.local_addr()?);
    axum::serve(listener, router).await
}
