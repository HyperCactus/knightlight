//! Rare, engine-verified opportunities to think from the other side in review.
use crate::{
    bad,
    engine::{Engine, Evaluation},
    error, position,
    training::{self, Review, ReviewMove},
    unavailable, ApiError, Shared,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shakmaty::{Color, Position};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Punish,
    Defend,
}

#[derive(Clone, Serialize)]
pub struct Challenge {
    pub ply: usize,
    pub kind: Kind,
    pub fen: String,
    pub side: String,
    pub intro: String,
    pub objective: String,
    #[serde(skip)]
    best: Evaluation,
}

fn candidate(m: &ReviewMove) -> Option<(Kind, i32)> {
    if !m.player || m.reply_line.is_empty() {
        return None;
    }
    let pos = position(&m.after).ok()?;
    if pos.is_game_over() || pos.legal_moves().len() <= 2 {
        return None;
    }
    let sign = if pos.turn() == Color::White { 1 } else { -1 };
    let before = m.eval_before * sign;
    let after = m.eval_after * sign;
    // Early punishment can be instructive; routine opening development cannot.
    let mating_chance = m.mate.is_some_and(|n| (2..=5).contains(&n));
    if m.loss >= 180 && before < 400 && ((-120..1500).contains(&after) || mating_chance) {
        return Some((Kind::Punish, 200 + m.loss.min(600)));
    }
    let pressure = m.san.contains('+')
        || m.evidence.iter().any(|f| {
            matches!(f.context, Some(crate::tactics::EvidenceContext::Played))
                && (matches!(
                    f.theme.as_str(),
                    "Forks & double attacks" | "Pins" | "King safety" | "Material & captures"
                ) || f.outlook.is_some())
        });
    if m.ply >= 16 && m.loss <= 80 && (-150..180).contains(&after) && pressure {
        return Some((Kind::Defend, 350 + if pos.is_check() { 100 } else { 0 }));
    }
    None
}

fn suitable(lines: &[Evaluation], pos: &shakmaty::Chess) -> bool {
    crate::puzzles::meaningful(lines, pos)
        && lines[0].mate != Some(1)
        && (lines[0].mate.is_some_and(|n| n > 1)
            || lines[0].score - lines[1].score >= 100
            || (lines.len() >= 3 && lines[0].score - lines[2].score >= 180))
}

pub fn select(review: &Review) -> Result<Vec<Challenge>, String> {
    let mut candidates: Vec<_> = review
        .moves
        .iter()
        .filter_map(|m| candidate(m).map(|(kind, score)| (m, kind, score)))
        .collect();
    // Prefer a defensive lesson in roughly one game in three when one exists.
    // This is stable across replays; the engine still has to confirm its value.
    let seed = training::key(&review.moves.iter().map(|m| &m.uci).collect::<Vec<_>>());
    let prefer_defence = seed.as_bytes().last().is_some_and(|b| b % 3 == 0);
    candidates.sort_by_key(|(m, kind, score)| {
        let bonus = if prefer_defence && *kind == Kind::Defend {
            450
        } else {
            0
        };
        (std::cmp::Reverse(*score + bonus), m.ply)
    });
    let budget = if review.moves.len() >= 64 { 2 } else { 1 };
    let mut selected: Vec<Challenge> = vec![];
    if candidates.is_empty() {
        return Ok(selected);
    }
    let mut engine = Engine::new()?;
    let mut searches = 0;
    for (m, kind, _) in candidates {
        if selected.len() >= budget || searches >= 4 {
            break;
        }
        if selected.iter().any(|c| {
            c.ply.abs_diff(m.ply + 1) < 16
                || c.fen.split_whitespace().next() == m.after.split_whitespace().next()
        }) {
            continue;
        }
        let pos = position(&m.after)?;
        searches += 1;
        let mut lines = crate::puzzles::analyze(&mut engine, &pos, 15)?;
        if !suitable(&lines, &pos) || crate::exchange::needs_verification(&pos, &lines[0].pv[0]) {
            lines = crate::puzzles::analyze(&mut engine, &pos, 18)?;
        }
        if !suitable(&lines, &pos) {
            continue;
        }
        let side = if pos.turn() == Color::White {
            "White"
        } else {
            "Black"
        };
        let (intro, objective) = match kind {
            Kind::Punish => (format!("Now let’s take a look from your opponent’s side. After your {}, they had a chance to take advantage. Play {side} and find their strongest response.",m.san), "Find the response that makes the most of your mistake."),
            Kind::Defend => (format!("Now let’s take a look from your opponent’s side. Your {} put them under pressure. Play {side} and find how they could defend.",m.san), "Find the defence that holds the position together."),
        };
        selected.push(Challenge {
            ply: m.ply + 1,
            kind,
            fen: m.after.clone(),
            side: side.to_lowercase(),
            intro,
            objective: objective.into(),
            best: lines.remove(0),
        });
    }
    selected.sort_by_key(|c| c.ply);
    Ok(selected)
}

