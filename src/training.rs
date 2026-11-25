use crate::engine::{Engine, Evaluation};
use crate::{fen, position, Game};
use serde::{Deserialize, Serialize};
use shakmaty::{
    san::{San, SanPlus},
    uci::UciMove,
    Chess, Color, Move, Position, Role,
};
use std::{
    collections::{BTreeMap, HashSet},
    hash::{Hash, Hasher},
    str::FromStr,
};
pub fn hash_u64<T: Hash>(x: &T) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    x.hash(&mut h);
    h.finish()
}
pub fn key<T: Hash>(x: &T) -> String {
    format!("{:016x}", hash_u64(x))
}
pub fn play(p: &mut Chess, u: &str) -> Result<Move, String> {
    let m = UciMove::from_str(u)
        .map_err(|e| e.to_string())?
        .to_move(p)
        .map_err(|e| e.to_string())?;
    p.play_unchecked(m);
    Ok(m)
}
pub fn san(p: &Chess, u: &str) -> String {
    UciMove::from_str(u)
        .ok()
        .and_then(|u| u.to_move(p).ok())
        .map(|m| San::from_move(p, m).to_string())
        .unwrap_or_else(|| u.into())
}
#[derive(Clone, Serialize, Deserialize)]
pub struct LineMove {
    pub uci: String,
    pub san: String,
    pub fen: String,
}
pub fn line(pos: &Chess, moves: &[String]) -> Vec<LineMove> {
    line_up_to(pos, moves, 6)
}
pub fn line_up_to(pos: &Chess, moves: &[String], limit: usize) -> Vec<LineMove> {
    let mut p = pos.clone();
    let mut out = vec![];
    for u in moves.iter().take(limit.min(10)) {
        let name = san(&p, u);
        if play(&mut p, u).is_err() {
            break;
        }
        out.push(LineMove {
            uci: u.clone(),
            san: name,
            fen: fen(&p),
        });
    }
    out
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ReviewMove {
    pub ply: usize,
    pub before: String,
    pub after: String,
    pub uci: String,
    pub san: String,
    pub best: String,
    pub best_san: String,
    pub best_line: Vec<LineMove>,
    pub reply_line: Vec<LineMove>,
    pub eval_before: i32,
    pub eval_after: i32,
    pub loss: i32,
    pub grade: String,
    pub explanation: String,
    pub theme: String,
    pub player: bool,
    pub mate: Option<i32>,
    #[serde(default)]
    pub best_mate: Option<i32>,
    #[serde(default)]
    pub evidence: Vec<crate::tactics::Evidence>,
    #[serde(default)]
    pub review_pace: crate::review_pacing::Pace,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Review {
    pub moves: Vec<ReviewMove>,
    pub accuracy: f64,
    pub blunders: usize,
    pub mistakes: usize,
    pub depth: u8,
    #[serde(default)]
    pub analysis_version: u8,
}
pub fn eval(engine: &mut Engine, p: &Chess, depth: u8) -> Result<Evaluation, String> {
    if p.is_game_over() {
        return Ok(Evaluation {
            score: if p.is_checkmate() { -10000 } else { 0 },
            mate: if p.is_checkmate() { Some(0) } else { None },
            pv: vec![],
        });
    }
    let mut result = engine.evaluate(&fen(p), depth, 1)?.remove(0);
    if depth < 14
        && result
            .pv
            .first()
            .is_some_and(|u| crate::exchange::needs_verification(p, u))
    {
        result = engine.evaluate(&fen(p), 14, 1)?.remove(0);
    }
    Ok(result)
}
pub fn grade(loss: i32, same: bool) -> &'static str {
    if same || loss <= 10 {
        "best"
    } else if loss <= 35 {
        "excellent"
    } else if loss <= 80 {
        "good"
    } else if loss <= 150 {
        "inaccuracy"
    } else if loss <= 300 {
        "mistake"
    } else {
        "blunder"
    }
}
pub fn describe(
    before: &Chess,
    uci: &str,
    a: &Evaluation,
    b: &Evaluation,
    ply: usize,
    player: bool,
) -> ReviewMove {
    let mut after = before.clone();
    let played = play(&mut after, uci).expect("validated move");
    let best = a.pv.first().cloned().unwrap_or_else(|| uci.into());
    let loss = if best == uci {
        0
    } else {
        (a.score + b.score).max(0)
    };
    let grade = grade(loss, best == uci).to_string();
    let played_san = SanPlus::from_move(before.clone(), played).to_string();
    let best_san = san(before, &best);
    let best_line = line_up_to(
        before,
        &a.pv,
        if a.mate.is_some_and(|n| n > 0) { 10 } else { 6 },
    );
    let reply_line = line_up_to(
        &after,
        &b.pv,
        if b.mate.is_some_and(|n| n > 0) { 10 } else { 6 },
    );
    let best_move = UciMove::from_str(&best)
        .ok()
        .and_then(|u| u.to_move(before).ok());
    let mut theme = if before.board().occupied().count() <= 12 {
        "Endgame technique"
    } else if ply < 20 {
        "Opening decisions"
    } else {
        "Piece activity"
    }
    .to_string();
    if after.is_checkmate() {
        theme = "Checkmate patterns".into();
    } else if (b.mate.is_some_and(|n| n > 0) && loss > 80)
        || best_move.is_some_and(|m| m.is_castle())
    {
        theme = "King safety".into();
    } else if best_move.is_some_and(|m| m.capture().is_some()) {
        theme = "Material & captures".into();
    } else if best_move.is_some_and(|m| m.is_promotion()) {
        theme = "Endgame technique".into();
    }
    let sign = if before.turn() == Color::White { 1 } else { -1 };
    let mut result = ReviewMove {
        ply,
        before: fen(before),
        after: fen(&after),
        uci: uci.into(),
        san: played_san,
        best,
        best_san,
        best_line,
        reply_line,
        eval_before: a.score * sign,
        eval_after: -b.score * sign,
        loss,
        grade,
        explanation: String::new(),
        theme,
        player,
        mate: b.mate,
        best_mate: a.mate,
        evidence: vec![],
        review_pace: crate::review_pacing::Pace::default(),
    };
    enrich(&mut result);
    result
}
pub fn enrich(m: &mut ReviewMove) {
    m.evidence = crate::tactics::for_review(m);
    if let Some(f) = m
        .evidence
        .iter()
        .find(|f| matches!(f.theme.as_str(), "Forks & double attacks" | "Pins"))
    {
        m.theme = f.theme.clone();
    }
    // Regenerate prose when reading older caches; engine results remain reusable.
    let conclusion = match m.grade.as_str() {
        "best" if m.best != m.uci => "Strong move.",
        "best" => "Best move.",
        "excellent" => "Excellent move.",
        "good" => "A good move.",
        "inaccuracy" => "A small inaccuracy.",
        "mistake" => "A mistake.",
        _ => "A blunder.",
    };
    let mut detail = m
        .evidence
        .first()
        .map(|f| {
            format!(
                "{} {}{}",
                f.introduction,
                f.text,
                f.outlook
                    .as_ref()
                    .map(|o| format!(" {}", o.text))
                    .unwrap_or_default()
            )
            .trim()
            .to_string()
        })
        .unwrap_or_default();
    if position(&m.after).is_ok_and(|p| p.is_checkmate()) {
        detail = "Checkmate: the king has no legal escape, capture, or block.".into();
    } else if m.mate.is_some_and(|n| n > 0) && m.loss > 80 {
        detail = format!(
            "This allows a forced mate in {} with best play. {}",
            m.mate.unwrap(),
            detail
        );
    }
    m.explanation = format!("{}. {conclusion} {detail}", m.san);
    if m.best != m.uci && m.loss > 80 {
        if let Some(better) = m
            .evidence
            .iter()
            .find(|f| f.title.starts_with("Better plan"))
        {
            if m.evidence
                .first()
                .is_none_or(|first| first.text != better.text || first.fen != better.fen)
            {
                m.explanation.push_str(&format!(
                    " {} {}{}",
                    better.introduction,
                    better.text,
                    better
                        .outlook
                        .as_ref()
                        .map(|o| format!(" {}", o.text))
                        .unwrap_or_default()
                ));
            }
        }
    }
    m.review_pace = crate::review_pacing::assess(m, None);
}
fn refresh_player(review: &mut Review, game: &Game, player: &str) {
    for m in &mut review.moves {
        m.player = if m.before.split_whitespace().nth(1) == Some("w") {
            game.white.eq_ignore_ascii_case(player)
        } else {
            game.black.eq_ignore_ascii_case(player)
        };
    }
    let mine: Vec<_> = review.moves.iter().filter(|m| m.player).collect();
    review.blunders = mine.iter().filter(|m| m.grade == "blunder").count();
    review.mistakes = mine.iter().filter(|m| m.grade == "mistake").count();
    review.accuracy = if mine.is_empty() {
        0.0
    } else {
        mine.iter()
            .map(|m| 100.0 * (-(m.loss.min(1000) as f64) / 300.0).exp())
            .sum::<f64>()
            / mine.len() as f64
    };
}
pub fn review(game: &Game, player: &str) -> Result<Review, String> {
    let id = key(&("review-v3", &game.moves, &game.white, &game.black));
    let path = format!("data/reviews/{id}.json");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(mut r) = serde_json::from_slice::<Review>(&bytes) {
            // Engine results are reusable, ownership and player totals are not.
            refresh_player(&mut r, game, player);
            let needs_migration = r.analysis_version < 2;
            let mut engine = None;
            for m in &mut r.moves {
                let p = position(&m.before)?;
                let signed_score = m.eval_before * if p.turn() == Color::White { 1 } else { -1 };
                let legacy_mate = m.best_mate.is_none() && signed_score >= 9000;
                if needs_migration
                    && (legacy_mate
                        || (r.analysis_version < 1
                            && crate::exchange::needs_verification(&p, &m.best)))
                {
                    if engine.is_none() {
                        engine = Some(Engine::new()?);
                    }
                    let e = engine.as_mut().unwrap();
                    let a = eval(e, &p, 14)?;
                    let b = eval(e, &position(&m.after)?, 14)?;
                    *m = describe(&p, &m.uci, &a, &b, m.ply, m.player);
                } else {
                    enrich(m);
                }
            }
            refresh_player(&mut r, game, player);
            crate::review_pacing::refresh(&mut r.moves);
            if needs_migration {
                r.analysis_version = 2;
                write_review(&path, &r)?;
            }
            return Ok(r);
        }
    }
    let mut engine = Engine::new()?;
    let mut pos = Chess::default();
    let mut positions = vec![pos.clone()];
    for m in &game.moves {
        play(&mut pos, m)?;
        positions.push(pos.clone());
    }
    let mut evals = vec![];
    for p in &positions {
        evals.push(eval(&mut engine, p, 10)?);
    }
    let moves: Vec<_> = game
        .moves
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let mine = if positions[i].turn() == Color::White {
                game.white.eq_ignore_ascii_case(player)
            } else {
                game.black.eq_ignore_ascii_case(player)
            };
            describe(&positions[i], u, &evals[i], &evals[i + 1], i, mine)
        })
        .collect();
    let my: Vec<_> = moves.iter().filter(|m| m.player).collect();
    let accuracy = if my.is_empty() {
        0.0
    } else {
        my.iter()
            .map(|m| 100.0 * (-(m.loss.min(1000) as f64) / 300.0).exp())
            .sum::<f64>()
            / my.len() as f64
    };
    let mut result = Review {
        accuracy,
        blunders: my.iter().filter(|m| m.grade == "blunder").count(),
        mistakes: my.iter().filter(|m| m.grade == "mistake").count(),
        moves,
        depth: 10,
        analysis_version: 2,
    };
    crate::review_pacing::refresh(&mut result.moves);
    std::fs::create_dir_all("data/reviews").map_err(|e| e.to_string())?;
    write_review(&path, &result)?;
    Ok(result)
}
fn write_review(path: &str, result: &Review) -> Result<(), String> {
    std::fs::write(format!("{path}.tmp"), serde_json::to_vec(result).unwrap())
        .and_then(|_| std::fs::rename(format!("{path}.tmp"), path))
        .map_err(|e| e.to_string())
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct ThemeStats {
    pub count: u32,
    pub errors: u32,
    pub loss: f64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Attempt {
    pub solved: u32,
    pub missed: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Learner {
    pub owner: String,
    pub completed_games: u32,
    pub weights: [f64; 10],
    pub samples: u32,
    pub average_loss: f64,
    pub skill: f64,
    pub themes: BTreeMap<String, ThemeStats>,
    pub seen: HashSet<String>,
    pub attempts: BTreeMap<String, Attempt>,
    pub practice_rating: i32,
    pub rated_games: u32,
    pub rating_history: Vec<crate::rating::RatingPoint>,
    pub initial_rating: i32,
    pub rating_seeded: bool,
    pub rating_origin: String,
}
impl Default for Learner {
    fn default() -> Self {
        Self {
            owner: String::new(),
            completed_games: 0,
            weights: [0.0; 10],
            samples: 0,
            average_loss: 120.0,
            skill: 3.0,
            themes: BTreeMap::new(),
            seen: HashSet::new(),
            attempts: BTreeMap::new(),
            practice_rating: 1000,
            rated_games: 0,
            rating_history: vec![],
            initial_rating: 1000,
            rating_seeded: false,
            rating_origin: "Provisional starting rating".into(),
        }
    }
}
pub fn features(p: &Chess, score: i32) -> [f64; 10] {
    let material = |c| {
        p.board()
            .by_color(c)
            .into_iter()
            .map(|sq| match p.board().role_at(sq).unwrap() {
                Role::Pawn => 1.0,
                Role::Knight | Role::Bishop => 3.0,
                Role::Rook => 5.0,
                Role::Queen => 9.0,
                Role::King => 0.0,
            })
            .sum::<f64>()
    };
    let count = p.board().occupied().count() as f64;
    [
        1.0,
        (p.fullmoves().get() < 11) as u8 as f64,
        (count <= 12.0) as u8 as f64,
        p.is_check() as u8 as f64,
        count / 32.0,
        p.legal_moves().len() as f64 / 50.0,
        (material(p.turn()) - material(!p.turn())) / 39.0,
        (score as f64 / 400.0).tanh(),
        (p.board().by_role(Role::Queen).count() as f64) / 2.0,
        p.board().by_role(Role::Pawn).count() as f64 / 16.0,
    ]
}
impl Learner {
    pub fn rated_outcome(&mut self, session: &str, result: &str, opponent: i32) {
        let score = match result {
            "1-0" => 1.0,
            "0-1" => 0.0,
            "1/2-1/2" => 0.5,
            _ => return,
        };
        if !self.seen.insert(format!("elo:{session}")) {
            return;
        }
        self.practice_rating =
            crate::rating::update(self.practice_rating, opponent, score, self.rated_games);
        self.rated_games += 1;
        self.rating_history.push(crate::rating::RatingPoint {
            rating: self.practice_rating,
            opponent,
            score,
            day: crate::practice::today(),
        });
        if self.rating_history.len() > 200 {
            self.rating_history.remove(0);
        }
    }
    pub fn load_for_player(player: &str) -> Result<Self, String> {
        let mut learner: Self =
            crate::history::read_json(std::path::Path::new("data/learning.json"))?
                .unwrap_or_default();
        learner.configure_player(player);
        Ok(learner)
    }
    fn configure_player(&mut self, player: &str) {
        if !self.owner.is_empty() && !self.owner.eq_ignore_ascii_case(player) {
            let defaults = Self::default();
            self.weights = defaults.weights;
            self.samples = 0;
            self.average_loss = defaults.average_loss;
            self.skill = defaults.skill;
            self.themes.clear();
            self.seen
                .retain(|id| id.starts_with("elo:") || id.starts_with("result:"));
        }
        self.owner = player.to_string();
    }
    pub fn save(&self) -> Result<(), String> {
        crate::history::write_json(std::path::Path::new("data/learning.json"), self)
    }
    pub fn predict(&self, x: [f64; 10]) -> f64 {
        let z = self.weights.iter().zip(x).map(|(w, x)| w * x).sum::<f64>();
        1.0 / (1.0 + (-z.clamp(-20.0, 20.0)).exp())
    }
    pub fn outcome(&mut self, session: &str, result: &str) {
        let score = match result {
            "1-0" => 1.0,
            "0-1" => 0.0,
            "1/2-1/2" => 0.5,
            _ => return,
        };
        if !self.seen.insert(format!("result:{session}")) {
            return;
        }
        self.completed_games += 1;
        self.skill = (self.skill + 1.4 * (score - 0.45)).clamp(0.0, 20.0);
    }
    pub fn observe(&mut self, id: String, m: &ReviewMove) {
        if !self.seen.insert(id) {
            return;
        }
        let Ok(p) = position(&m.before) else { return };
        let x = features(
            &p,
            m.eval_before * if p.turn() == Color::White { 1 } else { -1 },
        );
        let prob = self.predict(x);
        let target = (m.loss >= 100) as u8 as f64;
        for (w, x) in self.weights.iter_mut().zip(x) {
            *w += 0.04 * ((target - prob) * x - 0.002 * *w);
        }
        self.samples += 1;
        let rate = 1.0 / (self.samples.min(80) as f64);
        self.average_loss += (m.loss.min(600) as f64 - self.average_loss) * rate;
        let st = self.themes.entry(m.theme.clone()).or_default();
        st.count += 1;
        st.errors += (m.loss >= 100) as u32;
        st.loss += m.loss.min(600) as f64;
        let target_skill = (12.0 - self.average_loss / 18.0).clamp(0.0, 18.0);
        self.skill += (target_skill - self.skill) * 0.015;
    }
}
#[derive(Clone, Serialize)]
pub struct Opening {
    pub eco: String,
    pub name: String,
    pub moves: Vec<String>,
}
pub fn openings() -> Vec<Opening> {
    let mut out = vec![];
    for v in ['a', 'b', 'c', 'd', 'e'] {
        let Ok(text) =
            std::fs::read_to_string(crate::runtime::resource(format!("data/openings/{v}.tsv")))
        else {
            continue;
        };
        for row in text.lines().skip(1) {
            let fields: Vec<_> = row.split('\t').collect();
            if fields.len() < 3 {
                continue;
            }
            let mut pos = Chess::default();
            let mut moves = vec![];
            for t in fields[2].split_whitespace() {
                if t.ends_with('.') {
                    continue;
                }
                if let Ok(s) = SanPlus::from_ascii(t.as_bytes()) {
                    if let Ok(m) = s.san.to_move(&pos) {
                        moves.push(UciMove::from_standard(m).to_string());
                        pos.play_unchecked(m);
                    }
                }
            }
            if !moves.is_empty() {
                out.push(Opening {
                    eco: fields[0].into(),
                    name: fields[1].into(),
                    moves,
                });
            }
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outcomes_adapt_once() {
        let mut l = Learner::default();
        let initial = l.skill;
        l.outcome("win", "1-0");
        assert!(l.skill > initial);
        let after = l.skill;
        l.outcome("win", "1-0");
        assert_eq!(after, l.skill);
        l.outcome("loss", "0-1");
        assert!(l.skill < after);
    }
    #[test]
    fn labels() {
        assert_eq!(grade(0, true), "best");
        assert_eq!(grade(310, false), "blunder");
        assert_eq!(grade(100, false), "inaccuracy");
    }
    #[test]
    fn learning_changes_prediction() {
        let mut l = Learner::default();
        let p = Chess::default();
        let x = features(&p, 0);
        let initial = l.predict(x);
        let a = Evaluation {
            score: 0,
            mate: None,
            pv: vec!["e2e4".into()],
        };
        let b = Evaluation {
            score: 200,
            mate: None,
            pv: vec![],
        };
        let m = describe(&p, "a2a3", &a, &b, 0, true);
        for i in 0..30 {
            l.observe(i.to_string(), &m)
        }
        assert!(l.predict(x) > initial);
        let n = l.samples;
        l.observe("0".into(), &m);
        assert_eq!(l.samples, n);
    }
    #[test]
    fn cached_review_ownership_and_totals_follow_the_selected_player() {
        let game = Game {
            white: "Tester".into(),
            black: "Other".into(),
            ..Default::default()
        };
        let before = Chess::default();
        let a = Evaluation {
            score: 50,
            mate: None,
            pv: vec!["d2d4".into()],
        };
        let b = Evaluation {
            score: 350,
            mate: None,
            pv: vec!["e7e5".into()],
        };
        let first = describe(&before, "f2f3", &a, &b, 0, true);
        let after = position(&first.after).unwrap();
        let second = describe(&after, "e7e5", &b, &a, 1, false);
        let mut review = Review {
            moves: vec![first, second],
            accuracy: 0.0,
            blunders: 0,
            mistakes: 0,
            depth: 10,
            analysis_version: 2,
        };
        refresh_player(&mut review, &game, "tester");
        assert_eq!(
            review.moves.iter().map(|m| m.player).collect::<Vec<_>>(),
            [true, false]
        );
        assert_eq!(review.blunders, 1);
        refresh_player(&mut review, &game, "OTHER");
        assert_eq!(
            review.moves.iter().map(|m| m.player).collect::<Vec<_>>(),
            [false, true]
        );
        assert_eq!(review.blunders, 0);
        assert_eq!(review.accuracy, 100.0);
    }

    #[test]
    fn changing_player_rebuilds_the_model_without_erasing_progress() {
        let mut learner = Learner {
            owner: "Tester".into(),
            samples: 42,
            completed_games: 7,
            practice_rating: 1500,
            ..Default::default()
        };
        learner.weights[0] = 0.7;
        learner.themes.insert(
            "Pins".into(),
            ThemeStats {
                count: 20,
                errors: 10,
                loss: 1000.0,
            },
        );
        learner.seen.extend([
            "move-observation".to_string(),
            "elo:game-1".into(),
            "result:game-1".into(),
        ]);
        learner.attempts.insert(
            "puzzle-1".into(),
            Attempt {
                solved: 2,
                missed: 1,
            },
        );
        learner.configure_player("tester");
        assert_eq!(learner.samples, 42);
        learner.configure_player("Other");
        assert_eq!(learner.samples, 0);
        assert!(learner.themes.is_empty());
        assert_eq!(learner.weights, [0.0; 10]);
        assert_eq!(learner.completed_games, 7);
        assert_eq!(learner.practice_rating, 1500);
        assert_eq!(learner.attempts["puzzle-1"].solved, 2);
        assert!(!learner.seen.contains("move-observation"));
        assert!(learner.seen.contains("elo:game-1"));
        assert!(learner.seen.contains("result:game-1"));
        let mut legacy = Learner {
            samples: 12,
            ..Default::default()
        };
        legacy.configure_player("Tester");
        assert_eq!(legacy.samples, 12);
        assert_eq!(legacy.owner, "Tester");
    }
}
