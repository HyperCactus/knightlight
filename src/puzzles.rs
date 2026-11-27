//! A large offline bank, diverse recommendations, and engine-checked puzzle plans.
use crate::{
    engine::{Engine, Evaluation},
    exchange, fen, position, training, Puzzle,
};
use serde::{Deserialize, Serialize};
use shakmaty::{Chess, Position};
use std::{
    cmp::{Ordering, Reverse},
    collections::{BTreeMap, BinaryHeap, HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Arc, RwLock,
    },
};

pub fn position_key(fen: &str) -> String {
    training::key(&fen.split_whitespace().take(4).collect::<Vec<_>>())
}
/// Readers keep an immutable snapshot while the full offline collection loads.
/// Publishing never invalidates an in-flight puzzle or holds a lock during ranking.
pub(crate) struct Bank(RwLock<Arc<Vec<Puzzle>>>, AtomicBool);
impl Bank {
    pub(crate) fn bootstrap() -> Self {
        let bytes = std::fs::read(crate::runtime::resource("data/public-puzzles.json"))
            .unwrap_or_else(|_| include_bytes!("../data/public-puzzles.json").to_vec());
        let starter = decode_bank(&bytes).unwrap_or_else(|error| {
            eprintln!("Starter puzzle collection unavailable; using embedded collection: {error}");
            decode_bank(include_bytes!("../data/public-puzzles.json"))
                .expect("Bundled starter puzzles must be valid")
        });
        Self(RwLock::new(Arc::new(starter)), AtomicBool::new(false))
    }
    pub(crate) fn snapshot(&self) -> Arc<Vec<Puzzle>> {
        self.0.read().unwrap().clone()
    }
    pub(crate) fn ready(&self) -> bool {
        self.1.load(AtomicOrdering::Acquire)
    }
    pub(crate) fn finish_loading(&self) {
        self.1.store(true, AtomicOrdering::Release);
    }
    pub(crate) fn publish(&self, mut full: Vec<Puzzle>) {
        let starter = self.snapshot();
        let ids: HashSet<_> = starter.iter().map(|p| &p.id).collect();
        let positions: HashSet<_> = starter.iter().map(|p| &p.position_key).collect();
        // Keep starter identities available to already displayed queues and drills.
        full.retain(|p| !ids.contains(&p.id) && !positions.contains(&p.position_key));
        full.extend(starter.iter().cloned());
        *self.0.write().unwrap() = Arc::new(full);
        self.finish_loading();
    }
}

pub fn load_bank() -> Result<Vec<Puzzle>, String> {
    let bytes = std::fs::read(crate::runtime::resource("data/puzzle-bank.json"))
        .or_else(|_| std::fs::read(crate::runtime::resource("data/public-puzzles.json")))
        .map_err(|error| format!("Could not read full puzzle collection: {error}"))?;
    decode_bank(&bytes)
}

fn decode_bank(bytes: &[u8]) -> Result<Vec<Puzzle>, String> {
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        fen: String,
        moves: Vec<String>,
        rating: i32,
        theme: String,
        game_url: String,
        #[serde(default)]
        tags: Vec<String>,
    }
    let entries: Vec<Entry> = serde_json::from_slice(bytes)
        .map_err(|error| format!("Could not decode puzzle collection: {error}"))?;
    let mut seen = HashSet::new();
    Ok(entries
        .into_iter()
        .filter_map(|e| {
            let mut p = position(&e.fen).ok()?;
            let key = position_key(&fen(&p));
            if !seen.insert(key.clone()) {
                return None;
            }
            let best = e.moves.first()?.clone();
            for u in &e.moves {
                training::play(&mut p, u).ok()?;
            }
            Some(Puzzle {
                fen: e.fen,
                best,
                played: String::new(),
                loss: 0,
                game: None,
                ply: 0,
                theme: e.theme,
                id: format!("lichess-{}", e.id),
                priority: 0.5,
                source: "lichess".into(),
                rating: Some(e.rating),
                source_url: Some(e.game_url),
                solution: e.moves,
                tags: e.tags,
                position_key: key,
                reason: String::new(),
            })
        })
        .collect())
}