async fn plans(app: &Shared, id: usize) -> Result<Vec<Challenge>, ApiError> {
    if id >= app.data.lock().unwrap().games.len() {
        return Err(error(StatusCode::NOT_FOUND, "Game not found"));
    }
    let review = app
        .reviews
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            error(
                StatusCode::CONFLICT,
                "The game review is still being analyzed",
            )
        })?;
    let moves: Vec<_> = review.moves.iter().map(|m| m.uci.clone()).collect();
    {
        let data = app.data.lock().unwrap();
        if data.games[id].moves != moves {
            return Err(error(
                StatusCode::CONFLICT,
                "This game changed. Its new review is being analyzed.",
            ));
        }
        if let Some(items) = app.perspectives.lock().unwrap().get(&id) {
            return Ok(items.clone());
        }
    }
    let permit = app
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(unavailable)?;
    let items = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        select(&review)
    })
    .await
    .map_err(unavailable)?
    .map_err(unavailable)?;
    // A save can finish while Stockfish is choosing challenges. Publish only
    // for the same game revision, with the library lock held through insertion.
    let data = app.data.lock().unwrap();
    if data.games[id].moves != moves {
        return Err(error(
            StatusCode::CONFLICT,
            "This game changed. Its new review is being analyzed.",
        ));
    }
    let mut cache = app.perspectives.lock().unwrap();
    if cache.len() >= 64 {
        cache.clear();
    }
    cache.insert(id, items.clone());
    Ok(items)
}

pub async fn prepare(
    State(app): State<Shared>,
    Path(id): Path<usize>,
) -> Result<Json<Value>, ApiError> {
    let items = plans(&app, id).await?;
    Ok(Json(json!({"items":items,"next_cursor":null})))
}

