// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = {}; 

const SUITS = ['Denari','Spade','Coppe','Bastoni'];
const RANKS = ['A','3','Re','Cavallo','Donna','7','6','5','4','2'];
const SCORE = { A:11, 3:10, Re:4, Cavallo:3, Donna:2, 7:0, 6:0, 5:0, 4:0, 2:0 };
const RANK_POWER = Object.fromEntries(RANKS.map((r,i)=>[r, RANKS.length - i]));

function italianDeck40() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit:s, rank:r, score:SCORE[r] });
  return deck;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } }

function expectedPlayerId(room){
  const idx = (room.leaderIndex + room.trick.length) % room.players.length;
  return room.players[idx].id;
}
function betterCard(a, b, leadSuit, briscola){
  if (a.suit === b.suit) return RANK_POWER[a.rank] > RANK_POWER[b.rank];
  if (b.suit === briscola) return (a.suit === briscola) ? RANK_POWER[a.rank] > RANK_POWER[b.rank] : false;
  if (a.suit === briscola) return true;
  if (a.suit === leadSuit && b.suit !== leadSuit) return true;
  return false;
}

function playersPayload(room){
  return room.players.map(p => ({
    id: p.id, name: p.name, connected: p.connected, isHost: p.id === room.hostId
  }));
}

function sendPlayers(roomId){
  const room = rooms[roomId];
  io.to(roomId).emit('players', room.players.map(p => (p.connected? '🟢 ':'⚪ ') + p.name));
  io.to(roomId).emit('playersFull', playersPayload(room));
  io.to(roomId).emit('roomInfo', { 
    hasCode: !!room.accessCode, hostId: room.hostId, deckType: room.deckType || 'siciliane',
    startLeaderMode: room.startLeaderMode || 'auctionStarter'
  });
}

function summarizeState(room){
  const leaderName = room.players[room.leaderIndex]?.name || '—';
  const nextId = expectedPlayerId(room);
  const nextName = room.awaitingConfirm ? '—' : (room.players.find(p=>p.id===nextId)?.name || '—');
  return {
    state: room.state,
    players: playersPayload(room),
    hostId: room.hostId,
    hasCode: !!room.accessCode,
    deckType: room.deckType || 'siciliane',
    startLeaderMode: room.startLeaderMode || 'auctionStarter',
    awaitingConfirm: !!room.awaitingConfirm,
    briscola: room.briscola,
    declarer: room.players.find(p=>p.id===room.declarer)?.name || '—',
    declarerId: room.declarer,
    mate: room.mateRevealed ? (room.players.find(p=>p.id===room.mate)?.name || '—') : null,
    mateId: room.mateRevealed ? room.mate : null,
    calledCard: room.calledCard,
    leader: leaderName,
    trick: room.trick.map(t => ({ by: room.players.find(p=>p.id===t.pid)?.name, card: t.card })),
    next: nextName
  };
}

