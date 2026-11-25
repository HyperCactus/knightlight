"""Independent, disposable test of the full bank, fresh queues and live puzzle answers."""
import json, os, pathlib, socket, subprocess, tempfile, time, urllib.request, urllib.error
import chess, chess.engine
ROOT=pathlib.Path(__file__).resolve().parents[1]
report={'bank_size':0,'opened':0,'rejected':0,'accepted_moves':0,'seen_unique':0,'samples':[]}

def api(base,path,body=None):
    req=urllib.request.Request(base+'/api/'+path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=120) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as r:return r.code,json.load(r)

def key(fen):return ' '.join(chess.Board(fen).fen().split()[:4])
entries=json.loads((ROOT/'data/puzzle-bank.json').read_text())
identities={key(p['fen']) for p in entries}
assert len(entries)==len(identities)>=100000
report['bank_size']=len(entries)
print(f'PASS {len(entries):,} distinct board positions in the offline bank',flush=True)
with tempfile.TemporaryDirectory(prefix='chess-puzzle-audit-') as tmp:
    folder=pathlib.Path(tmp);(folder/'data').mkdir()
    for name in ['static','scripts','vendor']:(folder/name).symlink_to(ROOT/name)
    for name in ['openings','puzzle-bank.json']:(folder/'data'/name).symlink_to(ROOT/'data'/name)
    (folder/'fixture.pgn').write_text('[White "Audit"]\n[Black "Other"]\n[Result "*"]\n\n1. e4 e5 *\n')
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    base=f'http://127.0.0.1:{port}'
    log=(folder/'server.log').open('w+')
    def launch():return subprocess.Popen([str(ROOT/'target/release/chess-study')],cwd=folder,env={**os.environ,'PORT':str(port),'CHESS_PLAYER':'Audit'},stdout=log,stderr=log)
    def ready():
        for _ in range(300):
            try:
                if api(base,'data')[1]['ready']:return
            except OSError:pass
            time.sleep(.1)
        raise AssertionError('Server did not become ready')
    server=launch();engine=None
    try:
        ready();engine=chess.engine.SimpleEngine.popen_uci(str(ROOT/'vendor/stockfish/usr/games/stockfish'))
        engine.configure({'Threads':1,'Hash':64})
        seen=set();skipped=[]
        for n in range(25):
            status,summary=api(base,'practice');assert status==200
            assert summary['pool_size']>=100000 and len(summary['candidates'])<=80
            assert len(json.dumps(summary))<150000
            assert not seen.intersection(key(p['fen']) for p in summary['candidates'])
            candidate=summary['candidates'][0]
            status,d=api(base,'drills',{'id':candidate['id'],'fresh':True})
            if status==422:
                report['rejected']+=1;continue
            assert status==200,(status,d)
            board=chess.Board(d['board']['fen']);identity=key(board.fen());assert identity not in seen;seen.add(identity)
            assert api(base,'drills',{'id':candidate['id'],'fresh':True})[0]==409
            report['opened']+=1
            score=engine.analyse(board,chess.engine.Limit(depth=17))['score'].relative.score(mate_score=10000)
            assert score>=-180,(candidate,score)
            sample={'id':candidate['id'],'theme':candidate['theme'],'rating':candidate['rating'],'score':score,'moves':[]}
            # Skips must be remembered just as reliably as completed puzzles.
            if n%4==0:skipped.append(candidate['id']);continue
            for turn in range(5):
                uci=d['best'];move=chess.Move.from_uci(uci);assert move in board.legal_moves
                baseline=engine.analyse(board,chess.engine.Limit(depth=17))['score'].relative.score(mate_score=10000)
                after=board.copy();after.push(move)
                if not after.is_game_over():
                    consequence=engine.analyse(after,chess.engine.Limit(depth=17))['score'].pov(board.turn).score(mate_score=10000)
                    assert baseline-consequence<=150,(candidate,uci,baseline,consequence)
                status,r=api(base,f'drills/{d["session"]}/moves',{'uci':uci,'revision':d['revision'],'request_id':f'audit-{n}-{turn}'})
                assert status==200 and r['accepted'],(status,r)
                assert key(after.fen())==key(r['player_step']['fen'])
                board=after
                if r['reply_step']:
                    reply=chess.Move.from_uci(r['reply_step']['uci']);assert reply in board.legal_moves;board.push(reply)
                assert key(board.fen())==key(r['board']['fen'])
                report['accepted_moves']+=1;sample['moves'].append(uci);d={**d,**r}
                if r['complete']:break
            assert d['complete']
            report['samples'].append(sample)
            print(f'PASS {candidate["id"]}: {len(sample["moves"])} meaningful player turns',flush=True)
        report['seen_unique']=len(seen)
        server.terminate();server.wait(timeout=10);server=launch();ready()
        candidates=api(base,'practice')[1]['candidates']
        assert not seen.intersection(key(p['fen']) for p in candidates)
        report['restart_preserves_skips']=True
        print('PASS fresh queues remember completed and skipped boards across restart',flush=True)
    finally:
        if engine:engine.quit()
        server.terminate();server.wait(timeout=10);log.close()
(ROOT/'reports/puzzle-bank-audit.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='samples'},indent=2))