#[derive(Deserialize)]
pub struct Answer {
    uci: Option<String>,
    #[serde(default)]
    reveal: bool,
}
pub async fn answer(
    State(app): State<Shared>,
    Path((id, ply)): Path<(usize, usize)>,
    Json(req): Json<Answer>,
) -> Result<Json<Value>, ApiError> {
    let challenge = plans(&app, id)
        .await?
        .into_iter()
        .find(|c| c.ply == ply)
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "This move has no perspective challenge",
            )
        })?;
    let pos = position(&challenge.fen).map_err(bad)?;
    let mut uci = if req.reveal {
        challenge.best.pv[0].clone()
    } else {
        req.uci.ok_or_else(|| bad("Choose a response"))?
    };
    let mut after = pos.clone();
    training::play(&mut after, &uci).map_err(bad)?;
    let permit = app
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(unavailable)?;
    let result = tokio::task::spawn_blocking(move || {
        let _permit=permit;
        let mut engine=Engine::new()?;
        let mut baseline=challenge.best;
        let mut evaluation=training::eval(&mut engine,&after,16)?;
        if !crate::practice::acceptable(&baseline,&evaluation,&after) &&
            (baseline.pv.first()==Some(&uci) || (baseline.score+evaluation.score).abs()<180) {
            baseline=training::eval(&mut engine,&pos,19)?;
            evaluation=training::eval(&mut engine,&after,19)?;
        }
        if req.reveal && !crate::practice::acceptable(&baseline,&evaluation,&after) {
            uci = baseline.pv[0].clone();
            after = pos.clone();
            training::play(&mut after,&uci)?;
            evaluation = training::eval(&mut engine,&after,19)?;
        }
        let accepted=crate::practice::acceptable(&baseline,&evaluation,&after);
        if req.reveal && !accepted { return Err("Could not confirm a clear response. Continue the review and try this moment later.".into()); }
        let feedback=training::describe(&pos,&uci,&baseline,&evaluation,ply,true);
        Ok::<_,String>(json!({"accepted":accepted,"revealed":req.reveal,"board":crate::board(&after),"feedback":feedback}))
    }).await.map_err(unavailable)?.map_err(unavailable)?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(ply: usize, loss: i32) -> ReviewMove {
        let p = position("3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12").unwrap();
        training::describe(
            &p,
            "e5d3",
            &Evaluation {
                score: 200,
                mate: None,
                pv: vec!["e5f7".into()],
            },
            &Evaluation {
                score: loss - 200,
                mate: None,
                pv: vec!["d8d3".into()],
            },
            ply,
            true,
        )
    }
    #[test]
    fn selects_punishment_but_skips_opponent_moves_and_already_won_games() {
        let mut m = record(20, 400);
        assert!(matches!(candidate(&m), Some((Kind::Punish, _))));
        m.player = false;
        assert!(candidate(&m).is_none());
        m.player = true;
        m.eval_before = -700;
        assert!(candidate(&m).is_none());
    }
    #[test]
    fn includes_new_mating_combinations_but_not_obvious_mate_in_one() {
        let mut m = record(20, 400);
        m.eval_after = -9997;
        m.mate = Some(3);
        assert!(matches!(candidate(&m), Some((Kind::Punish, _))));
        m.mate = Some(1);
        m.eval_after = -9999;
        assert!(candidate(&m).is_none());
    }
    #[test]
    fn ordinary_openings_and_forced_replies_are_not_challenges() {
        let mut m = record(4, 20);
        assert!(candidate(&m).is_none());
        m.after = "7k/5K2/6Q1/8/8/8/8/8 b - - 0 1".into();
        assert!(candidate(&m).is_none());
    }
    #[test]
    fn finds_a_real_defence_after_a_promotion() {
        let pos = position("r6r/pp3kPp/1b5n/8/8/2B5/b1P2PPP/4R1K1 w - - 1 21").unwrap();
        let m = training::describe(
            &pos,
            "g7h8q",
            &Evaluation {
                score: -117,
                mate: None,
                pv: vec!["g7h8q".into()],
            },
            &Evaluation {
                score: 130,
                mate: None,
                pv: vec!["a8h8".into(), "c3h8".into()],
            },
            40,
            true,
        );
        assert!(matches!(candidate(&m), Some((Kind::Defend, _))));
        let review = Review {
            moves: vec![m],
            accuracy: 90.0,
            blunders: 0,
            mistakes: 0,
            depth: 15,
            analysis_version: 1,
        };
        let result = select(&review).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].kind == Kind::Defend);
        assert_eq!(result[0].best.pv[0], "a8h8");
    }
    #[test]
    fn caps_frequency_spaces_switches_and_avoids_repeating_positions() {
        let pos = position("r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4")
            .unwrap();
        let describe = |uci, ply| {
            training::describe(
                &pos,
                uci,
                &Evaluation {
                    score: 9999,
                    mate: Some(1),
                    pv: vec!["h5f7".into()],
                },
                &Evaluation {
                    score: 800,
                    mate: None,
                    pv: vec!["f6h5".into()],
                },
                ply,
                true,
            )
        };
        let first = describe("a2a3", 20);
        let mut repeated = first.clone();
        repeated.ply = 55;
        let mut filler = first.clone();
        filler.player = false;
        let mut moves = vec![filler; 64];
        moves[20] = first;
        moves[24] = describe("a2a4", 24); // Too close to the more important first move.
        moves[55] = repeated;
        let mut review = Review {
            moves,
            accuracy: 50.0,
            blunders: 3,
            mistakes: 0,
            depth: 15,
            analysis_version: 1,
        };
        assert_eq!(select(&review).unwrap().len(), 1);
        review.moves[40] = describe("a2a4", 40);
        let result = select(&review).unwrap();
        assert_eq!(result.len(), 2);
        assert!(result[1].ply - result[0].ply >= 16);
        review.moves.truncate(60);
        assert_eq!(select(&review).unwrap().len(), 1);
    }
    #[test]
    fn rejects_ambiguous_hopeless_and_mate_in_one_positions() {
        let p = position("3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12").unwrap();
        let e = |score| Evaluation {
            score,
            mate: None,
            pv: vec!["e5f7".into()],
        };
        assert!(!suitable(&[e(30), e(20), e(0)], &p));
        assert!(!suitable(&[e(-500), e(-700), e(-800)], &p));
        assert!(suitable(&[e(20), e(-180), e(-300)], &p));
        let mut win = e(9999);
        win.mate = Some(1);
        assert!(!suitable(&[win, e(0), e(-50)], &p));
    }
}
