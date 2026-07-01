// ================================================================
//  ДУРАК — Multiplayer Server (2-6 игроков)
//  Node.js + Express + WebSocket + Telegram Bot API
//  Ставки: Telegram Stars минимум 5 XTR
// ================================================================

const express   = require("express");
const cors      = require("cors");
const crypto    = require("crypto");
const https     = require("https");
const http      = require("http");
const WebSocket = require("ws");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.json());
app.use(cors());

// ──────────────────────────────────────────────────────────────
//  КОНФИГ
// ──────────────────────────────────────────────────────────────
const BOT_TOKEN     = process.env.BOT_TOKEN     || "YOUR_BOT_TOKEN";
const BOT_USERNAME  = process.env.BOT_USERNAME  || "durak_gamebot";
const WEBAPP_URL    = process.env.WEBAPP_URL    || "https://your-game.vercel.app";
const PORT          = process.env.PORT          || 3000;
const MIN_BET       = 5;   // минимум Stars
const MAX_PLAYERS   = 6;
const MIN_PLAYERS   = 2;

// ──────────────────────────────────────────────────────────────
//  IN-MEMORY ХРАНИЛИЩЕ
// ──────────────────────────────────────────────────────────────
const users    = new Map(); // userId → User
const rooms    = new Map(); // roomId → Room
const invoices = new Map(); // payload → Invoice
const sockets  = new Map(); // userId → WebSocket

function getUser(userId, name) {
  userId = String(userId);
  if (!users.has(userId)) {
    users.set(userId, { id:userId, name:name||"Игрок", stars:100, coins:500, wins:0, losses:0 });
  }
  const u = users.get(userId);
  if (name && name !== "Игрок") u.name = name;
  return u;
}

// ──────────────────────────────────────────────────────────────
//  WEBSOCKET
// ──────────────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const url    = new URL(req.url, "http://localhost");
  const userId = url.searchParams.get("userId");
  const roomId = url.searchParams.get("roomId");
  if (!userId) return ws.close();

  sockets.set(userId, ws);

  ws.on("close", () => {
    sockets.delete(userId);
    if (roomId) handleDisconnect(userId, roomId);
  });

  ws.on("message", raw => {
    try { handleWsMsg(userId, roomId, JSON.parse(raw)); } catch {}
  });

  // Отправить текущее состояние при подключении
  const room = roomId && rooms.get(roomId);
  if (room) ws.send(JSON.stringify({ type:"room_state", data: buildView(room, userId) }));
});

function sendTo(userId, type, data) {
  const ws = sockets.get(String(userId));
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

function broadcast(room, type, extraData) {
  for (const p of room.players) {
    const ws = sockets.get(p.userId);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    const data = type === "room_state" ? buildView(room, p.userId) : (extraData || {});
    ws.send(JSON.stringify({ type, data }));
  }
}

function handleWsMsg(userId, roomId, msg) {
  const room = roomId && rooms.get(roomId);
  if (!room) return;
  if (msg.type === "chat") {
    const u = getUser(userId);
    broadcast(room, "chat", { from:u.name, text:String(msg.text||"").slice(0,100) });
  }
  if (msg.type === "emoji") {
    const u = getUser(userId);
    const safe = ["👍","😂","😤","🤯","🃏","🔥","💀","👑"].includes(msg.emoji) ? msg.emoji : "👍";
    broadcast(room, "emoji", { from:u.name, emoji:safe });
  }
}

function handleDisconnect(userId, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.settled) return;
  if (room.status === "waiting") {
    room.players = room.players.filter(p => p.userId !== userId);
    const u = users.get(userId);
    if (u) u.stars += room.betAmount; // вернуть ставку
    broadcast(room, "room_state");
  } else if (room.status === "playing") {
    room.status  = "finished";
    room.message = `${getUser(userId).name} вышел из игры`;
    broadcast(room, "room_state");
    settleRoom(room, userId, "disconnect");
  }
}

