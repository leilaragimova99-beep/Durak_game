// ================================================================
//  game.js — Логика «Подкидного Дурака» для 2–6 игроков
// ================================================================

const RANKS  = ["6","7","8","9","10","J","Q","K","A"];
const SUITS  = ["♠","♥","♦","♣"];
const RV     = {6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};

function rv(r)  { return RV[r] || 0; }
function isRed(s) { return s === "♥" || s === "♦"; }

function makeDeck() {
  const d = [];
  for (const s of SUITS)
    for (const r of RANKS)
      d.push({ suit: s, rank: r, id: r + s });
  return shuffle(d);
}

function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function beats(atk, def, trump) {
  if (atk.suit === def.suit) return rv(def.rank) > rv(atk.rank);
  return def.suit === trump && atk.suit !== trump;
}

// ─── Создание игры ────────────────────────────────────────────
function createGame(playerIds) {
  if (playerIds.length < 2 || playerIds.length > 6)
    throw new Error("От 2 до 6 игроков");

  const deck      = makeDeck();
  const handSize  = playerIds.length <= 3 ? 6 : 6;  // всегда 6
  const hands     = {};

  for (const id of playerIds)
    hands[id] = deck.splice(0, handSize);

  const trumpCard = deck[deck.length - 1];
  const trump     = trumpCard.suit;

  // Первым ходит тот, у кого наименьший козырь
  const firstPlayer = findFirstAttacker(hands, trump, playerIds);

  // Порядок игроков по часовой стрелке
  const order = [...playerIds];
  const firstIdx = order.indexOf(firstPlayer);
  const rotated  = [...order.slice(firstIdx), ...order.slice(0, firstIdx)];

  return {
    deck,
    hands,
    trumpCard,
    trump,
    order:       rotated,        // очерёдность ходов
    attackerIdx: 0,              // индекс в order[] — текущий атакующий
    defenderIdx: 1,              // следующий после атакующего
    table:       [],             // [{attack, defense?}]
    phase:       "attack",       // attack | defend | done
    losers:      [],             // вышедшие дураки (проигравшие)
    finished:    [],             // завершившие без поражения (по порядку)
    durak:       null,           // последний проигравший
    log:         [],
    turnCount:   0,
  };
}

function findFirstAttacker(hands, trump, playerIds) {
  let best = null, bestVal = 999;
  for (const id of playerIds) {
    for (const card of hands[id]) {
      if (card.suit === trump && rv(card.rank) < bestVal) {
        bestVal = rv(card.rank);
        best = id;
      }
    }
  }
  return best || playerIds[0];
}

// ─── Активные игроки (ещё не вышли) ──────────────────────────
function activePlayers(g) {
  return g.order.filter(id => !g.finished.includes(id) && !g.losers.includes(id));
}

function attackerId(g) { return g.order[g.attackerIdx]; }
function defenderId(g) { return g.order[g.defenderIdx]; }

// ─── Применение действия ─────────────────────────────────────
function applyAction(game, playerId, action, payload) {
  const g   = deepCopy(game);
  const act = activePlayers(g);
  if (!act.includes(playerId)) return err("Вы уже выбыли из игры");

  if (action === "attack") {
    if (playerId !== attackerId(g))           return err("Не ваш ход для атаки");
    if (g.phase !== "attack")                 return err("Сейчас фаза защиты");
    if (g.table.length >= 6)                  return err("Стол полон (макс 6 пар)");
    // нельзя атаковать картами больше, чем карт у защитника
    if (g.table.length >= g.hands[defenderId(g)].length)
      return err("У защитника недостаточно карт");

    const card = takeFromHand(g, playerId, payload.cardId);
    if (!card) return err("Карта не найдена");

    // Подброс: ранги должны совпадать с уже лежащими картами
    if (g.table.length > 0) {
      const existing = g.table.flatMap(s => [s.attack.rank, s.defense?.rank]).filter(Boolean);
      if (!existing.includes(card.rank)) {
        returnToHand(g, playerId, card);
        return err("Можно подбрасывать только карты совпадающего ранга");
      }
    }

    g.table.push({ attack: card });
    g.phase = "defend";
    addLog(g, `${playerId} атакует ${card.rank}${card.suit}`);
    checkHandEmpty(g, playerId);
    return { ok: true, game: g };
  }

  if (action === "defend") {
    if (playerId !== defenderId(g))            return err("Вы не защитник");
    if (g.phase !== "defend")                  return err("Сейчас не фаза защиты");

    const { attackCardId, defenseCardId } = payload;
    const slot = g.table.find(s => !s.defense && s.attack.id === attackCardId);
    if (!slot) return err("Такой атакующей карты нет");

    const defCard = takeFromHand(g, playerId, defenseCardId);
    if (!defCard) return err("Карта не найдена");
    if (!beats(slot.attack, defCard, g.trump)) {
      returnToHand(g, playerId, defCard);
      return err("Эта карта не бьёт");
    }

    slot.defense = defCard;
    addLog(g, `${playerId} отбивает ${defCard.rank}${defCard.suit}`);
    checkHandEmpty(g, playerId);

    // Все карты отбиты → переходим к подброску или завершению
    if (g.table.every(s => s.defense)) {
      g.phase = "attack"; // атакующий может подбросить ещё
    }
    return { ok: true, game: g };
  }

  if (action === "pass") {
    // Атакующий завершает атаку (пас / бито)
    if (playerId !== attackerId(g))            return err("Вы не атакующий");
    if (g.table.length === 0)                  return err("Нечего завершать");
    if (!g.table.every(s => s.defense))        return err("Не все карты отбиты");

    // Бито — стол убирается, ход переходит к следующему
    g.table = [];
    addLog(g, "Бито! Ход следующему");
    advanceTurn(g, false);
    return { ok: true, game: g };
  }

  if (action === "take") {
    // Защитник берёт все карты со стола
    if (playerId !== defenderId(g))            return err("Вы не защитник");
    if (g.phase !== "defend")                  return err("Сейчас не фаза защиты");

    const taken = g.table.flatMap(s => [s.attack, s.defense].filter(Boolean));
    g.hands[playerId] = [...g.hands[playerId], ...taken];
    g.table = [];
    addLog(g, `${playerId} берёт карты (${taken.length} шт.)`);
    advanceTurn(g, true); // защитник пропускает следующий ход
    return { ok: true, game: g };
  }

  return err("Неизвестное действие: " + action);
}

