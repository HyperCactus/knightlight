//! Date-weighted history score, with FOCALORS-style Elo samples for bot results.
use chrono::{DateTime, FixedOffset, NaiveDate};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
pub struct RatingPoint {
    pub rating: i32,
    pub opponent: i32,
    pub score: f64,
    pub day: u64,
}
pub fn update(player: i32, opponent: i32, score: f64, games: u32) -> i32 {
    let expected = 1.0 / (1.0 + 10.0_f64.powf((opponent - player) as f64 / 400.0));
    let k = if games < 30 { 40.0 } else { 20.0 };
    (player + (k * (score - expected)).round() as i32).clamp(100, 3500)
}
pub fn from_level(level: u8) -> i32 {
    400 + (level.clamp(1, 20) as i32 - 1) * 105
}
pub fn to_level(rating: i32) -> u8 {
    (((rating - 400) as f64 / 105.0).round() as i32 + 1).clamp(0, 20) as u8
}
pub const HALF_LIFE_DAYS: f64 = 14.0;
pub struct Weighted {
    pub rating: i32,
    pub samples: usize,
    pub history: Vec<RatingPoint>,
}
pub fn game_day(game: &crate::Game) -> Option<i64> {
    let date = game
        .played_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| {
            d.with_timezone(&FixedOffset::east_opt(36000).unwrap())
                .date_naive()
        })
        .or_else(|| NaiveDate::parse_from_str(&game.date, "%Y.%m.%d").ok())
        .or_else(|| NaiveDate::parse_from_str(&game.date, "%Y-%m-%d").ok())?;
    Some(
        date.signed_duration_since(NaiveDate::from_ymd_opt(1970, 1, 1).unwrap())
            .num_days(),
    )
}
pub fn result(game: &crate::Game, player: &str) -> Option<f64> {
    if !game.white.eq_ignore_ascii_case(player) && !game.black.eq_ignore_ascii_case(player) {
        return None;
    }
    match game.result.as_str() {
        "1/2-1/2" => Some(0.5),
        "1-0" => Some(if game.white.eq_ignore_ascii_case(player) {
            1.0
        } else {
            0.0
        }),
        "0-1" => Some(if game.black.eq_ignore_ascii_case(player) {
            1.0
        } else {
            0.0
        }),
        _ => None,
    }
}
pub fn weighted(games: &[crate::Game], player: &str) -> Weighted {
    let mut values = vec![];
    for (i, g) in games.iter().enumerate() {
        let Some(score) = result(g, player) else {
            continue;
        };
        let Some(day) = game_day(g) else { continue };
        let (own, opponent) = if g.white.eq_ignore_ascii_case(player) {
            (g.white_elo, g.black_elo.or(g.opponent_rating))
        } else {
            (g.black_elo, g.white_elo)
        };
        let sample = g
            .rating_sample
            .or(own)
            .filter(|n| (100..=3500).contains(n))
            .or_else(|| {
                opponent.filter(|n| (100..=3500).contains(n)).map(|n| {
                    (n as f64 + 400.0 * (2.0 * score - 1.0))
                        .clamp(100.0, 3500.0)
                        .round() as i32
                })
            });
        if let Some(sample) = sample {
            values.push((day, i, sample, opponent.unwrap_or(sample), score));
        }
    }
    values.sort_by_key(|(day, i, _, _, _)| (*day, *i));
    let mut history = vec![];
    let mut sum = 0.0;
    let mut weight = 0.0;
    let mut previous = values.first().map_or(0, |v| v.0);
    for (day, _, sample, opponent, score) in &values {
        let decay = 2.0f64.powf(-((*day - previous) as f64) / HALF_LIFE_DAYS);
        sum = sum * decay + *sample as f64;
        weight = weight * decay + 1.0;
        previous = *day;
        history.push(RatingPoint {
            rating: (sum / weight).round() as i32,
            opponent: *opponent,
            score: *score,
            day: (*day).max(0) as u64,
        });
    }
    Weighted {
        rating: history.last().map_or(1000, |p| p.rating),
        samples: values.len(),
        history,
    }
}
/// Calibrate the next sparring partner from recent completed practice results.
/// The visible date-weighted score stays independent of this difficulty estimate.
pub fn adaptive(games: &[crate::Game], player: &str, base: i32) -> i32 {
    let mut recent: Vec<_> = games
        .iter()
        .filter_map(|g| {
            if g.source != "practice" && g.session_id.is_empty() {
                return None;
            }
            Some((g, game_day(g)?, result(g, player)?, g.opponent_rating?))
        })
        .collect();
    recent.sort_by(|(a, day_a, _, _), (b, day_b, _, _)| {
        day_b
            .cmp(day_a)
            .then_with(|| b.played_at.cmp(&a.played_at))
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    recent.truncate(12);
    // A modest prior prevents one lucky win from causing a large jump. Each
    // game is weighted by recency and its actual opponent's strength.
    let newest = recent.first().map_or(0, |row| row.1);
    let residual = |estimate: f64| {
        1.5 * (base as f64 - estimate) / 400.0
            + recent
                .iter()
                .enumerate()
                .map(|(i, (_, day, score, opponent))| {
                    let weight = 0.88f64.powi(i as i32)
                        * 2.0f64.powf(-((newest - day) as f64) / HALF_LIFE_DAYS);
                    let expected =
                        1.0 / (1.0 + 10.0f64.powf((*opponent as f64 - estimate) / 400.0));
                    weight * (score - expected)
                })
                .sum::<f64>()
    };
    let (mut lo, mut hi) = (100.0, 3200.0);
    for _ in 0..32 {
        let mid = (lo + hi) / 2.0;
        if residual(mid) > 0.0 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    // About a 36% expected player score under the local rating approximation.
    // Continued wins raise the estimate; losses ease the next challenge.
    (((lo + hi) / 2.0).round() as i32 + 100).clamp(400, 2400)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn practice_results(results: &[&str]) -> Vec<crate::Game> {
        results
            .iter()
            .enumerate()
            .map(|(i, result)| crate::Game {
                white: "Me".into(),
                black: "Bot".into(),
                result: (*result).into(),
                date: format!("2026.11.{:02}", i + 1),
                source: "practice".into(),
                session_id: format!("game-{i}"),
                opponent_rating: Some(550),
                ..Default::default()
            })
            .collect()
    }
    #[test]
    fn recent_bot_wins_raise_difficulty_and_losses_ease_it() {
        let wins = practice_results(&["1-0"; 8]);
        let losses = practice_results(&["0-1"; 8]);
        assert_eq!(adaptive(&[], "Me", 500), 600);
        assert!(adaptive(&wins, "Me", 500) > 750);
        assert!(adaptive(&losses, "Me", 500) < 550);
        let mut reversed = wins.clone();
        reversed.reverse();
        assert_eq!(adaptive(&wins, "Me", 500), adaptive(&reversed, "Me", 500));
        assert_eq!(adaptive(&wins, "Stranger", 500), 600);
    }
    #[test]
    fn adaptation_ignores_unfinished_games_and_respects_limits() {
        let mut games = practice_results(&["*"; 8]);
        assert_eq!(adaptive(&games, "Me", 1000), 1100);
        for game in &mut games {
            game.result = "1-0".into();
            game.opponent_rating = Some(2400);
        }
        assert_eq!(adaptive(&games, "Me", 2400), 2400);
        assert_eq!(adaptive(&[], "Me", 100), 400);
    }
    #[test]
    fn elo_matches_standard_examples() {
        assert_eq!(update(1200, 1200, 1.0, 0), 1220);
        assert_eq!(update(1200, 1200, 0.0, 0), 1180);
        assert_eq!(update(1200, 1200, 0.5, 0), 1200);
        assert_eq!(update(1200, 1200, 1.0, 30), 1210);
        assert_eq!(from_level(20), 2395);
    }
    #[test]
    fn date_weighting_is_independent_of_input_order() {
        let a = crate::Game {
            white: "Me".into(),
            black: "Other".into(),
            result: "1-0".into(),
            date: "2026.10.23".into(),
            white_elo: Some(1000),
            ..Default::default()
        };
        let b = crate::Game {
            date: "2026.11.06".into(),
            white_elo: Some(1600),
            ..a.clone()
        };
        assert_eq!(weighted(&[a.clone(), b.clone()], "Me").rating, 1400);
        assert_eq!(weighted(&[b.clone(), a.clone()], "Me").rating, 1400);
        let unfinished = crate::Game {
            result: "*".into(),
            white_elo: Some(3000),
            ..b
        };
        assert_eq!(weighted(&[a, unfinished], "Me").rating, 1000);
    }
}