// ──────────────────────────────────────────────────────────────
//  TELEGRAM API
// ──────────────────────────────────────────────────────────────
function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   "POST",
      headers:  { "Content-Type":"application/json", "Content-Length":Buffer.byteLength(data) },
    }, res => {
      let raw = "";
      res.on("data", d => raw += d);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error(raw)); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

function validateTg(initData) {
  try {
    const p    = new URLSearchParams(initData);
    const hash = p.get("hash"); p.delete("hash");
    const str  = [...p.keys()].sort().map(k=>`${k}=${p.get(k)}`).join("\n");
    const sec  = crypto.createHmac("sha256","WebAppData").update(BOT_TOKEN).digest();
    if (crypto.createHmac("sha256",sec).update(str).digest("hex") !== hash) return null;
    return JSON.parse(p.get("user")||"{}");
  } catch { return null; }
}

function authMw(req, res, next) {
  if (process.env.NODE_ENV === "development") {
    req.tgUser = { id: req.headers["x-user-id"]||"dev1", first_name: req.headers["x-user-name"]||"Тестер" };
    return next();
  }
  const u = validateTg(req.headers["x-telegram-init-data"]);
  if (!u) return res.status(403).json({ error:"Неверная авторизация" });
  req.tgUser = u;
  next();
}

// ──────────────────────────────────────────────────────────────
//  ИГРОВАЯ ЛОГИКА — ПОДКИДНОЙ ДУРАК (2-6 игроков)
// ──────────────────────────────────────────────────────────────
const RANKS = ["6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♠","♥","♦","♣"];
const RV    = {"6":6,"7":7,"8":8,"9":9,"10":10,J:11,Q:12,K:13,A:14};

const mkDeck = () => {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({suit:s,rank:r,id:r+s});
  return shuffle(d);
};
const shuffle = a => {
  a=[...a]; for(let i=a.length-1;i>0;i--){const j=Math.random()*(i+1)|0;[a[i],a[j]]=[a[j],a[i]];} return a;
};
const rv    = r  => RV[r]||0;
const beats = (a,d,t) => a.suit===d.suit ? rv(d.rank)>rv(a.rank) : d.suit===t&&a.suit!==t;

function initGame(players) {
  const deck  = mkDeck();
  const hands = {};
  for (const p of players) hands[p.userId] = deck.splice(0,6);

  const trump = deck[deck.length-1];

  // Кто ходит первым — наименьший козырь
  let firstIdx = 0, minV = 99;
  players.forEach((p,i) => {
    for (const c of hands[p.userId]) {
      if (c.suit === trump.suit && rv(c.rank) < minV) { minV = rv(c.rank); firstIdx = i; }
    }
  });

  return {
    deck, hands, trumpCard:trump, trump:trump.suit,
    table:  [],      // [{attack, defense?, attackBy}]
    phase:  "attack",
    atkIdx: firstIdx,
    defIdx: (firstIdx+1) % players.length,
    losers: [],
    message: "",
  };
}

const alive = (gs, players) => players.filter(p => !gs.losers.includes(p.userId));

function refill(gs, players) {
  const act = alive(gs, players);
  if (!act.length) return;
  const def = act[gs.defIdx % act.length];
  const order = act.filter(p => p.userId !== def?.userId);
  order.push(def);
  for (const p of order) {
    if (!p) continue;
    while ((gs.hands[p.userId]?.length||0) < 6 && gs.deck.length > 0)
      gs.hands[p.userId].push(gs.deck.pop());
  }
}

function checkLosers(gs, players) {
  for (const p of players) {
    if (!gs.losers.includes(p.userId) && gs.deck.length===0 && (gs.hands[p.userId]?.length||0)===0)
      gs.losers.push(p.userId);
  }
}