// ─── Переход хода ─────────────────────────────────────────────
function advanceTurn(g, defenderTook) {
  refill(g);

  // Убираем тех, кто опустошил руку (только если колода тоже пуста)
  const act = activePlayers(g);
  for (const id of act) {
    if (g.hands[id].length === 0 && g.deck.length === 0 && !g.finished.includes(id)) {
      g.finished.push(id);
      addLog(g, `${id} вышел из игры!`);
    }
  }

  // Пересчитываем активных
  const stillActive = activePlayers(g);

  if (stillActive.length <= 1) {
    // Игра завершена
    if (stillActive.length === 1) {
      g.durak   = stillActive[0];
      g.losers  = [g.durak];
      addLog(g, `${g.durak} — ДУРАК!`);
    } else {
      g.durak = null; // ничья (крайне редко)
    }
    g.phase = "done";
    return;
  }

  // Следующий атакующий
  // Если защитник взял карты — следующий атакующий = тот, кто был атакующим
  // Если бито — следующий = тот, кто был защитником
  const currentAttackerPos = g.order.indexOf(attackerId(g));
  const currentDefenderPos = g.order.indexOf(defenderId(g));

  let nextAttackerPos;
  if (defenderTook) {
    // Защитник пропускает ход — атакует следующий после защитника
    nextAttackerPos = nextActiveIdx(g, currentDefenderPos);
  } else {
    // Бито — атакует бывший защитник
    nextAttackerPos = currentDefenderPos;
    // Но если он уже вышел, берём следующего
    if (g.finished.includes(g.order[nextAttackerPos])) {
      nextAttackerPos = nextActiveIdx(g, nextAttackerPos);
    }
  }

  g.attackerIdx = nextAttackerPos;
  g.defenderIdx = nextActiveIdx(g, nextAttackerPos);
  g.phase       = "attack";
  g.turnCount++;
}

function nextActiveIdx(g, fromIdx) {
  const n = g.order.length;
  let i = (fromIdx + 1) % n;
  while (g.finished.includes(g.order[i]) || g.losers.includes(g.order[i])) {
    i = (i + 1) % n;
    if (i === fromIdx) break;
  }
  return i;
}

function refill(g) {
  // Сначала атакующий, потом остальные по кругу, защитник последний
  const attIdx = g.attackerIdx;
  const defIdx = g.defenderIdx;
  const n      = g.order.length;
  const order  = [];

  // Собираем порядок добора
  let i = attIdx;
  for (let k = 0; k < n; k++) {
    const id = g.order[i];
    if (!g.finished.includes(id)) order.push(id);
    i = (i + 1) % n;
  }

  for (const id of order) {
    while (g.hands[id].length < 6 && g.deck.length > 0)
      g.hands[id].push(g.deck.pop());
  }
}

// ─── Хелперы ──────────────────────────────────────────────────
function takeFromHand(g, playerId, cardId) {
  const idx = g.hands[playerId].findIndex(c => c.id === cardId);
  if (idx === -1) return null;
  return g.hands[playerId].splice(idx, 1)[0];
}
function returnToHand(g, playerId, card) {
  g.hands[playerId].push(card);
}
function checkHandEmpty(g, playerId) {
  // Проверяется в advanceTurn после добора
}
function addLog(g, msg) {
  g.log.push({ t: Date.now(), msg });
  if (g.log.length > 50) g.log.shift();
}
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
function err(msg)    { return { ok: false, error: msg }; }

// ─── Вид для конкретного игрока (скрываем чужие карты) ────────
function playerView(game, playerId) {
  const g   = game;
  const act = activePlayers(g);
  return {
    trump:        g.trump,
    trumpCard:    g.trumpCard,
    deckCount:    g.deck.length,
    table:        g.table,
    phase:        g.phase,
    attacker:     attackerId(g),
    defender:     defenderId(g),
    myHand:       g.hands[playerId] || [],
    opponents:    g.order
      .filter(id => id !== playerId)
      .map(id => ({
        id,
        cardCount: (g.hands[id] || []).length,
        isActive:  act.includes(id),
        isAttacker: id === attackerId(g),
        isDefender: id === defenderId(g),
        isFinished: g.finished.includes(id),
      })),
    order:        g.order,
    finished:     g.finished,
    durak:        g.durak,
    isMyTurn:     playerId === attackerId(g) || playerId === defenderId(g),
    isAttacker:   playerId === attackerId(g),
    isDefender:   playerId === defenderId(g),
    phase:        g.phase,
    log:          g.log.slice(-5),
    turnCount:    g.turnCount,
  };
}

module.exports = { createGame, applyAction, playerView, activePlayers, attackerId, defenderId };