pub struct Selection<'a> {
    pub practice: &'a crate::practice::Practice,
    pub weaknesses: &'a BTreeMap<String, f64>,
    pub rating: i32,
    pub review: bool,
    pub focus: &'a str,
}
/// Shared availability rule for recommendation and counts. Due retrievals remain
/// available when a learner's rating changes; fresh examples target current skill.
pub(crate) fn available(
    puzzle: &Puzzle,
    practice: &crate::practice::Practice,
    rating: i32,
    review: bool,
    day: u64,
) -> bool {
    if practice.excluded_positions.contains(&puzzle.position_key) {
        return false;
    }
    let card = practice.cards.get(&puzzle.id);
    if review {
        return card.is_some_and(|c| c.due <= day);
    }
    !practice.seen_positions.contains_key(&puzzle.position_key)
        && card.is_none()
        && puzzle
            .rating
            .is_none_or(|r| (r - (rating + 150)).abs() <= 500)
}
struct Ranked<'a> {
    puzzle: &'a Puzzle,
    score: f64,
    overdue: u64,
    index: usize,
}
impl PartialEq for Ranked<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Ranked<'_> {}
impl PartialOrd for Ranked<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ranked<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        self.overdue
            .cmp(&other.overdue)
            .then_with(|| self.score.total_cmp(&other.score))
            .then_with(|| other.index.cmp(&self.index))
    }
}
pub fn recommend(bank: &[Puzzle], personal: &[Puzzle], selection: &Selection<'_>) -> Vec<Puzzle> {
    let Selection {
        practice,
        weaknesses,
        rating,
        review,
        focus,
    } = selection;
    let day = crate::practice::today();
    let mut identities = HashSet::new();
    let mut themes: HashMap<&str, BinaryHeap<Reverse<Ranked<'_>>>> = HashMap::new();
    // At most eighty results can be used from any one theme. Keep only that
    // theme's best eighty while scanning, rather than sorting the entire bank.
    for (index, p) in personal.iter().chain(bank).enumerate() {
        if (*focus != "all" && p.theme != *focus)
            || !available(p, practice, *rating, *review, day)
            || !identities.insert(p.position_key.as_str())
        {
            continue;
        }
        let weakness = weaknesses.get(&p.theme).copied().unwrap_or(0.0);
        let complexity = if p
            .tags
            .iter()
            .any(|t| t == "sacrifice" || t == "defensiveMove")
        {
            0.15
        } else {
            0.0
        };
        let distance = p
            .rating
            .map_or(0.0, |r| (r - (*rating + 150)).abs() as f64 / 450.0);
        let noise = training::hash_u64(&(practice.selection_nonce, &p.id)) as f64 / u64::MAX as f64;
        let ranked = Ranked {
            puzzle: p,
            overdue: if *review {
                practice
                    .cards
                    .get(&p.id)
                    .map_or(0, |c| day.saturating_sub(c.due))
            } else {
                0
            },
            score: weakness * 3.0 + if p.game.is_some() { 1.8 } else { 0.0 } - distance.min(5.0)
                + noise * 1.6
                + complexity,
            index,
        };
        let heap = themes.entry(p.theme.as_str()).or_default();
        if heap.len() < 80 {
            heap.push(Reverse(ranked));
        } else if heap.peek().is_some_and(|worst| ranked > worst.0) {
            heap.pop();
            heap.push(Reverse(ranked));
        }
    }
    let mut candidates: Vec<_> = themes
        .into_values()
        .flat_map(|h| h.into_iter().map(|r| r.0))
        .collect();
    candidates.sort_unstable_by(|a, b| b.cmp(a));
    identities.clear();
    let mut counts = BTreeMap::<&str, usize>::new();
    let mut out = vec![];
    // Interleave themes in rounds, retaining targeted practice and diversity.
    for quota in [2, 5, 15, usize::MAX] {
        for ranked in &candidates {
            if out.len() >= 80 {
                return out;
            }
            let p = ranked.puzzle;
            if counts.get(p.theme.as_str()).copied().unwrap_or(0) >= quota
                || !identities.insert(p.position_key.as_str())
            {
                continue;
            }
            *counts.entry(p.theme.as_str()).or_default() += 1;
            let mut puzzle = p.clone();
            puzzle.reason = if p.game.is_some() {
                "A missed opportunity from your game".into()
            } else if weaknesses.get(&p.theme).copied().unwrap_or(0.0) > 0.1 {
                format!("Targets {} from your game history", p.theme.to_lowercase())
            } else {
                "A fresh pattern at your challenge level".into()
            };
            puzzle.priority = (80 - out.len()) as f64;
            out.push(puzzle);
        }
    }
    out
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Plan {
    pub best: Evaluation,
    pub choices: usize,
    pub line: Vec<String>,
}
fn good(best: &Evaluation, other: &Evaluation) -> bool {
    if best.mate.is_some_and(|n| n > 0) {
        other.mate.is_some_and(|n| n > 0)
    } else {
        best.score - other.score <= 60
    }
}
pub fn meaningful(lines: &[Evaluation], pos: &Chess) -> bool {
    if pos.legal_moves().len() <= 2 || lines.is_empty() {
        return false;
    }
    let best = &lines[0];
    if best.score < -120 || best.mate.is_some_and(|n| n < 0) {
        return false;
    }
    if best.mate == Some(1) {
        return true;
    }
    let choices = lines.iter().filter(|e| good(best, e)).count();
    choices <= 2 && lines.len() >= 3 && best.score - lines[2].score >= 100
}
pub fn analyze(engine: &mut Engine, pos: &Chess, depth: u8) -> Result<Vec<Evaluation>, String> {
    if pos.is_game_over() {
        return Ok(vec![training::eval(engine, pos, depth)?]);
    }
    engine.evaluate(&fen(pos), depth, 3)
}
pub fn verify(engine: &mut Engine, puzzle: &Puzzle) -> Result<Plan, String> {
    let pos = position(&puzzle.fen)?;
    let mut lines = analyze(engine, &pos, 15)?;
    // More search for ambiguity or a suggested sacrifice; reject unresolved positions.
    if !meaningful(&lines, &pos) || exchange::needs_verification(&pos, &lines[0].pv[0]) {
        lines = analyze(engine, &pos, 18)?;
    }
    if !meaningful(&lines, &pos) {
        return Err("This position has no clear puzzle solution".into());
    }
    if !puzzle.solution.is_empty() && puzzle.source == "lichess" {
        let source = &puzzle.solution[0];
        let mut after = pos.clone();
        training::play(&mut after, source)?;
        let score = training::eval(engine, &after, 18)?;
        if (lines[0].score + score.score).max(0) > 100 {
            lines = analyze(engine, &pos, 19)?;
            let score = training::eval(engine, &after, 19)?;
            if (lines[0].score + score.score).max(0) > 100 {
                return Err("The published solution needs further verification".into());
            }
        }
    }
    if !meaningful(&lines, &pos) {
        return Err("This position has several equally strong choices".into());
    }
    let best = lines.remove(0);
    let choices = 1 + lines.iter().filter(|e| good(&best, e)).count();
    let line = if puzzle.solution.first() == best.pv.first() {
        puzzle.solution.clone()
    } else {
        best.pv.iter().take(9).cloned().collect()
    };
    Ok(Plan {
        best,
        choices,
        line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publishing_collection_keeps_starter_ids_and_in_flight_snapshots() {
        let starter = puzzle(1, "Pins");
        let bank = Bank(
            RwLock::new(Arc::new(vec![starter.clone()])),
            AtomicBool::new(false),
        );
        assert!(!bank.ready());
        let in_flight = bank.snapshot();
        let mut duplicate_position = puzzle(2, "Pins");
        duplicate_position.position_key = starter.position_key.clone();
        bank.publish(vec![duplicate_position, puzzle(3, "King safety")]);
        let loaded = bank.snapshot();
        assert!(bank.ready());
        assert_eq!(in_flight.len(), 1);
        assert_eq!(in_flight[0].id, starter.id);
        assert_eq!(loaded.len(), 2);
        assert!(loaded.iter().any(|p| p.id == starter.id));
        assert!(loaded.iter().any(|p| p.id == "test-3"));
        assert!(!loaded.iter().any(|p| p.id == "test-2"));
    }

    #[test]
    fn bootstrap_is_playable_and_corrupt_collection_is_reported() {
        let bank = Bank::bootstrap().snapshot();
        assert!(bank.len() >= 100);
        assert!(bank.iter().all(|p| !p.solution.is_empty()));
        assert!(matches!(decode_bank(b"broken JSON"), Err(error) if error.contains("decode")));
    }

    fn eval(score: i32) -> Evaluation {
        Evaluation {
            score,
            mate: None,
            pv: vec!["e2e4".into()],
        }
    }
    fn puzzle(id: usize, theme: &str) -> Puzzle {
        Puzzle {
            id: format!("test-{id}"),
            position_key: format!("board-{id}"),
            fen: fen(&Chess::default()),
            best: "e2e4".into(),
            played: String::new(),
            loss: 0,
            game: None,
            ply: 0,
            theme: theme.into(),
            priority: 0.5,
            source: "lichess".into(),
            rating: Some(1100),
            source_url: None,
            solution: vec![],
            tags: vec![],
            reason: String::new(),
        }
    }
    #[test]
    fn clear_one_or_two_choices_are_required_and_lost_positions_are_rejected() {
        let p = Chess::default();
        assert!(meaningful(&[eval(300), eval(100), eval(50)], &p));
        assert!(meaningful(&[eval(300), eval(285), eval(-100)], &p));
        assert!(!meaningful(&[eval(300), eval(280), eval(265)], &p));
        assert!(!meaningful(&[eval(-500), eval(-900), eval(-1200)], &p));
        assert!(!meaningful(&[eval(0), eval(-20), eval(-30)], &p));
    }
    #[test]
    fn history_counters_do_not_create_different_puzzles() {
        let a = position_key("7k/8/8/8/8/8/P7/6K1 w - - 0 1");
        assert_eq!(a, position_key("7k/8/8/8/8/8/P7/6K1 w - - 45 31"));
        assert_ne!(a, position_key("7k/8/8/8/8/8/P7/6K1 b - - 0 1"));
    }
    #[test]
    fn skips_completions_and_duplicate_positions_stay_out_of_fresh_queues() {
        let mut bank = vec![
            puzzle(0, "Pins"),
            puzzle(1, "Pins"),
            puzzle(2, "King safety"),
            puzzle(3, "King safety"),
        ];
        bank[3].position_key = bank[2].position_key.clone();
        let mut p = crate::practice::Practice::default();
        p.seen_positions
            .insert("board-0".into(), crate::practice::today());
        p.cards
            .insert("test-1".into(), crate::practice::Card::default());
        let p: crate::practice::Practice =
            serde_json::from_slice(&serde_json::to_vec(&p).unwrap()).unwrap();
        let weaknesses = BTreeMap::new();
        let request = Selection {
            practice: &p,
            weaknesses: &weaknesses,
            rating: 1000,
            review: false,
            focus: "all",
        };
        let fresh = recommend(&bank, &[], &request);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].position_key, "board-2");
        let review = recommend(
            &bank,
            &[],
            &Selection {
                review: true,
                ..request
            },
        );
        assert_eq!(review.len(), 1);
        assert_eq!(review[0].id, "test-1");
    }
    #[test]
    fn weaknesses_get_priority_without_repeating_one_theme_throughout_the_session() {
        let bank: Vec<_> = (0..60)
            .map(|i| puzzle(i, ["Pins", "King safety", "Endgame technique"][i % 3]))
            .collect();
        let p = crate::practice::Practice::default();
        let weaknesses = BTreeMap::from([("Pins".into(), 1.5)]);
        let list = recommend(
            &bank,
            &[],
            &Selection {
                practice: &p,
                weaknesses: &weaknesses,
                rating: 1000,
                review: false,
                focus: "all",
            },
        );
        assert!(list[..2].iter().all(|p| p.theme == "Pins"));
        assert_eq!(list[..6].iter().filter(|p| p.theme == "Pins").count(), 2);
    }
    #[test]
    fn a_previously_repeated_lost_game_position_is_not_a_puzzle() {
        let mut p = puzzle(0, "King safety");
        p.source = "personal".into();
        p.fen = "8/7p/8/Q1P2p2/3p1pk1/P7/1P3PPP/6K1 b - - 0 33".into();
        let mut engine = Engine::new().unwrap();
        assert!(verify(&mut engine, &p).is_err());
    }
    #[test]
    fn a_real_queen_sacrifice_is_preserved_when_it_forces_mate() {
        let mut puzzle = puzzle(0, "King safety");
        puzzle.fen = "5r1k/6pp/4Q2N/8/8/8/8/6K1 w - - 0 1".into();
        puzzle.solution = vec!["e6g8".into(), "f8g8".into(), "h6f7".into()];
        let mut engine = Engine::new().unwrap();
        let plan = verify(&mut engine, &puzzle).unwrap();
        assert_eq!(plan.best.pv[0], "e6g8");
        assert_eq!(plan.best.mate, Some(2));
    }
    #[test]
    fn a_hanging_queen_in_a_bad_source_line_is_not_taught_as_the_only_answer() {
        let mut puzzle = puzzle(0, "Material & captures");
        puzzle.fen = "3r3k/8/8/3p4/8/8/8/3Q2K1 w - - 0 1".into();
        puzzle.solution = vec!["d1d5".into(), "d8d5".into()];
        let mut engine = Engine::new().unwrap();
        assert!(verify(&mut engine, &puzzle).is_err());
    }
    #[test]
    fn overdue_cards_are_selected_before_future_cards_regardless_of_rating() {
        let mut bank: Vec<_> = (0..200).map(|i| puzzle(i, "Pins")).collect();
        let mut practice = crate::practice::Practice::default();
        let day = crate::practice::today();
        for p in &bank {
            practice.cards.insert(
                p.id.clone(),
                crate::practice::Card {
                    due: day + 30,
                    attempts: 1,
                    ..Default::default()
                },
            );
        }
        // An old, harder pattern remains due even after the learner's rating changes.
        bank[199].rating = Some(2400);
        practice.cards.get_mut(&bank[199].id).unwrap().due = day - 2;
        let selected = recommend(
            &bank,
            &[],
            &Selection {
                practice: &practice,
                weaknesses: &BTreeMap::new(),
                rating: 1000,
                review: true,
                focus: "all",
            },
        );
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, bank[199].id);
        let overview = crate::practice::overview(&practice, &selected);
        assert_eq!(overview["queue"].as_array().unwrap().len(), 1);
    }
}