function getDurak(gs, players) {
  if (gs.deck.length > 0) return null;
  const still = players.filter(p => (gs.hands[p.userId]?.length||0) > 0);
  return still.length === 1 ? still[0].userId : null;
}

function advanceTurn(gs, act, defAttacksNext) {
  if (act.length < 2) return;
  const d = gs.defIdx % act.length;
  gs.atkIdx = defAttacksNext ? d : (d+1) % act.length;
  gs.defIdx = (gs.atkIdx+1) % act.length;
}

// ── Применить ход ─────────────────────────────────────────────
function applyAction(gs, players, userId, action, cardId, targetId) {
  gs = JSON.parse(JSON.stringify(gs));
  const act      = alive(gs, players);
  if (!act.length) return {error:"Игра завершена"};
  const atkIdx   = gs.atkIdx % act.length;
  const defIdx   = gs.defIdx % act.length;
  const attacker = act[atkIdx];
  const defender = act[defIdx];
  const isAtk    = attacker?.userId === userId;
  const isDef    = defender?.userId === userId;
  const isHelper = !isDef && act.some(p => p.userId === userId); // может подбрасывать

  if (action === "attack") {
    if (gs.phase !== "attack")       return {error:"Сейчас не атака"};
    if (!isAtk && !isHelper)         return {error:"Не ваш ход"};
    if (gs.table.length >= 6)        return {error:"Стол полон"};
    const defCards = gs.hands[defender.userId]?.length || 0;
    if (gs.table.length >= defCards) return {error:"У защитника не хватит карт"};

    const card = gs.hands[userId]?.find(c => c.id===cardId);
    if (!card) return {error:"Карта не найдена"};

    if (gs.table.length > 0) {
      const ranks = gs.table.flatMap(s=>[s.attack.rank, s.defense?.rank].filter(Boolean));
      if (!ranks.includes(card.rank)) return {error:"Ранг не совпадает"};
    }

    gs.hands[userId] = gs.hands[userId].filter(c=>c.id!==cardId);
    gs.table.push({attack:card, attackBy:userId});
    gs.phase   = "defend";
    gs.message = `${getUser(userId).name} атакует`;
    return {gs};
  }

  if (action === "defend") {
    if (gs.phase !== "defend") return {error:"Сейчас не защита"};
    if (!isDef)                return {error:"Вы не защитник"};
    const card = gs.hands[userId]?.find(c=>c.id===cardId);
    if (!card) return {error:"Карта не найдена"};
    const slot = gs.table.find(s=>!s.defense && s.attack.id===targetId);
    if (!slot) return {error:"Такой атаки нет"};
    if (!beats(slot.attack, card, gs.trump)) return {error:"Карта не бьёт"};

    gs.hands[userId] = gs.hands[userId].filter(c=>c.id!==cardId);
    slot.defense = card;
    gs.message   = `${getUser(userId).name} отбивается`;

    if (gs.table.every(s=>s.defense)) {
      gs.table   = [];
      gs.phase   = "attack";
      gs.message = `${getUser(userId).name} отбился!`;
      refill(gs, players);
      checkLosers(gs, players);
      advanceTurn(gs, alive(gs,players), true);
    }
    return {gs};
  }

  if (action === "take") {
    if (gs.phase !== "defend") return {error:"Нечего брать"};
    if (!isDef)                return {error:"Вы не защитник"};
    const taken = gs.table.flatMap(s=>[s.attack,s.defense].filter(Boolean));
    gs.hands[userId] = [...(gs.hands[userId]||[]), ...taken];
    gs.table   = [];
    gs.phase   = "attack";
    gs.message = `${getUser(userId).name} взял карты`;
    refill(gs, players);
    checkLosers(gs, players);
    advanceTurn(gs, alive(gs,players), false); // защитник пропускает ход
    return {gs};
  }

  if (action === "pass") {
    if (!isAtk)               return {error:"Только атакующий пасует"};
    if (gs.table.length === 0) return {error:"Нечего пасовать"};
    gs.table   = [];
    gs.phase   = "attack";
    gs.message = `${getUser(userId).name} завершил атаку`;
    refill(gs, players);
    checkLosers(gs, players);
    advanceTurn(gs, alive(gs,players), true);
    return {gs};
  }

  return {error:"Неизвестное действие"};
}