function countActiveBidders(room){
  const passed = room.auction.passed || {};
  return room.players.filter(p => !passed[p.id]).length;
}
function nextBidderIndex(room, fromIndex){
  const passed = room.auction.passed || {};
  for (let step=1; step<=room.players.length; step++){
    const idx = (fromIndex + step) % room.players.length;
    const pid = room.players[idx].id;
    if (!passed[pid]) return idx;
  }
  return -1;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  socket.on('join', ({ roomId, name, playerId, accessCode }) => {
    if (!roomId) return;
    if (!rooms[roomId]) rooms[roomId] = { 
      id: roomId,
      players:[], hostId:null, accessCode:null, deckType:'siciliane',
      startLeaderMode:'auctionStarter', // 'auctionStarter' or '4denari'
      state:'lobby', deck:[], hands:{},
      auction:{ bids:{}, highest:null, passed:{}, passes:0, currentTurn:0, startIndex:0 },
      declarer:null, calledCard:null, briscola:null, mate:null,
      leaderIndex:0, trick:[], tricksPlayed:0, leadSuit:null,
      points:{ declarerTeam:0, opponents:0 },            // private totals
      publicPoints:{ declarerTeam:0, opponents:0 },      // unused for UI now
      publicPendingDeclarerPoints:0,
      mateRevealed:false,
      awaitingConfirm:false,
      lastTrick:null
    };
    const room = rooms[roomId];

    if (room.accessCode && accessCode !== room.accessCode) {
      socket.emit('errorMsg','Password errata');
      return;
    }

    let player = room.players.find(p => p.id === playerId);
    if (player) {
      player.socketId = socket.id;
      player.connected = true;
      if (name && name.trim()) player.name = name.trim();
    } else {
      if (room.players.length >= 5) { socket.emit('errorMsg', 'Stanza piena'); return; }
      const displayName = (name && name.trim()) ? name.trim() : 'Anon';
      player = { id: playerId, socketId: socket.id, name: displayName, connected: true };
      room.players.push(player);
      if (!room.hostId) {
        room.hostId = playerId;
        if (accessCode && accessCode.trim()) room.accessCode = accessCode.trim();
      }
    }

    currentRoom = roomId;
    currentPlayerId = playerId;
    socket.join(roomId);
    sendPlayers(roomId);

    if (room.hands[playerId]) io.to(socket.id).emit('yourHand', room.hands[playerId]);
    io.to(socket.id).emit('stateSync', summarizeState(room));
  });

  // Host-only controls
  socket.on('setDeckType', (type) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può cambiare il mazzo'); return; }
    if (room.state !== 'lobby') { io.to(socket.id).emit('errorMsg','Puoi cambiare mazzo solo in lobby'); return; }
    const allowed = ['siciliane','savana'];
    if (!allowed.includes(type)) { io.to(socket.id).emit('errorMsg','Tipo di mazzo non valido'); return; }
    room.deckType = type;
    sendPlayers(currentRoom);
    io.to(currentRoom).emit('chat', `Mazzo impostato: ${type}`);
  });
  socket.on('setStartLeaderMode', (mode) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può cambiare questa opzione'); return; }
    if (room.state !== 'lobby') { io.to(socket.id).emit('errorMsg','Puoi cambiare questa opzione solo in lobby'); return; }
    const allowed = ['auctionStarter','4denari'];
    if (!allowed.includes(mode)) { io.to(socket.id).emit('errorMsg','Valore non valido'); return; }
    room.startLeaderMode = mode;
    sendPlayers(currentRoom);
    io.to(currentRoom).emit('chat', `Prima carta tirata da: ${mode === '4denari' ? 'chi ha il 4 di Denari' : 'chi inizia l’asta'}`);
  });
  socket.on('setAccessCode', (newCode) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può impostare la password'); return; }
    room.accessCode = (typeof newCode === 'string' && newCode.trim()) ? newCode.trim() : null;
    sendPlayers(currentRoom);
    io.to(socket.id).emit('chat', room.accessCode ? 'Password impostata/aggiornata.' : 'Password rimossa.');
  });
  socket.on('resetGame', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può resettare la partita'); return; }
    room.state = 'lobby';
    room.deck = [];
    room.hands = {};
    room.auction = { bids:{}, highest:null, passed:{}, passes:0, currentTurn:0, startIndex:0 };
    room.declarer = null; room.calledCard = null; room.briscola = null; room.mate = null;
    room.leaderIndex = 0; room.trick = []; room.leadSuit = null; room.tricksPlayed = 0;
    room.points = { declarerTeam:0, opponents:0 };
    room.publicPoints = { declarerTeam:0, opponents:0 };
    room.publicPendingDeclarerPoints = 0;
    room.mateRevealed = false; room.awaitingConfirm = false;
    room.lastTrick = null;
    io.to(currentRoom).emit('resetDone');
    sendPlayers(currentRoom);
    io.to(currentRoom).emit('chat', 'Partita resettata dall’host.');
  });
  socket.on('requestLastTrick', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può mostrare l’ultima presa'); return; }
    if (!room.lastTrick) { io.to(socket.id).emit('errorMsg','Non c’è ancora nessuna presa conclusa'); return; }
    io.to(currentRoom).emit('lastTrick', room.lastTrick);
  });

  socket.on('chat', msg => { if (currentRoom) io.to(currentRoom).emit('chat', msg); });

  socket.on('start', () => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'lobby') return;
    if (room.players.length !== 5) { io.to(currentRoom).emit('errorMsg','Servono 5 giocatori'); return; }
    if (currentPlayerId !== room.hostId) { io.to(currentRoom).emit('errorMsg','Solo l’host può avviare la partita'); return; }

    room.deck = italianDeck40();
    shuffle(room.deck);
    room.hands = {};
    room.declarer = null; room.calledCard = null; room.briscola = null; room.mate = null;
    room.trick = []; room.leadSuit = null; room.tricksPlayed = 0;
    room.points = { declarerTeam:0, opponents:0 };
    room.publicPoints = { declarerTeam:0, opponents:0 };
    room.publicPendingDeclarerPoints = 0;
    room.mateRevealed = false;
    room.awaitingConfirm = false;
    room.lastTrick = null;

    for (const p of room.players) room.hands[p.id] = room.deck.splice(0, 8);

    // Random auction starter
    const startIndex = Math.floor(Math.random() * room.players.length);
    room.auction = { bids:{}, highest:null, passed:{}, passes:0, currentTurn:startIndex, startIndex };

    // First trick leader option
    if (room.startLeaderMode === '4denari') {
      let idx4 = 0;
      for (let i=0;i<room.players.length;i++){
        const pid = room.players[i].id;
        if ((room.hands[pid] || []).some(c => c.suit==='Denari' && c.rank==='4')) { idx4 = i; break; }
      }
      room.leaderIndex = idx4;
    } else {
      room.leaderIndex = startIndex;
    }

    for (const p of room.players) { if (p.connected) io.to(p.socketId).emit('yourHand', room.hands[p.id]); }
    io.to(currentRoom).emit('started', { players: room.players.map(p=>p.name), deckType: room.deckType, auctionStarter: room.players[startIndex].name });

    room.state = 'auction';
    io.to(currentRoom).emit('auctionStart', { first: room.players[startIndex].name });
    const target = room.players[startIndex];
    if (target?.connected) io.to(target.socketId).emit('yourTurnAuction');
  });

  socket.on('bid', (value) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'auction') return;

    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx !== room.auction.currentTurn) return;

    const passed = room.auction.passed || {};
    if (passed[currentPlayerId]) { io.to(socket.id).emit('errorMsg','Hai già passato: non puoi più offrire'); return; }

    if (value === 'pass') {
      if (!passed[currentPlayerId]) {
        passed[currentPlayerId] = true;
        room.auction.passes++;
      }
      room.auction.passed = passed;
      io.to(currentRoom).emit('auctionMsg', `${room.players[idx].name} passa (fuori dall'asta)`);

      const active = room.players.filter(p => !passed[p.id]);
      if (room.auction.highest && active.length === 1 && active[0].id === room.auction.highest.id) {
        room.state = 'calling';
        room.declarer = room.auction.highest.id;
        io.to(currentRoom).emit('auctionEnd', { 
          winner: room.players.find(p=>p.id===room.declarer).name,
          value: room.auction.highest.value
        });
        const decl = room.players.find(p=>p.id===room.declarer);
        if (decl?.connected) io.to(decl.socketId).emit('yourTurnCall');
        return;
      }

      const nextIdx = nextBidderIndex(room, room.auction.currentTurn);
      if (!room.auction.highest && room.auction.passes >= room.players.length) {
        room.auction = { bids:{}, highest:null, passed:{}, passes:0, currentTurn:room.auction.startIndex, startIndex:room.auction.startIndex };
        io.to(currentRoom).emit('auctionMsg', `Tutti hanno passato. L'asta riparte da ${room.players[room.auction.startIndex].name} (min 61).`);
        const first = room.players[room.auction.startIndex];
        if (first?.connected) io.to(first.socketId).emit('yourTurnAuction');
        return;
      }
      if (nextIdx !== -1) {
        room.auction.currentTurn = nextIdx;
        const nxt = room.players[nextIdx];
        if (nxt?.connected) io.to(nxt.socketId).emit('yourTurnAuction');
      }
      return;
    } 

    const v = Number(value);
    if (!Number.isFinite(v) || v < 61 || v > 120) { io.to(socket.id).emit('errorMsg','Offerta non valida (61–120)'); return; }
    if (room.auction.highest && v <= room.auction.highest.value) { io.to(socket.id).emit('errorMsg',`Devi offrire più di ${room.auction.highest.value}`); return; }

    room.auction.bids[currentPlayerId] = v;
    room.auction.highest = { id: currentPlayerId, value: v };
    io.to(currentRoom).emit('auctionMsg', `${room.players[idx].name} offre ${v}`);

    const nextIdx = nextBidderIndex(room, room.auction.currentTurn);
    if (nextIdx !== -1) {
      room.auction.currentTurn = nextIdx;
      const nxt = room.players[nextIdx];
      if (nxt?.connected) io.to(nxt.socketId).emit('yourTurnAuction');
    } else {
      room.state = 'calling';
      room.declarer = room.auction.highest.id;
      io.to(currentRoom).emit('auctionEnd', { 
        winner: room.players.find(p=>p.id===room.declarer).name,
        value: room.auction.highest.value
      });
      const decl = room.players.find(p=>p.id===room.declarer);
      if (decl?.connected) io.to(decl.socketId).emit('yourTurnCall');
    }
  });

  socket.on('callCard', (card) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'calling') return;
    if (currentPlayerId !== room.declarer) return;
    if (!card || !card.suit || !card.rank) return;

    if (!SUITS.includes(card.suit) || !RANKS.includes(card.rank)) { io.to(socket.id).emit('errorMsg','Carta non valida.'); return; }
    const declarerHand = room.hands[room.declarer] || [];
    if (declarerHand.some(c => c.suit===card.suit && c.rank===card.rank)) { io.to(socket.id).emit('errorMsg','Non puoi chiamare una carta che hai in mano.'); return; }

    room.calledCard = { suit: card.suit, rank: card.rank, score: SCORE[card.rank] };
    room.briscola = card.suit;

    room.mate = null;
    for (const pid in room.hands) {
      if (room.hands[pid].some(c => c.suit===card.suit && c.rank===card.rank)) { room.mate = pid; break; }
    }

    io.to(currentRoom).emit('called', { 
      declarer: room.players.find(p=>p.id===room.declarer).name,
      card: room.calledCard, briscola: room.briscola
    });

    room.state = 'playing';
    const leaderName = room.players[room.leaderIndex].name;
    io.to(currentRoom).emit('trickStart', { leader: leaderName });
  });

  socket.on('playCard', (card) => {
    const room = rooms[currentRoom];
    if (!room || room.state !== 'playing' || room.awaitingConfirm) return;
    const expected = expectedPlayerId(room);
    if (currentPlayerId !== expected) { io.to(socket.id).emit('errorMsg','Non è il tuo turno'); return; }

    const hand = room.hands[currentPlayerId] || [];
    const idx = hand.findIndex(c => c.suit===card.suit && c.rank===card.rank);
    if (idx === -1) return;

    if (room.trick.length === 0) room.leadSuit = card.suit;

    const played = hand.splice(idx,1)[0];
    room.trick.push({ pid: currentPlayerId, card: played });
    io.to(currentRoom).emit('played', { by: room.players.find(p=>p.id===currentPlayerId)?.name, card: played });

    const sock = io.sockets.sockets.get(room.players.find(p=>p.id===currentPlayerId).socketId);
    if (sock) io.to(sock.id).emit('yourHand', room.hands[currentPlayerId]);

    // Reveal mate if played the called card
    if (!room.mateRevealed && room.mate && room.calledCard &&
        played.suit === room.calledCard.suit && played.rank === room.calledCard.rank && currentPlayerId === room.mate) {
      room.mateRevealed = true;
      if (room.publicPendingDeclarerPoints > 0) {
        room.publicPoints.declarerTeam += room.publicPendingDeclarerPoints;
        room.publicPendingDeclarerPoints = 0;
      }
      io.to(currentRoom).emit('mateRevealed', { mate: room.players.find(p=>p.id===room.mate).name });
    }

    if (room.trick.length === room.players.length) {
      room.awaitingConfirm = true;
      io.to(currentRoom).emit('trickFull', { trick: room.trick.map(t => ({ by: room.players.find(p=>p.id===t.pid)?.name, card: t.card })) });
    } else {
      const idxNext = (room.leaderIndex + room.trick.length) % room.players.length;
      const nextName = room.players[idxNext].name;
      io.to(currentRoom).emit('turn', nextName);
    }
  });

  socket.on('confirmTrick', () => {
    const room = rooms[currentRoom];
    if (!room || !room.awaitingConfirm) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può confermare la presa'); return; }

    // Safety: reveal mate if the called card has just been played by mate
    if (!room.mateRevealed && room.mate && room.calledCard) {
      const revealNow = room.trick.some(t => t.pid === room.mate && t.card.suit === room.calledCard.suit && t.card.rank === room.calledCard.rank);
      if (revealNow) {
        room.mateRevealed = true;
        if (room.publicPendingDeclarerPoints > 0) {
          room.publicPoints.declarerTeam += room.publicPendingDeclarerPoints;
          room.publicPendingDeclarerPoints = 0;
        }
        io.to(currentRoom).emit('mateRevealed', { mate: room.players.find(p=>p.id===room.mate).name });
      }
    }

    let winner = room.trick[0];
    for (let i=1;i<room.trick.length;i++){
      if (betterCard(room.trick[i].card, winner.card, room.leadSuit, room.briscola)) winner = room.trick[i];
    }
    const winnerPid = winner.pid;
    const winnerIdx = room.players.findIndex(p=>p.id===winnerPid);
    const winnerName = room.players[winnerIdx].name;

    const trickPoints = room.trick.reduce((sum, t) => sum + (t.card.score||0), 0);
    const isDeclarerTeam = (winnerPid === room.declarer) || (room.mate && winnerPid === room.mate);

    // Update private points only (no UI during play)
    if (isDeclarerTeam) room.points.declarerTeam += trickPoints;
    else room.points.opponents += trickPoints;

    // Store LAST TRICK snapshot before clearing
    room.lastTrick = {
      trick: room.trick.map(t => ({ by: room.players.find(p=>p.id===t.pid)?.name, card: t.card })),
      winner: winnerName,
      points: trickPoints,
      briscola: room.briscola,
      leadSuit: room.leadSuit
    };

    io.to(currentRoom).emit('trickEnd', { winner: winnerName, points: trickPoints });

    room.tricksPlayed += 1;
    room.trick = [];
    room.leadSuit = null;
    room.leaderIndex = winnerIdx;
    room.awaitingConfirm = false;

    if (room.tricksPlayed >= 8) {
      room.state = 'scoring';
      const bid = room.auction?.highest?.value || 61;
      const declarerName = room.players.find(p=>p.id===room.declarer)?.name;
      const mateName = room.players.find(p=>p.id===room.mate)?.name || '—';
      const declPts = room.points.declarerTeam;
      const oppPts = room.points.opponents;
      const success = declPts >= bid;
      io.to(currentRoom).emit('roundEnd', {
        briscola: room.briscola,
        calledCard: room.calledCard,
        declarer: declarerName,
        declarerId: room.declarer,
        mate: mateName,
        mateId: room.mate,
        bid,
        points: { declarerTeam: declPts, opponents: oppPts },
        success
      });
      room.state = 'lobby';
    } else {
      const leaderName2 = room.players[room.leaderIndex].name;
      io.to(currentRoom).emit('trickStart', { leader: leaderName2 });
    }
  });

  // KICK
  socket.on('kickPlayer', (targetPlayerId) => {
    const room = rooms[currentRoom];
    if (!room) return;
    if (currentPlayerId !== room.hostId) { io.to(socket.id).emit('errorMsg','Solo l’host può espellere'); return; }
    if (targetPlayerId === room.hostId) { io.to(socket.id).emit('errorMsg','Non puoi espellere l’host'); return; }
    const idx = room.players.findIndex(p => p.id === targetPlayerId);
    if (idx === -1) return;
    const kicked = room.players[idx];
    io.to(kicked.socketId).emit('errorMsg', 'Sei stato espulso dalla stanza');
    const sock = io.sockets.sockets.get(kicked.socketId);
    if (sock) sock.leave(currentRoom);
    room.players.splice(idx, 1);
    delete room.hands[targetPlayerId];
    sendPlayers(currentRoom);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === currentPlayerId);
    if (player) player.connected = false;

    if (room.hostId === currentPlayerId) {
      const nextHost = room.players.find(p => p.connected) || room.players[0];
      if (nextHost) room.hostId = nextHost.id;
    }
    sendPlayers(currentRoom);

    if (room.players.length === 0 || room.players.every(p=>!p.connected)) {
      setTimeout(() => { const r = rooms[currentRoom]; if (r && (r.players.length===0 || r.players.every(p=>!p.connected))) delete rooms[currentRoom]; }, 10*60*1000);
    }
  });
});

const PORT = process.env.PORT || 3000;
srv.listen(PORT, () => console.log('Server su http://localhost:'+PORT));
