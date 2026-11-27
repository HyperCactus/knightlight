use crate::{
    bad, board,
    engine::{Engine, Evaluation},
    error, fen, position, tactics, training, unavailable, ApiError, Puzzle, Shared,
};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shakmaty::{Chess, Position};
use std::{
    collections::{BTreeMap, HashMap},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn today() -> u64 {
    (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + 36000)
        / 86400
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Card {
    pub box_level: u8,
    pub due: u64,
    pub attempts: u32,
    pub clean: u32,
    pub last: u64,
    pub outcome: String,
    pub recall_correct: u32,
    pub recall_wrong: u32,
}
impl Card {
    pub fn record(&mut self, outcome: &str, day: u64) {
        let already_reviewed = self.attempts > 0 && self.last == day;
        self.attempts += 1;
        self.last = day;
        self.outcome = outcome.into();
        if outcome == "clean" {
            self.clean += 1;
            if !already_reviewed {
                self.box_level = (self.box_level + 1).min(5)
            }
        } else {
            self.box_level = 0
        }
        let intervals = [1, 1, 3, 7, 14, 30];
        self.due = day + intervals[self.box_level as usize];
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Practice {
    pub cards: BTreeMap<String, Card>,
    pub days: BTreeMap<u64, [u32; 2]>,
    pub xp: u32,
    pub xp_days: BTreeMap<u64, u32>,
    pub rewarded: BTreeMap<String, u64>,
    pub recall_rewarded: BTreeMap<String, u64>,
    pub seen_positions: BTreeMap<String, u64>,
    pub excluded_positions: std::collections::HashSet<String>,
    pub selection_nonce: u64,
    #[serde(skip)]
    pub drills: HashMap<String, Drill>,
}
#[derive(Clone)]
pub struct Drill {
    id: String,
    fen: String,
    best: Evaluation,
    turns: u8,
    helped: bool,
    failed: bool,
    done: bool,
    recorded: bool,
    revision: u32,
    replies: HashMap<String, Value>,
    theme: String,
    reflected: bool,
    line: Vec<String>,
    target_turns: u8,
    choices: usize,
}
impl Practice {
    pub fn load() -> Result<Self, String> {
        Ok(
            crate::history::read_json(std::path::Path::new("data/practice.json"))?
                .unwrap_or_default(),
        )
    }
    pub fn save(&self) -> Result<(), String> {
        crate::history::write_json(std::path::Path::new("data/practice.json"), self)
    }
    // Drills contain transient boards, continuations and reply caches; queue
    // planning needs persisted progress only, and never holds the live lock.
    fn selection_snapshot(&self) -> Self {
        Self {
            cards: self.cards.clone(),
            days: self.days.clone(),
            xp: self.xp,
            xp_days: self.xp_days.clone(),
            rewarded: self.rewarded.clone(),
            recall_rewarded: self.recall_rewarded.clone(),
            seen_positions: self.seen_positions.clone(),
            excluded_positions: self.excluded_positions.clone(),
            selection_nonce: self.selection_nonce,
            drills: HashMap::new(),
        }
    }
    fn award(&mut self, id: &str, outcome: &str, day: u64) -> u32 {
        if self.rewarded.get(id) == Some(&day) {
            return 0;
        }
        let amount = match outcome {
            "clean" => 15,
            "revealed" => 5,
            _ => 10,
        };
        self.rewarded.insert(id.into(), day);
        self.xp += amount;
        *self.xp_days.entry(day).or_default() += amount;
        amount
    }
    fn finish(&mut self, id: &str, outcome: &str) -> u32 {
        let day = today();
        self.cards
            .entry(id.into())
            .or_default()
            .record(outcome, day);
        let counts = self.days.entry(day).or_default();
        counts[0] += 1;
        counts[1] += (outcome == "clean") as u32;
        self.award(id, outcome, day)
    }
}
pub fn overview(p: &Practice, puzzles: &[Puzzle]) -> Value {
    let day = today();
    let mut themes: BTreeMap<String, (u32, u32, u32)> = BTreeMap::new();
    let mut queue = puzzles.to_vec();
    // Due positions before new positions; a stable rank within each theme rotates exposure.
    queue.sort_by(|a, b| {
        let rank = |x: &Puzzle| {
            let c = p.cards.get(&x.id);
            match c {
                Some(c) if c.due <= day => (0, c.due),
                None => (1, 0),
                Some(c) => (2, c.due),
            }
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b.priority.total_cmp(&a.priority))
    });
    for x in puzzles {
        let t = themes.entry(x.theme.clone()).or_default();
        t.0 += 1;
        if p.cards.get(&x.id).is_none_or(|c| c.due <= day) {
            t.1 += 1
        }
        if p.cards.get(&x.id).is_some_and(|c| c.box_level >= 3) {
            t.2 += 1
        }
    }
    let due = puzzles
        .iter()
        .filter(|x| p.cards.get(&x.id).is_none_or(|c| c.due <= day))
        .count();
    let mut counts: HashMap<String, u8> = HashMap::new();
    let mut ids = vec![];
    for x in &queue {
        if ids.len() >= 10 {
            break;
        }
        let c = counts.entry(x.theme.clone()).or_default();
        if *c < 3 && p.cards.get(&x.id).is_none_or(|c| c.due <= day) {
            ids.push(x.id.clone());
            *c += 1
        }
    }
    if ids.len() < 10 {
        for x in &queue {
            if ids.len() >= 10 {
                break;
            }
            if !ids.contains(&x.id) && p.cards.get(&x.id).is_none_or(|c| c.due <= day) {
                ids.push(x.id.clone())
            }
        }
    }
    // Mix in fresh examples of the same motifs, so memorizing a personal board is insufficient.
    let personal_themes: std::collections::HashSet<_> = puzzles
        .iter()
        .filter(|x| x.game.is_some())
        .map(|x| x.theme.as_str())
        .collect();
    let fresh: Vec<_> = queue
        .iter()
        .filter(|x| {
            x.game.is_none()
                && personal_themes.contains(x.theme.as_str())
                && !ids.contains(&x.id)
                && p.cards.get(&x.id).is_none_or(|c| c.due <= day)
        })
        .take(2)
        .map(|x| x.id.clone())
        .collect();
    for id in fresh {
        if ids.len() >= 10 {
            ids.pop();
        }
        ids.insert(ids.len().saturating_sub(1), id);
    }
    let week:Vec<_>=(0..7).rev().map(|i|{let d=day.saturating_sub(i);json!({"day":d,"total":p.days.get(&d).map_or(0,|s|s[0]),"clean":p.days.get(&d).map_or(0,|s|s[1])})}).collect();
    let totals = p
        .days
        .values()
        .fold([0, 0], |a, v| [a[0] + v[0], a[1] + v[1]]);
    let mut streak = 0;
    let mut d = if p.days.contains_key(&day) {
        day
    } else {
        day.saturating_sub(1)
    };
    while p.days.get(&d).is_some_and(|n| n[0] > 0) {
        streak += 1;
        if d == 0 {
            break;
        }
        d -= 1;
    }
    let daily_unique = p.rewarded.values().filter(|d| **d == day).count();
    let achievements = json!([
        {"id":"first","name":"First discovery","description":"Complete your first learning position","earned":p.xp>0},
        {"id":"explorer","name":"Pattern explorer","description":"Practice five different positions","earned":p.cards.len()>=5},
        {"id":"builder","name":"Memory builder","description":"Retrieve a pattern on a later day","earned":p.cards.values().any(|c|c.box_level>=2)},
        {"id":"streak","name":"Finding a rhythm","description":"Practice on three consecutive days","earned":streak>=3}
    ]);
    json!({"due":due,"queue":ids,"themes":themes.iter().map(|(name,(total,due,mastered))|json!({"name":name,"total":total,"due":due,"mastered":mastered})).collect::<Vec<_>>(),"week":week,"streak":streak,"today":p.days.get(&day).copied().unwrap_or([0,0]),"total":totals[0],"clean":totals[1],"cards":p.cards,"xp":p.xp,"today_xp":p.xp_days.get(&day).copied().unwrap_or(0),"daily_unique":daily_unique,"level":1+p.xp/150,"level_progress":p.xp%150,"achievements":achievements})
}
#[derive(Default, Deserialize)]
pub struct QueueRequest {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    focus: String,
}
pub async fn summary(
    State(app): State<Shared>,
    Query(req): Query<QueueRequest>,
) -> Result<Json<Value>, ApiError> {
    let personal: Vec<_> = app
        .data
        .lock()
        .unwrap()
        .puzzles
        .iter()
        .filter(|p| p.game.is_some())
        .cloned()
        .collect();
    let (rating, weaknesses) = {
        let l = app.learner.lock().unwrap();
        let weaknesses = l
            .themes
            .iter()
            .map(|(name, s)| {
                (
                    name.clone(),
                    (s.errors as f64) / (s.count as f64 + 5.0)
                        + (s.loss / (s.count.max(1) as f64) / 400.0).min(1.0),
                )
            })
            .collect();
        (l.practice_rating, weaknesses)
    };
    let p = app.practice.lock().unwrap().selection_snapshot();
    let out = tokio::task::spawn_blocking(move || {
    let pool_ready = app.puzzle_bank.ready();
    let bank = app.puzzle_bank.snapshot();
    let day = today();
    let candidates = crate::puzzles::recommend(
        &bank,
        &personal,
        &crate::puzzles::Selection {
            practice: &p,
            weaknesses: &weaknesses,
            rating,
            review: req.mode == "review",
            focus: if req.focus.is_empty() {
                "all"
            } else {
                &req.focus
            },
        },
    );
    let mut out = overview(&p, &candidates);
    out["pool_size"] = json!(bank.len() + personal.len());
    out["pool_ready"] = json!(pool_ready);
    out["fresh_mode"] = json!(req.mode != "review");
    out["seen_count"] = json!(p.seen_positions.len());
    out["candidates"] = json!(candidates);
    out["weaknesses"] = json!(weaknesses);
    let mut themes = BTreeMap::<String, (usize, usize, usize)>::new();
    let mut positions = std::collections::HashSet::new();
    for puzzle in personal.iter().chain(bank.iter()) {
        if !positions.insert(&puzzle.position_key)
            || p.excluded_positions.contains(&puzzle.position_key)
        {
            continue;
        }
        let t = themes.entry(puzzle.theme.clone()).or_default();
        t.0 += 1;
        let card = p.cards.get(&puzzle.id);
        if crate::puzzles::available(puzzle, &p, rating, req.mode == "review", day) {
            t.1 += 1;
        }
        if card.is_some_and(|c| c.box_level >= 3) {
            t.2 += 1;
        }
    }
    out["due"] = json!(themes.iter().filter(|(name, _)| req.focus.is_empty() || req.focus == "all" || **name == req.focus).map(|(_, t)| t.1).sum::<usize>());
    out["themes"]=json!(themes.iter().map(|(name,(total,due,mastered))|json!({"name":name,"total":total,"due":due,"mastered":mastered})).collect::<Vec<_>>());
    out
    }).await.map_err(unavailable)?;
    Ok(Json(out))
}
#[derive(Deserialize)]
pub struct StartRequest {
    id: String,
    #[serde(default)]
    fresh: bool,
}
pub async fn start(
    State(app): State<Shared>,
    Json(req): Json<StartRequest>,
) -> Result<Json<Value>, ApiError> {
    let puzzle = app
        .data
        .lock()
        .unwrap()
        .puzzles
        .iter()
        .find(|p| p.id == req.id)
        .cloned()
        .or_else(|| {
            app.puzzle_bank
                .snapshot()
                .iter()
                .find(|p| p.id == req.id)
                .cloned()
        })
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Position not found"))?;
    let fresh = req.fresh;
    if fresh {
        let p = app.practice.lock().unwrap();
        if p.seen_positions.contains_key(&puzzle.position_key) || p.cards.contains_key(&puzzle.id) {
            return Err(error(
                StatusCode::CONFLICT,
                "This position was already explored. Choosing a fresh one.",
            ));
        }
    }
    let permit = app
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(unavailable)?;
    let a = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let pos = position(&puzzle.fen)?;
        let mut engine = Engine::new()?;
        let plan = match crate::puzzles::verify(&mut engine, &puzzle) {
            Ok(plan) => plan,
            Err(reason)
                if reason.starts_with("This position") || reason.starts_with("The published") =>
            {
                let mut p = a.practice.lock().unwrap();
                p.excluded_positions.insert(puzzle.position_key.clone());
                p.save()?;
                return Err(format!("unsuitable:{reason}"));
            }
            Err(reason) => return Err(reason),
        };
        let best = plan.best;
        let target_turns = plan.line.len().div_ceil(2).min(5) as u8;
        let key = puzzle.position_key.clone();
        let session = format!("{:032x}", rand::random::<u128>());
        let drill = Drill {
            id: puzzle.id,
            fen: puzzle.fen,
            best,
            turns: 0,
            helped: false,
            failed: false,
            done: false,
            recorded: false,
            revision: 0,
            replies: HashMap::new(),
            theme: puzzle.theme,
            reflected: false,
            line: plan.line,
            target_turns: target_turns.max(1),
            choices: plan.choices,
        };
        let out = describe(&drill, &pos, &session);
        let mut p = a.practice.lock().unwrap();
        if fresh && (p.seen_positions.contains_key(&key) || p.cards.contains_key(&drill.id)) {
            return Err("seen:This position was already explored. Choosing a fresh one.".into());
        }
        if p.drills.len() >= 128 {
            p.drills.clear();
        }
        p.seen_positions.insert(key, today());
        p.selection_nonce = p.selection_nonce.wrapping_add(1);
        p.drills.insert(session, drill);
        p.save()?;
        Ok::<_, String>(out)
    })
    .await
    .map_err(unavailable)?
    .map_err(|e| {
        if e.starts_with("seen:") {
            error(
                StatusCode::CONFLICT,
                "This position was already explored. Choosing a fresh one.",
            )
        } else if e.starts_with("unsuitable:") {
            error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "This position is being replaced with a clearer puzzle.",
            )
        } else {
            unavailable(e)
        }
    })?;
    Ok(Json(result))
}
fn describe(d: &Drill, pos: &Chess, session: &str) -> Value {
    json!({"session":session,"revision":d.revision,"board":board(pos),"best":d.best.pv.first(),"turns":d.turns,"target_turns":d.target_turns,"good_choices":d.choices,"complete":d.done,"objective":if d.best.mate==Some(1){"Find checkmate"}else if d.best.mate.is_some_and(|n|n>0){"Keep the mating attack"}else{"Find a strong continuation"},"evidence":tactics::suggestion_facts(pos,&d.best),"helped":d.helped})
}
// Search both sides of a move at equal depth. Preserve forced mates explicitly.
pub fn acceptable(best: &Evaluation, after: &Evaluation, pos: &Chess) -> bool {
    if pos.is_checkmate() {
        return true;
    }
    if best.mate == Some(1) {
        return false;
    }
    if best.mate.is_some_and(|n| n > 0) {
        return after.mate.is_some_and(|n| n < 0);
    }
    if after.mate.is_some_and(|n| n > 0) && best.mate.is_none() {
        return false;
    }
    (best.score + after.score).max(0) <= 60
}
#[derive(Deserialize)]
pub struct MoveRequest {
    uci: String,
    revision: u32,
    request_id: String,
}
pub async fn play(
    State(app): State<Shared>,
    Path(session): Path<String>,
    Json(req): Json<MoveRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.request_id.is_empty() || req.request_id.len() > 80 {
        return Err(bad("Invalid request identifier"));
    }
    let d = {
        let p = app.practice.lock().unwrap();
        let d = p.drills.get(&session).ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "Practice session expired. Start this position again.",
            )
        })?;
        if let Some(out) = d.replies.get(&req.request_id) {
            return Ok(Json(out.clone()));
        }
        if d.done || d.revision != req.revision {
            return Err(error(
                StatusCode::CONFLICT,
                "This position has changed. Reload it before moving.",
            ));
        }
        d.clone()
    };
    let pos = position(&d.fen).map_err(bad)?;
    let mut after = pos.clone();
    training::play(&mut after, &req.uci).map_err(bad)?;
    let permit = app
        .compute
        .clone()
        .acquire_owned()
        .await
        .map_err(unavailable)?;
    let a = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut e = Engine::new()?;
        let mut evaluation = training::eval(&mut e, &after, 16)?;
        let mut baseline=d.best.clone();
        if !acceptable(&baseline,&evaluation,&after) && (baseline.pv.first()==Some(&req.uci) || (baseline.score+evaluation.score).abs()<180) {
            baseline=training::eval(&mut e,&pos,19)?;
            evaluation=training::eval(&mut e,&after,19)?;
        }
        let accepted=acceptable(&baseline,&evaluation,&after);
        let mut next = d.clone();
        next.best=baseline.clone();
        next.revision += 1;
            let mut reply = None;
            let mut reply_choices = vec![];
        let player_step = json!({"uci":req.uci,"fen":fen(&after)});
        let explanation = training::describe(&pos, &req.uci, &baseline, &evaluation, 0, true);
        if accepted {
            next.turns += 1;
            if next.line.first()==Some(&req.uci) {next.line.remove(0);} else {next.line.clear();}
            next.done = next.turns >= next.target_turns || after.is_game_over();
            if !next.done {
                if let Some(u) = evaluation.pv.first() {
                        let mut choices=vec![u.clone()];
                        for m in after.legal_moves() {let candidate=shakmaty::uci::UciMove::from_standard(m).to_string();if !choices.contains(&candidate){choices.push(candidate)}
                        if choices.len()>=3{break}}
                        for candidate in choices {reply_choices.push(json!({"uci":candidate,"san":training::san(&after,&candidate)}));}
                        let shift=rand::random::<u8>()as usize%reply_choices.len();reply_choices.rotate_left(shift);
                    let name = training::san(&after, u);
                    training::play(&mut after, u)?;
                    if next.line.first()==Some(u) {next.line.remove(0);} else {next.line.clear();}
                    reply = Some(json!({"uci":u,"san":name,"fen":fen(&after)}));
                }
            }
            next.done |= after.is_game_over();
            if !next.done {
                let options=crate::puzzles::analyze(&mut e,&after,15)?;
                // Finish once the tactic is resolved, before drifting into routine or losing moves.
                next.done = !crate::puzzles::meaningful(&options,&after);
                if !next.done {next.best=options[0].clone();}

            }
            next.fen = fen(&after);
        } else {
            // A changed engine recommendation must update the hint instead of trapping the user on it.
            next.failed |= d.best.pv.first()!=Some(&req.uci);
        }
        let current = position(&next.fen)?;
        let mut out = describe(&next, &current, &session);
        out["accepted"] = json!(accepted);
        out["player_step"] = player_step;
        out["reply_step"] = json!(reply);
            out["reply_choices"] = json!(reply_choices);
        out["explanation"] = json!(explanation.explanation);
        out["feedback_evidence"] = json!(explanation.evidence);
            out["assessment"]=json!({"grade":explanation.grade,"loss":explanation.loss,"before":explanation.eval_before,"after":explanation.eval_after});
            if next.done {out["reflection"]=reflection(&next.theme,false);}
        out["clean"] = json!(!next.failed && !next.helped);
        let mut p = a.practice.lock().unwrap();
        let live = p.drills.get(&session).ok_or("Session expired")?;
        if live.revision != d.revision {
            return Err("Position changed while checking the move".into());
        }
        next.helped |= live.helped;
        next.recorded |= live.recorded;
        out["clean"] = json!(!next.failed && !next.helped);
        if next.done && !next.recorded {
            let earned = p.finish(
                &next.id,
                if next.helped {
                    "assisted"
                } else if next.failed {
                    "retry"
                } else {
                    "clean"
                },
            );
            out["xp_earned"] = json!(earned);
            next.recorded = true;
        }
        next.replies.insert(req.request_id, out.clone());
        if next.replies.len() > 40 {
            next.replies.clear();
        }
        p.drills.insert(session, next);
        p.save()?;
        Ok::<_, String>(out)
    })
    .await
    .map_err(unavailable)?
    .map_err(unavailable)?;
    Ok(Json(result))
}
fn reflection(theme: &str, answer: bool) -> Value {
    let (question,correct,why)=match theme {
        "Forks & double attacks"=>("What should your scan look for?","One move that attacks two valuable targets","Count the targets a move creates, then check the opponent's forcing replies before assuming you can win one."),
        "Pins"=>("What makes an absolute pin restrict a piece?","Moving off the line would expose its king","Trace the attacker, the pinned piece, and the king. Then consider moves that stay on the line or remove the attacker."),
        "King safety"|"Checkmate patterns"=>("What should you verify before calling an attack checkmate?","Every legal king escape, capture, and block","A check alone is not mate. Test all three defensive resources and notice which squares the attacking pieces cover."),
        "Material & captures"=>("Before capturing, what should you calculate?","The opponent's recaptures and forcing replies","A capture is not automatically a gain. Compare the whole exchange, including checks and newly opened lines."),
        "Endgame technique"=>("What deserves special attention with few pieces left?","King activity, pawn races, and promotion squares","Look at whether the kings can stop the pawns and whether a forcing move changes the race."),
        _=>("How can you test a promising positional move?","Check forcing replies, then compare the resulting activity","A useful plan must survive checks, captures, and threats. Compare the position after your opponent responds."),
    };
    let mut options = vec![
        correct,
        "Only the material count before the move",
        "The move that looks most natural at first glance",
    ];
    let shift = theme.len() % 3;
    options.rotate_left(shift);
    if answer {
        json!({"correct":correct,"why":why})
    } else {
        json!({"question":question,"options":options})
    }
}
#[derive(Deserialize)]
pub struct ReflectionRequest {
    answer: String,
}
pub async fn reflect(
    State(app): State<Shared>,
    Path(session): Path<String>,
    Json(req): Json<ReflectionRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut p = app.practice.lock().unwrap();
    let d = p
        .drills
        .get_mut(&session)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Practice session expired"))?;
    if !d.done {
        return Err(error(
            StatusCode::CONFLICT,
            "Complete the continuation first",
        ));
    }
    let options = reflection(&d.theme, false);
    if !options["options"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o.as_str() == Some(&req.answer))
    {
        return Err(bad("Choose one of the listed answers"));
    }
    let solution = reflection(&d.theme, true);
    let correct = solution["correct"].as_str() == Some(&req.answer);
    let record = !d.reflected;
    d.reflected = true;
    let id = d.id.clone();
    if record {
        let card = p.cards.entry(id.clone()).or_default();
        if correct {
            card.recall_correct += 1
        } else {
            card.recall_wrong += 1;
            card.box_level = 0;
            card.due = today() + 1;
        }
        if correct && p.recall_rewarded.get(&id) != Some(&today()) {
            p.recall_rewarded.insert(id, today());
            p.xp += 5;
            *p.xp_days.entry(today()).or_default() += 5;
        }
        p.save().map_err(unavailable)?;
    }
    Ok(Json(
        json!({"correct":correct,"explanation":solution["why"],"answer":solution["correct"]}),
    ))
}
#[derive(Deserialize)]
pub struct HelpRequest {
    kind: String,
}
pub async fn help(
    State(app): State<Shared>,
    Path(session): Path<String>,
    Json(req): Json<HelpRequest>,
) -> Result<Json<Value>, ApiError> {
    if !["hint", "reveal"].contains(&req.kind.as_str()) {
        return Err(bad("Unknown help type"));
    }
    let mut p = app.practice.lock().unwrap();
    let d = p
        .drills
        .get_mut(&session)
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Practice session expired"))?;
    d.helped = true;
    let id = d.id.clone();
    let record = req.kind == "reveal" && !d.recorded;
    if record {
        d.recorded = true;
    }
    let out = json!({"best":d.best.pv.first(),"line":training::line(&position(&d.fen).map_err(bad)?,&d.best.pv),"evidence":tactics::suggestion_facts(&position(&d.fen).map_err(bad)?,&d.best)});
    if record {
        p.finish(&id, "revealed");
    }
    p.save().map_err(unavailable)?;
    Ok(Json(out))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewards_are_for_distinct_daily_retrievals() {
        let mut p = Practice::default();
        assert_eq!(p.award("fork", "clean", 100), 15);
        assert_eq!(p.award("fork", "clean", 100), 0);
        assert_eq!(p.award("fork", "assisted", 100), 0);
        assert_eq!(p.award("pin", "assisted", 100), 10);
        assert_eq!(p.award("fork", "clean", 101), 15);
        let saved: Practice = serde_json::from_str(&serde_json::to_string(&p).unwrap()).unwrap();
        assert_eq!(saved.xp, 40);
        assert_eq!(saved.xp_days[&100], 25);
    }
    #[test]
    fn schedule_requires_unaided_success() {
        let mut c = Card::default();
        c.record("clean", 100);
        assert_eq!(c.due, 101);
        c.record("clean", 101);
        assert_eq!(c.due, 104);
        c.record("clean", 101);
        assert_eq!(
            c.box_level, 2,
            "Repeating the same board immediately must not inflate spaced mastery"
        );
        c.record("revealed", 104);
        assert_eq!(c.box_level, 0);
        assert_eq!(c.clean, 3);
        assert_eq!(c.due, 105);
    }
    #[test]
    fn any_actual_mate_is_accepted_but_missing_mate_is_not() {
        let best = Evaluation {
            score: 9999,
            mate: Some(1),
            pv: vec![],
        };
        let quiet = position("7k/8/6K1/8/8/8/8/Q7 b - - 1 1").unwrap();
        let eval = Evaluation {
            score: -9997,
            mate: Some(-3),
            pv: vec![],
        };
        assert!(!acceptable(&best, &eval, &quiet));
        let mate = position("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1").unwrap();
        assert!(acceptable(&best, &eval, &mate));
    }
    #[test]
    fn centipawn_window_is_from_movers_perspective() {
        let b = Evaluation {
            score: 120,
            mate: None,
            pv: vec![],
        };
        let p = Chess::default();
        assert!(acceptable(
            &b,
            &Evaluation {
                score: -100,
                mate: None,
                pv: vec![]
            },
            &p
        ));
        assert!(!acceptable(
            &b,
            &Evaluation {
                score: 80,
                mate: None,
                pv: vec![]
            },
            &p
        ));
    }
}
