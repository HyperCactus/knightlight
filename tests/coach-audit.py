"""Play disposable games and independently validate coaching with python-chess.
Run with vendor/maia-env/bin/python tests/coach-audit.py. No audio is requested.
"""
import json, os, pathlib, random, socket, subprocess, tempfile, time, urllib.request
import chess, chess.engine, chess.pgn

ROOT = pathlib.Path(__file__).resolve().parents[1]
rng = random.Random(147)
counts = dict(games=0, reviewed_moves=0, targeted_positions=0, legal_capture_arrows=0,
              continuation_moves=0, queen_recommendations_with_recaptures=0, outlooks=0, contextual_plans=0)
samples = []
replay = json.loads(pathlib.Path(os.environ['CHESS_AUDIT_REPLAY']).read_text()) if os.environ.get('CHESS_AUDIT_REPLAY') else None
game_results = []
game_dialogue = []

def request(base, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + '/api/' + path, data=data,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.status, json.load(response)

def same(board, fen):
    other = chess.Board(fen)
    return board.board_fen() == other.board_fen() and board.turn == other.turn and board.castling_rights == other.castling_rights

def validate_line(board, line):
    board = board.copy()
    for step in line:
        move = chess.Move.from_uci(step['uci'])
        assert move in board.legal_moves, (board.fen(), step)
        board.push(move)
        assert same(board, step['fen']), (board.fen(), step['fen'])
    return board

def validate(record):
    before = chess.Board(record['before'])
    assert chess.Move.from_uci(record['best']) in before.legal_moves
    validate_line(before, record['best_line'])
    validate_line(chess.Board(record['after']), record['reply_line'])
    if record['loss'] <= 80:
        assert record['evidence'][0]['context'] == 'played', record
        assert 'Another option' not in record['explanation'], record
    for fact in record['evidence']:
        assert len(fact['text'].split()) <= 65, fact
        assert not any(phrase in fact['text'] for phrase in ['positional choice', 'not promising', 'can legally take']), fact
        if any(plan in fact['title'] for plan in ['Move out of danger', 'Free the bishop', 'Use the file', 'Advance the passer']):
            counts['contextual_plans'] += 1
        if fact.get('before') and fact.get('uci'):
            validate_line(chess.Board(fact['before']), [dict(uci=fact['uci'], fen=fact['fen'])])
        board = chess.Board(fact['fen'])
        for arrow in fact['arrows']:
            fr, to = map(chess.parse_square, [arrow['from'], arrow['to']])
            assert arrow['from'] in fact['squares'] and arrow['to'] in fact['squares']
            if arrow['kind'] == 'capture':
                assert any(m.from_square == fr and m.to_square == to and board.is_capture(m)
                           for m in board.legal_moves), (fact, arrow)
                counts['legal_capture_arrows'] += 1
            if arrow['kind'] == 'support':
                assert board.color_at(fr) == board.color_at(to) and to in board.attacks(fr)
            if board.piece_type_at(fr) == chess.KING and arrow['kind'] == 'threat':
                assert any(m.from_square == fr and m.to_square == to for m in board.legal_moves)
        steps = fact.get('follow_up', [])
        for step in steps:
            assert same(board, step['before'])
            board = validate_line(board, [step])
            counts['continuation_moves'] += 1
        outlook = fact.get('outlook')
        if outlook:
            counts['outlooks'] += 1
            assert 1 <= len(outlook['steps']) <= 4
            assert len(outlook['text'].split()) <= 40
            start = chess.Board(fact['before'])
            board = chess.Board(fact['fen'])
            for step in outlook['steps']:
                assert same(board, step['before'])
                board = validate_line(board, [step])
                counts['continuation_moves'] += 1
            value = {chess.PAWN:100, chess.KNIGHT:320, chess.BISHOP:330, chess.ROOK:500, chess.QUEEN:900, chess.KING:0}
            def balance(b):
                return sum(value[p.piece_type] * (1 if p.color == start.turn else -1) for p in b.piece_map().values())
            if outlook['title'] == 'The payoff': assert balance(board) > balance(start), outlook
            if outlook['title'] == 'After the queen trade': assert not board.queens, outlook
            if outlook['title'] == 'Finish the attack': assert board.is_checkmate(), outlook
    best = chess.Move.from_uci(record['best'])
    if before.piece_type_at(best.from_square) == chess.QUEEN:
        after = before.copy(); after.push(best)
        if any(m.to_square == best.to_square and after.is_capture(m) for m in after.legal_moves):
            own_facts = [f for f in record['evidence'] if f['context'] in ['played', 'alternative']]
            assert any(f.get('follow_up') for f in own_facts), record
            counts['queen_recommendations_with_recaptures'] += 1

with tempfile.TemporaryDirectory(prefix='chess-coach-audit-') as tmp:
    folder = pathlib.Path(tmp)
    for name in ['static', 'scripts', 'vendor']:
        (folder/name).symlink_to(ROOT/name)
    (folder/'data').mkdir()
    (folder/'data'/'openings').symlink_to(ROOT/'data'/'openings')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    # An opening-only fixture lets the server become ready before self-play begins.
    (folder/'fixture.pgn').write_text('[White "Audit"]\n[Black "Other"]\n[Result "*"]\n\n1. e4 e5 *\n')
    with (folder/'server.log').open('w+') as log:
        server = subprocess.Popen([str(ROOT/'target/release/chess-study')], cwd=folder,
                                  env={**os.environ, 'PORT': str(port), 'CHESS_PLAYER':'Audit'}, stdout=log, stderr=log)
        engine = None
        try:
            for _ in range(300):
                try:
                    if request(base, 'data')[1]['ready']: break
                except Exception: pass
                time.sleep(.1)
            else: raise AssertionError('Audit server did not become ready')
            engine = chess.engine.SimpleEngine.popen_uci(str(ROOT/'vendor/stockfish/usr/games/stockfish'))
            engine.configure({'Threads':1, 'Hash':32})
            known = [['f2f3','e7e5','g2g4','d8h4'],
                     ['e2e4','e7e5','d1h5','b8c6','f1c4','g8f6','h5f7']]
            for game_no in range(6):
                board = chess.Board(); moves = []
                if replay:
                    for move in [m for m in replay['dialogue'] if m['game'] == game_no+1]:
                        board.push_uci(move['uci']); moves.append(move['uci'])
                elif game_no < 2:
                    for uci in known[game_no]: board.push_uci(uci); moves.append(uci)
                else:
                    for ply in range(48):
                        if board.is_game_over(): break
                        if game_no < 4 and board.turn == chess.BLACK:
                            reply = request(base, 'bot', {'fen':board.fen(), 'moves':moves,
                                    'rating':800 if game_no == 2 else 1400, 'style':'varied', 'session_id':f'audit-{game_no}'})[1]
                            move = chess.Move.from_uci(reply['move'])
                        elif rng.random() < .12:
                            move = rng.choice(list(board.legal_moves))
                        else:
                            lines = engine.analyse(board, chess.engine.Limit(depth=5), multipv=3)
                            move = rng.choice(lines[:1] if rng.random() < .65 else lines)['pv'][0]
                        assert move in board.legal_moves
                        moves.append(move.uci()); board.push(move)
                saved = request(base, 'games', {'white':'Audit','black':f'Opponent {game_no}',
                         'result':board.result() if board.is_game_over() else '*', 'date':'2026.11.07',
                         'event':f'Coaching audit {game_no}', 'moves':moves, 'session_id':f'audit-game-{game_no}',
                         'opponent_rating':1000})[1]
                index = saved['index']
                for _ in range(600):
                    status, review = request(base, f'reviews/{index}')
                    if status == 200: break
                    time.sleep(.1)
                else: raise AssertionError('Review did not finish')
                for move in review['moves']:
                    validate(move); counts['reviewed_moves'] += 1
                    game_dialogue.append({'game':game_no+1, **move})
                game_results.append({'game':game_no+1, 'plies':len(moves), 'result':board.result() if board.is_game_over() else '*', 'opponent':'Maia-3' if game_no in [2,3] else 'Stockfish/fixture'})
                counts['games'] += 1
                print(f'PASS game {game_no+1}: {len(moves)} legal moves and all coaching continuations checked', flush=True)
            targets = {
                'delayed_fork':'3r3k/6pp/8/4N3/8/8/P7/6K1 w - - 0 12',
                'protected_king':'8/8/4k3/3p4/8/8/6B1/3Q2K1 w - - 0 1',
                'pinned_defender':'4k3/3pr3/2B5/8/8/8/8/3QR1K1 w - - 0 1',
                'hanging_queen':'3r3k/8/8/3p4/8/8/8/3Q2K1 w - - 0 1',
                'queen_trade':'r1bqkb1r/ppp3pp/4p3/3P4/4QP1P/8/PP4P1/R1B1K1NR b KQkq - 0 13',
                'queen_sacrifice':'5r1k/6pp/4Q2N/8/8/8/8/6K1 w - - 0 1',
                'protected_king_target':'7k/8/8/8/5p2/4n3/8/6K1 w - - 0 1',
            }
            # Include queen-for-pawn recommendations from real history, read-only.
            for file in sorted((ROOT/'data/reviews').glob('*.json')):
                for move in json.loads(file.read_text())['moves']:
                    b = chess.Board(move['before']); u = chess.Move.from_uci(move['best'])
                    if u in b.legal_moves and b.piece_type_at(u.from_square) == chess.QUEEN and b.piece_type_at(u.to_square) == chess.PAWN:
                        b.push(u)
                        if any(m.to_square == u.to_square and b.is_capture(m) for m in b.legal_moves):
                            if move['before'] not in targets.values():
                                targets['history_'+str(len(targets))] = move['before']
                if len(targets) >= 16: break
            for name, fen in targets.items():
                record = request(base, 'coach', {'fen':fen})[1]
                validate(record); counts['targeted_positions'] += 1
                if name == 'hanging_queen': assert record['best'] != 'd1d5'
                if name == 'queen_sacrifice':
                    assert record['best'] == 'e6g8'
                    assert any('force checkmate' in f['text'] for f in record['evidence'])
                samples.append({'name':name,'record':record})
            print('PASS targeted king legality, pinned defenders, hanging queen, queen trade and forced-mate sacrifice', flush=True)
        finally:
            if engine: engine.quit()
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
        if server.returncode not in [0,-15]:
            log.seek(0); print(log.read())
report = {'counts':counts, 'games':game_results, 'samples':samples, 'dialogue':game_dialogue, 'scope':'Disposable games; no real history or audio preferences modified.'}
(ROOT/'reports').mkdir(exist_ok=True)
pathlib.Path(os.environ.get('CHESS_AUDIT_REPORT', ROOT/'reports/coach-audit.json')).write_text(json.dumps(report, indent=2))
print(json.dumps(counts, indent=2))