// ──────────────────────────────────────────────────────────────
//  РАЗБОР (выплата)
// ──────────────────────────────────────────────────────────────
async function settleRoom(room, durakId, reason="normal") {
  if (room.settled) return;
  room.settled = true;
  const winners = room.players.filter(p => p.userId !== durakId);
  if (reason === "disconnect") {
    for (const w of winners) { const u=users.get(w.userId); if(u) u.stars+=room.betAmount; }
    return;
  }
  const pot   = room.betAmount * room.players.length;
  const share = Math.floor(pot / winners.length);
  for (const w of winners) {
    const u = users.get(w.userId);
    if (u) { u.stars+=share; u.wins++; }
    notifyUser(w.userId, `🏆 Победа! +${share} ⭐`);
  }
  const loser = users.get(durakId);
  if (loser) loser.losses++;
  notifyUser(durakId, `💀 Дурак! Проиграно ${room.betAmount} ⭐`);
  setTimeout(() => rooms.delete(room.id), 60_000);
}

async function notifyUser(userId, text) {
  try {
    await tgApi("sendMessage", {
      chat_id: userId, text,
      reply_markup: {inline_keyboard:[[{text:"🎮 Ещё раз!", web_app:{url:WEBAPP_URL}}]]},
    });
  } catch {}
}

// ──────────────────────────────────────────────────────────────
//  VIEW ДЛЯ КОНКРЕТНОГО ИГРОКА
// ──────────────────────────────────────────────────────────────
function buildView(room, userId) {
  const gs = room.gameState;
  const base = {
    id:         room.id,
    status:     room.status,
    betAmount:  room.betAmount,
    maxPlayers: room.maxPlayers,
    message:    room.message || "",
    players: room.players.map(p => ({
      userId:    p.userId,
      name:      p.name,
      cardCount: gs ? (gs.hands[p.userId]?.length||0) : 0,
      isLoser:   gs ? gs.losers.includes(p.userId) : false,
    })),
  };
  if (!gs) return base;
  const act    = alive(gs, room.players);
  const atkIdx = gs.atkIdx % (act.length||1);
  const defIdx = gs.defIdx % (act.length||1);
  return {
    ...base,
    myHand:     gs.hands[userId]||[],
    trump:      gs.trump,
    trumpCard:  gs.trumpCard,
    deckCount:  gs.deck.length,
    table:      gs.table,
    phase:      gs.phase,
    attackerId: act[atkIdx]?.userId,
    defenderId: act[defIdx]?.userId,
    message:    gs.message,
    losers:     gs.losers,
    durak:      room.durak||null,
  };
}

function makeRoomId() { return Math.random().toString(36).slice(2,8).toUpperCase(); }

// ──────────────────────────────────────────────────────────────
//  REST API
// ──────────────────────────────────────────────────────────────

// Лобби — открытые комнаты
app.get("/api/lobby", (req, res) => {
  const list = [...rooms.values()]
    .filter(r => r.status==="waiting")
    .map(r => ({
      id:r.id, betAmount:r.betAmount, maxPlayers:r.maxPlayers,
      players:r.players.length, hostName:r.players[0]?.name||"?",
    }));
  res.json(list);
});

// Профиль
app.get("/api/user", authMw, (req, res) => {
  const u = getUser(String(req.tgUser.id), req.tgUser.first_name);
  res.json({...u, winRate: u.wins+u.losses>0 ? Math.round(u.wins/(u.wins+u.losses)*100) : 0});
});

