
# 🃏 Дурак Multiplayer — Telegram Mini App

Полноценный мультиплеер 2–6 игроков. Ставки от 5 Stars.

---

## 📁 Структура

```
durak-multiplayer/
├── server/
│   ├── server.js     — Express + WebSocket + Telegram Bot API
│   ├── game.js       — Игровая логика (подкидной дурак, 2–6 игроков)
│   └── package.json
└── client/
    └── index.html    — Telegram Mini App (фронтенд)
```

---

## ⚡ Быстрый старт

```bash
cd server
npm install
cp .env.example .env   # вставь BOT_TOKEN
npm run dev
```

---

## 🤖 Настройка бота (5 минут)

### 1. Создать бота
```
@BotFather → /newbot → получить токен
```

### 2. Включить Stars-платежи
```
@BotFather → /mybots → выбрать бота
→ Payments → Telegram Stars → Enable
```

### 3. Настроить Mini App
```
@BotFather → /mybots → выбрать бота
→ Bot Settings → Menu Button
→ URL: https://your-game.vercel.app
→ Title: 🃏 Дурак
```

---

## 🚀 Деплой сервера

### Вариант A: Railway (рекомендуется, бесплатно)

```bash
npm install -g @railway/cli
railway login
cd server
railway init
railway up
```

Переменные окружения в Railway Dashboard:
```
BOT_TOKEN=1234:ABCdef...
BOT_USERNAME=durak_gamebot
WEBAPP_URL=https://your-game.vercel.app
NODE_ENV=production
PORT=3000
```

### Вариант B: Render.com

1. New → Web Service → подключи GitHub
2. Build: `cd server && npm install`
3. Start: `cd server && node server.js`
4. Добавь Environment Variables

### Вариант C: VPS (nginx + pm2)

```bash
# Установка
npm install -g pm2
cd server && npm install

# Запуск
pm2 start server.js --name durak
pm2 save

# nginx конфиг (добавить в sites-enabled)
# location /  { proxy_pass http://localhost:3000; }
# location /ws { proxy_pass http://localhost:3000; proxy_http_version 1.1;
#                proxy_set_header Upgrade $http_upgrade;
#                proxy_set_header Connection "upgrade"; }
```

---

## 🌐 Деплой фронтенда

### Vercel (бесплатно, 1 команда)

```bash
npm install -g vercel
cd client
vercel --prod
```

Или просто перетащи папку `client/` на https://vercel.com

### GitHub Pages

```bash
# Создай репо, пуш client/index.html
# Settings → Pages → Deploy from branch
```

---

## 🔧 .env.example

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
BOT_USERNAME=durak_gamebot
WEBAPP_URL=https://your-game.vercel.app
PORT=3000
NODE_ENV=production
```

---

## 🎮 Как работает мультиплеер

```
1. Игрок A создаёт комнату (ставка 5+ Stars, 2–6 мест)
   → Stars/монеты списываются сразу
   → Получает код комнаты и ссылку для приглашения

2. Игрок B (C, D...) заходит по ссылке или коду
   → Их ставка тоже списывается
   → WS транслирует всем: "игрок зашёл"

3. Хост нажимает "Начать игру"
   → createGame() раздаёт карты, определяет первого атакующего
   → Все видят своё состояние через playerView()

4. Ходы через POST /api/rooms/:id/action
   → Сервер проверяет валидность хода (нельзя смошенничать)
   → WebSocket рассылает всем обновлённое состояние

5. Игра завершается когда остался 1 игрок с картами
   → Дурак — последний с картами
   → Банк делится между победителями (60%/35%/... для мест)
   → Уведомление всем через WS и Telegram
```

---

## 💰 Распределение банка

| Место | Доля при 2 игр. | 3 игр. | 4+ игр. |
|-------|----------------|--------|---------|
| 🥇 1-е | 100%          | 55%    | 50%     |
| 🥈 2-е | —             | 30%    | 28%     |
| 🥉 3-е | —             | 15%    | 12%     |
| 4+ | —              | —      | 0%      |

Дурак не получает ничего.

---

## 📡 WebSocket события

| Тип               | Кто шлёт | Данные                         |
|-------------------|----------|--------------------------------|
| `connected`       | Сервер   | `{ userId }`                   |
| `room_state`      | Сервер   | `{ room, gameView }`           |
| `player_joined`   | Сервер   | `{ player, room }`             |
| `player_left`     | Сервер   | `{ playerId }`                 |
| `game_over`       | Сервер   | `{ isWinner, isDurak, prize }` |
| `balance_update`  | Сервер   | `{ stars, coins }`             |

---

## 🃏 Правила игры (подкидной дурак)

- Колода 36 карт (6–A), 6 карт в руке
- Козырь — последняя карта колоды (положена рубашкой вверх)
- Бить можно картой того же масти большего ранга или козырем
- Подбрасывать можно карты тех же рангов, что на столе
- Нельзя подбросить больше карт, чем у защитника
- Кто опустошил руку первым — тот победил
- Последний с картами — ДУРАК 💀

---

## 🏆 Команды бота

| Команда      | Описание                    |
|--------------|-----------------------------|
| `/start`     | Открыть игру                |
| `/top`       | Топ-10 игроков              |
| `/balance`   | Баланс (через callback)     |