// Лидерборд
app.get("/api/leaderboard", (req, res) => {
  res.json([...users.values()].sort((a,b)=>b.wins-a.wins).slice(0,20)
    .map((u,i)=>({rank:i+1,name:u.name,wins:u.wins,losses:u.losses,stars:u.stars})));
});

// Создать комнату → вернуть invoice для оплаты Stars
app.post("/api/room/create", authMw, async (req, res) => {
  let { betAmount=10, maxPlayers=4 } = req.body;
  betAmount  = Math.max(MIN_BET, Math.min(1000, parseInt(betAmount)||10));
  maxPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, parseInt(maxPlayers)||4));

  const userId = String(req.tgUser.id);
  const user   = getUser(userId, req.tgUser.first_name);
  if (user.stars < betAmount) return res.status(400).json({error:`Нужно ${betAmount} ⭐`});

  const payload = `create_${userId}_${Date.now()}`;
  invoices.set(payload, {userId, type:"create", betAmount, maxPlayers});
  // TTL 15 минут
  setTimeout(()=>invoices.delete(payload), 15*60_000);

  try {
    const r = await tgApi("createInvoiceLink", {
      title:       `Создать комнату — ${betAmount} ⭐`,
      description: `Дурак ${maxPlayers} игроков. Выигрыш до ${betAmount*maxPlayers} ⭐`,
      payload, currency:"XTR",
      prices:[{label:"Ставка", amount:betAmount}],
    });
    if (!r.ok) return res.status(500).json({error:r.description});
    res.json({invoiceLink:r.result, payload});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Войти в комнату → invoice
app.post("/api/room/join", authMw, async (req, res) => {
  const { roomId } = req.body;
  const userId = String(req.tgUser.id);
  const room   = rooms.get(roomId);
  if (!room)                              return res.status(404).json({error:"Комната не найдена"});
  if (room.status !== "waiting")          return res.status(400).json({error:"Игра уже идёт"});
  if (room.players.length>=room.maxPlayers) return res.status(400).json({error:"Комната полна"});
  if (room.players.find(p=>p.userId===userId)) return res.status(400).json({error:"Вы уже в комнате"});

  const user = getUser(userId, req.tgUser.first_name);
  if (user.stars < room.betAmount) return res.status(400).json({error:`Нужно ${room.betAmount} ⭐`});

  const payload = `join_${userId}_${Date.now()}`;
  invoices.set(payload, {userId, type:"join", betAmount:room.betAmount, roomId});
  setTimeout(()=>invoices.delete(payload), 15*60_000);

  try {
    const r = await tgApi("createInvoiceLink", {
      title:`Войти — ${room.betAmount} ⭐`,
      description:`Дурак. Выигрыш до ${room.betAmount*room.maxPlayers} ⭐`,
      payload, currency:"XTR",
      prices:[{label:"Ставка", amount:room.betAmount}],
    });
    if (!r.ok) return res.status(500).json({error:r.description});
    res.json({invoiceLink:r.result, payload});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Хост запускает игру вручную (если комната не полная)
app.post("/api/room/:id/start", authMw, (req, res) => {
  const room   = rooms.get(req.params.id);
  const userId = String(req.tgUser.id);
  if (!room)                              return res.status(404).json({error:"Нет комнаты"});
  if (room.players[0]?.userId !== userId) return res.status(403).json({error:"Только хост может начать"});
  if (room.players.length < MIN_PLAYERS)  return res.status(400).json({error:`Нужно минимум ${MIN_PLAYERS} игрока`});
  if (room.status !== "waiting")          return res.status(400).json({error:"Уже началось"});

  room.status    = "playing";
  room.gameState = initGame(room.players);
  room.gameState.message = `${room.players[room.gameState.atkIdx]?.name} ходит первым!`;
  broadcast(room, "room_state");
  res.json({ok:true});
});

// Ход игрока
app.post("/api/room/:id/action", authMw, (req, res) => {
  const room   = rooms.get(req.params.id);
  const userId = String(req.tgUser.id);
  if (!room)                     return res.status(404).json({error:"Нет комнаты"});
  if (room.status!=="playing")   return res.status(400).json({error:"Игра не идёт"});
  if (!room.players.find(p=>p.userId===userId)) return res.status(403).json({error:"Вы не в игре"});

  const {action,cardId,targetCardId} = req.body;
  const result = applyAction(room.gameState, room.players, userId, action, cardId, targetCardId);
  if (result.error) return res.status(400).json({error:result.error});
  room.gameState = result.gs;

  const durakId = getDurak(room.gameState, room.players);
  if (durakId) {
    room.status = "finished";
    room.durak  = durakId;
    room.gameState.message = `💀 Дурак: ${getUser(durakId).name}!`;
    broadcast(room, "room_state");
    settleRoom(room, durakId);
    return res.json({ok:true});
  }

  broadcast(room, "room_state");
  res.json({ok:true});
});

// Получить состояние (polling fallback)
app.get("/api/room/:id", authMw, (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({error:"Нет комнаты"});
  res.json(buildView(room, String(req.tgUser.id)));
});

// ──────────────────────────────────────────────────────────────
//  TELEGRAM WEBHOOK
// ──────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const upd = req.body;
  res.sendStatus(200);
  try {
    const msg = upd.message;
    const cq  = upd.callback_query;

    // /start
    if (msg?.text?.startsWith("/start")) {
      const roomId = msg.text.split(" ")[1]||null;
      getUser(String(msg.from.id), msg.from.first_name);
      await tgApi("sendMessage", {
        chat_id: msg.chat.id,
        text:"🃏 *ДУРАК* — играй против друзей!\n\nДо 6 игроков • Ставки от 5 ⭐ • Победитель забирает всё",
        parse_mode:"Markdown",
        reply_markup:{inline_keyboard:[[
          {text:"🎮 Играть", web_app:{url:roomId?`${WEBAPP_URL}?room=${roomId}`:WEBAPP_URL}},
        ],[
          {text:"🏆 Топ", callback_data:"top"},
          {text:"👤 Профиль", callback_data:"profile"},
        ]]},
      });
    }

    // /balance
    if (msg?.text === "/balance") {
      const u = getUser(String(msg.from.id), msg.from.first_name);
      await tgApi("sendMessage", {chat_id:msg.chat.id, text:`⭐ Stars: ${u.stars}\n✅ Побед: ${u.wins}\n❌ Поражений: ${u.losses}`, parse_mode:"Markdown"});
    }

    // Callback
    if (cq) {
      await tgApi("answerCallbackQuery", {callback_query_id:cq.id});
      const u = getUser(String(cq.from.id), cq.from.first_name);
      if (cq.data==="profile") {
        await tgApi("sendMessage", {
          chat_id:cq.message.chat.id,
          text:`👤 *${u.name}*\n⭐ ${u.stars} Stars\n✅ ${u.wins} побед / ❌ ${u.losses} поражений`,
          parse_mode:"Markdown",
        });
      }
      if (cq.data==="top") {
        const top=[...users.values()].sort((a,b)=>b.wins-a.wins).slice(0,10);
        const m=["🥇","🥈","🥉"];
        await tgApi("sendMessage", {
          chat_id:cq.message.chat.id,
          text:"🏆 *Топ игроков:*\n"+top.map((u,i)=>`${m[i]||i+1+"."}${u.name} — ${u.wins}п`).join("\n"),
          parse_mode:"Markdown",
        });
      }
    }

    // Pre-checkout — подтвердить за 10 сек
    if (upd.pre_checkout_query) {
      const pcq = upd.pre_checkout_query;
      const ok  = invoices.has(pcq.invoice_payload);
      await tgApi("answerPreCheckoutQuery", {
        pre_checkout_query_id:pcq.id, ok,
        error_message: ok ? undefined : "Платёж устарел, попробуйте снова",
      });
    }

    // Successful payment — провести логику
    if (msg?.successful_payment) {
      const sp      = msg.successful_payment;
      const inv     = invoices.get(sp.invoice_payload);
      const userId  = String(msg.from.id);
      const uName   = msg.from.first_name || "Игрок";
      if (!inv) return;
      invoices.delete(sp.invoice_payload);

      if (inv.type === "create") {
        // Создать комнату
        const roomId = makeRoomId();
        rooms.set(roomId, {
          id:roomId, status:"waiting",
          betAmount:inv.betAmount, maxPlayers:inv.maxPlayers,
          players:[{userId, name:uName}],
          gameState:null, settled:false,
        });
        const link = `https://t.me/${BOT_USERNAME}?startapp=${roomId}`;
        await tgApi("sendMessage", {
          chat_id:msg.chat.id,
          text:`✅ Комната создана!\n🔑 Код: \`${roomId}\`\n👥 Мест: ${inv.maxPlayers}\n⭐ Ставка: ${inv.betAmount}`,
          parse_mode:"Markdown",
          reply_markup:{inline_keyboard:[[
            {text:"🎮 Открыть", web_app:{url:`${WEBAPP_URL}?room=${roomId}`}},
            {text:"🔗 Пригласить", url:link},
          ]]},
        });
        // Авто-удалить пустую комнату через 10 мин
        setTimeout(()=>{
          const r=rooms.get(roomId);
          if (r?.status==="waiting"&&r.players.length<2) {
            const h=users.get(userId); if(h) h.stars+=inv.betAmount;
            rooms.delete(roomId);
          }
        }, 10*60_000);
      }

      if (inv.type === "join") {
        const room = rooms.get(inv.roomId);
        if (!room || room.status!=="waiting") {
          const u=users.get(userId); if(u) u.stars+=inv.betAmount;
          await tgApi("sendMessage", {chat_id:msg.chat.id, text:"❌ Комната недоступна. Ставка возвращена."});
          return;
        }
        room.players.push({userId, name:uName});
        broadcast(room, "room_state");
        await tgApi("sendMessage", {
          chat_id:msg.chat.id,
          text:`✅ Вы в игре!\n⭐ Ставка: ${inv.betAmount}`,
          reply_markup:{inline_keyboard:[[{text:"🎮 Играть", web_app:{url:`${WEBAPP_URL}?room=${room.id}`}}]]},
        });
        // Автостарт при заполнении
        if (room.players.length >= room.maxPlayers) {
          room.status    = "playing";
          room.gameState = initGame(room.players);
          const first = room.players[room.gameState.atkIdx];
          room.gameState.message = `${first?.name} ходит первым!`;
          broadcast(room, "room_state");
        }
      }
    }
  } catch(e) { console.error("Webhook:", e.message); }
});

// ──────────────────────────────────────────────────────────────
//  HEALTH + СТАРТ
// ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({
  ok:true, users:users.size, rooms:rooms.size, uptime:Math.floor(process.uptime()),
}));

async function registerWebhook() {
  if (WEBAPP_URL.includes("localhost")||WEBAPP_URL.includes("your-game")) {
    return console.log("⚠️  Задай WEBAPP_URL в .env для webhook");
  }
  const url = WEBAPP_URL.replace(/\/$/,"")+"/webhook";
  const r   = await tgApi("setWebhook", {url, allowed_updates:["message","callback_query","pre_checkout_query"]});
  console.log("Webhook:", r.ok?"✅ "+url:"❌ "+r.description);
}

server.listen(PORT, async () => {
  console.log(`\n🃏  Дурак Multiplayer Server — порт ${PORT}`);
  console.log(`🌐  WebSocket: ws://localhost:${PORT}`);
  await registerWebhook();
});

module.exports = { app, server };
